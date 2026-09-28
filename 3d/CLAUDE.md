# 3d.tris.sh

3D tools. So far one: **Orthographic Studio** at `/orthographic/`, an editor where a scene is one closed outline per object in each of three orthographic views (front x/z, top x/y, right side y/z), traced over per-view reference images and checked through a perspective camera.
Each object's solid is the intersection of its three outlines extruded along their view directions.
It is agent-first: one JSON document format, a validator that reports every problem with a JSON Pointer, and renders of every view.

## Running

```sh
bun install
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
  - `mesher.ts`: the silhouette-intersection reconstruction (pure; runs in a worker in the editor).
  - Internally outlines are normalised to the object's bounding box (`ring.ts`); documents use world units.
- `orthographic/src/`: the Solid app. `store.ts` (undoable scene state + UI state; `commit` runs a command on a copy), `actions.ts` (UI operations), `ortho/` (SVG views), `perspective/` (WebGL + software renderer), `ui/` (panels, dialogs), `io.ts` (load, save, autosave, exports), `snapshots.tsx` (off-screen renders), `api.ts` (`window.orthographic`).
- `orthographic/llms.txt`: the guide for agents. A test validates its example document.
- `server.ts` + `api/browser.ts`: serves the built single-file editor, `llms.txt`, `schema.json` and the HTTP API. `validate` runs the core in Bun; `render` drives the real editor in headless Chromium (one job at a time, fresh context each).

The build (`vite-plugin-singlefile`) inlines everything into `dist/orthographic/index.html`; "Save working editor" copies the running page, so keep the build single-file.

## Conventions

- Match the existing dark UI (`styles.css` came from the original single-file editor; its class names are load-bearing).
- Scene edits go through a core command, never by writing the store directly, so validation and undo stay in one place.
- Vertical FOV is stored; focal length is derived as the full-frame equivalent, f = 12 mm / tan(fov / 2).
