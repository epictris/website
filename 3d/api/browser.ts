// Runs the real editor in headless Chromium for render requests. One browser,
// one job at a time, each in a fresh context (no shared storage), with a
// bounded queue so a burst of requests is refused instead of piling up.

import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";

const CANDIDATES = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
const JOB_TIMEOUT_MS = 60_000;
const MAX_QUEUED = 4;

export class Busy extends Error {}

function executable(): string {
  const path = process.env.CHROMIUM_PATH ?? CANDIDATES.find((p) => existsSync(p));
  if (!path) throw new Error("No Chromium found; set CHROMIUM_PATH.");
  return path;
}

let browser: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  browser ??= puppeteer
    .launch({
      executablePath: executable(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // Software WebGL so the perspective view renders without a GPU.
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ozone-platform=headless",
      ],
    })
    .then((b) => {
      b.on("disconnected", () => {
        browser = null;
      });
      return b;
    })
    .catch((e) => {
      browser = null;
      throw e;
    });
  return browser;
}

let tail: Promise<unknown> = Promise.resolve();
let queued = 0;

/**
 * A function run inside the editor page (puppeteer sends its source, so it
 * must be self-contained: reach the editor through window.orthographic).
 */
export type EditorJob<I, T> = (input: I) => Promise<T>;

/** Load the editor at `url` in a fresh context and run `job` there. */
export function runInEditor<I, T>(url: string, job: EditorJob<I, T>, input: I): Promise<T> {
  if (queued >= MAX_QUEUED) return Promise.reject(new Busy("The renderer is busy; retry shortly."));
  queued++;
  const run = tail.then(async () => {
    const b = await getBrowser();
    const context = await b.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setViewport({ width: 1600, height: 1000 });
      // The editor needs nothing from the network beyond its own page.
      await page.setRequestInterception(true);
      page.on("request", (r) =>
        r.url().startsWith(new URL(url).origin) || r.url().startsWith("data:") || r.url().startsWith("blob:")
          ? r.continue()
          : r.abort(),
      );
      await page.goto(url, { waitUntil: "load", timeout: JOB_TIMEOUT_MS });
      await page.waitForFunction("window.orthographic !== undefined", { timeout: JOB_TIMEOUT_MS });
      const evaluation = page.evaluate(job as (input: unknown) => Promise<T>, input);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("The render timed out.")), JOB_TIMEOUT_MS),
      );
      return (await Promise.race([evaluation, timeout])) as T;
    } finally {
      await context.close().catch(() => {});
    }
  });
  tail = run.catch(() => {}).finally(() => queued--);
  return run;
}

export async function closeBrowser() {
  const b = await browser?.catch(() => null);
  await b?.close();
}
