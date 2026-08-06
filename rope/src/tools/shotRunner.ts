// Headless chromium, driven over the DevTools protocol.
//
// It replaces `--screenshot=<file>`, which could only ever answer the question
// "what was on screen when the virtual-time budget ran out" - a guess in both
// directions. Too early is the late-frame blank flake (`shot --3d` returning a
// uniformly empty picture while the 2D path renders the same frame fine); too
// late is six seconds a grab, which in one session was 56 grabs and 25 minutes
// of waiting for a page that had been ready for five of them.
//
// What CDP buys, and each of these was a real cost before it:
//
// - The grab is GATED ON `window.shotReady`, which the page has always set and
//   nothing has ever polled. It fires the moment the page says it is done.
// - The page's console comes back on the same channel (`window.__shotLog`, plus
//   `Runtime.consoleAPICalled` for anything the page-side hook cannot reach), so
//   a screenshot arrives with the diagnostics that explain it.
// - `Page.captureScreenshot` takes a CLIP, and `Emulation.setDeviceMetricsOverride`
//   fixes the viewport at exactly the game's 1920x1080 frame. That retires the
//   measured "headless chromium keeps 87px of the window" hack, which never
//   worked: it left an 87px letterbox band along the bottom of every grab.
// - A hung page fails loudly, with its partial log printed, instead of stalling.
//
// No dependency: Bun's own `fetch` and `WebSocket`, and chromium's own protocol.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PageLogEntry {
  level: string;
  text: string;
}

export interface GrabRequest {
  url: string;
  // Where to write the PNG. Null takes no screenshot at all, which is what a
  // caller wanting only the page's log asks for.
  out: string | null;
  // The 3D path needs a GL implementation spelled out (headless has no GPU by
  // default) and a readable drawing buffer; the 2D path wants neither. Which
  // implementation is `GL_BACKENDS`, tried in order.
  gpu: boolean;
  width: number;
  height: number;
  // Wall-clock ceiling on the whole run. A page that never becomes ready must
  // kill the run and print what it did say, never stall.
  timeoutMs: number;
  // Virtual-time budget, in virtual milliseconds. Virtual time is kept because it
  // is what makes a grab reproducible - the page's clocks advance as fast as the
  // work allows rather than with the wall - and this is only the point past which
  // a page that has not finished is not going to.
  virtualBudgetMs: number;
}

export interface GrabResult {
  log: PageLogEntry[];
  // Wall milliseconds from launch to the screenshot landing.
  elapsedMs: number;
}

export function findChromium(): string | null {
  return (
    ["chromium-browser", "chromium", "google-chrome"].find(
      (b) => spawnSync("which", [b]).status === 0,
    ) ?? null
  );
}

// How a 3D grab is given a GL implementation, in the order they are tried.
//
// SwiftShader stays FIRST because it is the reproducible one: it is the same
// rasteriser on every machine and in CI, where there is no GPU at all, so a
// grab taken here and a grab taken there are comparable pictures. It is also
// the slow one - see "Performance claims need real-GPU numbers" in CLAUDE.md.
//
// It is no longer guaranteed to exist, which is why there is a second entry.
// A distribution may ship a chromium whose SwiftShader cannot start (Fedora's
// Chromium 142 is one: `libvk_swiftshader.so` is present and the context is
// refused anyway), and what that looks like from here is every `--3d` grab in
// the project failing at once, on every scene, with a page that never becomes
// ready - which reads as the renderer being broken rather than as the browser
// having no software GL.
//
// ANGLE over the host's EGL is the fallback: it uses whatever GL the machine
// really has, so it is a picture of this machine rather than of SwiftShader.
// That is a fine trade for the thing a grab is usually FOR (does the scene
// draw, is the prop the right way round) and the wrong one for a pixel diff
// across two machines - so the fallback announces itself.
const GL_BACKENDS: readonly (readonly string[])[] = [
  ["--enable-unsafe-swiftshader", "--disable-gpu"],
  ["--use-gl=angle", "--use-angle=gl-egl"],
];

// Did this run fail for want of a GL context, as against for any of the
// ordinary reasons a page does not become ready? Only that one failure is worth
// re-launching for; anything else is the page's own problem and a second
// attempt would just cost another timeout.
function webglRefused(log: readonly PageLogEntry[]): boolean {
  return log.some((e) => /WebGL context could not be created|Error creating WebGL context/i.test(e.text));
}

export async function grab(chromium: string, req: GrabRequest): Promise<GrabResult> {
  if (!req.gpu) return grabWith(chromium, req, []);
  let last: unknown;
  for (const [i, flags] of GL_BACKENDS.entries()) {
    const lastBackend = i === GL_BACKENDS.length - 1;
    try {
      const result = await grabWith(chromium, req, flags);
      // A page can also come up READY with no GL - the blank-frame detector is
      // what catches that - so the refusal is checked on the way out too.
      if (!lastBackend && webglRefused(result.log)) continue;
      return result;
    } catch (err: unknown) {
      last = err;
      if (lastBackend || !(err instanceof PageNotReady) || !webglRefused(err.log)) throw err;
      console.warn(
        `[shot] no software GL (${flags.join(" ")} refused a context); retrying with ${GL_BACKENDS[i + 1]!.join(" ")}.`,
      );
      console.warn(`[shot] the frame is this machine's GL rather than SwiftShader's.`);
    }
  }
  throw last;
}

async function grabWith(
  chromium: string,
  req: GrabRequest,
  glFlags: readonly string[],
): Promise<GrabResult> {
  const started = Date.now();
  const profile = mkdtempSync(join(tmpdir(), "rope-shot-"));
  let child: ChildProcess | null = null;
  let cdp: CDP | null = null;
  try {
    child = spawn(
      chromium,
      [
        "--headless",
        // Port 0 asks the OS for a free one and chromium writes it into the
        // profile, so two grabs can never collide over a fixed port - which is
        // exactly how a stale server once got screenshotted instead of the new
        // one (see `cli shot`'s process-group kill).
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--hide-scrollbars",
        ...glFlags,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"], detached: true },
    );
    // chromium's stderr is kept as a last resort for a launch that never gets as
    // far as speaking the protocol.
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });

    const port = await devToolsPort(profile, child, () => stderr, req.timeoutMs);
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page) throw new Error(`no page target (targets: ${targets.map((t) => t.type).join(",")})`);

    cdp = await CDP.connect(page.webSocketDebuggerUrl, req.timeoutMs);
    const log: PageLogEntry[] = [];
    // Messages from contexts the page-side hook cannot reach - a worker, if one
    // ever appears here. Deduped against the page buffer below, since the hook
    // and this see the same `console.log` twice.
    cdp.on("Runtime.consoleAPICalled", (p) => {
      const params = p as { type: string; args: { value?: unknown; description?: string }[] };
      log.push({
        level: params.type === "warning" ? "warn" : params.type,
        text: params.args
          .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? "")))
          .join(" "),
      });
    });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // The viewport IS the frame, so the clip below is the whole picture and
    // there are no bars in it. Window size cannot say this: chromium keeps part
    // of the window for itself, and how much is a measured constant that was
    // wrong.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: req.width,
      height: req.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
    await cdp.send("Page.navigate", { url: req.url });
    await cdp.send("Emulation.setVirtualTimePolicy", {
      policy: "pauseIfNetworkFetchesPending",
      budget: req.virtualBudgetMs,
      waitForNavigation: true,
    });

    const ready = await pollReady(cdp, started + req.timeoutMs);
    // The page's own buffer, read whether or not it ever became ready: a partial
    // log is the whole point of the timeout path.
    const raw = (await cdp.send("Runtime.evaluate", {
      expression: "JSON.stringify(window.__shotLog || [])",
      returnByValue: true,
    })) as { result?: { value?: string } };
    const pageLog = JSON.parse(raw.result?.value || "[]") as PageLogEntry[];
    // The page buffer first, in the page's own order; a protocol message that
    // says the same thing as one of its entries is the hook's own delegation
    // coming back and is dropped.
    const seen = new Set(pageLog.map((e) => `${e.level}:${e.text}`));
    const merged = [...pageLog, ...log.filter((e) => !seen.has(`${e.level}:${e.text}`))];

    if (!ready) {
      throw new PageNotReady(
        `page never set window.shotReady within ${req.timeoutMs}ms`,
        merged,
      );
    }

    if (req.out) {
      const shot = (await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: req.width, height: req.height, scale: 1 },
      })) as { data: string };
      writeFileSync(req.out, Buffer.from(shot.data, "base64"));
    }
    return { log: merged, elapsedMs: Date.now() - started };
  } finally {
    cdp?.close();
    if (child?.pid) {
      // Negative pid: the process group. chromium spawns a tree of helpers and
      // killing the parent alone leaves them holding the profile directory.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

// A page that never became ready, carrying whatever it did manage to say. It is
// its own error type so the caller can print the partial log rather than only
// the failure.
export class PageNotReady extends Error {
  constructor(
    message: string,
    readonly log: PageLogEntry[],
  ) {
    super(message);
    this.name = "PageNotReady";
  }
}

// The port chromium chose, from the file it writes into the profile.
async function devToolsPort(
  profile: string,
  child: ChildProcess,
  stderr: () => string,
  timeoutMs: number,
): Promise<number> {
  const file = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`chromium exited (${child.exitCode}): ${stderr().trim().slice(-500)}`);
    }
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (Number.isFinite(port) && port > 0) return port;
    }
    await sleep(25);
  }
  throw new Error(`chromium never reported a devtools port: ${stderr().trim().slice(-500)}`);
}

// The whole point of the runner: ask the page whether it is done, rather than
// guessing how long being done takes.
async function pollReady(cdp: CDP, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const r = (await cdp.send("Runtime.evaluate", {
      expression: "window.shotReady === true",
      returnByValue: true,
    })) as { result?: { value?: boolean } };
    if (r.result?.value === true) return true;
    await sleep(20);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// The thinnest possible DevTools client: ids in, results out, events to
// listeners. Bun's own `WebSocket`, no dependency.
class CDP {
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Map<string, ((params: unknown) => void)[]>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: unknown;
      };
      if (msg.id !== undefined) {
        const pending = this.waiting.get(msg.id);
        if (!pending) return;
        this.waiting.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${msg.error.message}`));
        else pending.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const l of this.listeners.get(msg.method) ?? []) l(msg.params);
      }
    });
    // A socket that closes with commands outstanding must fail them, or the
    // caller waits on a promise nothing will ever settle.
    ws.addEventListener("close", () => {
      for (const [, p] of this.waiting) p.reject(new Error("devtools socket closed"));
      this.waiting.clear();
    });
  }

  static connect(url: string, timeoutMs: number): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("devtools socket did not open")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CDP(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("devtools socket failed"));
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: (params: unknown) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Already gone: nothing to do.
    }
  }
}
