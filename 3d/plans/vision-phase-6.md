# Plan: phase 6, help with the reference image

This finishes phase 6 of `agent-geometry-tooling.md`: segmentation (click an object in the reference, get a trace) and depth estimation (a relative depth map of the reference, used to order objects and propose depth ranges).
Phases 1–5 are done and committed (`0a2aab0`).
Read `3d/CLAUDE.md` first; its conventions apply (schema first, then `types.ts`; a command, an op, a tool and a line in `llms.txt` for every capability).

The hosting question the parent plan left open is settled: both models run inside the `3d` container with `onnxruntime-node`, loaded on first use, unloaded when idle.
Everything below about models, speed and memory was measured on 2026-09-29 against the cave painting (`backdrop.png`, scene `8h1SI1O4Hqeg4B9ZlU-gRg`).
The prototypes lived in a scratchpad that will not survive; the code that matters is reproduced here.

## What is already known

### Runtime

- `onnxruntime-node` (npm) loads and runs under Bun. Its postinstall is blocked by Bun as untrusted; that is fine, it only fetches GPU extras. The CPU binaries (`bin/napi-v*/linux/x64/`) ship in the package.
- Always create sessions with `{ enableCpuMemArena: false, enableMemPattern: false }`: with the arena on, one depth run grew the process by 360 MB; with it off, by 24 MB, at the same speed.
- `sharp` (npm) works under Bun: decoding the 1695 × 928 PNG and resizing it took 22 ms. Use it to decode PNG, JPEG, WebP and GIF on the server, which has no decoder today (`core/images.ts` only reads headers).
- Writing a 16-bit grey PNG through sharp silently produced 8-bit; write 16-bit PNGs with the studio's own `core/png.ts` (`encodePng(w, h, { grey16 }, deflateSync)`). Reading one back through sharp is not yet verified: check `sharp(buf).toColourspace("grey16").raw({ depth: "ushort" })` returns the values that went in, before relying on it.

### Depth: Depth Anything V2 small

- File: `https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx`, 99,060,839 bytes, sha256 `afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c`. Licence Apache-2.0 (only the Small size is; Base and Large are CC-BY-NC, do not use them).
- Input `pixel_values` [1, 3, h, w]; output `predicted_depth` [1, h, w]: relative inverse depth (larger is nearer), up to an unknown scale and offset.
- Preprocessing: short side to 518, both sides rounded to a multiple of 14 (1695 × 928 becomes 952 × 518), bicubic, RGB / 255, then (x − [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225], channels first.
- Cost: 0.2 s to load, 0.8 s per image on 4 threads (1.4 s on 1), +165 MB loaded, +24 MB per run.
- Quality on the painting, scored against the 20 fitted objects (visible pixels from `core/raster.ts`, eroded 3 px, per-object medians):
  - Spearman rank correlation of object order: 0.928.
  - Object pairs in the right order (pairs within 25 cm skipped): 169 / 185 (91.4 %).
  - Boundary pixels in the right order, sampling 6 px either side of every edge between two objects whose depths differ by 10 cm or more: 10,830 / 13,066 (82.9 %) over 43 pairs.
  - Model value against 1 / scene depth, linear fit over objects: R² 0.850; after the fit most objects land within 1–3 m (the back wall 20 m against 24 m).
  - Disagreements: `centre-pillar | tall-pillar` (111 / 310 boundary pixels agree) and `right-ledge | right-platform-front` (9 / 81). The first is where the original session also got the order wrong once; it is ambiguous in the painting, not clearly a model error.
  - Visually: crisp edges, vines and ferns separated cleanly, light shafts and mist not mistaken for surfaces.

### Segmentation: SAM 2.1 hiera tiny

- Files under `https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/` (fp32; each `.onnx` needs its `.onnx_data` beside it, same directory, same base name):

  | File | Bytes | sha256 |
  |------|-------|--------|
  | `vision_encoder.onnx` | 354,238 | `4f30aacd3aaefbca81a0b7fe4c1fc96345570ea0a6f80ced599493d1b3be2e8c` |
  | `vision_encoder.onnx_data` | 134,084,864 | `e83df9866a5afe68ea7f0f721f18f65137fc3acbf0da1c74e946d363e09c69cc` |
  | `prompt_encoder_mask_decoder.onnx` | 213,114 | `874414704c5d686db7d206a35f6e15d26563d50c8c4468fccc6739bd7e491dcf` |
  | `prompt_encoder_mask_decoder.onnx_data` | 20,958,208 | `e9874d900dd4134ed60eab1e97910327c2419e0b2954485d8fd6e7f1a1470f47` |

- Licence: SAM 2 is Apache-2.0 upstream (`facebook/sam2.1-hiera-tiny`); the onnx-community repo carries no licence tag. Note this in `CLAUDE.md`.
- Preprocessing (`preprocessor_config.json`): resize to exactly 1024 × 1024, ignoring the aspect ratio, bilinear; RGB / 255; ImageNet mean and std as above; channels first.
- Encoder: input `pixel_values` [1, 3, 1024, 1024]; outputs `image_embeddings.0` [1, 32, 256, 256], `image_embeddings.1` [1, 64, 128, 128], `image_embeddings.2` [1, 256, 64, 64]. About 16 MB per image in all: cache them per image.
- Decoder inputs: the three embeddings; `input_points` float32 [1, 1, n, 2] in the 1024 × 1024 space (x × 1024 / W, y × 1024 / H); `input_labels` int64 [1, 1, n] (1 foreground, 0 background); `input_boxes` float32 [1, b, 4] as (x0, y0, x1, y1) in the same space, or shape [1, 0, 4] for none (that works).
- Decoder outputs: `iou_scores` [1, 1, 3], `pred_masks` [1, 1, 3, 256, 256] (logits; > 0 is inside), `object_score_logits` [1, 1, 1]. Take the mask with the highest IoU score and upsample it to the image's size before thresholding.
- Cost: 0.18 s to load both, 1.06 s to encode the painting on 4 threads, 15–23 ms per decode. Process RSS was 506 MB with both loaded and one image encoded (arena off).
- Behaviour on the painting: a single click segments one visible surface, not a whole object. A click on the mushroom cap gave its front face with notches where vines hang over it (IoU score 0.86); a click on the tall pillar gave its rock face without the mossy top (0.80); the same click plus a box around the pillar gave 0.88 and a cleaner edge. So an object needs several positive points, often a box, and background points to trim; and a trace is "as if nothing stood in front", so holes must be filled and edges cut by occluders marked `hidden` by whoever makes the trace.
- The 256 × 256 mask is coarse at the painting's size (a mask pixel is 6.6 × 3.6 image pixels): upsample the logits bilinearly before thresholding, not the thresholded mask.

The prototype decoder call, for reference:

```ts
const feeds = {
  "image_embeddings.0": emb["image_embeddings.0"],
  "image_embeddings.1": emb["image_embeddings.1"],
  "image_embeddings.2": emb["image_embeddings.2"],
  input_points: new ort.Tensor("float32", Float32Array.from(points.flatMap(([x, y]) => [(x * 1024) / W, (y * 1024) / H])), [1, 1, n, 2]),
  input_labels: new ort.Tensor("int64", BigInt64Array.from(labels.map(BigInt)), [1, 1, n]),
  input_boxes: box
    ? new ort.Tensor("float32", Float32Array.from([(box[0] * 1024) / W, (box[1] * 1024) / H, (box[2] * 1024) / W, (box[3] * 1024) / H]), [1, 1, 4])
    : new ort.Tensor("float32", new Float32Array(0), [1, 0, 4]),
};
```

With points and no box, pass `n ≥ 1`; with a box and no points, try `input_points` of shape [1, 1, 0, 2] and `input_labels` [1, 1, 0] first (untested).

## Part 1: model files and the runtime

- `3d/scripts/fetch-models.ts`: downloads the five files above into `MODELS_DIR` (default `3d/models/`), verifies each sha256, skips files already present with the right hash, and fails loudly on a mismatch. `bun run models` runs it. Add `models/` to `3d/.gitignore` and `3d/.dockerignore`.
- `Dockerfile`: fetch the models in a build stage with that script (pinned by hash, so deploys are reproducible and never depend on Hugging Face being up at runtime), and copy them into the runner at `/app/models`; set `MODELS_DIR=/app/models`. Add `onnxruntime-node` and `sharp` to `dependencies` (the runner installs production dependencies only). Check the runner image (`oven/bun:1-slim`, glibc) loads both native addons: build it and run a one-line smoke script in it.
- `3d/api/vision.ts`, the only module that touches onnxruntime:
  - One lazily created session per model, `{ intraOpNumThreads: VISION_THREADS (default 4), enableCpuMemArena: false, enableMemPattern: false }`.
  - Unload (release the sessions) after `VISION_IDLE_MS` (default 5 minutes) without use; log loads and unloads.
  - One inference at a time, through a bounded queue like `api/browser.ts` (refuse with `Busy` beyond 4 waiting), so two agents cannot double the memory.
  - Decode and resize with sharp from the scene's image blob (`imageBytes` in `scenes.ts`).
  - Cache by the image's content hash (the blob's sha): SAM embeddings in memory (LRU of about 4 images, ~16 MB each); depth maps on disk under `DATA_DIR/vision/<sha>.depth.f32` plus a small JSON header (they are small and slow to recompute).
  - When `MODELS_DIR` lacks a model, every vision tool answers issue `vision-unavailable` ("the server has no <model>; run bun run models") instead of throwing.
- Check the production host before deploying: `free -m` and `nproc`. Budget about 700 MB extra while both models are loaded; if the host cannot spare that, set `VISION_THREADS` lower and keep the idle unload short, and tell Tris.

## Part 2: shared pieces in core (pure, tested without models)

- Move the cell-grid helpers out of `core/fit.ts` into `core/grid.ts`: `largestRegion`, `fillHoles`, `closeDiagonals`, `solidRegion`, `regionOutline`. `fit.ts` imports them; behaviour unchanged (its tests must stay green).
- `core/mask.ts`: `maskToRing(mask, width, height, { maxPoints, tolerance })`: the largest 4-connected region, holes filled, diagonal contacts closed, traced on the pixel grid, simplified with `simplify` from `ring.ts` (tolerance about 0.75 px, default `maxPoints` 160), in image pixels. Returns null for an empty mask.
- `core/depthmap.ts`:
  - `DepthMap { width, height, values: Float32Array }` in reference-image pixels (larger is nearer), and bilinear sampling at an image pixel.
  - `calibrate(s, meshOf, map, image)`: from the scene's own raster (visible pixels of every object, eroded 3 px, mapped from frame to image pixels with `core/overlay.ts`), fit value ≈ a / depth + b by least squares over per-object medians; return `{ a, b, r2, objects }` or null with fewer than 3 objects or a degenerate spread. This is exactly the scoring above; reuse its numbers as the test's expectations on a synthetic scene.
  - `depthOrderIssues(s, meshOf, map, image)`: across every boundary between two visible objects whose rendered depths differ by at least 10 cm, sample the map 6 px into each side; for each object pair with at least 40 samples where fewer than 30 % agree with the scene, a warning `depth-order` naming both objects, the share and the frame bounding box. Report it from `compare_to_reference` and `validate` when the perspective reference has a depth map.
  - `depthRangeFor(s, map, calibration, trace)`: the 5th and 95th percentile of calibrated depth over the trace's pixels, converted to world y by placing those depths on the trace pixels' rays (`pointAtDepth` in `raycast.ts`) and taking the smallest and largest y. That is what `suggest_views` needs.

## Part 3: the document and the tools

- Schema, then `types.ts`, then `document.ts`: `references.perspective.depth`: an image id, the depth map of the perspective image (a 16-bit grey PNG, near white, 0 for no data). Being referenced keeps it from being pruned by `pruneImages` in `scenes.ts`. Setting a new perspective image clears it (a depth map belongs to one image).
- `estimate_depth { sceneId, dryRun? }`: runs the model on the perspective reference image (cached), stores the PNG with `addImage` under the id `depth-<image id>`, sets `references.perspective.depth` as one undoable edit, and returns `{ image, width, height, calibration }` (calibration when at least 3 objects are placed: `a`, `b`, `r2`, and each object's estimated depth next to its scene depth, as in the table above) plus any `depth-order` issues.
- `segment { sceneId, points?: [[u, v, label]], box?: [u0, v0, u1, v1], maxPoints?, id? }`: prompts in reference-image pixels (labels 1 inside, 0 outside; at least one point or a box). Returns `{ trace: { points }, score, area, bbox }`. With `id`, also records it as that object's trace (one undoable edit via `ops.setTrace`, `baseRevision` applies as for every write tool). The answer must say plainly that the trace follows only what is visible: edges where something covers the object need extending and marking `hidden`.
- `suggest_views`: accept `depth: "estimate"` besides `{ min, max }`, using `depthRangeFor`; answer `calibration-needed` when there is no depth map or fewer than 3 placed objects.
- Page API (`window.orthographic`) cannot run the models (the editor is one offline file). Give it `depthOrderIssues` in `validate` when a depth map image is loaded (decode the PNG through a canvas; 8 bits are enough for ordering), and nothing else; say so in `llms.txt`.
- New issue codes: `vision-unavailable`, `calibration-needed`, `depth-order`, `segment-empty` (the mask is empty), `busy` (existing).

## Part 4: the editor

- Perspective header: a `Depth` checkbox, shown when the reference has a depth map, that draws the depth map in place of the reference image (same overlay geometry, same opacity).
- Trace section of the inspector (`TraceTools` in `ui/TransformTab.tsx`): a `Segment` button, enabled only on a live scene (`live()` in `live.ts`; the offline editor has no server to call; the tooltip says to Share the scene). While active: click adds a foreground point, Alt-click a background point, drag draws a box; each change calls the `segment` tool (without `id`) and draws the returned polygon dashed, as a trace being drawn is drawn now; Enter records it (`set_trace`, so it is one undo step and live-syncs), Escape cancels. The first call per image takes about a second (the encoder); show that in the perspective HUD.
- Check it in a real browser against the cave scene, and screenshot it; the UI rules in the repository's `CLAUDE.md` apply (pixel-level care, no stray units).

## Part 5: tests

- Core, without models: `maskToRing` on synthetic masks (a disc with a hole: one ring, hole filled, area within 1 %; two blobs: the larger one; a diagonal contact: a valid ring); `calibrate` and `depthOrderIssues` on a scene whose depth map is synthesised from its own raster (a / depth + b plus a little noise: r² near 1, no issues; then swap two objects' values: exactly that pair reported); `depthRangeFor` on a box traced from its own projection returns its y range within a few percent.
- End to end with the real models, skipped (with a visible skip reason) when `MODELS_DIR` lacks them: `segment` on a generated PNG (a flat-coloured rounded rectangle on a contrasting background, encoded with `core/png.ts`) with one point inside returns a ring whose IoU with the rectangle is at least 0.95; `estimate_depth` on a generated image of two overlapping rectangles, the upper one darker, stores a depth image, sets `references.perspective.depth`, and survives a document round trip.
- The existing 76 tests stay green; `bun run typecheck`, `bun run check`, and a warning-free `vite build`.

## Part 6: documentation

- `llms.txt`: tools table (`segment`, `estimate_depth`, `suggest_views depth: "estimate"`), a "Help with the reference" section (what segmentation gives and does not give: visible surfaces, several points and a box per object, then extend and mark hidden edges; what depth gives: order and rough depth, calibrated against placed objects, never geometry on its own), the document field, the issue codes, and a workflow step between tracing and fitting.
- `CLAUDE.md`: `api/vision.ts`, `core/mask.ts`, `core/depthmap.ts`, `core/grid.ts`, `bun run models`, `MODELS_DIR`, `VISION_THREADS`, `VISION_IDLE_MS`, the memory budget, and the model licences.
- MCP instructions in `api/mcp.ts`: one sentence on segment and estimate_depth.

## Order

Part 1 and Part 2 first (they are independent; Part 2 needs no models), then Part 3, then Part 4, with tests alongside each and the documentation last.
Nothing here needs a decision from Tris except the host memory check in Part 1, if it comes out tight.
