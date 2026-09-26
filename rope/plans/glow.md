# Plan: glowing mushrooms that wake for the player

The river is becoming a cave lit from inside (see `plans/atmosphere.md`).
The avatar's own sky from that plan was played and rejected: a ball reflecting a brighter sky than the room it is in looks pasted on.
What lights the player instead is the world itself: persistent glowing lichen, and mushrooms that come alight as the player approaches, lighting the ball and the rock around it together.
This plan says how to build the waking light, how to author one in the editor, and how it composes with the light budget and the shader-compile rule.
The mushrooms are purple cubes for now; the textures come later and change nothing below.

Where a number is given it is a default to be played, not a conclusion.
Read `docs/lighting-and-surfaces.md` (Lights, Beams, The avatar's own surface), `docs/render3d.md` and `docs/editor-model.md` before editing.

## The verdict

**A waking light is a light object with a `wake` distance, and the emission of every glowing shape in its body follows it.**

- No new object type.
  The lantern pattern (a glowing geometry object and a light object in one body) is already the format's way of saying "this thing is a source"; a mushroom is that pattern with a light that starts dark.
- The waking is RENDER-SIDE and driven by the wall clock, exactly like flicker and the beams: the renderer reads the ball's position and writes nothing back, so no replay can diverge on it.
- Waking lights do not add THREE lights to the scene one by one.
  They are served by a fixed POOL of point lights that always exist, so the shader's light count never changes while a level is played.

The user-facing knobs, all on the light object:

| field | unit | meaning |
|---|---|---|
| `wake` | metres, scaled on load like `range` | the ball within this distance of the light triggers it; absent = a light that is always on, which is every light authored so far |
| `wakeDelay` | seconds | how long after the trigger the emission starts; absent = 0 |
| `wakeRise` | seconds | how long the emission takes to reach full; absent = `DEFAULT_WAKE_RISE` (0.6) |
| `wakeFall` | seconds | how long it takes to go dark after the ball leaves; absent = `DEFAULT_WAKE_FALL` (1.5) |
| `intensity` | candela, existing | the full brightness it rises to |

Seconds are not lengths and pass through `scaleObject` untouched; `wake` is a length and is scaled beside `range` and `shadowNear`.

## What was verified in the tree before writing this

- `LightRig.add` (`render3d/lights.ts` ~195) builds one THREE light per light object at mount, refuses past `LIGHT_BUDGET` (16) in authored order, and `LightRig.update(seconds, viewportHeight)` runs every frame from `Scene3D.sync` with the wall clock or the pinned one.
  `flick` sets `light.intensity = baseIntensity * level` and passes the same level to the beam; a waking light's level slots into that same multiply.
- Three derives the program defines (`NUM_POINT_LIGHTS` and the rest) from the lights in the scene at render time.
  A light at intensity 0 is still counted; a light removed or hidden changes the count and recompiles every lit material.
  `Scene3D.prewarm` compiles everything under the loading screen against the lights present at `setLevel`, and `cli shot --probe all` reports any program compiled after it.
  A light that comes and goes with the player would be a fresh program on a played frame, which is the stutter class `session-1697f` was.
- The ball's render position is `level.ball.renderPosition(alpha)` (used by `BallVisual.sync`), and `Scene3D.sync` has `level` in hand where it calls `lights.update`.
- Lights are children of their body's visual group, so a light's world position is its holder's `matrixWorld`, which is stale until three's own render walks the tree.
  Reading it before the render needs `holder.updateWorldMatrix(true, false)` first; for a few dozen lights that costs nothing.
- Materials are cached by `surfaceKey` and shared (`render3d/assets.ts` `surfaceFor`), which is why the docs say the light flickers and the emission does not.
  `SurfaceRequest.avatar` is the precedent for a private cache entry that is still dressed when the images arrive.
- A body's geometry objects get their materials in `bodyVisuals.ts` (~180-200), where `emissive`, `emissiveIntensity` and `emissiveTexture` are passed through; a solid surface (`isSolidSurface`) wears its `color` exactly, which is what a purple cube wants.
- The editor's light inspector is `groupNum` fields (`editor/editor.ts` ~6446: `intensity`, `z`, `flicker`, then the spot-only group); `lightItem` in `editor/model.ts` (~1640) is the editor item for a light object, with the reach as its circle; `+ Light` is a tool button at ~2071 that places a body holding only a light.
- The editor reconstructs its `Scene3D` on every model revision and has no ball in it, so a waking light in the editor's 3D view would never wake.
- `Scene3D` has a pinned clock for headless grabs (`pinnedClock`), which the flicker and the water read.
  How `cli shot` advances it across a filmstrip decides whether a waking light can be photographed rising; the implementer must check `pinClock`'s callers before writing the glow's time step.
- The avatar sky from the previous plan touches 21 places across `environment.ts`, `scene.ts`, `ballVisual.ts`, `chainVisual.ts`, `avatarSurface.ts`, `render3dCases.ts` and the docs.
  The sky-orientation fix in `equirectEnvironment` and its case are separate from it and stay.

## Step 0: take the avatar sky out

Remove the avatar's own environment map entirely: `AVATAR_SKY_LIFT`, `AVATAR_GROUND_LIFT`, `avatarSkyInputs`, the second PMREM target and the `avatarEnvironment` getter in `environment.ts`; `setAvatarSky` and `AVATAR_ENV_INTENSITY` in `avatarSurface.ts`; `setSky` and the constructor parameter on `BallVisual` and `ChainLayer`; the hand-off in `scene.ts`; the two cases (the lifted sky's brightness and hue, the lobe with the sun off); the doc section that describes it.
Keep `AVATAR_FOG`, the `avatar` surface key and the fog patch, which were not rejected.
Keep the orientation fix and its case.
Add one line to `docs/lighting-and-surfaces.md` saying the avatar reflects the level's own environment on purpose, and that a private sky was tried on 2026-09-24 and rejected as out of place, so the next person does not build it again.

`bun run test` afterwards must equal the run before it, and `cli shot --probe all` on the river must still report nothing fresh.

## Step 1: the waking law, pure

`render3d/glow.ts`, with no three.js in it, so `cli render3d` can run it.

- `GlowState`: one waking light's life, stepped by `(distance, dt)` and answering a level in 0..1.
  Phases: `dormant` (the ball is outside `wake`), `armed` (inside, the delay running), `rising` (over `wakeRise`, linear from where the level was), `lit`, `falling` (over `wakeFall`, linear toward 0).
- The trigger is the ball's centre within `wake` of the light; the release is the ball beyond `wake * WAKE_HYSTERESIS` (1.15), so a ball resting on the edge does not strobe.
- Leaving during `armed` cancels with nothing emitted.
  Re-entering during `falling` re-arms from the current level with no delay: a mushroom half-dark does not wait to notice you came back.
- `dt` is clamped to `MAX_GLOW_STEP` (0.1 s), so a tab that was in the background does not snap every mushroom in the level to full on the first frame back.
- `wakeRise` of 0 and `wakeFall` of 0 mean instant, and are legal.

**Cases (`cli render3d`, the format section):** the phases in order at fixed dt (a table of levels against time); leaving during the delay emits nothing; hysteresis (a ball parked at `wake * 1.05` after triggering stays lit); re-entry during the fall; the clamp; and `wake` scaled by `scaleObject` while `wakeDelay`, `wakeRise` and `wakeFall` are not.

## Step 2: the pool

`LightRig` gains a pool of `GLOW_POOL` (6) point lights, created at rig construction, parented to the scene in world space, intensity 0, `castShadow` false, and never removed while the level is loaded.

- A light object with `wake` set mounts NO THREE light of its own.
  `LightRig.add` records it as a `GlowSource` (world position from its holder, colour, `intensity`, `range`, the `GlowState`, and the body's driven materials from step 3) and returns the holder as before, so the body visual's ownership and `drop` are unchanged.
  Beams are spot-only and a waking light is point-only, so the two never meet; the editor enforces it (step 4).
- `update(seconds, viewportHeight, ballPosition | null)`: step every source's state against the ball's distance to it (a null ball, which is every non-ball level and the editor, steps nothing).
  Then assign the pool: sources with level above 0, nearest to the ball first, take the pool lights in order; each pool light copies the source's world position, colour and `range`, and sets `intensity = source.intensity * level * flickerLevel`.
  Pool lights past the awake count sit at intensity 0.
  Assignment is stable for equal distances (authored order breaks ties), so two mushrooms the same distance away do not swap lights between frames.
- A level with more awake sources than the pool leaves the furthest dark.
  That is the budget being spent by distance rather than by authored order, which is the right order for a light that only matters near the player.
  Say so in the format comment beside `wake`.
- Shadows: pool lights cast none.
  A point light's shadow is six renders, and a shadow map handed between sources as they swap would flash.
  `castShadow` on a waking light is ignored and the editor greys it out.
- The pool size is per rig, so a level with no waking light at all still carries `GLOW_POOL` dark point lights in its programs.
  The alternative (a pool sized at `setLevel` to the level's waking sources, capped) keeps levels without mushrooms exactly as they are, and is what to build: `poolSize = min(GLOW_POOL, wakingSources)`, fixed at build, since `prewarm` runs after `setLevel`.
  A level with none is bit-for-bit the scene it was.
- `dispose` frees the pool with the rest.

**Cases:** assignment is pure (`assignPool(sources, ballPos, n)`): nearest first, stable ties, dark sources never take a light; a level with no waking source builds a pool of zero; the pool never exceeds `GLOW_POOL`.

## Step 3: the mushroom's own emission

The purple cube must brighten with its light, and its material is shared with every other purple cube unless it is asked not to be.

- `SurfaceRequest.instance?: string`, appended to `surfaceKey` like `avatar`, gives a body its own dressed copy of a surface.
  `bodyVisuals.ts` sets it (to the body's own id) for every geometry object of a body that carries at least one waking light, and only then, so nothing else in the level gains a material.
- The body visual keeps those materials and their authored `emissiveIntensity`, and hands them to the rig's `GlowSource` as its driven set.
  Each frame the rig writes `emissiveIntensity = authored * level` on them (a uniform write, no recompile).
  A body with several waking lights drives its shapes by the greatest level among them.
- A geometry object with no `emissive` in such a body is left alone: the stalk does not glow with the cap.
- `docs/render3d.md`'s "materials are immutable" trap gains this as its second named exception, beside the avatar.

**Cases:** the instance key differs from the plain key and from another body's; a body without a waking light requests no instance key (the no-regression proof for every existing level's material count).

## Step 4: authoring in the editor

- **Fields.** In the light inspector, for point lights only, below `flicker`:
  `wake` (canvas px on screen, metres on disk, like `range`; blank or 0 = always on), `delay s`, `rise s`, `fall s` (0.05 steps, floored at 0).
  For a spot light the fields do not appear, and setting `kind` to spot on a waking light clears `wake` with a notice in the status line.
  `castShadow` is disabled while `wake` is set.
- **The 2D canvas** draws the wake radius as a dashed circle in the light's colour outside the reach circle, so the trigger distance is visible and draggable like the reach (`editor/render.ts` ~332 is where the reach circle is picked).
- **A `+ Glow` tool** beside `+ Light`: one click places a body holding a purple cube and a waking light at the click point.
  The cube is a `geometry` object, primitive `rect` `GLOW_CUBE` (0.3 m) square, `depth` 0.3 m, the solid surface in `GLOW_COLOR` (`#8a3fd6`), `emissive` `GLOW_EMISSIVE` (`#b070ff`), `emissiveIntensity` 2, with a matching collision rect so the ball can roll into it (a mushroom the ball passes through reads as a ghost; the author can delete the collision object for one on a far wall).
  The light is a point light at the cube's centre, `z` default, colour `GLOW_EMISSIVE`, `range` 4 m, `intensity` 6, `wake` 3 m, `wakeDelay` 0.25, `wakeRise` 0.6, `wakeFall` 1.5.
  It is one body, so the outliner shows one row and the whole thing drags together.
  These are editor DEFAULTS in `editor/model.ts`, not format defaults: a light object on disk with `wake` and nothing else gets the renderer's `DEFAULT_WAKE_*`.
- **The editor's 3D preview** shows waking lights AWAKE: `LightRig.previewAwake = true` on the editor's scene pins every source's level to 1 without stepping its state, and the pool serves the nearest to the view centre rather than to a ball.
  An author must be able to see what a mushroom lights before there is anyone to wake it.
- **Round trip.** `EdLight` gains `wake`, `wakeDelay`, `wakeRise`, `wakeFall`; saving writes each only when set and only on a point light.
  The clipboard payload carries them with the light.

**Cases:** the editor save/load round trip of the four fields; a spot light never writes `wake`; the `+ Glow` body's shapes and the light's defaults (a pure `glowBody(pos)` in `model.ts`); `cli levels` accepts the river after step 5.

## Step 5: the river

Place four glow bodies with the tool (or the same JSON by hand) along the route from the spawn, one roughly every screen width at the river's zoom, on the rock the ball rolls past rather than in the air.
Keep the shaft.
Do not place lichen yet: persistent lichen is the same light without `wake`, and its authoring waits on the emissive moss texture.

Whether the ball reads between mushrooms is the play that decides the spacing, `range` and `intensity`, and none of those numbers gets a case.

## What to verify before handing it over

- `bun run test` equals the run before step 0 (the same suites red, the same bundle corpus) and `render3d` is green with the new cases.
- `cli shot --3d --probe all` over a filmstrip of a recorded river run that rolls past a mushroom reports nothing fresh after frame 1: the pool means no program compiles on a played frame.
  If the pinned clock does not advance across the filmstrip, say so and photograph the rise with `previewAwake` instead; do not change how the clock is pinned without reading `shot.ts`.
- A filmstrip that shows a mushroom dark, then lit, then dark again as the ball passes, kept in the scratchpad.
- The docs: a "Waking lights" section in `docs/lighting-and-surfaces.md` (the law, the pool, why by distance, why no shadow, the constants); the four fields in `docs/level-format.md`'s light table; the `+ Glow` tool and the awake preview in `docs/editor.md`; the instance-key exception in `docs/render3d.md`.

## Rejected

- **A THREE light per waking source, switched on and off.** Every switch changes the light count and recompiles every lit material on a played frame.
- **Sim-side waking.** A mushroom's glow has no effect on the ball, so putting it in the sim would only give it a path into replays and the determinism contract.
- **A separate `glow` object type.** Every editor touchpoint for lights again, and a source that could disagree with its own light.
- **Driving emission through the shared material.** Every purple cube in the level would pulse with the nearest one.
- **Shadows from waking lights.** Six renders each, swapped between sources as they wake.
