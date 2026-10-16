# The glass ball (Hard)

The menu offers two difficulties, and a difficulty is a ball: **Normal** is the iron ball and **Hard** is a glass one (`?ball=glass`, Tris 2026-10-16).
The glass ball is the iron ball in every number the sim reads - mass, radius, loop, chain, winch - except that it **breaks on the first solid thing it touches**.
Water does not break it; the bed under the water does.
The hook and the chain touch whatever they like: it is only the ball that is fragile.

`ball.json` opens with a five-metre drop onto rock, and that is deliberate (Tris: "I want the ball to break on opening, unless the player grabs the vine next to spawn").
A throw at the vine to the right of the spawn between frames 35 and 45 of the fall catches it; anything else lands and breaks on frame 60.

## What a touch is

`BallLevel.shatterIfStruck`, at the end of `physicsProcess`, after every phase that moves the ball and after the breakables:

- **a contact that pushed** - any `world.frameContacts` entry on the ball with `maxNormalImpulse > 0`: it pushed at some point of the frame's solve. That is a landing, a graze, a crate knocked into it, and the speculative contact that stops a ball arriving within the slop before it ever overlaps. A speculative contact that pushed nothing is the ball passing close, and is not one.
  It is the MOST the contact pushed in any one solve, not its total (`normalImpulse`), because a ball whose chain is on a tied body (a span vine, a bridge) is a body of that island, and its contacts are solved in the island's substeps (`TieSolver`), where a push the biased pass made and the relax took back moved the ball and sums to nothing.
  `session-198f` f129: the ball, swinging on a span vine, struck the bed at 1.8 m/s and the chain went taut in the same frame; the bed pushed 89.7 N·s in one early substep, the ball was leaving it by the last, and the island then wrote back only the last substep's impulse, 0, so the ball bounced off whole (committed as `playtests/regressions/session-198f-glass-graze`, which `glass-intact` fails at f129 with the break blind to it). The island now writes back the frame's total as well ([scene-chains](scene-chains.md)).
  The world's own solve is one pass, so there the two are the same number.
- **a push-out** - a surface the chain phase hauled the ball into and then pushed it back out of (`ballPushes`: the leading depenetration and the chain phase's `pushedOutOf`, real pushes only). The contact solve never sees those.

What is NOT solid is everything the solver never pairs the ball with, which is exactly the list the request makes: water and every other area (a region, not a body), vines (non-solid links), and the ball's own hook (a collision exception).

A level already **finished** is not broken by what the ball meets on its way out of the gate: the run is over, and the linger is the page's presentation of that.

Everything is behind `BallPlayer.glass`: an iron ball runs none of it, collects no push-outs, and digests exactly what it always did.

## After it breaks: the respawn

`SHATTER_RESPAWN_FRAMES` (120, two seconds) after the break, a **fresh ball is put at the spawn, in the same level** (`BallLevel.respawn`, Tris: "don't reload the whole page when the glass ball shatters, just respawn the player at the beginning after a couple of seconds").
Nothing is rebuilt - not the world, not the 3D scene - and everything else in the level stays as the attempt left it.
A rebuild is what a kill zone's reset is, and after a break, which Hard asks the player to suffer over and over, it read as the page reloading.

- **A fresh `BallPlayer`, not the broken one put back**, so no state of it carries over: its loop ride, its aim, its wind stall, and the collision layer `passable` moved it to (the ball's own is `LAYER_PLAYER`, which `passable = false` would not restore). The old ball leaves the world and the new one takes its slot in the level's body list; `ball` is the one field that changes, and the renderers follow it: the `BallVisual` already drawn is handed the new ball (`BallVisual.follow`) and nothing is rebuilt. Rebuilding it disposed the glass materials, which released their programs (nothing else draws with them), so every respawn frame compiled the lens shader again - the hitch Tris reported 2026-10-16, seen as two fresh programs on the respawn frame by `cli shot --probe` and none after.
- **First thing in the frame**, before anything reads the ball's start-of-frame pose: the swept finish and the render snapshot see the new ball rather than one that jumped from the break to the spawn.
- **A spawn that hangs hangs again** (`hangAtSpawn`, shared with the build). The level's openings - a roll, a recorded arrival - are not replayed: they are the level's, played once.
- **The camera snaps** with it (`main.ts` compares `level.attempt` across a step), rather than easing the length of the level.
- **The run carries on.** The respawn is a sim event on a frame of the run, so a replay respawns on the same frame and the recorder's run simply continues through it. A finish is timed from the start of the attempt that made it (`attemptStartFrame`).
- A jump press still restarts the whole level, as everywhere.

Until the respawn the broken ball stays in the world - every phase takes the ball as given and the camera reads it - but **inert**: `passable` (it collides with nothing), its chain released, its input replaced by "not aiming, not throwing", and its pose put back every frame (`holdShattered`).
So the world carries on around it (`glass-respawn` watches a crate keep falling) and the camera holds on the place it broke.
A broken ball cannot finish a level (`finish` refuses), and neither the ball nor its glass cuff strikes sparks (`reportSpark` returns early for a glass ball - glass breaks, it does not spark).

## Detectors

- `WorldDigest.shattered` - written only for a glass ball, under `finished`'s rule: absent on both sides compares equal (every iron run, every bundle from before), present on one alone is a different ball, broken in one run only is a different run.
- `Recording.ball` / `SessionMeta.ball` / `RunRow.ball` / `FeedbackSubmission.ball` - `"glass"` or absent. The level file cannot say which ball a run was played with, so a glass run replayed without the field is an iron run, which `glass-replay` proves diverges.
- Invariants (`checkGlassBall` in `sim/trace.ts`), tracked per BALL so a respawn's new ball starts clean: `glass-iron` (an iron ball broke), `glass-intact` (a whole glass ball ended a frame with a contact that pushed on it, by `maxNormalImpulse` - a touch the break never heard about), `glass-once` (the break moved, cleared, or the ball mended), `glass-held` (a broken ball moved, is still solid, still carries its chain, or something is in contact with it).
- `cli glass` (`sim/glassCases.ts`, in `bun run test`): lands, water, hook, iron (bit-identical to iron until the break), respawn, finished, replay (through a respawn). Disabling the break turns five of the seven red, with `glass-intact` firing on every landing.
- `cli render3d`'s `glass:` cases run every rewrite of three's shaders on three's own physical shader and check what came out: a three upgrade that rewords a line fails there rather than drawing black plastic.

## What it looks like

The ball is **hollow quartz**, a shell with a wall of a set thickness (see "The hollow ball"); its loop, its links and its manacle are **solid glass**; its broken pieces are seen through (see "The shards").
`render3d/glassMaterial.ts` has the reasoning in full.

**Solid glass is a lens, traced, seeing the room through the reflection probe.**
A solid sphere is a ball lens: the room behind it is seen through it upside down and shrunk, and that is what makes it read as an object.
Each fragment's view ray is refracted in (n = 1.544, quartz), carried across the sphere's chord, refracted out (a sphere never traps a ray past the critical angle), and the light arriving along the exit direction is read from the **ball's reflection probe** - the cube of the room the ball already draws one face a frame for its reflection, with the ball and chain left out.
For the ball that is the exact picture: every exit ray starts inside the sphere the probe sits at the centre of.
Both surfaces' Fresnel losses come off what comes through, and the front surface's reflection is three's specular, lit from the same probe.
The loop, the links and the cuff are round bar, traced the same way with the bar's radius (exact across the bar, near enough along it); they see the room from the ball's centre, which a sliver a few pixels wide cannot show.
Absorption is in the trace (`GLASS_ABSORPTION`, Beer-Lambert over the chord) and is zero: clear glass. `?glasstint=0.4,3,11` is amber, for comparing (temporary).
**The probe sees 40 m for a glass ball** (`glassProbeFar`; 5 m, `PROBE_FAR`, for iron): what fills a crystal ball is the room behind it, and at 5 m that was mostly the sky colour, a flat pale disc that read as frosted glass (Tris: "make the glass more transparent").
It costs one probe face a frame of a farther scene: +0.03 ms of GPU a frame at 4K on the RTX 4070 SUPER (`cli shot --3d --gl angle --query "bench=256&benchprobe=1&scale=2"`, run with NVIDIA's offload variables so headless Chrome takes the 4070 rather than the integrated GPU).

**It is an aurora crystal ball** (Tris, 2026-10-16, from a reference photo: "the most important part is the rainbow gradient inside it"): clear crystal with a film a few hundred nanometres thick on it (`COAT_IOR` 1.94, `COAT_THICKNESS_NM` 142-332, render3d/glassCoat.ts).
It was titania (2.3, 120-280 nm) until Tris asked to "tone down the aurora effect - maybe 50%": a quarter-wave film reflects ((n_glass - n_film^2) / (n_glass + n_film^2))^2 at its strongest, 30% for titania against bare quartz's 4.6%, and a 1.94 film (silicon nitride, zirconia) peaks at 17.5%, half the rise; at the same optical thickness the bands keep their colours.
Interference in the film makes each surface reflect some wavelengths strongly and pass the rest, and the film thins from one pole of the ball to the other (`coatAt`, along the piece's own +y so the bands roll with it), so its colours run in bands across the ball through one interference order: orange, magenta, purple, blue, green, yellow.
Every surface the trace crosses takes its Fresnel from the film where the ray crosses it (three's `evalIridescence`, the Belcour-Barla thin-film model, which also lights the front reflection through `iridescence: 1`); the gradient seen inside is the film on the far side, through the lens.
A lossless film reflects the same share from either side, so the inside reflections use the same function at the outside angle.
**Off for now** (Tris, 2026-10-16: "remove the coating temporarily"): `glassCoatShown` is false, so the materials take `iridescence: 0`, three compiles no `evalIridescence`, and `filmFresnel` is bare quartz's Schlick on every surface - the ball, the chain and the pieces; `?glasscoat=1` puts the film back.
**It glows** (Tris: "a slight glow. That doesn't need to be realistic because it's a magic crystal ball"), and lights the world ("make it emit actual light (using a scene light)").
The glow is a warm yellow, `BALL_GLOW` 0xffc857, both the emission and the light (Tris, 2026-10-16: "glow a warm yellow, not purple"; it was 0xdcd8ff, a lavender white). At this strength the shift is subtle: the core of the ball at f100 of `session-198f` went from (69, 100, 126) to (74, 99, 118) sRGB, and the rock below it did not change on average.
The world's light is a point light at the ball's centre (`Scene3D.ballGlow`, `BALL_GLOW_INTENSITY` 0.35 cd, `BALL_GLOW_RANGE` 2.5 m, no shadow), built with ANY level that has a ball and only turned up or down - dark for an iron or a broken ball - because three compiles every lit program against the number of lights, and a dark light is skipped wherever it is shaded (`lightReach.ts`).
The glass's own lens lights skip a point light inside the glass (`seeEachLight`): unguarded, the lens drew the ball's own light as a lamp seen through it, a white point at the centre and a white ring at the rim.
The ball itself shows the glow as a faint emission through its volume (`BALL_GLOW_RADIANCE` 0.025 through the centre; 0.08 read as "fogginess"), which leaves through the film like any other light, so the film colours it.
The colours are only as rich as the light: the photo's ball sits on white, and the river cave's light is nearly all blue, so there the film shows as a teal-to-green shift and coloured lamp highlights rather than the full rainbow (open, 2026-10-16).
And one film is weaker than the photo even in the photo's light: rendered on a white sweep with a white key (a scratch studio harness), it is a faint pastel tint, where the photo's ball is strongly banded - its coating reflects far more than a single titania layer can (a multi-layer, dichroic-style stack would).

**Rejected: three's transmission**, the solid ball's first version.
A transmissive material makes three re-render the whole opaque scene into a full-size target every frame, mipmap it, and again inside every other render that sees it (the pool's mirror): "massive performance drops while the glass ball is active".
Read from the probe instead, the glass ball costs what the iron one does - 6.1 ms against 5.95 ms of GPU a frame on the river spawn, measured in Chrome.

### The hollow ball

Tris, 2026-10-16: "I want the crystal ball to have thin walls instead of being solid. I want to be able to configure the thickness of the wall", "make sure the inside wall of the orb is rendered as well", and "the chain and manacle should still be solid glass, not hollow".

**The wall** is `GLASS_WALL` in `render3d/glassWall.ts`: 6 mm on a ball 24 cm across, a hand-blown sphere's.
`?glasswall=<mm>` sets it for a visit (`?glasswall=25`, `?glasswall=solid`); a wall as thick as the radius or more is the solid ball above.
It sets both the look (the inner radius, a uniform) and how the ball breaks (shards of the wall).

**Traced through all four surfaces** (`hollowGlassMaterial`, one opaque draw): the outer one coated with the film, the inner one bare quartz, air in the middle.
Quartz keeps n x (impact parameter) the same across concentric spheres, which is the whole look:
- inside the hollow's own outline, a ray crosses wall, air and far wall; each wall is a concentric meniscus, a weak diverging lens, so what is behind the ball is seen a little smaller, bent hard and split into colour toward the hollow's edge, where the ray grazes the inner surface;
- outside it, the ray meets the inner surface past the critical angle or misses it, stays in the wall and comes out bent as through solid glass: the rim is a band of solid quartz exactly the wall's thickness wide in the projected radius.

Paths: A straight through (per channel, dispersion), B reflected once off the far side's film (per channel, the aurora inside), C off the far wall's bare inner surface, D off the near wall's bare inner surface (the second, fainter reflection thick glass shows); C and D in green only.

**What it sees behind it is the frame**, not the probe, wherever path A crosses the hollow: it leaves the ball close to where it was going, and the probe holds a few texels across that whole view (drawn from the probe, the middle was a blur).
A patch of the frame round the ball, colour and depth, is copied out the moment before the ball is drawn (`render3d/frameCopy.ts`, the mesh's `onBeforeRender`: one blit, resolving the samples), and the leaving ray is walked to the depth the frame holds there (two steps of a secant search).
A multisample resolve blit in WebGL 2 must use identical source and destination rectangles, so the copy is the frame's size and only the patch is written (copied to the origin, it failed with INVALID_OPERATION wherever the ball was not in the frame's corner, and the ball showed a black square).
The frame is tone mapped and sRGB, so it is decoded (`frameDecode`, three's ACES inverted exactly from its own constants, checked against three's chunk) and the sum encoded again.
The rim's rays, the reflections and anything of A that leaves the patch, or lands on something nearer than where it left the ball, read the probe and the scene's lamps, as the solid ball does.

**Drawn late**: the copy has to hold what is behind the ball, the light shafts' lit air included, so with the ball in view the frame is drawn in the depth of field's two passes without the blur (`DepthOfField.renderInTwo`): the scene without its see-through things near the plane, the shafts, then those things, the ball first among them (`seesFrame`).
With depth of field on, the ball is one of the overlays drawn after the blur, so the scene through it is out of focus as around it.
Cost: +0.1-0.2 ms of GPU a frame at 4K on the RTX 4070 SUPER against the solid ball (`bench=128&benchprobe=1&scale=2`, offMs 2.02-2.10 against 1.91).

**The chain stops at the loop.** The ball's chain is laid from its anchor to the ball's centre, so the links being reeled in sit inside the ball - hidden in iron, and in the middle of the glass ball ("I can see a link of chain in the middle of the ball", session-253f). A glass ball's run is cut on its last stretch, loop to centre, at the loop's own inner edge (`stopAtLoop` in chainVisual.ts), so the last whole link reaches no deeper than the loop; the released chain reeling home is cut the same way.
Only that stretch is cut: the first version dropped every link whose middle was near the centre, and the links wound round the ball lie on its surface, nearer the centre than the loop is, so the whole coil vanished (session-277f).
`render3d` "glass chain" holds both.

**Tried and replaced: the coated thin-walled shell** (Tris asked for it, then "actually switch back to the solid version", the same day): the wall taken as no thickness, two blended draws, the frame multiplied by what both walls pass and the light added. A blend can only see the pixel straight behind, so nothing bent: no rim band, no minified middle.
**Rejected before that: the hollow shell** (the first look): "a blue bubble", lost against the cave.

No glass casts a shadow: a glass ball's shadow is a faint ring around a bright focus, which a shadow map cannot draw, and a black disc under a clear ball would be the one thing wrong with it.

## The wear

**Off for now** (Tris, 2026-10-16: "remove all the dust/smears/fogginess for now (not forever)"): `glassWearShown` is false, so nothing is baked and the ball compiles clean; `?glasswear=1` puts it back.

A perfect sphere read as a render (Tris: "it should look more like an actual glass orb ... smudge/dust marks ... the reflection still looks too perfect ... more scuffed/smudged").
The ball carries a handled ball's history, **baked once** into a mipmapped cube texture in its own frame (`render3d/glassWear.ts`, 1024² a face, 2x2 samples a texel, a few milliseconds on a GPU) and read by one filtered lookup per fragment, so it rolls with the ball and the mips - not the shader - decide what each pixel sees at each distance.

- **R, grease**: an uneven film everywhere a hand has been, 4 fingerprints (ridges 0.45 mm apart round a warped whorl, broken toward the pad's edge, some part-wiped into a film) and 2 wipes (streaked bands 4-9 cm long), each with an abraded patch of parallel scratches; 22 prints and 12 wipes read as too many, and the dust is a fifth of its first density for the same reason. Grease roughens the surface (up to `GREASE_ROUGHNESS` 0.45), so the reflection blurs there, the room seen through it hazes (`GREASE_HAZE_MIPS` 3 probe mips), and it scatters a little light back milky (`GREASE_SCATTER`).
- **G, B, dust**: grains a few hundredths to a fifth of a millimetre, clumped, and a little lint; a diffuse grey that nothing comes through. **Rejected: millimetre grains**, which read as "random white dots" - grit that size is a thing one wipes off.
- **A, scuffs**: fine scratches at every angle and abraded patches of parallel ones; they roughen like grease and scatter whiter (`SCUFF_SCATTER`).

Only the ball wears it; on a 6 mm link it is below anything a pixel shows.

## The shards

Tris, 2026-10-16: "make the smashing animation look much better with actual chunks of ball that bounce around the level geometry realistically ... as realistic as possible", then "the chain and hook shouldn't shatter - just the ball. The chain and hook should just disappear", and "the bits should fade away after a short time".

On the debris' boundary: the sim hands over one `ShatterEvent` per break (where the ball was and how it was turned, the struck point and normal, the arrival velocity, the spin) and owns nothing after. Its chain and hook are let go of on that frame and simply go.

**The pieces** (`render/glassFracture.ts`) are cut once, as the level loads, so a break builds no geometry. **The hollow ball** breaks as a bauble does: a thin shell cracks through its wall square to its surface, so the same seeds, on the sphere, cut it by planes through its centre into curved **shards** of the wall - the outer surface coated, the inner one bare and drawn, a bare broken edge between - and each shard collides as several convex parts no wider than `PART_ANGLE` (0.5 rad) of the sphere, since one hull would fill its curve like a lens and it would rest on that. The **solid ball** (`?glasswall=solid`) breaks as three Voronoi fracture patterns of the solid ball, struck at its bottom pole - a few seeds in a ring round the axis of the blow (the large WEDGES, `WEDGES` 5-8), many crowded at the contact (the crushed FINES, `FINES` 34 within `FINES_SCALE` 0.22 radii) and a few strays - in a metric squeezed along the axis (`WEDGE_STRETCH` 0.45), so the cells run from the contact toward the far side as a struck glass ball's do. The largest piece is 9-14% of the ball, the smallest under a millimetre; every cell is convex, and the cells tile the ball (`cli render3d` checks their volumes). The loop breaks into two or three arcs of its bar. A break picks a pattern and turns its crushed pole onto the contact, twisted about it at random. The ball's surface stays smooth and coated (`coatNm`, the film it had there); every cut face is flat, bare quartz.

**The motion** (`render/glassShardsSim.ts`) is a rigid-body simulation in Rapier (`@dimforge/rapier3d-compat` 0.20.0, WASM), **in a worker** (`render/glassShardsWorker.ts`): every piece a convex body of quartz's density (2650 kg/m³, the ball is 19 kg) with its own mass and inertia, colliding with the level, the other pieces and a respawned ball. The page (`render/glassShards.ts`) hands the worker the level's collision once (what the 3D scene draws, see below, or every piece of every body the ball collides with as prisms ±2 m through the plane; no vines; water as areas), then each frame the breaks, the bodies the sim moved and the ball, and draws the poses that come back a frame late. A grab waits for each answer (`flush`), so a filmstrip is the same every time.

- Thrown with the ball's velocity and spin, plus a burst out from the contact (`KICK_PER_SPEED` 0.28 of the speed into the surface, at least 0.4 m/s, the fines faster as `volume^-1/6`); the bounce off what it struck is the engine's (restitution 0.4, friction 0.6).
- **In 3D, on what the scene draws** (Tris, 2026-10-16: "the shards shouldn't just bounce around on the 2D plane. They should have 3D physics"; `render3d/shardCollision.ts`). The pieces collide with the 3D scene's solid meshes as triangle meshes: its static scenery in the world (sent once per scene file, kept across restarts: the river's 700 thousand triangles take 0.44 s to build into the engine, in the worker, as the level loads) and what each level body draws, in the body's frame, moving with it. Leaves (ferns, ivy), shadow decals, the pool's water, see-through surfaces and the depth prepass's copies are left out; printed moss is in (`solidMesh`). They move freely in depth, thrown straight out from the contact, and land on rock in front of or behind the plane. The break frame is 8 ms of worker time at 60 Hz, then 3-5 ms a frame.
- **Without a 3D scene** (the 2D view, or before the scene file lands) they collide with the sim's outlines extruded ±2 m and are held to the depth they broke at (`LevelData.flat`): bounced freely off a slab, pieces were 3.5 m out of the plane 2 s after a 3 m drop, off the end of the level.
- **Engine scale** `LENGTH_UNIT` 0.1: its tolerances default to a human-sized world, and a 1 mm tolerance kept pieces a few millimetres across jittering (halved the step cost too).
- **Settling**: no rolling resistance in the engine, so spin is damped (0.8/s, and 8/s once a piece has all but stopped: curved pieces rocked for seconds); no piece lighter than 0.5 g (0.04 g fines wedged among 20 g pieces spun at 20 rad/s); and a break's pieces are put to sleep together once they average under 1 cm/s with none over 10 cm/s for 0.5 s (the engine's island sleep waited on one turning fine). Collision hulls are each piece's extremes in 32 directions (every corner was 100-150 points, milliseconds a step); a loop piece collides as three capsules along its bar.
- **Fades** (`FADE_START` 1.5 s, `FADE_TIME` 1 s), then removed; the respawn is at 2 s.
- Cost: none on the page's frame (median 0.001 ms; the worker's step was 1-3 ms a sim frame, 13 ms on a break's first step, which on the page was a visible hitch).

**No stutter after a break** (Tris, 2026-10-16). Two causes, measured on the live page replaying a recording in headless Chrome on the 4070, with every frame's main-thread time by method: three works out each piece shape's bounds over every vertex the first time a batch draws it, 9 ms in the pool mirror's render three frames after the break - now done when the pieces are cut (`ShardLayer.build`); and the worker's break step (spawn plus first steps, 22 ms at 60 Hz) ran past a frame, so the pieces held still and jumped. Half of that was the engine's first break in a world, which costs three times any later one: a throwaway break is thrown and stepped a kilometre below the level as it is bound (`ShardSim.warm`, 38 ms in the worker). The other half was contacts along the cracks: a break's pieces pass through other pieces for their first `PIECE_GRACE` (0.05 s), by which the slowest kick has opened every crack by 2 cm. The break frame is now 10 ms of worker time at 60 Hz (two steps), and the page's worst frame across a break is no worse than before it.

**The look** (`render3d/shardVisual.ts`, `pieceGlassMaterial`): two `BatchedMesh`es of every piece shape, one draw each, culled per piece (never as a whole: the batch's bounds are measured empty). A piece is seen through by blending: traced like the ball through the probe, a flat face read one texel - "painted plastic". So the frame behind is multiplied by what each face passes and each face's light added, encoded for the frame; a back face past quartz's critical angle passes nothing and reflects the room, which is the dark facet and the flash a glass chunk has. A hollow ball's shards are plates (`setPieceSlabs`): what leaves a face came in by the face opposite, all but parallel, so it leaves at the angle it entered at and is never trapped; drawn as chunks, their back faces went past the critical angle wherever seen obliquely and showed only the dark cave ("the ugly black areas that appear on the glass after it breaks"). The fade is each piece's batch colour, read by both draws.

The 2D path outlines each piece's projection, pale and bright-edged, and draws no broken ball.

## Where it is

| Path | What |
|---|---|
| `level/ballLevel.ts` | `BallLevelOptions`, `shatterIfStruck`, `holdShattered`, `respawn`, `ShatterEvent`, `SHATTER_RESPAWN_FRAMES` |
| `classes/ballPlayer.ts` | `glass`, `shattered` |
| `sim/trace.ts`, `sim/glassCases.ts` | the digest field, the invariants, the cases |
| `render/difficulty.ts` | the two difficulties, their URLs and progress keys |
| `render3d/glassMaterial.ts`, `glassWall.ts`, `frameCopy.ts`, `glassWear.ts`, `ballVisual.ts`, `chainVisual.ts`, `shardVisual.ts` | the look; the wall; the frame behind the hollow ball |
| `render/glassShards.ts`, `glassShardsSim.ts`, `glassShardsWorker.ts`, `glassFracture.ts` | the shards: the page's side, the simulation, its worker, the pieces |
