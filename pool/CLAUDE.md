# pool.tris.sh

Multiplayer 8-ball. Bun relay (`server.ts`) + deterministic client physics
(`client/src/physics.ts`). Multiplayer syncs by sending shot parameters only;
both clients + replays re-simulate to byte-identical rest positions, so the
physics must stay deterministic (fixed timestep, fixed iteration order, no
`Math.random`).

## Input & orientation

Designed for **fullscreen + landscape**. The table's long axis runs across the
screen; a player stands at a **short end**. The cue power widget lives at the
**right** short end in a **widget column** (`.cue-col`): a **white-ball button**
on top, then the **cue power** widget (which flex-grows to fill the rest).

**Portrait phones are played held SIDEWAYS.** On the immersive nudge the client
locks `screen.orientation` to **portrait** (`enterImmersive` in `Game.tsx`). The
layout never changes — the table + widgets are always built landscape. Instead,
when `resize()`'s `rotate90` test fires
(`innerHeight > innerWidth && innerWidth < 700`) the entire game root is
**CSS-rotated 90°** (`.game-root.rot90` in `styles.css`, sized to the swapped
viewport). So it's identical to landscape, just quarter-turned to fill the
portrait screen. Two consequences:

- `resize()` measures the table against the **swapped** viewport (`vw`/`vh`) and
  always calls `layoutFor(scale, false)` — the render-side portrait rotation
  (`layout.rotated`) is now unused.
- **Every pointer handler** maps screen coords through `localPoint()`, which
  inverts the 90° rotation so each widget stays in its natural landscape frame.
  Add new pointer input via `localPoint(el, e)`, never raw `getBoundingClientRect`
  math, or it breaks when rotated.

The cue power is a **vertical pull** (drag down = load). The on-table cue is a DOM
`<img>` overlay (`.table-cue`) so it can extend past the canvas edge. Input lives
in `Game.tsx` pointer handlers + these widgets:

- **Aim** — *tap* anywhere on the felt snaps the aim to that point. *Drag* on the
  felt fine-adjusts the aim (rotates about the cue ball at gain < 1, so it moves
  slower than the finger — for precision). Tap vs. drag is the `TAP_PX`
  pointer-travel threshold.
- **Power** — drag the cue widget back (down) and release to strike; pull
  distance = power. The on-table cue mirrors the pull.
- **Spin + cue angle** — the white-ball button opens the `showTune` modal
  (`.pick-modal`) holding the spin pad (draw/follow + english) and the
  cue-elevation widget. The button's dot previews the current english.
- **Ball-in-hand** (after a foul) — *drag* the cue ball to reposition it.

**Join flow** — the root route `/` renders the **Landing** menu (`index.tsx`): a
**New Game** button that mints a random room code and navigates to `/:room`, a
**Load Replay** file button beside it, plus a live **lobby** below. The lobby
polls `GET /rooms` every 3s (`fetchRooms` in `net.ts`) — the server returns every
room holding exactly one socket (a single waiting player), newest first — and
renders a **Join** button per game that navigates straight into it. No
link-sharing needed; opening a shared `origin/<code>` link still works as a
direct entry. Landing on `/:room` you're offered **fullscreen** (`showFsPrompt`)
and land straight on a **solo practice table** (`solo()` is `peerCount <= 1`, so
you can shoot freely, turns ignored). A `.solo-hint` banner shows the copy-link
while waiting.

When a **second** peer joins, the host (**slot 0**) resets to a fresh rack via
`doRematch(0, false)` on the `peer-join` 1→2 transition (guarded so later
spectators don't reset) and syncs it; the joiner adopts it via `hello` →
`need-sync`. The first connector is slot 0 and always **breaks** (`breaker = 0`).

**In-game menu** — the table is always shown; the **hamburger button**
(`.hamburger`, left of the table's top-left corner) opens `showMenu`, a modal
(`.pick-modal.menu-modal`) with three actions: **save replay**, **go
fullscreen**, and **resign**. Resign broadcasts a `resign` Msg and both tables
set `rules.winner` to the opponent; a `.game-over` banner shows the result with a
link back to the Landing menu (there is no in-game *new game* — you rematch by
starting again from `/`). **Load replay** lives on the **Landing** menu: the file
is parsed there, stashed via `setPendingReplay` (`replay.ts`), and the freshly
entered room consumes it on mount (`takePendingReplay` in `Game.onMount`).

## Table collision geometry

All geometry lives in `client/src/physics.ts`. Two exported sources of truth,
both consumed by `render.ts` so the drawn table always matches collision:

- `CUSHION_SEGS` — the cushion polygon faces (rails + jaws) a ball bounces off,
  on the true felt surface.
- `CUSHION_VERTS` — the convex corners (nose/jaw tips + mouth corners) a ball
  rounds; it rebounds off each as a point-circle of radius `R`, so it deflects
  off a corner at whatever angle it arrives.
- `POCKET_LIST` — the pocket hole circles (one circle = pot test AND drawn hole).

Edit the constants below and rebuild; do **not** hand-edit `CUSHION_SEGS`
(it's generated by `buildCushionSegs()`).

### How the cushion polygon is built

You define felt-surface segments for the **top-left quadrant only**; the build
mirrors them across both mid-lines into all four quadrants (so the table is
forced symmetric — asymmetry needs explicit segments outside the mirror loop).
The faces stay on the felt surface; collision insets each by `R` (ball radius)
on the fly (a ball touches the felt when its centre is `R` away). Convex corners
between/at the ends of faces are auto-detected into `CUSHION_VERTS` and rounded
as `R`-circles, which is what gives realistic corner rebounds — there is no
miter fudging the flat faces into each other. Coordinates are world metres;
origin at the cloth corner.

Each face's inward normal auto-orients toward the table centre. A corner **jaw**
runs along the corner diagonal, where that heuristic is degenerate, so jaw
segments carry an explicit `ref` point (the pocket mouth centre) and orient
toward it — that's what makes the two jaws of a corner face each other.

### Parameters

| Const | File loc | Meaning | Effect of ↑ |
|-------|----------|---------|-------------|
| `TABLE` | `{w,h}` | Playfield size (m). | Bigger table |
| `R` | ball radius (m) | 2.25" ball; also the auto-inset applied to every felt face. | — |
| `RAIL_INSET` | pulls every cushion face into the felt (~1 ball diameter). Pockets follow inward via `POCKET_LIST` `shift`. | Smaller playfield |
| `POCKET_DEPTH` | hard outer-wall distance beyond the felt edge; a ball that enters a mouth but misses the hole rattles off it. | Deeper backstop |

**Pocket holes** — in the `POCKET_LIST` builder:

| Const | Meaning | Effect of ↑ |
|-------|---------|-------------|
| `hole` | Hole circle radius. A ball drops when its centre enters the circle. | Easier pots |
| `push` | Recede the hole from the (inset) felt edge. | Hole retreats into pocket |
| `shift` | `push - RAIL_INSET`; moves holes inward with the rails so they stay reachable. Derived — don't set directly. | — |

**Rail noses** — top-left quadrant felt vertices:

| Const | Meaning | Effect of ↑ |
|-------|---------|-------------|
| `LC` | Long-rail (top) nose start, distance in from corner (x). | Wider corner mouth |
| `SC` | Short-rail (left) nose start, distance in from corner (y). | Wider corner mouth |

**Center (side) pocket jaws** — `SIDE_*`:

| Const | Meaning | Effect of ↑ |
|-------|---------|-------------|
| `SIDE_HALF` | Side-pocket mouth half-width at the rail (nose ends at `w/2 ± SIDE_HALF`). | Wider mouth |
| `SIDE_LIP.x` | Absolute world-x of the facing lip. Throat width = `w - 2·SIDE_LIP.x`; raise toward `w/2` for a tighter throat. | Wider throat |
| `SIDE_LIP.depth` | How far the facing lip juts into the felt from the rail. | Longer/deeper jaw |

**Corner pocket jaws** — `JAW_*` (throat sits along the corner diagonal):

| Const | Meaning | Effect of ↑ |
|-------|---------|-------------|
| `JAW_DEPTH` | Distance of the throat centre along the corner diagonal from the corner. | Deeper funnel |
| `JAW_THROAT` | Throat width between the two jaw tips. | Easier pot |

## Rebuild

```sh
cd client
bun run build          # -> client/dist
# or: bun run dev       # Vite HMR
```

## Visual-tune the geometry

`render.ts` `drawDebugOverlay` overlays the live collision geometry on the real
table. `debug-table.ts` is a standalone bundle of it:

```sh
cd client
bun build src/debug-table.ts --outfile <out>.js
# open a page with <canvas id="c"> that loads the bundle
```

Overlay legend:

| Colour | Shows |
|--------|-------|
| Red | Cushion contact surface (the felt face a ball's edge strikes) |
| Salmon tick | Inward normal at each face midpoint (which way it pushes) |
| Purple | Convex-corner `R`-circles (`CUSHION_VERTS`) the ball centre rounds |
| Green | Pocket pot circles (centre inside → ball drops) |
| Orange | Hard outer pocket walls (rattle backstop) |
| Yellow | Per-ball edge (radius `R`) |
| Cyan | Per-ball contact radius (`2R`, where another centre first touches) |

When adding/moving segments, check the salmon ticks point **into** the
playfield (jaw ticks should converge into the pocket mouth) before trusting the
bounce.
