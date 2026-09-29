// Depth estimation of the reference image (Depth Anything V2 Small), run on
// the CPU by onnxruntime.
//
// The model runs in a child process (api/visionWorker.ts) started on first use
// and stopped after VISION_IDLE_MS without one: memory freed inside a process
// is not given back to the system, so stopping the process is what unloads
// the model, and a crash in native code cannot take the server with it. One
// job runs at a time, with a short queue (Busy beyond it), so two callers
// cannot double the memory. Depth maps are kept on disk by the image's content
// hash (DATA_DIR/vision).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import sharp from "sharp";
import { type DepthMap, depthFromGrey } from "../orthographic/src/core/depthmap";
import { Busy } from "./browser";
import { DEPTH_MODEL, MODELS_DIR } from "./models";
import { DATA_DIR, imagePath, type SceneImage } from "./scenes";
import type { VisionRequest, VisionResponse } from "./visionWorker";

const IDLE_MS = Number(process.env.VISION_IDLE_MS ?? 5 * 60_000);
const MAX_QUEUED = 4;
/** No single job takes this long unless something is wrong. */
const JOB_TIMEOUT_MS = 120_000;

/** The server does not have the depth model: estimate_depth answers vision-unavailable. */
export class VisionUnavailable extends Error {
  constructor() {
    super(
      `The server has no depth estimation model (Depth Anything V2 Small); run bun run models (MODELS_DIR is ${MODELS_DIR}).`,
    );
  }
}

export const hasDepthModel = () => existsSync(join(MODELS_DIR, DEPTH_MODEL));

// ---- The worker process --------------------------------------------------------------

let worker: Subprocess<"ignore", "inherit", "inherit"> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: VisionResponse) => void; reject: (e: Error) => void }>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function start() {
  const started = Date.now();
  const w = Bun.spawn([process.execPath, new URL("./visionWorker.ts", import.meta.url).pathname], {
    stdio: ["ignore", "inherit", "inherit"],
    serialization: "advanced",
    ipc(message: VisionResponse) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      p?.resolve(message);
    },
    onExit(_, code, signal) {
      if (worker === w) worker = null;
      console.log(
        `vision: worker stopped after ${Math.round((Date.now() - started) / 1000)} s (${signal ?? `exit ${code}`})`,
      );
      const lost = [...pending.values()];
      pending.clear();
      for (const p of lost) p.reject(new Error(`the vision process stopped (${signal ?? `exit ${code}`})`));
    },
  });
  console.log(`vision: worker started (pid ${w.pid})`);
  worker = w;
  return w;
}

/** Stop the worker, releasing the model. */
export function releaseModels() {
  clearTimeout(idleTimer);
  worker?.kill();
  worker = null;
}

function request(r: Omit<VisionRequest, "id">): Promise<VisionResponse> {
  const w = worker ?? start();
  const id = nextId++;
  return new Promise<VisionResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      // A job this slow is stuck: stop the process, which rejects everything waiting on it.
      w.kill();
    }, JOB_TIMEOUT_MS);
    pending.set(id, {
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    w.send({ ...r, id } satisfies VisionRequest);
  });
}

let tail: Promise<unknown> = Promise.resolve();
let queued = 0;

/** Run one job at a time on the worker; stop it once it has been idle for IDLE_MS. */
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  if (queued >= MAX_QUEUED) return Promise.reject(new Busy("The depth model is busy; retry shortly."));
  queued++;
  clearTimeout(idleTimer);
  const run = tail.then(job);
  tail = run
    .catch(() => {})
    .finally(() => {
      queued--;
      if (!queued) {
        idleTimer = setTimeout(releaseModels, IDLE_MS);
        idleTimer.unref?.();
      }
    });
  return run;
}

// ---- Depth -----------------------------------------------------------------------------

const visionDir = join(DATA_DIR, "vision");
const depthPath = (sha: string) => join(visionDir, `${sha}.depth.f32`);

function readDepthCache(sha: string): DepthMap | null {
  const path = depthPath(sha);
  if (!existsSync(path) || !existsSync(`${path}.json`)) return null;
  try {
    const head = JSON.parse(readFileSync(`${path}.json`, "utf8")) as { width: number; height: number; model: string };
    const bytes = readFileSync(path);
    if (head.model !== DEPTH_MODEL || bytes.byteLength !== head.width * head.height * 4) return null;
    const values = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { width: head.width, height: head.height, values };
  } catch {
    return null;
  }
}

function writeDepthCache(sha: string, map: DepthMap) {
  mkdirSync(visionDir, { recursive: true });
  const path = depthPath(sha);
  writeFileSync(`${path}.tmp`, new Uint8Array(map.values.buffer, map.values.byteOffset, map.values.byteLength));
  renameSync(`${path}.tmp`, path);
  writeFileSync(`${path}.json`, JSON.stringify({ width: map.width, height: map.height, model: DEPTH_MODEL }));
}

/** The relative depth of an image (larger is nearer), at the model's resolution (short side 518). */
export async function estimateDepth(image: SceneImage): Promise<DepthMap> {
  const cached = readDepthCache(image.sha);
  if (cached) return cached;
  if (!hasDepthModel()) throw new VisionUnavailable();
  return exclusive(async () => {
    const again = readDepthCache(image.sha);
    if (again) return again;
    const r = await request({ file: imagePath(image), width: image.width, height: image.height });
    if (!r.ok) throw new Error(r.error);
    writeDepthCache(image.sha, r.depth);
    return r.depth;
  });
}

/** A stored grey picture (8 or 16 bits, any format sharp reads) as a depth map: 0 is no value. */
export async function decodeDepthImage(bytes: Uint8Array): Promise<DepthMap> {
  const { data, info } = await sharp(bytes, { pages: 1 })
    .toColourspace("grey16")
    .raw({ depth: "ushort" })
    .toBuffer({ resolveWithObject: true });
  const grey = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  // With an alpha channel the grey comes back interleaved with it.
  const plane =
    info.channels === 1
      ? grey
      : Uint16Array.from({ length: info.width * info.height }, (_, i) => grey[i * info.channels]);
  return depthFromGrey(info.width, info.height, plane);
}
