// Fetching a reference image from a URL an agent gives. The server fetches it,
// so the URL must lead to the public internet: never to this host, the
// container network or a cloud metadata service.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MAX_IMAGE_BYTES } from "../orthographic/src/core/images";
import { StoreError } from "./scenes";

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;

function v4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return v4Private(mapped[1]);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff") ||
    v6.startsWith("64:ff9b:")
  );
}

async function checkUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StoreError("invalid-url", `"${raw}" is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new StoreError("invalid-url", "Give an http or https URL.");
  if (url.username || url.password) throw new StoreError("invalid-url", "URLs with credentials are not fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new StoreError("fetch-failed", `${url.hostname} does not resolve.`);
  if (addresses.some(isPrivate))
    throw new StoreError("invalid-url", `${url.hostname} is not on the public internet; the server will not fetch it.`);
  return url;
}

/** Download an image, following redirects (each one checked), up to the image size limit. */
export async function fetchImage(raw: string): Promise<{ bytes: Uint8Array; name: string }> {
  let url = await checkUrl(raw);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": "OrthographicStudio/1 (+https://3d.tris.sh/orthographic/)", Accept: "image/*" },
      });
    } catch (e) {
      throw new StoreError("fetch-failed", `Could not fetch ${url.href}: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new StoreError("fetch-failed", "Too many redirects.");
      url = await checkUrl(new URL(res.headers.get("location")!, url).href);
      continue;
    }
    if (!res.ok) throw new StoreError("fetch-failed", `${url.href} answered ${res.status}.`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES)
      throw new StoreError("image-too-large", "Use an image smaller than 25 MB.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body ?? []) {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) throw new StoreError("image-too-large", "Use an image smaller than 25 MB.");
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    const last = url.pathname.split("/").pop() || url.hostname;
    let name = last;
    try {
      name = decodeURIComponent(last);
    } catch {
      // Keep the encoded form.
    }
    return { bytes, name: name.slice(0, 180) };
  }
}
