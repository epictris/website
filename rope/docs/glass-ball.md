# The glass ball (Hard)

The menu offers two difficulties, and a difficulty is a ball: **Normal** is the iron ball and **Hard** is a glass one (`?ball=glass`, Tris 2026-10-16).
The glass ball is the iron ball in every number the sim reads - mass, radius, loop, chain, winch - except that it **breaks on the first solid thing it touches**.
Water does not break it; the bed under the water does.
The hook and the chain touch whatever they like: it is only the ball that is fragile.

`ball.json` opens with a five-metre drop onto rock, and that is deliberate (Tris: "I want the ball to break on opening, unless the player grabs the vine next to spawn").
A throw at the vine to the right of the spawn between frames 35 and 45 of the fall catches it; anything else lands and breaks on frame 60.

## What a touch is

`BallLevel.shatterIfStruck`, at the end of `physicsProcess`, after every phase that moves the ball and after the breakables:

- **a contact that pushed** - any `world.frameContacts` entry on the ball that ended the solve with `normalImpulse > 0`. That is a landing, a graze, a crate knocked into it, and the speculative contact that stops a ball arriving within the slop before it ever overlaps. A speculative contact that pushed nothing is the ball passing close, and is not one.
- **a push-out** - a surface the chain phase hauled the ball into and then pushed it back out of (`ballPushes`: the leading depenetration and the chain phase's `pushedOutOf`, real pushes only). The contact solve never sees those.

What is NOT solid is everything the solver never pairs the ball with, which is exactly the list the request makes: water and every other area (a region, not a body), vines (non-solid links), and the ball's own hook (a collision exception).

A level already **finished** is not broken by what the ball meets on its way out of the gate: the run is over, and the linger is the page's presentation of that.

Everything is behind `BallPlayer.glass`: an iron ball runs none of it, collects no push-outs, and digests exactly what it always did.

## After it breaks: the respawn

`SHATTER_RESPAWN_FRAMES` (120, two seconds) after the break, a **fresh ball is put at the spawn, in the same level** (`BallLevel.respawn`, Tris: "don't reload the whole page when the glass ball shatters, just respawn the player at the beginning after a couple of seconds").
Nothing is rebuilt - not the world, not the 3D scene - and everything else in the level stays as the attempt left it.
A rebuild is what a kill zone's reset is, and after a break, which Hard asks the player to suffer over and over, it read as the page reloading.

- **A fresh `BallPlayer`, not the broken one put back**, so no state of it carries over: its loop ride, its aim, its wind stall, and the collision layer `passable` moved it to (the ball's own is `LAYER_PLAYER`, which `passable = false` would not restore). The old ball leaves the world and the new one takes its slot in the level's body list; `ball` is the one field that changes, and the renderers follow it (`Scene3D.render` rebuilds the `BallVisual` when `level.ball` is a different object - geometry only, the programs are cached).
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
- Invariants (`checkGlassBall` in `sim/trace.ts`), tracked per BALL so a respawn's new ball starts clean: `glass-iron` (an iron ball broke), `glass-intact` (a whole glass ball ended a frame with a contact pushing on it - a touch the break never heard about), `glass-once` (the break moved, cleared, or the ball mended), `glass-held` (a broken ball moved, is still solid, still carries its chain, or something is in contact with it).
- `cli glass` (`sim/glassCases.ts`, in `bun run test`): lands, water, hook, iron (bit-identical to iron until the break), respawn, finished, replay (through a respawn). Disabling the break turns five of the seven red, with `glass-intact` firing on every landing.
- `cli render3d`'s `glass:` cases run every rewrite of three's shaders on three's own physical shader and check what came out: a three upgrade that rewords a line fails there rather than drawing black plastic.

## What it looks like

The ball, its loop, its links and its manacle are **solid glass**; the shards are thin glass.
`render3d/glassMaterial.ts` has the reasoning in full.

**Solid glass is a lens, traced, seeing the room through the reflection probe.**
A solid sphere is a ball lens: the room behind it is seen through it upside down and shrunk, and that is what makes it read as an object.
Each fragment's view ray is refracted in (n = 1.5), carried across the sphere's chord, refracted out (a sphere never traps a ray past the critical angle), and the light arriving along the exit direction is read from the **ball's reflection probe** - the cube of the room the ball already draws one face a frame for its reflection, with the ball and chain left out.
For the ball that is the exact picture: every exit ray starts inside the sphere the probe sits at the centre of.
Both surfaces' Fresnel losses come off what comes through, and the front surface's reflection is three's specular, lit from the same probe.
The loop, the links and the cuff are round bar, traced the same way with the bar's radius (exact across the bar, near enough along it); they see the room from the ball's centre, which a sliver a few pixels wide cannot show.
Absorption is in the trace (`GLASS_ABSORPTION`, Beer-Lambert over the chord) and is zero: clear glass. `?glasstint=0.4,3,11` is amber, for comparing (temporary).

**Rejected: three's transmission**, the solid ball's first version.
A transmissive material makes three re-render the whole opaque scene into a full-size target every frame, mipmap it, and again inside every other render that sees it (the pool's mirror): "massive performance drops while the glass ball is active".
Read from the probe instead, the glass ball costs what the iron one does - 6.1 ms against 5.95 ms of GPU a frame on the river spawn, measured in Chrome.

**Rejected: the hollow shell** (the first look, `?glass=hollow` while compared): two walls a few millimetres thick bend nothing, so the background showed straight through and only the Fresnel rim drew the ball - "a blue bubble", lost against the cave.

**Thin glass** (the shards) is that wall: a premultiplied blend of `reflection + background * (1 - F)^2`, double-sided, no extra pass, drawn sharp over the depth-of-field blur as a see-through overlay.

No glass casts a shadow: a glass ball's shadow is a faint ring around a bright focus, which a shadow map cannot draw, and a black disc under a clear ball would be the one thing wrong with it.

## The wear

A perfect sphere read as a render (Tris: "it should look more like an actual glass orb ... smudge/dust marks ... the reflection still looks too perfect ... more scuffed/smudged").
The ball carries a handled ball's history, **baked once** into a mipmapped cube texture in its own frame (`render3d/glassWear.ts`, 1024² a face, 2x2 samples a texel, a few milliseconds on a GPU) and read by one filtered lookup per fragment, so it rolls with the ball and the mips - not the shader - decide what each pixel sees at each distance.

- **R, grease**: an uneven film everywhere a hand has been, 4 fingerprints (ridges 0.45 mm apart round a warped whorl, broken toward the pad's edge, some part-wiped into a film) and 2 wipes (streaked bands 4-9 cm long), each with an abraded patch of parallel scratches; 22 prints and 12 wipes read as too many, and the dust is a fifth of its first density for the same reason. Grease roughens the surface (up to `GREASE_ROUGHNESS` 0.45), so the reflection blurs there, the room seen through it hazes (`GREASE_HAZE_MIPS` 3 probe mips), and it scatters a little light back milky (`GREASE_SCATTER`).
- **G, B, dust**: grains a few hundredths to a fifth of a millimetre, clumped, and a little lint; a diffuse grey that nothing comes through. **Rejected: millimetre grains**, which read as "random white dots" - grit that size is a thing one wipes off.
- **A, scuffs**: fine scratches at every angle and abraded patches of parallel ones; they roughen like grease and scatter whiter (`SCUFF_SCATTER`).

Only the ball wears it; on a 6 mm link it is below anything a pixel shows.

## The shards

`render/glassShards.ts` (the system) and `render3d/shardVisual.ts` (one instanced mesh of glass plates), on the debris' boundary: the sim hands over one `ShatterEvent` per break (where, the struck surface's normal, the arrival velocity, the chain's polyline and the cuff) and owns nothing after.
The shell breaks into plates of its own wall lying in its tangent plane - 46 plates and 40 splinters - thrown with the ball's arrival reflected off the struck surface as a weak bounce, plus a burst round the shell scaled by the speed into it; they land on the struck surface (a plane through the contact), skitter to rest and shrink away just before the respawn.
The chain and the cuff break with the ball into splinters along their line.
A seeded generator, so a replay or a grab draws the same shower; the shards wear the ball's probe, which they fly from (on the sky they read as dark confetti), and are hidden while it captures; prewarm compiles them though no break has happened yet.

The 2D path draws the ball as a clear disc with a bright rim and the shards as pale triangles.

## Where it is

| Path | What |
|---|---|
| `level/ballLevel.ts` | `BallLevelOptions`, `shatterIfStruck`, `holdShattered`, `respawn`, `ShatterEvent`, `SHATTER_RESPAWN_FRAMES` |
| `classes/ballPlayer.ts` | `glass`, `shattered` |
| `sim/trace.ts`, `sim/glassCases.ts` | the digest field, the invariants, the cases |
| `render/difficulty.ts` | the two difficulties, their URLs and progress keys |
| `render3d/glassMaterial.ts`, `glassWear.ts`, `ballVisual.ts`, `chainVisual.ts`, `shardVisual.ts` | the look |
| `render/glassShards.ts` | the shards |
