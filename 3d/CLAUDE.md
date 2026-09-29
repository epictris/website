# 3d.tris.sh

3D tools. So far one: **Orthographic Studio** at `/orthographic/`, an editor where a scene is one closed outline per object in each of three orthographic views (front x/z, top x/y, right side y/z), traced over per-view reference images and checked through a perspective camera.
Each object's solid is the intersection of its three outlines extruded along their view directions; an object may be a union of such parts.
It is agent-first: one JSON document format, a validator that reports every problem with a JSON Pointer, and renders of every view.
Agents need no browser: the server stores scenes and exposes every editor capability as tools, over MCP (`/orthographic/mcp`) and HTTP (`/orthographic/api/tools/{name}`).
An editor opened with `?scene=<id>` works on the stored scene live, so a person and an agent can edit one scene together.

## Running

```sh
bun install
bun run models     # the depth model into models/ (99 MB, pinned by sha256; once)
bun run dev        # Vite on :3200 (hot reload) + server.ts API on :3201, proxied
bun run test       # unit (core) + end-to-end (builds, serves, drives headless Chromium)
bun run typecheck && bun run check
```

`just run 3d` from the repo root runs `bun run dev`.

## Layout

- `orthographic/src/core/`: DOM-free TypeScript, used by the editor and by the server.
  - `schema.json` is the published document schema **and** the validator (ajv). Change the format here first, then `types.ts`.
  - `document.ts`: state ⇄ document, validation (`fromDocument` collects every issue), geometry checks.
  - `commands.ts`: every scene edit, as a function on a draft state returning issues. The UI and the agent API both go through these.
  - `ops.ts`: the same edits in the document's vocabulary (`{x, y, z}`, metres); `window.orthographic` and the server tools both call these.
  - `mesher.ts`: the exact solid of an object, the intersection of its three outlines' prisms (manifold-3d, loaded once in `manifold.ts` with a top-level await; the WASM is inlined in the build). Milliseconds per object, so it runs in the page and in the server's process.
  - `parts.ts`: objects as unions of parts; a part's box is kept as fractions of its object's box.
  - `raycast.ts` (rays through the frame, what they hit, `measure`'s maths) and `raster.ts` (a CPU rasteriser: object id and depth per pixel, id and depth pictures): perspective geometry the server uses without Chromium.
  - `compare.ts`: traced objects against the perspective reference (spill, missing, IoU, occlusion order). `fit.ts`: `fit_front`, the front outline solved from a trace and the top and side views. `diff.ts`: what changed between two states (`get_changes`).
  - `depthmap.ts`: a relative depth map of the reference against the scene: calibration (value ≈ a / depth + b over the placed objects), `depth-order` issues at object boundaries, and the depth range a trace probably occupies (`suggest_views depth: "estimate"`).
  - `overlay.ts`: where the perspective reference lies on the frame; image pixels to frame pixels and back.
  - `png.ts`: PNG encoding for pictures made without a canvas, and decoding of plain 8/16-bit PNGs (the page reads a depth map at 16 bits; a canvas rounds to 8, too coarse to order objects at nearly one depth). The caller brings zlib.
  - `projection.ts`: the one scale every orthographic picture (renders, the views sheet) is drawn at, and where each lies in metres.
  - Internally each part's outlines are normalised to its box, and each part's box to its object's (`ring.ts`, `parts.ts`); documents use metres. A plain object is one part and is written with `outlines`.
- `orthographic/src/`: the Solid app. `store.ts` (undoable scene state + UI state; `commit` runs a command on a copy), `actions.ts` (UI operations), `ortho/` (SVG views), `perspective/` (WebGL + software renderer), `ui/` (panels, dialogs), `io.ts` (load, save, autosave, exports), `snapshots.tsx` (off-screen renders), `api.ts` (`window.orthographic`), `depth.ts` (reading the reference's depth map in the page).
- `orthographic/llms.txt`: the guide for agents. A test validates its example document.
- `orthographic/src/live.ts`: live scenes in the editor (load `?scene=`, save each change with its base revision, follow server-sent events, Share).
- `server.ts`: serves the built single-file editor, `llms.txt`, `schema.json`, and routes the APIs.
- `api/`: the server.
  - `tools.ts`: every tool (JSON Schema input, `{ ok, issues, ... }` output), one registry for MCP and HTTP. Add capabilities here.
  - `mcp.ts`: the MCP server (SDK, Streamable HTTP, stateless: state lives in the stored scenes).
  - `http.ts`: HTTP routes (stateless validate/render, tools, scenes, events, exports).
  - `scenes.ts`: the scene store under `DATA_DIR` (scenes by unguessable id, undo history, a change summary per revision, content-addressed image blobs, 90-day expiry). States stored by an older server are upgraded as they are read (`upgradeObject`), since documents are not migrated but stored scenes must keep working.
  - `geometry.ts`: geometry and trace checks, solids and meshes cached by shape. Every tool that changes a scene takes `baseRevision`, checked once in `callTool`.
  - `render.ts` + `browser.ts`: renders by the real editor in headless Chromium (one job at a time, fresh context each, cached by scene revision).
  - `fetchImage.ts`: `add_image` URLs, refused unless they resolve to the public internet.
  - `vision.ts` + `visionWorker.ts`: `estimate_depth`. The depth model runs on the CPU with onnxruntime-node in a child process, started on first use and stopped after `VISION_IDLE_MS` (default 5 minutes) idle: freed model memory is never returned to the system from inside a process, so stopping it is what unloads the model (and a native crash cannot take the server down). One job at a time, `busy` beyond 4 waiting. Depth maps are cached on disk by image hash (`DATA_DIR/vision`). `visionWorker.ts` is the only code that touches onnxruntime.
  - `models.ts`: the model file, URL and sha256; `scripts/fetch-models.ts` (`bun run models`, and a Dockerfile stage) downloads it into `MODELS_DIR` (default `3d/models/`, `/app/models` in the image). Without it `estimate_depth` answers `vision-unavailable`.

In production scenes live in `/opt/website/3d-scenes` on the host (compose bind mount, created by `deploy/host-setup.sh`); locally in `3d/data/`.

The build (`vite-plugin-singlefile`) inlines everything into `dist/orthographic/index.html`; "Save working editor" copies the running page, so keep the build single-file.

### Depth model

- Depth Anything V2 **Small** (Apache-2.0; the Base and Large sizes are CC-BY-NC, never use them).
- Cost: 1 s per image on 4 threads, then cached. `VISION_THREADS` defaults to the smaller of 4 and the cores available.
- Memory: the worker holds about 260 MB while it runs (RSS after one depth run); the server itself stays at its idle size. Sessions run with the CPU memory arena and memory patterns off; with them on, one depth run kept 360 MB more.
- Segmentation (SAM 2.1 tiny) was built and removed on 2026-09-29: against the cave's fitted objects, three clicks and a box gave a median IoU of 0.72 (0.80 with notches closed), and a trace must include what the picture hides, which segmentation cannot know, so most of its traces needed redrawing anyway.

## Conventions

- Match the existing dark UI (`styles.css` came from the original single-file editor; its class names are load-bearing).
- Scene edits go through a core command, never by writing the store directly, so validation and undo stay in one place.
- A new editor capability agents should have gets an op in `core/ops.ts`, a tool in `api/tools.ts` and a line in `llms.txt`.
- Every length is in metres; `scene.scale.basis` records what they were measured from. There is no abstract unit.
- Vertical FOV is stored; focal length is derived as the full-frame equivalent, f = 12 mm / tan(fov / 2).
