# Plan: cave atmosphere and the avatar's visibility

The river level (`levels/ball.json`, "2. river") wants the look of a misty cave with shafts of daylight coming down through it - a deep cool ambient, a pale key falling in visible beams, dust in the beams, and the far layers dissolving into haze.
The player starts directly under such a shaft.
The concern is the ball: a grey metal sphere in a murky grey-blue cave is a murky grey-blue sphere, and the shaft lights it only at the start.
This plan gives the ball a visibility contract that holds everywhere in the level, and builds the shafts and the mist without a light that hovers over the player (rejected: there is nothing in the world to justify it).

Where a number is given it is a default to be played, not a conclusion.
Read `docs/lighting-and-surfaces.md` and `docs/render3d.md` before touching anything below.

## The verdict

Three pieces, in this order, each played before the next is built:

1. **The avatar is drawn through less air.** The fog the ball and chain take on is scaled down by a renderer constant (`AVATAR_FOG`), so the world hazes with depth and the player stays crisp. This is the largest single win and costs one shader line.
2. **The avatar has its own sky.** A metal is its reflections, so the ball and chain get their own environment map: the level's own sky and ground colours, lifted, with a sun lobe always present. It cannot disagree with the level in hue, only in brightness. It is what lets the river drop the outdoor HDRI it is currently reflecting and go to a proper cave environment without the ball going dead.
3. **A spot light can show its beam.** A `LightObjectData` of kind `spot` gains `beam` and `dust`: a visible cone of lit air along the spot's own aim, range and angle, with drifting motes in it. Nothing new to place, nothing that can disagree with the light: the shaft IS the spot, made visible. The schema already says a spot "is what a shaft of daylight through a grate is".

The mist itself is the fog already authored (`fogAmount`, `fogColor`) plus the beams: a beam is the mist made visible where light crosses it, and that is what the reference picture actually shows.
A scene-wide drifting mist layer is deliberately NOT in this plan - build the three above, play the river, and only then judge whether the air still needs a visible layer of its own.

## What was verified in the tree before writing this

- `surfaceFor` (`render3d/assets.ts` ~2008) CACHES materials by `surfaceKey`, and `dressWithImages` swaps the authored maps into the cached object as they arrive.
  `forgedMetal()` in `ballVisual.ts` and `forgedMetal(FORGED_SMALL)` in `chainVisual.ts` therefore hand back materials SHARED with any level geometry that asks for the same surface and tint.
  Setting `fog` or `envMap` on them directly would leak onto that geometry, and cloning them would freeze the clone in the fallback surface before the images land.
  So the avatar's surface needs its own cache entry (step 1).
- The loaded ball model's materials are shared between balls on a page through `loadMesh` clones, and `shine()` already mutates them once under `userData.shined`.
  The same guard covers the two new properties.
- `MeshStandardMaterial` in three r0.185 has `envMap`, `envMapIntensity` and `envMapRotation` per material; a material with its own `envMap` ignores `scene.environment`.
  Setting `envMap` from null changes the program's defines, so `needsUpdate` must be set when it is assigned.
- `Environment.useEnvMap` (`render3d/environment.ts` ~284) owns the `PMREMGenerator` and the renderer; `equirectEnvironment` (~350) paints the generated sky as a float `DataTexture` from sky, ground, sun colour and sun direction.
  A second sky is one more call to each.
  `Scene3D` rebuilds the environment only when `envKey` changes, and owns both `env` and `ballVisual` (`scene.ts` 153, 231, 251), so it is the place that hands the avatar's map to the ball and the chain rig.
- Fog is one `THREE.FogExp2` on the scene (`environment.ts` ~265) and every lit material includes three's `fog_fragment`, which computes `fogFactor` and mixes `gl_FragColor.rgb` toward `fogColor` by it.
  The chunk is replaceable per material through `onBeforeCompile`, and a material that does so must also set `customProgramCacheKey` or three will hand it another material's program.
- `LightRig.add` (`render3d/lights.ts` ~195) builds the spot at its holder's origin, aims it at a child `target` one `range` along the authored direction (in the holder's frame, so `rot` turns it), and `LightRig.update(clock)` runs every frame from `Scene3D` with the wall clock or the pinned one.
  The beam and its dust hang off the same holder and read the same clock.
- The water spray (`render3d/water.ts` ~1190) is a working `THREE.Points` with a custom shader: point size in metres via `uViewHalfHeight`, `transparent`, `depthWrite: false`, `fog: true`, `frustumCulled = false`, `renderOrder = 11`, animated by `updateWater(clock, viewportHeight)`.
  The dust is the same shape and should be written from it, not beside it.
- `cli shot --3d --probe all` reports every program that failed to link after prewarm; headless cannot otherwise see a shader error (`docs/debugging-rendering.md`).
- The river's environment block today: sun 5 at `#bababa`, sky fill `#828282`, ground `#14181f`, fill 10, env 0.3 from the `golden-gate-hills` HDRI, background `#080a0f`, fog 0.4 at `#2b2e33`.
  It is a neutral grey scheme; the ball reads as metal only because it reflects an outdoor hillside.
- The spawn is `player` at (920, 550) scene px.
  The air above it is open to about y = -300 (the wooden fixtures at x 178-810 sit at y -620..-300); the moss rocks 190-192 lie below at y 718-830.
  A spot 8-9 m above the spawn aimed straight down reaches it with room to spare.
- The editor's light inspector adds a numeric field per light property in one call each (`editor/editor.ts` ~6456 `flicker`, ~6465 `penumbra`), and the format's `visual` round trips are checked by `cli render3d` (`sim/render3dCases.ts`).

## Step 1: the avatar's own surface, through less air

**Format:** none.

**Renderer:**

- `SurfaceRequest` gains `avatar?: boolean`, part of `surfaceKey`, so `forgedMetal()` asks for the same painted steel under a key of its own and gets a material that is still dressed when the images arrive but is shared with nothing else.
  Both `ballVisual.ts` and `chainVisual.ts` (including the manacle) go through it.
- A new module `render3d/avatarSurface.ts` holds the avatar's material rules and applies them to any `MeshStandardMaterial` handed to it: the stand-in sphere and loop, the chain's instanced material, the manacle, and the loaded model's materials inside `shine()`.
  It is the one place that says what the avatar is made of, beside the `MODEL_*` constants.
- `AVATAR_FOG` (start at 0.35): a constant scale on the fog the avatar takes.
  Applied by `onBeforeCompile`, replacing `#include <fog_fragment>` with the same chunk where `fogFactor` is multiplied by the constant before the mix, and a `customProgramCacheKey` that names it.
  0 is three's `fog: false`; 1 is the world's air; the constant exists because binary exemption reads as a cut-out in a thick fog, and the right value is a played one.
  Document it: the ball is drawn through less air than the wall behind it, on purpose, because it is the one thing in the frame the player must never lose.

**Cases (`cli render3d`):** the avatar surface key differs from the plain key for the same request and is stable; the patched fog chunk contains the constant (a string check on the shader source through a stub `onBeforeCompile` call).

**Play:** the river at the current environment, `AVATAR_FOG` at 0.35, then 0 and 0.6, choosing by eye.
The chain must read as one object with the ball at whichever value is kept.

## Step 2: the avatar's own sky

**Format:** none.
The lift is a property of the avatar, not of a level.

**Renderer:**

- `Environment` builds a second generated sky, `avatarSky`, from the SAME sky, ground and sun inputs it already has, through `equirectEnvironment`, with:
  - sky and ground each mixed toward white by `AVATAR_SKY_LIFT` (start 0.45) and `AVATAR_GROUND_LIFT` (start 0.2), so the map is brighter than the level's but cannot disagree with it in hue;
  - the sun lobe ALWAYS on, along the level's sun direction, in the level's sun colour, so a rough metal has a highlight to travel across it even in a level whose sun is off (an underground level has no `DirectionalLight`, but its steel still needs something bright to reflect).
    In a level with no sun and no authored direction, the default sun direction is used.
  - convolved by the same `PMREMGenerator` into its own target, disposed with the other one.
- It is built whether the level names an HDRI or not: the avatar's sky is derived from the colours, never from the capture.
- `Environment` exposes it (`avatarEnvironment: THREE.Texture | null`) and `Scene3D` hands it, at `setEnvironment` and whenever the environment rebuilds, to `ballVisual.setSky(map)` and `chains.setSky(map)`, which set `envMap` and `envMapIntensity` (`AVATAR_ENV_INTENSITY`, start 0.9) on the avatar materials through `avatarSurface.ts` and mark them `needsUpdate`.
  A ball built before the map exists gets it when it arrives; a model that lands after gets it in `shine()`.
- The sticker rule from `docs/lighting-and-surfaces.md` still holds: the lobe is a highlight fixed to the view, not to the ball's rotation.
  Keep `SUN_LOBE_SIZE` as it is and let `MODEL_ROUGHNESS` do the softening; do not sharpen the ball to make the sky show.

**Cases (`cli render3d`):** `equirectEnvironment` is already pure; add a case that the avatar sky's mean is brighter than the level sky's and its hue (per texel, sky row and ground row) is unchanged; a case that a level with `sunIntensity: 0` still produces a lobe in the avatar sky.

**Play:** the river with the HDRI removed from its environment block and a cool generated one in its place (see the authoring step), so the ball is judged against the sky it will actually be reflecting.

## Step 3: the visible beam

**Format** (`level/levelFormat.ts`, `LightObjectData`, spot only, both dimensionless so `scaleLevelData` is untouched):

- `beam?: number` - 0..1, how visible the lit air inside the cone is. Absent = 0, which is every spot authored so far: invisible, exactly as now.
- `dust?: number` - 0..1, how thick the motes drifting in the beam are. Absent = 0.
  Document both beside `flicker` in the same voice: render-only, wall-clock driven, nothing here reaches the sim.

**Renderer** (`render3d/beam.ts`, mounted by `LightRig.add` on the spot's holder when `beam > 0` or `dust > 0`, disposed with the light):

- **The cone.** An open `CylinderGeometry` from a small radius at the source to `range * tan(angle)` at the far end, `range` long, its axis along the authored aim (the same direction the target sits on), drawn with a `ShaderMaterial`:
  - `transparent`, `AdditiveBlending`, `depthWrite: false`, `side: DoubleSide`, `fog: true` (the beam is air and takes the level's haze like anything else), `renderOrder` above the water spray;
  - alpha = `beam` x a radial falloff that goes to zero at the cone's edge with the spot's own `penumbra` as its softness x a length falloff (zero at the source, full by a tenth of the range, easing out toward the far end so the beam dies in the air rather than at a rim) x a silhouette fade (the dot of the view direction with the cone's surface normal, so the cone's own edges never show as lines);
  - rays: a low-frequency noise along the cone's azimuth, drifting slowly with the clock, so the beam is a bundle of soft rays rather than one flat cone.
    Two octaves at most; no grain (`docs/art-style.md`'s rule still stands even with the paint pass gone);
  - colour = the light's colour x the light's current intensity fraction, so a flickering lamp's beam flickers with it;
  - the constants (`BEAM_ALPHA` at `beam = 1`, the fade fractions, the ray count and drift) live in `beam.ts`.
- **The dust.** A `THREE.Points` seeded uniformly inside the cone (in the holder's frame: a random length along the axis, a random radius up to the cone's radius there), count = `dust` x `DUST_PER_METRE` x `range`, capped.
  Each mote drifts slowly (a per-seed velocity of a few cm/s, mostly down, with a sideways wander) and wraps back into the cone.
  Sized in metres (the spray's `uViewHalfHeight` rule), soft-edged, `fog: true`, colour = the light's colour, brightness fading with radial distance from the axis so motes at the beam's edge are dim.
  `LightRig.update(clock)` gains the viewport height as `updateWater` has, and drives both the cone's and the dust's `uTime`.
- The beam is NOT occluded by geometry.
  A shaft that should stop at a floor is authored with a `range` that stops there; the spot's own `castShadow` gives the pool on the floor and the shadow of anything hanging in it.
  Say this in the format comment so an author does not look for a switch.
- Budget: the beam costs one draw and the dust one more, per light that asks; neither adds a light or a shadow pass.
  `LIGHT_BUDGET` is unchanged.

**Editor:** two numeric fields (`beam`, `dust`) in the light inspector beside `flicker`, spot only, 0..1 in 0.05 steps.
The 2D editor view does not draw the cone; the 3D preview shows it.

**Cases (`cli render3d`):** the cone's far radius from `angle` and `range`; the dust seeding stays inside the cone for every seed (a sampled check); `beam`/`dust` survive the editor model round trip; a spot with neither field builds no beam objects at all (the no-regression proof: every existing level draws exactly what it drew).

**Play:** the river's opening shaft (below).

## Authoring the river's opening

After step 3, in `levels/ball.json`, via the editor's own model (or a hand edit that `cli levels` accepts):

- A static body above the spawn, at about (920, -250), with a single `light` object: `kind: "spot"`, aimed straight down (the default), `range` about 10 m, `angle` 7, `penumbra` 0.6, colour a pale warm white (`#f3ecd8`), intensity to taste, `castShadow: true`, `beam` 0.6, `dust` 0.5.
  The pool lands on the spawn, and the ball sits in the beam at frame 0.
- A proposed environment block, to be played against the current one and kept only if it is better:
  sun off (`sunIntensity: 0` - a cave has no sun reaching every surface equally; the shaft is the sun), HDRI removed, sky fill a deep teal-blue (`#3d5a72`) and ground a dark green-black (`#0c1410`) at a fill around 2, env 0.3, background `#070a10`, fog 0.4 at a desaturated blue (`#1f2a36`).
  The reference is a cool ambient with a pale key, not a grey one.
- Every lantern and wooden-fixture spot the river already has keeps `beam` absent.
  Whether a lantern wants a faint beam is a separate judgement made after the shaft is seen.

## What to verify before handing it over

- `bun run test` is green, and every bundle in `playtests/regressions/` still replays: nothing here touches the sim, so a divergence is a mistake.
- `cli shot ball.json --frame 1 --3d --probe all` on the river reports no fresh or failed program: the beam, the dust and the patched avatar fog all compile (headless cannot otherwise see a shader error).
- A `cli shot --3d` of the river's frame 1 before and after each step, kept in the scratchpad with `shot --diff`, so the play can be argued from pictures.
- The docs: a section in `docs/lighting-and-surfaces.md` for the avatar's own surface (why it takes less fog, why it has its own sky, the constants) and one for beams; the two new fields in `docs/level-format.md`'s light table; a line in `rope/CLAUDE.md`'s map only if a new doc file is added.

## Rejected

- **A light carried by the ball.** The strongest visibility guarantee there is, and Ori and Hollow Knight both use it, but nothing in this world emits it, and Tris declined it.
- **A `fog: false` exemption.** The limit case of `AVATAR_FOG`; kept as the value 0 rather than as a separate switch.
- **A separate `shaft` object type.** Every one of the editor's forty light touchpoints again, and a shaft that can drift off its own light. A spot already has a position, an aim, a cone and a reach.
- **Screen-space god rays.** They need the source on screen and a full-screen pass over the frame; the camera never stops panning and the shaft's source is usually above the frame.
- **A scene-wide mist layer.** Deferred, not rejected: the fog and the beams may be the whole of the mist, and a drifting sheet built before that is known is a sheet built twice.
