# Leaves and slime

What the cuff knocks loose: **leaves** where it strikes ivy, and **globs of slime** where it grabs a vine or its ring slides along one.
The vines are wet - their grab and slide are wet recordings ([sound](sound.md)) - so what comes off them is the wet, not their leaves (Tris, 2026-11-09: "the vine particles shouldn't be leaves - they should be globs of slime").
`render/leafShed.ts` and `render/vineSlime.ts` are the systems; `render3d/leafShedVisual.ts` and `render3d/vineSlimeVisual.ts` draw them.

## The boundary

Both keep the sparks' rule ([sparks](sparks.md)): **nothing here touches the sim.**
They only read the level after each step, through two things the sim already exposes and never reads back:

- `BallLevel.soundEvents` for the hook's touches (`level/soundEvents.ts`).
  A touch counts when it is an arrival (`fromFlight`: the cuff biting, or glancing off out of free flight), once per hook per step - the hardest of its reports, since a flight sweep and a probe may both report one touch.
  The surface decides which system answers (`audio/surfaces.ts` `surfaceOf`): **ivy** (a piece whose `soundMaterial` is ivy) shakes leaves, a **vine** link splashes slime.
  The ivy sound material is the one place a level says "this face is leaves", and a second flag for the same fact would drift from it.
  A bounce that is not an arrival is a tip dragged across the carpet, which shakes nothing.
- `ball.chain.end` for the ring on a vine (`RopeVineClamp`), slime only.
  The slide is measured as the sound's is, with `vineArc` (`lib/vineClamp.ts`): both of the ring's material coordinates on the vine's line as it stands now, so the vine swinging with the ring on it flicks nothing off.

The pool, the PRNG, the thresholds, the flight and the fade are all render-side.
Hosts feed each per sim step inside the catch-up loop (`leaves.ingest(level)`, `slime.ingest(level, STEP)`), advance them once per rendered frame (`advance(dt)`), and reset them with the level - `main.ts`, the editor's ▶ Test, and `shotMain.ts`, which advances them at the fixed step so two grabs of a frame are one picture.
Each PRNG is a seeded mulberry32, as the sparks'.

## How much comes off

The counts were halved on 2026-11-09 at Tris's request, from 0.8 per m/s (at most 10) on a strike and 8 per metre on a slide.

- **A strike on ivy** knocks off `0.4` leaves per m/s of arrival, at most 5, none under 1.5 m/s: a full-speed throw (about 12 m/s) throws 5.
  60% are whole leaves (6-11 cm, the Blender add-on growing 7-12 cm cards) and 40% torn bits (2-4.5 cm).
  They come back out of the carpet the way the cuff came in, lifted and toward the camera, at 8-20% of the arrival (at most 2.5 m/s): the rock behind the carpet stops the cuff.
  **A leafy body sheds its full handful only the first time it is grabbed**, and 30% of it on every grab after, rate and cap alike (`REPEAT_SHARE`; Tris, 2026-11-09, first 20% then 30%): the loose leaves are the ones a first knock takes.
  A full-speed repeat throws 1 or 2, averaging 1.44 against 4.8 the first time.
  The body is marked on the strike that threw some, so a cuff settling gently into the carpet first does not spend it, and the marks clear with the level (a restart, and a replay seek, which resets the systems).
  A run that grabs `moss-145-1` five times at 12 m/s (f36, f156, f276, f396, f516) sheds 5, 1, 1, 2, 2.
- **A grab on a vine** splashes `0.2` globs per m/s, at most 3, none under 1.5 m/s: a full-speed grab throws 2 or 3.
  It was 0.4 per m/s, at most 5, halved as "too much slime on attach" (Tris, 2026-11-09); the cap is 3 rather than 2.5 so the rate is what halves a full-speed grab.
  The cuff closes round the cord and carries on, so they go on the way it was going, at 4-10% of the arrival (at most 1.2 m/s) with 0.15 m/s of scatter.
  Slime clings, so it is shaken loose more than thrown: at 10-25% (at most 3 m/s) with 0.4 m/s of scatter the globs were "a bit too energetic" (Tris, 2026-11-09), and every speed was cut to about 40% of that.
  Over the ten grabs in the bundles that grab a vine, a grab throws 1 to 3, 20 globs in all where the old rate threw 41.
- **A ring sliding on a vine** drips 4 globs per metre slid above 0.1 m/s (the creep a ring does at rest is under that), with 8-20% of the ring's own velocity, swing included (was 20-50%).
  A slide is about a metre at up to 5 m/s in the bundles that slide a ring, so it trails a handful.

## The leaves' flight

A leaf is a plate, and its air force is almost all along its normal: `-NORMAL_DRAG |v| (v·n) n`, with skin friction along its face an order of magnitude smaller.
`NORMAL_DRAG` is `ρ C_N / 2σ` (air 1.2 kg/m³, a broadside plate's `C_N` 1.2, a fresh leaf's 0.2 kg/m²), so a leaf falling broadside settles at 1.65 m/s, and size does not change how fast a leaf falls - every force is per area.
A leaf tipped off level therefore slides down its own slope as it falls.

The centre of pressure sits ahead of the plate's centre, up to the quarter chord edge-on and at the centre broadside, which pitches the plate toward broadside about `n × v` by `sin·cos` of its angle to the flow.
Against a plate's moment of inertia (`m L² / 12`) that is `PITCH_GAIN = 3 NORMAL_DRAG`, divided by the leaf's length: small leaves turn faster.
The plate overshoots broadside and swings back, and with the glide that is the side-to-side fall a leaf is known by; nothing draws a wobble on.
The spin a strike gives it is worn down by the air its rotation pushes, `(12 / 64) 2 NORMAL_DRAG L ω²`, the normal force integrated along a plate spinning about its middle.
The flight is substepped at 1/120 s, since the pitch swings a leaf at up to about 17 rad/s.

## The slime's flight

A glob is a small dense drop, 8-20 mm in radius (mostly small), and flies as one: gravity and a sphere's drag, `3 ρ_air C_d / (8 ρ_slime r) |v| v` with slime at 1050 kg/m³ and `C_d` 0.47.
For a centimetre of slime that is a few percent of gravity at these speeds, so a glob is nearly ballistic, as a flung drop is.
Each has its own fixed squash (0.85-1.15 on each axis) so a shower is not a set of identical balls.

## Drawing

**A leaf** is the vines' own blade (`vineLeafGeometry`) in the vines' own material, in ivy tones (`LEAF_TONES`): a dark, cool three matched to the carpet in the game's light, plus a yellowed old leaf one time in seven.
The vines' own leaf tones (`VINE_LEAF_TONES`) came out three times as bright as the carpet the leaves had come off ((100, 126, 90) against (30, 70, 50) in the frame).
It is drawn at the depth of the body it came off (`Scene3D.depthOf`, a few centimetres in front so the face does not swallow it at once) and the stem is laid half a length back from the flight's point, which is the blade's middle.
It casts and receives shadows like a vine leaf.

It **fades without blending**: `makeVineLeafMaterial(true)` adds a per-instance `leafFade` that dissolves the blade from its rim inward in ragged patches (value noise in the blade's own UV), and the shadow materials cut the same holes.
An instanced mesh drawn blended would have to be sorted leaf by leaf against itself and the scene.
A leaf lives 2.4-3.4 s and dissolves over the last 0.7.

**A glob** is an icosphere in a glossy clearcoated `MeshPhysicalMaterial`, a paler, yellower film of the vine's green, so the scene's lights catch it - most of what makes a centimetre of slime readable at the game's framing.
It is drawn just in front of the gameplay plane, where the vines are, lives 1.2-2 s and shrinks away over the last 0.35, opaque so nothing is sorted.

Both meshes live on the scene for the session (fixed pools of 128 leaves and 96 globs, the oldest dropped for a new one) and are laid with one instance during `Scene3D.prewarm` (`prewarming`), so their programs and shadow variants compile under the loading screen rather than on the frame the first piece comes off.

The 2D path draws each leaf as a small ellipse, foreshortened by how edge-on it is, and each glob as a dot.

## What is not done

- **Nothing lands.** Leaves and globs fall through whatever is below and fade; a collision query against the world from the render side is not taken, since the world's broadphase syncs on query and the sim must not see the render side touch it.
- **No cases yet.** Per the working practice on feel, the counts and the flight are measured here and wait to be played before anything pins them.
