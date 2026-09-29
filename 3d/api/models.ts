// The vision model's files, pinned by hash. scripts/fetch-models.ts downloads
// them into MODELS_DIR; api/visionWorker.ts loads them from there.
//
// Depth Anything V2 Small is Apache-2.0. Only the Small size: Base and Large
// are CC-BY-NC, so never swap them in.

export const MODELS_DIR = process.env.MODELS_DIR ?? new URL("../models", import.meta.url).pathname;

export interface ModelFile {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

/** Depth Anything V2 Small: relative inverse depth. */
export const DEPTH_MODEL = "depth-anything-v2-small.onnx";

export const MODEL_FILES: ModelFile[] = [
  {
    name: DEPTH_MODEL,
    url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx",
    bytes: 99_060_839,
    sha256: "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
  },
];
