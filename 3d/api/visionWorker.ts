// The depth model's process: Depth Anything V2 Small on the CPU with
// onnxruntime, driven by api/vision.ts over IPC. It gives relative inverse
// depth (larger is nearer) at the model's resolution, short side 518. It lives
// only while it is being used, so the memory the model takes goes back to the
// system when it exits; in the server's own process freed model memory is not
// returned.

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { DEPTH_MODEL, MODELS_DIR } from "./models";

export interface VisionRequest {
  id: number;
  /** The image's bytes on disk, and its pixel size. */
  file: string;
  width: number;
  height: number;
}

export type VisionResponse =
  | { id: number; ok: true; depth: { width: number; height: number; values: Float32Array } }
  | { id: number; ok: false; error: string };

const THREADS = Number(process.env.VISION_THREADS ?? Math.min(4, availableParallelism()));

let model: Promise<ort.InferenceSession> | null = null;

function session(): Promise<ort.InferenceSession> {
  if (!model) {
    const started = performance.now();
    model = ort.InferenceSession.create(join(MODELS_DIR, DEPTH_MODEL), {
      intraOpNumThreads: THREADS,
      interOpNumThreads: 1,
      executionMode: "sequential",
      // With the arena and memory patterns a run keeps hundreds of MB; without them, tens.
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    model
      .then(() => console.log(`vision: loaded ${DEPTH_MODEL} in ${Math.round(performance.now() - started)} ms`))
      .catch(() => {
        model = null;
      });
  }
  return model;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** An image resized to width x height (ignoring its aspect ratio), as normalised RGB planes [3, h, w]. */
async function pixels(file: string, width: number, height: number, kernel: "cubic" | "linear") {
  const rgb = await sharp(readFileSync(file), { pages: 1 })
    .removeAlpha()
    .toColourspace("srgb")
    .resize(width, height, { fit: "fill", kernel })
    .raw()
    .toBuffer();
  const n = width * height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  return out;
}

// ---- Depth ---------------------------------------------------------------------------

/** The model's input size: short side 518, both sides multiples of 14. */
function depthInputSize(width: number, height: number): [number, number] {
  const k = 518 / Math.min(width, height);
  const round14 = (v: number) => Math.max(14, Math.round(v / 14) * 14);
  return [round14(width * k), round14(height * k)];
}

async function depth(r: VisionRequest) {
  const [w, h] = depthInputSize(r.width, r.height);
  const input = await pixels(r.file, w, h, "cubic");
  const out = await (await session()).run({ pixel_values: new ort.Tensor("float32", input, [1, 3, h, w]) });
  const t = out.predicted_depth;
  const [, oh, ow] = t.dims as number[];
  return { width: ow, height: oh, values: Float32Array.from(t.data as Float32Array) };
}

// ---- IPC -------------------------------------------------------------------------------

process.on("message", async (r: VisionRequest) => {
  let reply: VisionResponse;
  try {
    reply = { id: r.id, ok: true, depth: await depth(r) };
  } catch (e) {
    reply = { id: r.id, ok: false, error: (e as Error).message };
  }
  process.send!(reply);
});
// The server went away: nothing is left to answer.
process.on("disconnect", () => process.exit(0));
