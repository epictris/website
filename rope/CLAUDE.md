# rope

A 2D grappling-hook character-controller playground. **TypeScript port** of a C#/Godot
prototype (`~/projects/character_controller`), rewritten so it runs in the browser and can
be shared with friends to playtest. The novel part is the rope: it models the rope as a
sequence of **wrap points around scene geometry** (PBD length + friction solver), not as
evenly spaced segments.

## Stack

There is **no game engine dependency**. Godot's physics (CharacterBody2D `MoveAndSlide`,
RigidBody2D dynamics, `PhysicsServer2D` raycasts/shape queries) was reimplemented from
scratch in `src/engine/` so the simulation is self-contained and deterministic.

## Units

The simulation runs in **metres and seconds** (per-frame lengths at the fixed 1/60 step).
Every tuning constant, level coordinate, and stored position/velocity is metres - **never pixels**.
Pixels exist only at the edges: rendering (`render/`) and pointer un-projection (`camera.ts`).

`src/engine/units.ts` holds the single conversion, `PIXELS_PER_METER = 100` (chosen so the ported Godot gravity 980 px/s² reads as 9.8 m/s²), plus `PX = 1 / PIXELS_PER_METER`.
It is applied symmetrically - `÷` on the way in (level import via `scaleLevelData`, input) and `×` on the way out (the render transform is `camera.zoom * PIXELS_PER_METER`; fixed on-screen decoration is written as `<px> * PX`) - so changing it is an invisible reparametrization.
To rescale how large the world appears on screen, change `camera.zoom`; the physics never sees it.

When adding a constant, classify its dimension: lengths/velocities/accelerations scale by `PX` (Coulomb frictions here are per-frame decelerations - **length**, not coefficients); dimensionless coefficients, gains (1/s), angles, and frame counts do not.
`levelData.ts` stays authored in Godot pixels (converted at load); `playtests/*.json` world-coordinate/speed fields are in metres.

## Determinism & correspondence to the C# source

The sim is a **fixed 1/60 timestep**; input is sampled once per physics frame. It is
self-consistent (a recorded input trace replays bit-for-bit — see `cli selftest`) but **not**
bit-compatible with the C# original (float64 vs float32, reimplemented physics). Class and
method names track the C# sources closely to keep the two diffable.

Godot idioms that were collapsed in the port:
- `Vector2` value-type semantics → **immutable** `Vec2` (every op returns a new vector).
- `PhysicsServer2D.BodySetState(Transform/…)` in `Rope` → no-op; the TS `RigidBody2D`
  transform/velocity **is** the authoritative state.
- `Node._PhysicsProcess` ordering → `Level.physicsProcess` runs player+rope, then hooks,
  then `World.integrate` (rigidbody gravity/collision), mirroring Godot's frame order.

Only circles and body-aligned rectangles exist (as in the prototype); collision code
handles just those two shapes.

## Known simplifications (candidates for follow-up)

- `World` rigidbody dynamics are approximate (no full contact manifold / stacking solver);
  the rope drives attached bodies directly, so this mostly affects free-falling debris.
- `SlackSimulation` is fully ported but currently unwired — the C# `Rope` also left its
  `slackSimulation` field unused; the rope renders straight spans.
- `ApplyFrictionImpulse` is ported behaviour-for-behaviour but, as in the C# source, is
  not invoked from `physicsStep` (the call is commented out there too).

## Running

```sh
cd rope
bun install
bun run dev        # http://localhost:3100
```

Controls (match the Godot input map): **R/T** move · **Space** jump · **left-click** fire
hook · **right-click** retract-tug · **C** retract · **S** extend · **1/2** spawn circles ·
**P** download a replayable session bundle ·
Gamepad (standard mapping, merged with keyboard/mouse): **left stick/dpad** move ·
**A** jump · **right stick** aim (rendered crosshair) · **RT** fire · **LT** retract-tug ·
**RB/LB** retract/extend · **X/Y** spawn circles ·
**L** toggle the debug overlay (render-only). It shows ledge-grab markers (green marker +
dashed grab-radius circle = grabbable now, hollow red = candidate rotated out of reach,
grey X = seam-occluded, face ticks colored by floor/wall/ceiling classification) and an
arrow for the surface normal the player is currently touching (grounded/wall surface, or
both ledge faces while hanging/climbing), colored by the same classification.

Pick a level with `?level=NAME` (see `src/level/registry.ts`); `TEST_MOVERS` /
`TEST_WINDMILL` are hand-written mover test levels (sliding platform, windmill).
`LEVEL_2` is the grapple arena (the Godot-extracted scene).

`BALL` is the **default level** (`DEFAULT_LEVEL`), so a bare `/` runs the
**ball & chain controller** — a separate vertical slice
(`classes/ballPlayer.ts`, `level/ballLevel.ts`, `input/ballInput.ts`,
`renderBall`) that shares nothing with the Player state machine. The ball is a
RigidBody2D (rolls via the opt-in `contactFriction` field on RigidBody2D;
default 0 keeps old replays bit-identical). The chain reuses the Rope wrap
solver: its start contact sits on the ball's edge in the ball's local frame, so
it rotates with the ball, winds around it, and applies torque. The chain solve
runs *after* `World.integrate` (see `BallLevel.physicsProcess`), and `Rope`
writes its positional correction straight onto a rigid body — only the grapple
avatar sweeps — so the ball frame ends with `World.depenetrateRigid(ball)`, a
position-only push-out of static geometry. Without it a point-blank anchor on
the far side of a surface hauls the ball a little deeper every frame until it is
buried in the scenery. The chain end is
a `BallHook` — a RigidBody2D projectile that anchors to the first surface it
contacts, flying or dangling.
The throw is a **straight line**: the hook carries `gravityScale = 0` for the
deploy and `BallHook.endFlight()` switches gravity back on the moment the throw
ends, so the shot goes exactly where it was aimed and only then falls. Every
ending calls it — the hook attaching, a bounce off an impermeable (the deflected
remainder does arc), the chain snagging geometry, and the chain running out of
length (so the dangling tip swings instead of hanging in the air).
At the absolute max length
(`BallPlayer.CHAIN_MAX_LENGTH`) an unattached hook becomes the dangling chain
tip: the chain stays deployed at that length (solver-driven swing) until it
touches a surface and anchors, or is released. A deploying chain
that snags scene geometry mid-flight also converts to the dangling tip: while
the hook is in flight the chain is slack (no length solver), so
`BallPlayer.checkChainReach` runs `Rope.detectSceneCatch` each frame — if the
straight span has caught on a body other than the ball itself (ball
self-winding from aiming is not a catch), it keeps the generated wrap node and
freezes the deploy at the wrapped path length, so the chain wraps the corner
and stops paying out. The chain deploys
through the **loop** — a fixed
material point on the rim (top of the ball at rotation 0). Aiming rotates the
ball so the loop faces the aim direction (proportional steering — also while
the chain is out, which winds it around the ball); the shot always leaves
through the loop. A stick-released frame encodes its aim point as the ball's
own position ("not aiming"). Controls (mouse + gamepad + touch, most-recent aim device
wins): mouse move aim / left-click deploy chain; left
stick aim, RB deploy chain, top face button (X on a Pro Controller)
restart; on touch, the bottom-left on-screen joystick aims (deflect past the
deadzone to steer the loop, like the left stick) and the bottom-right circular
DEPLOY button deploys (no touch restart - reload the page).
Deploy is hold-to-keep: releasing it drops the chain. The touch controls only
appear on a coarse primary pointer (`(pointer: coarse)`), so desktop and
mouse-primary touchscreen laptops get none.
The OS cursor is hidden on the ball controller; a black **aim reticle** stands in
for it, drawn by `renderBall` from `BallInputSource.aimPoint()` (the same aim the
FrameInput carries, null when nothing aims).
Every device writes one piece of state, `aimLocal` - the aim point as an offset
from the ball, in metres. A deflected left stick or on-screen joystick writes it
at exactly the chain's reach (`CHAIN_MAX_LENGTH`).
The mouse has two aim modes behind the `MOTION_AIM` setting in `ballInput.ts`
(default **off**, overridable per session with `?motionAim=1` / `?motionAim=0` so
the two can be compared by feel without a rebuild):
- **position** (default): the aim point is the cursor's **screen** position,
  un-projected through the *current* camera every time it is read
  (`currentAimLocal`), unbounded - the reticle is exactly where the pointer is, a
  drawn stand-in for the hidden OS cursor and nothing more.
  Re-deriving it per read rather than freezing it at mousemove time is what keeps
  it there: held as an offset from the ball, a camera pan, ease or zoom slid the
  reticle across the screen with no hand on the mouse - the cursor visibly
  drifting on its own. Motion aim is exempt (the offset *is* the state, and under
  pointer lock there may be no cursor on screen), as are stick and joystick aim,
  which are ball-relative directions by definition.
- **motion**: `aimLocal` accumulates each mousemove's delta (metres at the
  current zoom) and is held within the reach, and clicking the canvas takes
  **pointer lock** (Esc releases it, the next click takes it back) so the cursor
  stays in the window; while locked the delta comes from `movementX/Y`, falling
  back to cursor travel for synthetic events that carry none.
  Clamping a *position* mapping is what this avoids: past the boundary the drawn
  dot would stop while the real cursor kept travelling outward, so moving back
  inward would do nothing until the real cursor re-entered the reach circle, dead
  travel the player cannot see since the cursor is hidden. Integrating motion
  lets the reticle be bounded without that cost.
  The first move (and the first after another device owned aim) seeds `aimLocal`
  from the real cursor position.
The camera zoom scales down on short viewports (height-driven, capped at the
desktop zoom) so a landscape phone still frames the ball and its chain arc.
The page is an installable full-screen web app (`public/manifest.webmanifest`
with `display: fullscreen`, plus `apple-mobile-web-app-*` metas for iOS and
`viewport-fit=cover`): added to a phone's home screen it launches without
browser chrome. Restart routes
through the `jump`
FrameInput field so it stays in the recorded input stream (BallLevel calls
onReset). Ball inputs map onto the existing FrameInput fields
(aim→mouseWorldPosition, shoot→fire, restart→jump), so
recordings serialize and `cli replay`/`cli bundles` work unchanged
(`cli continue` and playtest scripts are not ball-aware yet).

## Headless tooling

```sh
bun run replay selftest                       # determinism + replay round-trip check
bun run src/tools/cli.ts ledges               # generated ledge-grab matrix (speed × angle × negatives)
bun run src/tools/cli.ts play  playtests/grapple-swing.json
bun run src/tools/cli.ts replay session.json  # replay a P-exported bundle, run invariants
bun run src/tools/cli.ts bundles              # replay every bundle in playtests/bundles/
bun run src/tools/cli.ts dump session.json --from 100 --to 200   # digest+input table
bun run src/tools/cli.ts continue session.json --from 500 --hold left --trace t.jsonl
bun run src/tools/cli.ts render session.json --frame 65 --out f65.svg   # SVG snapshot of one frame
bun run src/tools/cli.ts chainpath session.json --from 60 --to 70       # chain wrap-node polyline per frame
bun run src/tools/cli.ts fork session.json --frame 979 --frames 24      # state trace + before/after SVG around a frame
scripts/abtest.sh session.json 979 <oldRef>                             # A/B the current tree vs oldRef from the fork frame
```

Playtest scripts are frame-indexed held-button ranges + mouse aim with asserts
(`reachState`, per-frame `state`/`maxSpeed`/`hasRope`/position bounds). Invariants
checked every frame: NaN, runaway speed, rope-over-length (once anchored),
player-embedded-in-geometry.

## Debugging physics issues

The debugging loop for gameplay/physics bugs (player stuck, frozen input, bad
launches, mover misbehavior):

1. **Capture.** Reproduce in the browser, press **P** — downloads a bundle
   (level id + full input trace + per-frame digests). Recording restarts on
   level reset, so a bundle always replays from frame 0.
2. **Make it red.** Drop the bundle into `playtests/bundles/` (gitignored,
   local corpus) and run `cli bundles`. Every bundle is re-simulated with
   *current* physics and checked against per-frame invariants — the bug should
   show up as violations at the frames where it was felt. If it doesn't,
   the invariants have a blind spot: fix the detector first, then the bug.
   A fix is only "done" when the bundle that reported it goes green.
3. **Locate.** `cli dump bundle.json --from A --to B --every N` prints a
   digest+held-input table (re-simulated, not the recorded digests). Look for
   `vx=0.0` runs under held input, state thrash (Grounded↔Airborne flicker),
   or position drifting against input.
4. **Inspect.** `cli continue bundle.json --from F --hold left --frames 120
   --trace t.jsonl` replays to frame F, then takes over with scripted held
   input (fed through the input deserializer so pressed/released edges are
   correct relative to the recording — do not hand-roll input streams; the
   `InputBuffer`s are edge-triggered and a missed `released` latches a key
   forever). The trace JSONL (`src/engine/physTrace.ts`) has one record per
   `moveAndCollide` contact — collider, `overlap` (depenetration) vs `sweep`,
   normal, mobility, contact-point surface velocity — plus per-frame snapshots
   (state, support body, velocity), state transitions, and ledge-detection
   events (`t:"ledge"` — every grab, and near-miss rejections with a reason:
   wrong-side, below-player, behind-wall, out-of-reach, seam). Grep it: opposite
   normals from the same body in one frame, surface classifications flipping,
   velocity resetting to the collider's `cvel` every frame.
4b. **See it.** For *geometric* bugs (rope/chain clipping through geometry,
   anchoring in mid-air, a hook on the wrong side of a wall) the digest table is
   blind — it only carries the avatar's pos/vel/rope-length, not the chain wrap
   path. `cli render bundle.json --frame N --out f.svg` writes an SVG of the
   whole scene at frame N (bodies, impermeable = dashed steel border, hook-only
   anchors = a grate mesh, areas with
   their glyphs — skulls for a killzone, flow arrows for a force area — chain
   wrap path + wrap-node markers, avatar); convert with `magick f.svg f.png` and
   look.
   `cli chainpath bundle.json --from A --to B` prints the wrap-node polyline per
   frame in px (node count > 2 means the chain caught a corner). Reach for these
   the moment a bug is about position/shape rather than a stuck/velocity number.
5. **Verify.** `cli bundles` green + all playtests + `bun run replay selftest`
   (must stay bit-identical — static-path behavior may never change; mobile
   behavior is gated behind `isMobile`/`isRotating` branches). To confirm a fix
   actually changed the felt behaviour — which plain replay *cannot* show once
   the fix diverges the recorded tail (see Bundle semantics) — use the **A/B
   fork**: `scripts/abtest.sh bundle.json <forkFrame> <oldRef>` replays the
   bundle to `forkFrame` under both the current tree and `oldRef`, then traces
   both past it and diffs. Because the sim is deterministic and a fix only bites
   at the issue frame, both sides reproduce the *same* pre-issue state, so the
   diff (and the two before/after SVGs) is exactly the fix's effect. Pick
   `oldRef` = the commit just before the fix, and `forkFrame` = a frame where old
   and new still agree, just before the issue (if they already diverge there, the
   divergence started earlier — walk `forkFrame` back until the pre-fork lines
   match). The script runs old *physics* with new *tooling* (it copies the
   current `src/tools` + `src/sim` into the old worktree), so `cli fork` need not
   exist in `oldRef`; this holds only while the tooling touches stable physics
   interfaces (`physicsProcess`, body/rope fields) — if a change alters those,
   run the two `cli fork`s by hand.

Key invariant — the **`input-frozen` stuck detector** (`src/sim/trace.ts`):
held direction for 45 frames with a mobile body nearby must produce ≥0.25 m of
displacement along the input, or >0.1 m *against* it (yielding to a mover's
push is displacement, not a freeze — wedge rules). Counts every input-held frame regardless of
state (state thrash must not reset the window); exempt: active rope, ledge
hang/climb, wall-jump startup, and purely static blockers (pressing into a
static wall is legit). Runs inside every playtest, replay, and continue.

Bundle semantics: digest divergence in `cli replay`/`cli bundles` is
**informational, not failure** — a bundle recorded before a physics fix
legitimately diverges from the frame the fix first bites; invariants are the
pass/fail signal.
`replay` distinguishes the two kinds it can see: `bit-identical behaviour (…
float noise)` is a settled body jittering in the last ULP (ignore it), whereas
`drifted @fN (maxDrift=…px)` or `behaviour forked @fN (different state branch)`
is a real path difference — `maxDrift` in the `bundles` line tells a faithful
bundle (≈0px) from a stale one (hundreds of px) at a glance.
Consequence: after a real divergence the re-simulated tail no longer matches
what the user experienced — diagnose via the detector's frame numbers on the
*current* simulation, not the recorded tail, and to check a fix landed at the
felt frame use the **A/B fork** (step 5) rather than reading the diverged tail.

Past root causes worth suspecting again (all found via this loop): absolute
velocity zeroed instead of surface-relative (PROJECT/CEILING cases), locomotion
basis stolen by a mover's corner normal (static-floor preference), separating
depenetration contacts redirecting escape velocity, phantom "hit-from-inside"
sweep normals on thin rotating shapes (guards in `World.moveAndCollide`), and
near-threshold face classification flapping on rotating bodies (grip grace in
`lib/surface.ts`).

## Level editor

The **`/editor`** page (its own HTML page `editor.html` → `src/editorMain.ts`, distinct
from the game at `/`) runs an in-browser level editor (`src/editor/`, its own canvas loop +
DOM overlay). Dev serves `/editor` via a rewrite in `vite.config.ts`; production maps it to
`dist/editor.html` in `serve.ts`; the build emits both pages (`rollupOptions.input`). It
edits an `EdModel` (positions in world **metres**, one
stable id per body) and manipulates it with the mouse: pan (**middle**-button drag, or the
right button), wheel-zoom about the cursor, click-select, drag to move, corner/rotate/
radius handles to resize, and `+Rect`/`+Circle` tools to draw new bodies.
Selection is a **set**: a plain click selects one body, **Shift+click** toggles a body in or out, and dragging any member moves the whole group (the grabbed body leads the snap; the rest keep their offsets).
Dragging from empty space rubber-bands a **rectangle selection** - anything the band touches is caught (a rotated box is tested with SAT, a circle by its nearest point), so it need not enclose a body; **Shift** unions the hits into the current selection instead of replacing it, and a click that never moves clears it.
That is why pan is on the middle button: the left button belongs to the band.
Resize handles only appear for a *single* selection, but the inspector is a **group panel** at
any size: every property the selection has in common is shown and every edit applies to all of
them (position and colour always; `rot°` when each body has a meaningful one, `w`/`h` or
`radius` when they are all the same shape, `force` when they are all force areas, `friction`
when none of them is an area or an anchor).
A property the bodies disagree on shows blank with a `mixed` placeholder and only writes once
something is typed into it; the kind picker gains a `mixed` entry for the same reason.
Selected bodies draw an orange halo *under* their own border,
so an impermeable's dashed steel edge stays legible while selected.
**Ctrl+C / Ctrl+V** copy the selection and paste it at the cursor: the clipboard holds copies
detached from the model, and paste re-centres the group's bounding box on the pointer (with
snap on, its top-left corner lands on the grid), leaving the new bodies selected so it can be
repeated. `Ctrl+D` duplicates in place at a 2-cell offset.
**Arrow keys** nudge the whole selection one grid cell (10 cm), or 1 cm with **Ctrl** held; the
nudge is a pure translation (never snapped), so a body keeps any sub-cell offset it has and the
fine step still works with snap on. A run of nudges collapses into one undo step, ending when the
key is released. The kind picker
covers `static`, `rigid`, `killzone`, `impermeable`, `anchor`, `force`.
Every body that can be stood on carries a **surface friction** (0 = ice, 1 = rubber; see below), and a
`force` area carries a signed **force** magnitude aimed by its own `rot°` - so the rotate
knob steers the current, and force-kind circles get that knob too (a plain circle's rotation
is invisible, so it has none). A toggleable snap (fixed 10 cm, the
backdrop's minor-grid spacing) keeps geometry aligned - **moves** snap the body's top-left
corner, and **corner-resize** anchors the opposite corner (grows toward the drag). Each body
**Undo/redo** (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y) keeps 50 model snapshots - one step per
discrete action (each drag, add/delete/duplicate, kind/colour/opacity/numeric edit); New and
Load clear the stack. Each body has an editable **colour + opacity** (inspector); defaults to
dark grey `#555555` at 0.5,
borders always drawn fully opaque in the same colour (`DEFAULT_BODY_COLOR`/`_OPACITY` in
`levelFormat.ts`, carried on the engine body as `fillColor`/`fillOpacity`, rendered the same
way in editor and game via `src/render/color.ts`). Both the editor and the game render
on the shared `src/render/trainingGrid.ts` backdrop (Smash training-mode graph paper).
`▶ Test Grapple` / `▶ Test Ball` build a real `Level`/`BallLevel` from
the current model and run it inline (with the real camera, so a camera region is felt exactly as it will play); **Esc** returns to editing.

### Layers

The model is a flat list of `EdItem`s, each carrying a **`layer`**: `geometry` (the scene bodies) and `camera` (the camera-behaviour volumes, see **Camera** below); background images are the next one to land here.
Only the **active** layer is hit-testable and drawn into — the others render at 40% opacity as context and are click-through — because a camera region blankets the geometry it governs, so a click has to mean one or the other and the layer switch is what says which.
The toolbar's layer row picks it (**Tab** cycles) and carries a visibility toggle each; hiding the active layer moves the edit focus off it rather than leaving an invisible edit target.
A selection therefore never spans layers, which is what lets the inspector pick one layer's panel instead of reconciling a mixed one, and a paste switches the active layer to the clipboard's rather than dropping items somewhere unclickable.

The camera panel carries `off x`/`off y`, `view ×`, `lock x`/`lock y`, `blend s` and `priority`.
A lock is a checkbox plus a value: ticking it seeds the lock from the region's own centre (the sane start for "frame this room"), unticking shows `follow`; a blank `blend s` means the controller default.
A region draws as a dashed violet volume labelled with what it does (`cam · off 0,-250 · view ×1.8 · lock xy`), and a locked axis draws a gold guide — a line across the region for one axis, a crosshair at the pinned point for both.

One item type rather than a union per layer is deliberate: a camera region is drawn, picked, dragged, resized, rotated, rubber-banded, duplicated and undone exactly like a body, and one type means those paths cannot drift apart per layer.
The cost is that an item carries the fields of every layer; `toLevelData` splits the list by layer and writes only the fields that layer gives meaning to, so nothing inapplicable reaches disk.

Levels save/load to `rope/levels/*.json` in the **on-disk pixel `LevelData` format**
(same as generated `levelData.ts`), through a **dev-only REST API** (`GET/PUT/DELETE
/api/levels[/<name>]`) added by the `levelApi` Vite plugin in `vite.config.ts`. The built
app has no server, so the editor is a dev tool.

Saving is **automatic** once the model has a name: every edit (including undo/redo) schedules a write 750 ms later, so a drag or a run of nudges collapses into one save, and a pending write is flushed on `pagehide` with a `keepalive` request.
An *unnamed* model never autosaves - the first Save/Save As names the file, and everything after that persists on its own; the title's `*` is therefore a brief in-flight marker, not a standing warning, and an autosave failure shows as `SAVE FAILED` there rather than an alert (a modal mid-drag is worse than the loss it reports).
New/Load/Delete each cancel a queued write, so it can never land on the wrong name or resurrect a deleted file.

Autosave must not reload the page, and by default it would: `levels/ball.json` is *imported* by `registry.ts`, so writing it invalidates a real module and Vite full-reloads every open page - including the editor doing the writing.
So `levelApi` implements `handleHotUpdate` and returns `[]` for anything under `levels/`, dropping those files out of HMR entirely (a level is only read at page load anyway; reload by hand to pick one up), and its `PUT` skips writes whose bytes are unchanged so a redundant autosave never even touches the watcher.

A saved level ships in the build by being **imported** into `src/level/registry.ts`
(`resolveJsonModule`; JSON widens string literals, so the spec casts to `LevelData`). That
is how `levels/ball.json` backs the `BALL` entry: one file, edited in the editor and bundled
into production, rather than a hand-copied TS duplicate.

The canonical, hand-editable schema now lives in `src/level/levelFormat.ts` (superset of
the generated one — adds the `rigid`, `anchor` and `force` kinds, plus the `cameraRegions`
list); `levelData.ts` stays
auto-generated and is structurally assignable to it. Both level drivers construct geometry
through the shared `src/level/buildBodies.ts` (statics, killzones, impermeables, anchors,
force areas, and rigid bodies), so the grapple and ball controllers load identical scenes.
`rigid` bodies get mass/inertia from `ShapeGeometry` and fall under gravity.

## Camera

`render/cameraController.ts` owns the view: an **eased follow** of the avatar, reshaped by the level's **camera regions**.
It is deliberately render-side, driven by the wall-clock frame `dt` rather than the fixed timestep, so easing it can never change a recorded run.
(The grapple controller un-projects the cursor through the camera, so the camera does reach the sim as *input* — but the trace records the resulting world point, so replays stay bit-identical.)
`camera.zoom` is the controller's **output**; the base framing scale lives in the caller (`GRAPPLE_ZOOM`, or `ballZoom(viewportHeight)` for the ball, re-derived on resize).
The default framing puts the avatar **dead centre** for both controllers — the ball's old 3/5-down shift is gone — so shifting the view is a camera region's `offsetX`/`offsetY` and nothing else, one authored mechanism rather than a per-controller rule.

Two smoothings run at deliberately different timescales:

- **Follow lag** (`CAMERA_FOLLOW_TAU`, 0.15 s) — an exponential ease of the camera toward its target, `1 - exp(-dt/tau)` so a 60 Hz and a 144 Hz display behave identically. This is the "not rigidly locked to the player" part.
- **Region cross-fade** (`CAMERA_BLEND_TIME`, 0.7 s, per-region `blend` override) — a smoothstep between the *targets* of the outgoing and incoming regions. Both targets are evaluated live every frame, so the avatar keeps being tracked through a transition instead of the camera dragging from a stale point.

One mechanism therefore covers default→region, region→region and region→default: "no region" is just the null region, whose target is the plain follow point.
An interrupted cross-fade restarts from the region it was heading to, so the *target* can jump by the unfinished remainder — the follow ease low-passes it, so the camera itself stays continuous.
`CameraController.snap()` drops the easing for one frame (level start and reset), where easing in from the last frame's position would be a swoop across the level.

### Render interpolation

The sim is a fixed 60 Hz, so drawing its raw state on a 120/144 Hz display repeats and skips frames, which reads as jitter - most visible on the ball at the end of a fast swing.
Every rendered frame therefore draws **between** two sim states: `World.captureRenderTransforms()` runs at the top of each level's `physicsProcess` (before anything moves), and the renderer takes an `alpha` = leftover accumulator ÷ step, clamped to 1 so a frame that hit `MAX_STEPS_PER_FRAME` never extrapolates past the current state.
`CollisionObject2D.renderPosition/renderRotation/renderShape(alpha)` are the whole interface; rotation interpolates the short way round (`wrapAngle`) so a body crossing ±π does not unwind a full turn.
The captured transform is **render-only state the sim never reads**, which is what makes this safe: `replay selftest` stays bit-identical.

Derived geometry follows the same rule rather than being lerped as a shape:

- The rope/chain is drawn from its wrap **nodes**, not the resolved spans. A node is a point in its body's local frame (`RopeContact.renderGlobalPosition`), so re-resolving it against the render transform keeps the chain welded to the drawn ball and the drawn hook — resolved spans would leave it visibly detached between steps.
- The player rig stores its limbs as offsets from the player, so interpolating the whole rig is interpolating one anchor point (`lastP`).
- The ball's loop (and the chain leaving it) comes from `renderLoopCenter/renderLoopDirection`, the same derivation against the interpolated pose.
- The camera follows `cameraRenderPosition(alpha)`, not the raw sim position: tracking the 60 Hz position while the avatar draws interpolated would put the jitter straight back, on screen.

The debug overlay (L) deliberately keeps drawing the **exact** sim state — it exists to show what the simulation believes, so a frame of render smoothing has no business in it.

A **camera region** (`CameraRegionData` in `levelFormat.ts`, its own `cameraRegions` list rather than a `BodyKind`, since it has no collision and nothing may wrap it) computes the target per axis:

```
target.x = lockX ?? (avatar.x + offsetX)
target.y = lockY ?? (avatar.y + offsetY)
zoom     = baseZoom / viewportScale
```

Per-axis locking is what makes one primitive cover all three asks: both axes locked is a fixed camera, one axis locked is a shaft or corridor that pins one and follows the other, neither locked is an offset follow.
`offsetX/offsetY` only apply to the axes that still follow, and `viewportScale` is *how much world is on screen* (2 = twice as much, zoomed out), so it divides the zoom and blends geometrically — 1→4 passes through 2, not 2.5.
The containing region with the highest `priority` wins (later in the list breaks a tie), and the region in force keeps its grip until the avatar leaves it by `REGION_EXIT_MARGIN` (15 cm) — without that hysteresis, hovering on a boundary re-triggers the cross-fade every frame and the camera stutters.
Regions are invisible in play, so the **debug overlay** (L) draws every volume and fills the active one: a camera that offsets, zooms or pins otherwise has no on-screen cause.

## Hook-only anchor geometry

An **`anchor`** body is an `AnchorBody` (`engine/body.ts`) — the exact mirror image of
`impermeable`. The hook attaches to it, but **nothing collides with it**: the avatar, the
ball, loose debris and the rope/chain all pass straight through. It is what background
scenery you can swing from is made of — a metal grate, a girder, a chandelier — geometry
that must not block the level it decorates.

Three mechanisms keep it out of the sim, none of them a per-call-site special case:

- It extends `PhysicsBody2D` **directly** rather than `StaticBody2D`. Every collision path
  in `World` (`moveAndCollide`, `resolveDynamicCollisions`) is written as an allowlist of
  `StaticBody2D | RigidBody2D`, so an anchor is excluded by construction.
- It sits on its own collision layer (`LAYER_ANCHOR`). Every existing raycast asks for
  `LAYER_SOLID`, so they all miss it; the grapple `Hook` is the one query that asks for
  both, which is exactly what makes it attachable. `BallHook`'s swept/probe contact names
  `AnchorBody` explicitly for the same reason.
- `buildLevelBodies` adds it to the world but keeps it **out of the returned wrap list**, so
  a passing span has nothing to catch on, and `Rope` itself refuses to wrap a body whose
  `isSolid` is false (the `isPassThrough` gate in `regeneratePath` *and* in both
  self-intersection resolvers).
  The second half is not redundant: the wrap list is only the *scan* list, whereas the
  self-intersection resolvers wrap whatever a rope node is **already attached to**, list or
  no list.
  Since the hook's whole purpose is to attach to an anchor, that path is reached on every
  anchored chain — without the gate the chain bent around the grate it was hooked to, which
  is precisely the collision anchors exist to avoid.

Queries that scan bodies generically (ledge detection, the debug overlay) filter on
`PhysicsBody2D.isSolid`, which is false only for anchors — a grate corner is not a ledge.
Anchors carry no surface friction (nothing rests on them) and are drawn first, behind the
solid geometry they sit among, in both renderers and the SVG snapshot.

## Force areas and surface friction

A **`force`** body is a `ForceArea` (`engine/body.ts`, an `Area2D`): a region that
accelerates every velocity-carrying body inside it — the grapple avatar and hook
(`CharacterBody2D`), the ball, its hook and loose debris (`RigidBody2D`). `World.integrate`
applies it before gravity, so a body entering is carried on its first frame inside. The
direction is the area's **own rotation** (local +X, so `rot` 0 flows right) and `force` is a
signed magnitude in px/s² on disk, m/s² in the sim — negative reverses the flow. It is
deliberately an *acceleration*, not a true force: a current carries light and heavy bodies
alike, so one authored number behaves the same for the avatar, a pebble and a boulder. Areas
are not wrap bodies; the rope passes straight through.

**`friction`** (0 = ice, 1 = rubber, default 1) is a property of every non-area body,
carried on the engine body as `CollisionObject2D.surfaceFriction`. It scales the contact
friction terms another body applies *against* it: `GROUND_FRICTION` in `GroundedState`,
`WALL_FRICTION` in `OnWallState`, and a rigidbody's Coulomb `contactFriction`, stiction
`staticFriction` and `contactDamp` in `World.resolveRigidCircle`. Every scaling is a plain
multiply so the default 1 multiplies by *exactly* 1 and is bit-identical to the historical
constants (recorded replays predate the field) — `contactDamp` is the one exception, since
`1 - (1 - 0.98) * 1` does not round back to `0.98`, so it takes an explicit `grip === 1`
branch. Locomotion *acceleration* is untouched: friction models how a surface slows you,
not how hard you can push off it.

A river is the two composed: a `force` area over a low-`friction` bed. On a default rubber
bed the ground friction (≈7 m/s² of deceleration) swamps a 3 m/s² current and the avatar
barely drifts; drop the bed to ~0.15 and the same current carries it.

### Area glyphs

Anything the player passes through must never be mistakable for solid geometry in a still
frame — see **"Pass-through geometry must read as pass-through"** in `docs/game-design.md`
for the rule and its rationale. Each such type is stamped with a glyph naming what it does:
`killzone` → **skulls**, `force` → **flow arrows**, `anchor` → a **grate mesh**.

`render/areaGlyphs.ts` holds the glyph geometry as plain closed polygons emitted into an
abstract `PolyPath` sink, so the game canvas, the level editor and the headless SVG snapshot
stamp identical marks from one source (`CanvasRenderingContext2D` satisfies the sink as-is;
`svgFrame.ts` has a small writer that turns it into path data). `render/areaFill.ts` wraps it
for canvas as `fillForceArea` / `fillKillZone` / `fillAnchor`.

The fill is one **even-odd** path — outline plus glyph polygons, clipped to the outline — so
glyphs are **cutouts** showing whatever is behind, legible against any authored colour
including an opaque one. Nested rings flip back to solid under the same rule, which is what
gives the skull its eye sockets. Glyph size *and* lattice spacing are fixed world constants,
so a long river and a small vent read as the same current and only the glyph *count* grows
with the box (a cap thins the lattice on huge areas; glyphs keep their size). Discs get an odd
row count so one row lies on the widest chord. Force arrows drift along the flow at a speed
proportional to the magnitude (clamped), driven by the wall clock — decoration that can never
reach the fixed-step sim; killzone skulls are static, since a killzone does not flow. The SVG
snapshot pins the phase at 0 so a frame render never depends on the wall clock. An anchor's
grate is the same machinery on a much finer pitch (7 cm holes on a 10 cm lattice, so 3 cm
bars) and static —
its holes are literally holes, so the backdrop shows through the body.

## Regenerating level geometry

`levelData.ts` is generated from the prototype's Godot scene; do not hand-edit it:

```sh
bun scripts/extract-level.ts <path-to>.tscn src/level/levelData.ts
```
