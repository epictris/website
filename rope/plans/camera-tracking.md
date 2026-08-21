# Plan: camera path tracking

The camera should tell the player where to go next.
Today it can only follow the avatar and be reshaped by volumes (`CameraRegionData`): a region can offset, zoom, or pin an axis while the avatar is inside it, with the `CameraController` easing every hand-off.
That vocabulary frames rooms well, but it cannot express the most common intent in a traversal level: "the route runs this way, keep the screen ahead of the player along it".

This plan adds a **camera path**: an authored polyline through the level that the camera rides.
The player's position is projected onto the path, the camera targets a point a configurable distance **further along** it, and so the screen leads the player toward where they are expected to go.
If the player strays more than a configurable distance from the path (falls to the bottom of the level, takes a side room), the path lets go and the camera falls back to whatever rule governs the place the player actually is: a camera region if one contains them, the plain follow camera otherwise.
Coming back within range re-acquires the path.
Every one of those transitions goes through the controller's existing frozen-delta hand-off, so nothing snaps.

## Design

### The data

A new top-level level list, `cameraPaths`, beside `cameraRegions`.
A path is deliberately NOT a body and NOT a region with a funny shape: a region is a closed volume tested by containment, a path is an open directed polyline tested by distance, and forcing one to impersonate the other would leave every shape helper (`pointInRegion`, `pathOutlineGrown`, convexity rules) half-lying.

```ts
// levelFormat.ts
export interface CameraPathData {
  x: number;
  y: number;
  rot: number;
  // Local-frame polyline, >= 2 verts, in vert order = direction of travel.
  // Same storage convention as ShapeData's poly: {x, y} pairs, local to (x, y, rot).
  verts: { x: number; y: number }[];
  // Metres (pixels on disk) the player may stray from the polyline before the
  // path lets the camera go. Absent = DEFAULT_PATH_RANGE.
  range?: number;
  // Metres along the path the camera leads the player's projection.
  // Absent = DEFAULT_PATH_LOOKAHEAD.
  lookahead?: number;
  // Same semantics as the region fields of the same names.
  viewportScale?: number;
  blend?: number;
  // Extra release hysteresis outside `range`; absent = REGION_EXIT_MARGIN.
  buffer?: number;
  // Overlap tie-break against regions and other paths; absent = 0.
  priority?: number;
}
```

Defaults, exported from `levelFormat.ts` beside `DEFAULT_VIEWPORT_SCALE`:

- `DEFAULT_PATH_RANGE = 4` metres.
  At `GRAPPLE_ZOOM = 2` and `PIXELS_PER_METER = 100` a 1080p frame shows 9.6 x 5.4 m of world, so 4 m is "most of a screen height off the route" before the path gives up.
- `DEFAULT_PATH_LOOKAHEAD = 2.5` metres, roughly a quarter of the frame width ahead.
  Both are starting points to be tuned in the editor, not constraints.

On disk the level is in scene pixels; `scaleLevelData` converts.
`x`, `y`, `verts`, `range`, `lookahead`, `buffer` are lengths and scale by the factor; `rot`, `viewportScale`, `blend`, `priority` do not.
Mirror the `cameraRegions` block in `scaleLevelData` (levelFormat.ts:1673) exactly, including the `...(field !== undefined ? ... : {})` spread style.
A path with fewer than 2 verts (or with every vert coincident) is dropped at load with a `console.warn` naming the level: it has no direction and nothing can be projected onto it.

### Governance: one rule set, two rule kinds

The controller currently governs with `CameraRegionData | null` plus `activeCameraRegion`'s priority/buffer logic.
That logic (highest priority wins, later author order breaks ties, the incumbent keeps its grip inside a grown margin unless strictly outranked, entering is never buffered) is exactly what paths need too, so it generalises rather than duplicates:

```ts
// cameraController.ts
export type CameraRule =
  | { kind: "region"; region: CameraRegionData }
  | { kind: "path"; path: CameraPathData; index: PolylineIndex };
```

`Level` builds the rule list once at construction: regions first in author order, then paths in author order.
Because `activeCameraRegion`'s tie-break is "later wins", listing paths after regions makes a path beat a region at equal priority, which is the right default: the path is the level's primary guide and a region is the local exception.
A region that must win anyway says so with `priority`, exactly as regions already outrank each other.

`activeCameraRegion` becomes `activeCameraRule(rules, p, current)` with the same shape:

- **Containment** for a region is `pointInRegion` as today.
  For a path it is `distance from p to the polyline <= range`.
- **The incumbent's grip** for a region is its volume grown by `regionBuffer`.
  For a path it is `range + (buffer ?? REGION_EXIT_MARGIN)`, and the distance is measured to the *windowed* projection described below, not the global closest point, so a switchback passing nearby cannot hold a player who has fallen off the branch they were actually on.
- Priority and the strictly-higher-override are untouched.

Keep `activeCameraRegion` as a thin wrapper over the general function only if the debug overlay still wants it; otherwise update the two call sites (debugOverlay.ts:192, via main.ts:261) and delete it.
`CameraController.activeRegion` becomes `activeRule: CameraRule | null`; the overlay and main.ts adapt.

### Projection and the lookahead target

New pure-geometry module `render/cameraPath.ts` (render-side, like everything camera):

```ts
// Cumulative arc lengths, built once per path at Level construction.
export interface PolylineIndex { verts: Vec2[]; cum: number[]; total: number }
export function buildPolylineIndex(verts: readonly Vec2[]): PolylineIndex;
// Global closest point: arc-length s of the projection and the distance to it.
export function projectOntoPolyline(ix: PolylineIndex, p: Vec2): { s: number; dist: number };
// Same, but only considering s in [sMin, sMax] - the continuity window.
export function projectOntoPolylineWindow(ix: PolylineIndex, p: Vec2, sMin: number, sMax: number): { s: number; dist: number };
// The world point at arc length s, clamped to [0, total].
export function pointAtArcLength(ix: PolylineIndex, s: number): Vec2;
```

All of these work in the path's local frame; the controller transforms the follow point into it with the same `p.sub(origin).rotated(-rot)` idiom `pointInRegion` uses, and transforms the resulting target back out.
(Equally acceptable: bake the transform into the `PolylineIndex` at build time and work in world space throughout, since nothing mutates a path at runtime.
Pick one and say so in a comment; do not do half of each.)

The camera's target under a path rule, for an avatar projected at arc length `s`:

```
target.pos  = pointAtArcLength(index, s + lookahead)   // clamped by pointAtArcLength
target.zoom = baseZoom / max(0.01, viewportScale ?? 1) // same guard as regions
```

The lookahead is always toward increasing `s`.
The path is directed by its vert order, and that direction *is* the design: even when the player backtracks, the screen keeps favouring the way the level wants them to go.
Clamping at the ends is the correct degenerate behaviour: near the goal the camera comes to rest centred on the path's end rather than staring past it.

`cameraRegionTarget` grows a sibling, `cameraRuleTarget(rule, follow, baseZoom, s)`, where `s` is the resolved projection for a path rule and ignored for regions and null.
Resolve the projection once per frame and pass it through; never recompute it inside the target function.

### Continuity: the windowed projection

A global closest-point query is discontinuous wherever the path passes near itself: on a switchback, one frame's projection can teleport many metres of arc length, and the lookahead target with it.
The hand-off blend cannot help because the rule identity has not changed.

So the controller tracks the projection statefully:

- On **acquisition** (the path was not the incumbent last frame): global `projectOntoPolyline`.
  Entering is unbuffered and history-free, exactly like regions.
- While **held**: `projectOntoPolylineWindow` around last frame's `s`, with the window sized to what the player could plausibly have moved:

```
maxStep = followDelta + PATH_TRACK_SLACK_SPEED * dt   // followDelta = |follow - lastFollow|
window  = [s - maxStep, s + maxStep]
```

`PATH_TRACK_SLACK_SPEED = 5` m/s of allowance beyond the player's own motion; the `dt` term keeps the window frame-rate independent, and the `followDelta` term means no legitimate move can outrun it, however fast the avatar is flung.
The controller stores `pathS` and `lastFollow` beside its existing smoothing state, and both reset on `snap()`.

This buys a clean, explainable semantics for switchbacks: the camera tracks the branch the player is actually on; if the player drops from an upper branch toward a lower one, the windowed distance grows past `range + buffer`, the path releases, the fallback rule takes over with a blend, and if the lower branch is within range the path re-acquires there (a fresh global projection) with another blend.
No teleports, and the release distance the author configured is measured against the branch that was being ridden, which is what they meant by it.

### What does not change

- The frozen-delta hand-off (`offset`/`zoomRatio`/`s`/`dur`) is untouched.
  It is keyed on rule identity, and every path transition (default -> path, path -> region, path -> path, path -> default) is a rule change, so the existing machinery blends all of them for free.
  The one addition: when the *outgoing* rule is a path, its "previous target" on the crossing frame uses the `pathS` frozen from the last held frame.
- `CAMERA_FOLLOW_TAU` easing, `snap()`, the ball controller's post-follow framing shift, `screenToWorld`/`worldToScreen`.
- The sim.
  The camera stays render-side and wall-clock driven; recorded replays and `cli selftest` stay bit-identical.
  (The grapple cursor un-projects through the camera, but as today the recorded trace stores the resulting world point.)
- Levels with no `cameraPaths` key: the rule list is regions-only and every code path reduces to today's behaviour.

## Ground rules

- `bun run test` green after every phase; `cli selftest` bit-identical throughout (nothing here touches the sim).
- A level without `cameraPaths` behaves pixel-identically to before, in play and in the editor.
- No new npm dependencies.
- Repo conventions: comments state constraints rather than narrate, Markdown sentences own their lines, no em dashes, Bash timeouts under 30s.
- The dev server on port 3100 with `/editor` open belongs to the author: never kill vite, never `git checkout` `levels/*.json`.

## Phase 1: geometry core plus its test suite

What lands:

- `render/cameraPath.ts` as specified above: `PolylineIndex`, `buildPolylineIndex`, `projectOntoPolyline`, `projectOntoPolylineWindow`, `pointAtArcLength`.
  Pure functions, no controller state, no DOM.
- A `cli camera` case suite in the pattern of the existing `cli` suites (see `src/sim/render3dCases.ts` and friends for the shape: a table of named cases, each asserting exact or toleranced values, one exit code).
  Cases that must exist:
  - Projection onto a single segment: interior, both endpoint clamps, a point exactly on the line.
  - Projection onto a multi-segment path: a point nearest a vertex (the corner case where two segments tie), verifying `s` is continuous through the corner.
  - `pointAtArcLength` at 0, mid-segment, exactly on a vertex, past `total` (clamps), negative (clamps).
  - A switchback (path doubles back within twice the test range): global projection picks the true closest branch; the windowed projection with a window confined to the original branch stays on it and reports the growing distance.
  - Degenerate input: duplicate consecutive verts contribute zero length and break nothing.
- A `camera` step in `scripts/test.ts` (the steps list is explicit; add it beside `decompose`).

Acceptance:

- `bun run test` green, including the new step.
- The switchback case is the load-bearing one: write it first, red against a deliberately naive `projectOntoPolylineWindow` (one that ignores the window), then green.

## Phase 2: format, controller, and play wiring

What lands:

- `levelFormat.ts`: `CameraPathData`, its defaults, the `cameraPaths?` key on `LevelData` (near line 887) and `RawLevelData` (near line 1020), the `scaleLevelData` block, and the drop-with-warning for degenerate paths.
- `level.ts`: `readonly cameraPaths` and a prebuilt `readonly cameraRules: CameraRule[]` (regions then paths), built beside `cameraRegions` at line 73.
- `cameraController.ts`: `CameraRule`, `activeCameraRule`, `cameraRuleTarget`, the `pathS`/`lastFollow` tracking, and `CameraController.update` taking the rule list.
  `update`'s signature changes from `regions` to `rules`; update the call sites: `main.ts:227`, the editor's test-play controller (`editor.ts:1141` and its update near 5521).
- `debugOverlay.ts`: alongside `drawCameraRegions`, draw each path as a directed polyline (arrowheads every few metres), its corridor (the polyline offset by `range` on both sides, dashed, same treatment as region outlines), and when a path is the rule in force: fill nothing (a corridor has no meaningful interior tint at switchbacks) but mark the projection point, the lookahead target, and the release boundary (`range + buffer`, the sparser dash used for region buffers).
  The overlay takes the controller's held rule exactly as it takes `heldCameraRegion` today, for the same reason: the grip is stateful and a recomputed answer lies inside the buffer.
- `main.ts:261` passes the held rule through.

Acceptance:

- Hand-add a `cameraPaths` entry to a copy of a level (scratch copy, not the live `levels/*.json`), run the game, and verify with the debug overlay: camera leads the player along the path; walking backwards keeps the lookahead pointing forward; dropping more than `range` off the path hands off (blended) to the containing region or the default follow; returning re-acquires with a blend.
- A level without paths plays identically (eyeball plus the existing suites).
- `bun run test` green.

## Phase 3: editor authoring

The editor is where this earns its keep: a path nobody can draw and drag is a JSON dialect, not a feature.

What lands:

- **Shape kind.** `EdShape` (model.ts:137) gains `{ kind: "path"; verts: Vec2[] }`: an open local-frame polyline, permitted only on the camera layer.
  A new writer `setPathVerts` beside `setPolyVerts` (model.ts:1366) is the single mutation point: it drops consecutive duplicate verts, requires 2+, and re-centres the item's `pos` on the vert average (a polyline has no area centroid; the average keeps the transform gizmo somewhere sensible).
  No simplicity or convexity constraint: a path may cross itself, that is what switchbacks are.
- **Item plumbing.** `EdCamera` (model.ts:142) gains `range: number | null` and `lookahead: number | null` (null = the format defaults), kept total on every item as the existing fields are.
  Load (`model.ts:859` block) and save (`model.ts:1033` block) gain the `cameraPaths` mirror of the regions mapping; a camera-layer item with a `path` shape serialises to `CameraPathData`, everything else exactly as today.
  Round-tripping a level without paths must be byte-identical to today's output.
- **Drawing.** A path tool on the camera layer beside the existing draw tools: click to place verts, Enter or double-click to finish, Escape to cancel, mirroring the poly tool's flow (editor.ts:4197 area) minus the closing edge and minus the convex fallback.
- **Picking and editing.** Hit-test by distance to the nearest segment within a pick band (the arrow notes already pick a segment through a stored band, `NOTE_ARROW_THICKNESS`; use the same width).
  Vert drag, insert-on-edge, and delete reuse the poly vert paths (editor.ts:4523, 4540, 5229), with the endpoint cases not wrapping.
  Move/rotate through the ordinary transform handles work already once the shape kind exists in the shared outline helpers; scale may be omitted for v1 if it fights the shared gizmo, but say so in a comment where it is refused.
- **Inspector.** `buildCameraPathGroup` beside `buildCameraGroup` (editor.ts:3132): `range`, `lookahead`, `view x`, `blend s`, `buffer`, `priority`, each with the blank-means-default treatment the region panel already uses, plus a `reverse` action that reverses vert order (direction is meaning, and re-drawing a long path backwards is miserable).
  No offsets, locks, or per-side buffers: none of them mean anything on a path.
- **Editor canvas rendering** (`editor/render.ts`): stroke the polyline in the camera layer colour with direction arrowheads, tint the corridor at `range` faintly, label it via the `cameraRegionLabel` pattern (render.ts:609).
- **Test-play.** The in-editor test-play already runs the real `CameraController`; feed it the drawn paths so an author feels the behaviour without leaving the editor.

Acceptance:

- Draw a path, tune `range`/`lookahead` in the panel, test-play it, save; reload the editor and the level is unchanged by a second save (idempotent round-trip).
- A level saved before this phase re-saves byte-identically with no paths present.
- `bun run test` green (typecheck covers the editor).

## Phase 4: docs, defaults, and a real level

What lands:

- A camera section in `docs/level-design.md` (which currently says nothing about cameras): regions in two paragraphs, then paths - direction is the design, `range` is "how far off the route the player may be while the camera still narrates the route", the release-to-region fallback, and the tie-break rule (path beats region at equal priority; raise the region's priority for deliberate interior framing).
- `docs/game-design.md`'s camera-region convexity note (line 238) gains a sentence distinguishing paths, so the next reader does not try to express one as a degenerate region.
- Author a path through the current ball level (with the author driving or reviewing: level tuning is design work, not plumbing) and tune the defaults against how it actually feels.
  Whatever `DEFAULT_PATH_RANGE`/`DEFAULT_PATH_LOOKAHEAD` end up as, the constants' comments state the frame-fraction reasoning at the final values.

Acceptance:

- A full playthrough of the pathed level with the debug overlay on: no snaps, no rubber-banding at hand-offs, release and re-acquire both blended, and the lookahead visibly allocating screen toward the direction of travel.
- `bun run test` green; a clean tree's `cli shot` output unchanged.

## Explicitly out of scope (recorded so they are choices, not oversights)

- **Per-vertex properties** (viewportScale, lookahead, range varying along the path).
  The uniform version has to prove itself first, and per-vertex anything multiplies the editor surface.
  The format leaves room: fields would move from the path onto its verts without renaming anything.
- **Curved paths.**
  A polyline through `CAMERA_FOLLOW_TAU` easing is already smooth on screen; splines buy little and cost every helper.
- **Axis locks or offsets on paths.**
  A path IS the position rule; composing it with locks reintroduces the ambiguity regions already cover.
- **Smart direction inference** (flipping lookahead when the player backtracks).
  Deliberately rejected, not deferred: the whole point is that the camera argues for the authored direction.
