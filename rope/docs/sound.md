# Sound

The game's sound is files, assigned to the game's sound **events** in the editor's **Sounds** menu.
Nothing is synthesised at run time: a first version (2026-11-06) generated every sound in the browser from physics - Hertz contact times, modal synthesis, roughness profiles played at the rolling speed - and was rejected on first listen as sounding awful.
What survived it is everything upstream of the sound itself: the events, the surfaces, the timing.

Where the files come from is the library's business, not the game's: recordings (Freesound's CC0 search, Kenney's packs), or files rendered offline.
`scripts/sfx.ts` renders one designed sound per event (`bun scripts/sfx.ts <outdir>`): layered noise bursts, pitch-swept thumps, inharmonic rings and granular grit with hand-chosen envelopes, the way an effect is built in a DAW rather than derived from the sim's numbers, seeded so a sound renders bit-identically.
Its output is uploaded through the menu like any other file, and whether it sounds right is judged by ear, as with everything here.

For offline creation and feedback, see [the audio workstation](../tools/audio/README.md): editable stems and REAPER projects, repeatable recipes, source provenance, technical analysis, and `/sound-lab.html` for matched-level A/B comparisons and exportable listening notes. It is linked from **Sounds → Compare sounds ↗**. Candidates stay outside the game's library until uploaded and assigned.

## The boundary

**Sound never touches the sim**, the sparks' rule ([sparks](sparks.md)) held the same way.
`audio/soundObserver.ts` reads a `BallLevel` after every step and writes nothing back; it is fed by `stepLevel` in `main.ts` beside the sparks, the debris and the reeling chain, skipped where they are (a replay seeking), and by the editor's ▶ Test loop.

Most of what is heard is read straight off the world: the ball's contacts (`World.frameContacts`), its velocity, how deep it is in water (`submerged`), and the coil (`Rope.coiledLength`, a read-only getter).
The hook's touches are the exception, because the sim keeps them to itself - an attach removes the hook inside its own step, and a bounce is reflected before the contact solver sees it - so they come through `BallLevel.soundEvents` (`level/soundEvents.ts`), a per-frame list cleared at the top of every `physicsProcess`, written from the hook's attach and bounce callbacks in `spawnBody`, and never read by the sim.
The bounce callback carries the struck piece for this, and every mounted shape carries its authored `material` (`CollisionShape2D.material`), which nothing in the sim reads either.
`replay selftest` stays bit-exact and the bundle corpus replays as before.

## Contact-driven chain audio (v29)

Chain drops and airborne slack movement now use short recorded gestures, not a complete drop performance or a looping pickup recording. `SlackChain.contactSnapshot()` exposes the drape solver's actual contacts, aggregated by node and shape across all constraint passes. It records normal approach before damping; sliding is measured from the **final** node displacement relative to the contacted body's transform. It never changes physics or drape positions.

`audio/chainSurfaceAudio.ts` emits new contacts above 0.25 m/s after more than three absent steps. Neighbouring arrivals within 12 cm are grouped with bounded energy; recent contacts in the same region are suppressed for 35 ms; at most three gestures play per step. A resting contact produces no new clink. Later links can make their own small contacts rather than restarting a whole-chain drop. Taut loaded contacts retain their separate Wrap cues.

`audio/chainArticulationAudio.ts` approximates link-to-link contacts from changes in local bend and velocity relative to neighbouring nodes. A node must accumulate 0.12 radians of bend change while moving relatively at least 0.12 m/s; one articulation cluster can sound every 40 ms. Stationary curvature and rigid translation do not generate clinks. This is a link-contact proxy on the existing cosmetic drape, not a new rigid-body simulation or self-collision solver.

`tools/audio/build-chain-microfoley.py` builds eight distinct 50 ms scenery-impact cuts from the supplied concrete-drop/rattle sources and eight articulation cuts from pickup/rattle. Cuts use native pitch, a 400 Hz high-pass, full onset/decay fades and −18 dBFS sample peaks. Provenance windows are in `tools/audio/microfoley-cuts.json`. **Chain link impact** and **Loose-link clinks** are one-shot families with no immediate repetition; the old Chain drop family is removed. Full original performances remain under `tools/audio/sources/`. Run the builder with the audio venv; the importer invokes it automatically. Run the timing auditor afterward to update its report.

**Hook dragging** is independent of chain slack: it reads tangential sliding from hook contact events and force-bearing world contacts, in either direction. **Chain dragging** reads the drape's final relative slide. A taut chain additionally requires at least 3 cm/s of genuine endpoint/material transport or scenery motion, so interior constraint shuffle cannot sustain scraping. Both drag loops fade to near-silence within 35 ms of motion/contact stopping. Session-239f (2) retains upward hook scrape; session-604f's stationary ending and a two-second continuation produce no drag cues. The old full-chain drop latch and slack loop described in historical revisions below are superseded.

## What is heard

Per step, `SoundObserver` reports:

- **Roll**: each surface the ball is in contact with, and how fast the contact moves across it (the ball's velocity relative to the surface, along it).
- **Land**: the ball making force-bearing contact after a break in similarly oriented support of more than 3 steps, at its speed INTO the piece - last step's velocity plus this step's gravity, because by the end of the step the contact solve has cancelled the arrival.

Land playback now resolves independent **Light**, **Medium**, and **Heavy** families from that normal approach speed. Light plays alone through 1.2 m/s; it crossfades into Medium over 1.2–2.4 m/s. Medium plays alone through 4.5 m/s, crossfading into Heavy over 4.5–6.5 m/s; Heavy plays alone above that. Equal-power crossfades select at most two recordings. Each strength has its own surface overrides, level, reference speed, and pitch controls in Sounds. An unassigned strength can fall back to the old Land slot, without double-playing a shared fallback. The existing speed-to-level scaling still applies within the selected layer(s); speed now changes timbre as well as loudness.

V13 uses the user's `314625-Rock_impact_-single_stone_-light_4` for Medium and `314636-Rock_impact_-single_stone_9` for Heavy, at their original pitch. Light is a separate damped metal-object impact, pitched down an octave and supported by a short contact-body layer; it contains no small-chain-link recording. These are local auditions with incomplete source/licence metadata. The previous single thud and metal-landing assignments have been unassigned; all old candidates remain in the lab.

V14 replaces Heavy with the user's `314632-Rock_impact_-single_stone_5`: source window 0.024–0.165 s and a 20 ms fade-out remove the trailing scraping while retaining the initial impact at original pitch. At the user's subsequent request, Light v14 uses the same stone-4 source as Medium, softened with a 2.8 kHz low-pass and 4 ms fade-in and shortened to source window 0.020–0.160 s with a 20 ms fade-out. Medium remains v13. Strength routing and levels are unchanged.
- **Attach** and **Bounce**: the cuff's arrivals. A bounce is a strike only when it ends a flight or follows 2 silent steps (a dragged tip is re-deflected every step, and those normals are the face's facets, not new hits - the sparks' rule again), at its speed into the face; an attach at the cuff's whole speed, which it spends stopping in what it bit.
- **Wind**: one cue per chain link (3.8 cm) the coil grows by, placed within the step where the link landed, at the winding speed. Unwinding does not trigger this cue; deploying and moving slack have their own rattles. The count restarts from wherever the coil is.
- **Deploy**: a continuous link rattle while the hook is flying out, at its flight speed. Playback stops on the step flight ends, with a 7 ms fade to near-silence. A throw attaching within one step has no continuing deployment cue. An already-attached spawn does not trigger it.
- **Loose-link clinks**: individual recorded gestures from local bend changes and relative node motion, silent at rest, during deployment, while taut, stowed or submerged. No slack recording loops independently of motion.
- **Chain link impact**: short clinks from new drape-node scenery collisions, spatially grouped and scaled by normal approach speed. Later links land individually; repeated solver corrections and settled contacts are silent.
- **Chain dragging** and **Hook dragging**: separate surface-relative sliding signals, including upward hook pulls. Interior taut-chain shuffle cannot sustain a scrape with stationary ends and material.
- **Taut**: one short catch when moving slack is taken up, or deployment ends at tension. It rearms only after the chain has more than 6 cm of slack and catches within 1.5 cm of full extension; minor fluctuations cannot chatter. The take-up rate sets the level, using the last flight speed at the end of a throw. An existing spawn chain is not a catch.
- **Creak**: short, non-looping friction phrases as a loaded taut chain turns. The observer accumulates angular travel: 0.03 radians starts a new movement/reversal, 0.18 radians requests another phrase, with at least 0.25 s between emissions. Resting for 0.12 s rearms a movement onset. Angular speed and the square root of load relative to ball weight set the level, not pitch. No cue is produced while still, slack, deploying, stowed, removed, or fully submerged. `SoundStep.creaks` carries each phrase's angular speed and load separately as well as its playback intensity. This reads the existing direction and load without adding forces.
- **Wrap**: short metal-link impacts against scenery a taut loaded chain wraps around. Contacts are grouped by collision shape, not regenerated node objects. A new loaded contact triggers once; subsequent impacts follow actual chain travel over the surface, placed within the step at a link crossing. Rapid crossings are grouped into one gesture per contact every 40 ms or more. Bend-angle changes alone are not impacts. Geometry-local positions exclude movement of the scenery itself, while arc length from the chain's material start detects chain sliding over a stationary corner. The cue carries material and world position for surface assignment and panning. Self-coiling, slack contacts, stationary wraps, and brief topology flicker do not produce repeated impacts. Fast travel is capped at one gesture per contact per 40 ms and six total per step; excess cues are dropped instead of rattling after motion ends.
- **Whoosh**: a wind bed above walking speed, swelling with positive speed gain during swing wind-up. The gain in scalar speed drives acceleration, so constant-speed turning does not boost it. Fully submerged motion is silent.
- **Splash** and **Wade**: going into water (the downward speed), and moving through its surface (speed relative to the flow, weighted by how much of the ball is at the surface).

Strikes under 0.15 m/s are not played: a settling body reports a great many of them.

## Speed wind (v30)

`wind_gust.m4a` is the source for **Whoosh**. `tools/audio/build-speed-wind.py` retains the original 96.59 s recording and builds a mono native-pitch bed from its steadier 24–40 s window, with a 70 Hz high-pass, 200 ms circular crossfade and −20 dBFS RMS calibration. The result is 15.8 s long; pitch and pace remain fixed. The source's slow fade-in/out and separate large gusts are excluded so gameplay controls the envelope.

`audio/windMotion.ts` derives positive scalar speed gain in m/s², capped at 30 and smoothed with 45 ms attack/140 ms release. Spawn/reset has no acceleration burst; water suppression is applied after measuring raw speed, so crossing the waterline cannot create a fake acceleration. Wind follows player position with the same camera-relative spatial path as other loops.

`windLevel` in `audio/playbackLevel.ts` fades in between 0.25 and 0.55 times reference speed (3–6.6 m/s at the default 12 m/s), grows approximately with speed squared, and adds up to a 2.25× swell for gaining speed (full boost at 12 m/s²). Overall gain is bounded at 2.2× before slot volume; default Whoosh volume is −6 dB. Coasting keeps the speed bed while the acceleration swell releases; slowing down reduces the bed. The Sounds menu's Whoosh volume/reference speed tune the overall loudness and onset range. `scripts/test-speed-wind.ts` checks these behaviours, including constant-speed swing rotation and water transitions.

## Spatial placement

Every gameplay cue carries its actual world `x` and `y`, including surface contacts, loose-link clinks and hook scraping. Web Audio sources stay at those level coordinates (`y` inverted for audio's upward axis). The listener follows the rendered camera on every frame, including frames with no physics step, so existing one-shot tails remain located correctly as the camera moves. Sound direction is relative to the camera rather than the player or the level origin.

`audio/spatialAudio.ts` reads the rendered 3D camera's world matrix after rendering has resolved its lens, authored Z offset, and any orbit. Listener position, forward and up axes exactly match that camera, including its distance from the gameplay plane. The level's 70 mm lens puts it substantially farther back than the former viewport-based estimate; there is no separate invented audio-camera depth. The canvas fallback shares the renderer's default camera-distance derivation. HRTF panners provide direction and elevation; distance rolloff is disabled to preserve event loudness. Source movement is smoothed over 25 ms, while the listener follows the already-eased rendered camera directly. Library auditions remain centred. `scripts/test-spatial-audio.ts` checks real lens/depth/Z offsets, orientation, camera/source translation, elevation, zoom and stable levels.

Spatial panners initialize their source position immediately at creation, before being connected or starting the source. Scheduling the initial position only at the buffer's start time lets HRTF begin at the default world origin and crossfade during the impact: the browser regression reproduced a 10.6 dB left bias for an otherwise centred transient. Loops masked it by lasting long enough to settle. Both loops and impacts now use the same mandatory-position panner factory.

`bun run scripts/audit-spatial-audio.ts` renders every assigned, edited recording through the production panner/envelope helpers in Chromium's OfflineAudioContext. It measures centre, left, right, above, below and head-locked audition placements, recording results in `tools/audio/spatial-audit.json`. Centred/elevated/audition sounds must balance within 0.15 dB; lateral sources must favour the correct ear. HRTF filtering/interpolation can make mirrored lateral energies slightly asymmetric, bounded here at 1 dB. This measures spatial playback correctness, not a subjective headphone audition. The script needs a working headless Chromium environment and is an explicit audit rather than a dependency of the browser-free default suite.

## Surfaces

`audio/surfaces.ts` classifies a piece, most specific first: mud (`viscosity`), rubber (a belt), vine, wood (a root), the piece's authored `material`, metal (a rail), stone (hook-proof), wood (any moving body, whose mass was computed as wood), and otherwise **moss** - scenery the cuff bites.
In `BALL` that puts the dark rocks and boulders on stone, the mossy rocks on moss and the roots on wood.
Authoring `material` on a piece is how to give it a different sound.

## Selected iron-chain recordings (2026-11-09)

The user-selected recordings now replace Deploy (`large_iron_chain_drop_1`), Slack (`large_iron_chain_pickup_7`), Taut (`large_iron_chain_move_1`), and all Wrap surface assignments (`large_iron_chain_rattle`). Wrap v27 uses three distinct 40 ms bright clinks from original-source windows 0.254–0.294, 0.350–0.390 and 0.397–0.437 s, replacing the quiet opening cut that sounded like rumble. A 500 Hz high-pass removes low handling energy; 1 ms onset and 28 ms tail fades avoid cut clicks. Each is calibrated to −18 dBFS sample peak before Opus encoding. Pitch remains native with ±0.25 semitone variation; choices never repeat immediately. `tools/audio/refine-chain-wrap.py` reproduces these edits and is run by the importer. Rapid link crossings are grouped at least 40 ms apart per contact; excess crossings are discarded rather than replayed later. This avoids regularly stacked copies of the same waveform becoming a buzz. Winding keeps its existing recordings. Taut uses the first firm gesture at 0.099–0.235 s of its trimmed movement recording; the quiet preparation and later movement are excluded. All six new sources play at native pitch; deployment, slack and drag also keep their recorded pace.

Two additional families separate surface friction and landings from airborne slack: **Chain dragging** uses `large_iron_chain_drag_on_stone`, and **Chain drop and settling** uses `large_iron_chain_drop_on_concrete`. They are defaults, with surface overrides available in Sounds; the defaults are the supplied stone/concrete performances on every material until specific alternatives are assigned.

`audio/chainSurfaceAudio.ts` reads interior drape nodes against solid, wrappable scenery within 2 mm of the drape collision radius. Relative tangential motion drives dragging; new contact after more than three absent steps and normal arrival above 0.25 m/s triggers a drop. The previous node velocity retains an arrival already stopped by the cosmetic solver. A landing latch groups all arriving links into one pile-up, even beyond the 0.3 s transient cooldown. It rearms after the entire interior drape has been clear of scenery for 0.12 s. Session-115f previously emitted drops at f56 and f76 while floor contact persisted; it now emits only f56. Startup/contact baselines, still contact, airborne motion, taut/stowed chains and full submersion do not trigger dry drops or scraping. This is a read-only contact proxy for the avatar's deployed slack drape, not per-link collision physics or audio for discarded/retracting chain visuals.

`python3 tools/audio/import-chain-recordings.py --source-dir /path/to/originals` reproduces the imports, backs up the previous bank and manifest under `out/`, retains the original files under `sources/`, and pins their hashes in `local-sources.json`. Imports are mono 48 kHz Opus with leading silence trimmed and a 2 ms onset fade. Source filenames are recorded; author/licence metadata remains unknown. These are local game assignments; release asset publication is separate. Reload an already-open game to load them. Event checks: `bun run scripts/test-chain-sound.ts`.

The v28 timing audit covers all 18 assigned recordings, including existing landings, attach, winding, mounting-loop impact, sphere settling and rolling. `tools/audio/timing-audit.json` records each playback window and decoded measurements. `tools/audio/.venv/bin/python tools/audio/audit-timing.py --apply` reproduces the corrections after importing: remove excessive quiet one-shot padding while retaining 20 ms beyond the last active 2 ms RMS block (−45 dB relative threshold); correct metadata to decoded length rather than Opus container padding; and derive native-pitch deployment, drag and slack loops from active source windows with circular crossfades. The previous manifests are retained under `tools/audio/out/timing-audit-before.json`. The original recordings are unchanged. The audit is a timing/edge measurement, not a listening assessment.

All one-shots, including edited previews, now use a 0.5 ms onset and 4 ms release on the audio clock, scaled down for very short clips. The release reaches zero at the actual pitched playback end, preventing a crop from cutting a nonzero waveform. Rolling retains its existing overlapping random grains. Deployment still stops with flight rather than completing a source cycle; dragging and slack still follow observed motion.

## Events and slots

`audio/slots.ts` lists the events (`FAMILIES`).
Deploy and Slack are loop slots, with separate volume, reference speed, and pace controls in the Sounds menu. Taut is a one-shot slot with its own volume and reference speed. The default keeps metallic pitch fixed as the rattle speeds up. The v8 loop recordings are circular, irregular sequences of the approved v7 winding source, and the taut cue is a short cluster of the same grain; the approved winding slot is unchanged.

The v9 default Attach file is the user's downloaded dirt-impact/scatter recording, trimmed for onset timing at original pitch. It uses the existing hook-attach events; assigning the default covers surfaces without their own overrides. Its provenance is incomplete and it is registered as a local audition, as is the v6 rock thud.

The v10 Creak loop remains in the audition lab. V11 splits its source windows (1.285–1.405 s, 1.82–1.98 s, and 2.51–2.79 s) into three independent short files, chosen without immediate repetition and played from their beginnings. This replaces the loop's randomly phased playback with movement-triggered phrases. The geometry-wrap file layers one of those friction cuts with a quiet link-seating detail from the approved winding source. Source/licence metadata remains incomplete; the new timing and timbre still need listening assessment.

Swinging creaks are currently unassigned at the user's request. V12 replaces the v11 geometry-wrap recording with 65 ms link-impact files, with no creak sources. The default is the approved chain recording alone; stone/brick adds a concrete contact transient, wood/vine adds a wood tap, metal adds a brighter metallic contact, moss adds earth texture, and mud/rubber uses a damped earth contact. Glass/ice and other unassigned surfaces use the plain link fallback until specific contact recordings are supplied. These are designed layers, not claims of recorded chain collisions against every material. `Wrap / <surface>` slots choose them; all earlier recordings remain in the audition lab.
Each has a **Default** slot, and the surface-dependent ones (roll, land, attach, bounce) a slot per surface; a surface slot with files of its own plays them, and one without plays the Default, settings and all.
The assignments are `src/audio/soundBank.json`, keyed `attach`, `attach.mud`, and so on.

A slot holds files (a one-shot picks one at random, never the same twice running; a loop picks one when it starts) and:

- **volume**, dB, at the reference speed;
- **reference speed**, m/s: a one-shot at this speed plays at its volume, scaling in proportion with speed up to twice as loud; a loop plays at its own pitch, pace and volume there;
- **pitch ±** (one-shots): random detune per play, in semitones;
- **pitch follows** (loops): 0 never changes pitch, 1 is pitch in proportion to speed, held within two octaves;
- **pace follows** (loops): how fast the recording's own time runs with speed, apart from its pitch - 0 never changes, 1 is in proportion ([below](#pace-and-pitch)).

A file can also carry a **clip edit** (below), which applies wherever it is assigned, on top of the slot's settings.

A loop's level grows with speed in proportion, except the whoosh, which grows as its square (moving air's pressure goes as the dynamic pressure), and each fades in from rest.

## Pace and pitch

Session-460f exposed a false-motion bug: two pieces of one body with different normals shared patch history. Alternating support fabricated about 2.1 m/s of rolling while the ball was almost still. History is now keyed by contacted shape and avatar circle, with feature continuity checked before displacement is differentiated. A shape/feature transfer uses the instantaneous centre-motion estimate. Relative circle-centre motion below 5 mm/s is treated as settled to exclude solver position corrections. Frames 96–325 of the recording now produce zero rolling speed. The compound-support regression fails before the fix (2.087 m/s while stationary) and passes after. Browser playback of the generated commands captures digital silence in the stationary interval.

V25 replaces rolling with a cleaned derivative of the same recording. `tools/audio/dering-roll.py` compares averaged STFT power to a local median spectrum, reducing narrow modes and sidebands instead of broadly filtering out upper detail. Measured source modes drop about 15–30 dB (1.57 kHz about 30 dB). The original, processing parameters and derived hash are retained. Run the script before rendering on a new checkout. Short varied grain playback remains. The archived v20 runtime notches do not apply to v25. Spectral attenuation cannot establish the subjective absence of ringing.

V26 separates the quiet contact timbres: Mounting loop impact uses a 100 ms, leaner, short-decay tick; Ball returns from loop uses a 160 ms, lower, rounder thud. Both use the fourth drop at native pitch with independent level calibration. These are distinct edits of a shared recording, not isolated recordings of the actual loop and sphere; the assembly can still share resonances.

Rolling now uses `RollingTexture` rather than sequential WSOLA playback. The original 4.8 s cannonball window varies about 20 dB across 150 ms sections; replaying it repeated that performance swell. The rolling renderer chooses random 160 ms source grains every 80 ms, with equal-power overlap, shared source positions across channels, RMS compensation bounded at 2.5×, and exclusion of unusually quiet/loud source windows. It avoids nearby repeated starts when alternatives exist. It holds native pitch by default; movement still drives the rolling level/tone through measured patch travel. It never traverses the whole phrase or time-stretches it at low speeds. Pace-follow is not used or shown for Roll; other loop families retain WSOLA. There is no fixed multi-second playback period. Window changes clear the old grains, and rest pauses processing. These are recording-led texture edits, not acoustic synthesis. `scripts/test-rolling-texture.ts` checks source-length recurrence, envelope stability, shared stereo positions, clip bounds and reproducible seeds; the synthetic fixture's quarter-second envelope span is 0.53 dB. Listening is still needed for texture quality.

V24 supplies a separate, quiet `ball-settle` cue (**Ball returns from loop**) as well as the existing `loop-hit` (**Mounting loop impact**). Both use a 120 ms softened fourth-cannonball-drop cut: native pitch, 1.8 kHz low-pass, 3 ms attack, 35 ms decay/tail fade. Each has an independent −30 dB event level; loop-hit retains its 3 m/s reference and ball-settle uses 1 m/s. Loop-only support arms a return on the same supporting body/compatible normal for 250 ms. The next sphere contact consumes it and emits a subtle return cue rather than suppressing it as continuous support or selecting Light/Medium/Heavy. Continued contact does not repeat it. A return above 3 m/s or after that window uses normal landing handling. Session-109f's returns are frames 52, 59, 73 and 87. Separate tests cover one-shot return, sustained-contact silence, timeout, and hard-landing fallback.

Rolling requires a force-bearing contact on either the sphere or mounting loop in the current step. Both are collision circles. The observer reconstructs their geometric contact patch from circle centre, radius and contact normal, then measures tangential patch displacement per second in the contacted body's local coordinates. This excludes rigid translation/rotation of supporting scenery. It measures patch migration, not the velocity of a material point on the ball (zero at ideal no-slip contact), and does not substitute the avatar centre's velocity for loop motion. First touches and abrupt normal changes use the circle centre's relative tangential velocity as a flat-face estimate until consecutive samples exist. Separate histories for each circle avoid jumps when support transfers between sphere and loop; compatible contacts on pieces of the same supporting body share history across seams. Multiple contacts on one material use the fastest patch, not summed duplicate speeds. This is a discrete collision-geometry estimate, not a deformable-contact or acoustic simulation. Speculative contacts with no normal impulse do not count. No contact means an immediate zero rolling target with the short playback fade below. `scripts/test-landing-sound.ts` covers loop-only rolling, measured travel, a fixed patch, moving/rotating supports, reversed contact ordering, speculative contacts, flight and return.

Rolling's near-rest fade now spans speed ratios 0–0.03 rather than 0.02–0.1: positive slow patch travel is attenuated smoothly instead of being hard-muted below the old 0.06 m/s threshold at the default reference speed. Other loop families keep their original fade range.

Session-109f replays bit-exactly (109 frames). Its actual contact gaps include frames 60–62 and 77–79. The previous 1/60 s gain time constant removed 95% of rolling level over each three-frame gap. Rolling gain now uses a 60 ms time constant for both onset and release: the target is still zero immediately without contact, but a 50 ms gap removes 57% rather than 95%. Sustained flight reduces the remaining level below 1% in 300 ms; the worklet sleeps after nine time constants so it cannot truncate this fade. The tone cutoff holds during contact loss instead of dipping to its slow-speed value. Other loop families retain their existing timing. Envelope measurements are headless; subjective continuity needs browser listening. With patch migration, frames 36–41 measure approximately 1.679, 0.159, 0.054, 0.036, 0.030 and 0.124 m/s: the loop naturally produces much slower rolling than the sphere without a forced mute.

Mounting-loop strikes now emit `loop-hit`, exposed as **Mounting loop impact** in Sounds. They resolve only their own recording and volume; they never select the ball's Light/Medium/Heavy mix or its fallback. Unassigned means silent. V22 uses the fourth supplied cannonball drop at 5.758–5.918 s, native pitch, 3.5 kHz low-pass and a 45 ms tail fade. Its initial event level is −30 dB at 3 m/s. This replaces the previous full layered landing sound for loop hits and makes the event's gain independently editable. Ball landing assignments remain unchanged.

A loop's file is played at a **pace** and a **pitch** set apart, because a rolling ball's sound is two things that answer the speed differently.
The roughness of the ball and the surface is struck at the contact at a rate in proportion to the speed: roll twice as fast and the bumps arrive twice as often, which is the texture, the grit and rumble.
The ball and the surface ring at their own natural frequencies, set by their size, shape and material and not by the speed: rolling faster strikes them harder and more often, it does not retune them.
The original Roll default used **pace follows 1, pitch follows 0** to model this. Listening feedback on the cannonball recording found slow rolls distorted: at 0.3 m/s against a 3 m/s reference, this stretches the recording tenfold. Roll now uses native-pitch grains with no sequential pace. Speed drives level and tone: below reference speed its gain follows speed ratio^1.25, with the near-rest fade described above, and a non-resonant low-pass opens smoothly from 6 kHz at rest to 14 kHz at reference speed. Tone changes smooth over 80 ms. A bass-only attempt was rejected as muffled; its v23 offline candidate remains unassigned. After further ringing feedback, the active original cannonball asset receives peaking cuts at 1570 Hz (−30 dB), 3217 Hz (−18 dB), 3891 Hz (−12 dB), and 4740 Hz (−18 dB), Q 9, targeting measured spectral peaks while retaining broadband detail. These recording-specific cuts apply only to the `roll-cannonball-v20` asset, not arbitrary replacement recordings. Original files are preserved. Spectral analysis identifies resonances, not perceived quality; the revised balance needs listening feedback. Other loop families retain their existing playback settings.

Played faster as a tape (until 2026-11-06, `playbackRate` at speed^0.5), both moved together: the ring rose with the speed, which a ball's does not, and the texture quickened by the square root of the speed rather than the speed.
A whoosh is the other case - air noise has no fixed resonance, its spectrum moves with speed (vortex shedding at a Strouhal frequency, f = St v / d) - so tape-like, pace and pitch together, is its physical choice; the whoosh and the wade keep 0.3 and 0.3, which is exactly how they played before.

A loop voice is a `grain-loop` AudioWorkletNode (`audio/grainWorklet.ts`) running `WsolaLoop` (`audio/grainCore.ts`): **WSOLA**, waveform-similarity overlap-add (Verhelst & Roelands 1993), the textbook time-scale modification and what browsers use for a media element's `preservesPitch`.
The output is 40 ms Hann grains at half overlap, each read at the pitch (resampled, linearly) from where the pace has got to in the file, slid by up to 10 ms to the place that best continues the last grain (normalised cross-correlation over the overlap, a coarse pass every 4 samples then every sample around its best), so the overlapping halves are in step rather than cancelling.
At pace = pitch the best place is exactly the continuation and the output is the file resampled, sample for sample.
The clip's own pitch is a tape's - higher and quicker - so it scales both.
A loop that fades out stops working 9 of its fade's time constants later (`run` 0), so a ball at rest does not pay for a search per hop; it holds its place in the file and carries on from there.

`scripts/test-grain.ts` (in `bun run test`) holds the arithmetic to it: pace = pitch is the file resampled, a chirp's frequency at an output time is the pitch times the chirp's where the pace has got to, only the window is read (wrapping, and after a window change), and a sine at pace 1.6 stays a steady sine at its own frequency (red with the similarity search taken out).
It costs about 1/130 of real time per loop in bun.

## Playing it

`audio/audioOut.ts`.
A rendered frame's steps are queued and scheduled together, each at its own place on the 60 Hz clock with the last 25 ms ahead of the audio clock, so a frame that ran three steps does not land their sounds in a lump.
Once the sim stops stepping (paused, frozen, the settings panel) the loops fade; a hidden tab suspends the context; the editor fades the loops and any one-shot still ringing on leaving ▶ Test.

"Stops stepping" is a step **overdue** - more than a step since the last was scheduled - not a frame that ran none.
Above 60 Hz most frames run none, and fading on each of them (until 2026-11-06) dragged every loop down between steps: a steady loop's gain swung 0.27 to 0.72 at 144 Hz, half its level on average, measured by replaying the schedule through Chromium's own automation in an OfflineAudioContext.
A fade also **cancels** what the steps had already scheduled, because steps are scheduled up to 25 ms ahead and Web Audio orders events by time: the last step's level, landing after a fade timed at `currentTime`, took the loop back up and held it there - which is how a roll used to carry on for ever after ▶ Test was left.
The bank is re-resolved every step, so a changed assignment is heard on the next one.
The context starts on the page's first press (browsers keep audio off until then), sounds are panned by where they happen relative to the camera, and a limiter catches what would clip.
**S → Sound** sets the volume (Off, Low, Medium, High; Medium by default).

`window.__sound` is a live handle: `stats()` (what has played, the loops running and on which file, the output's level) and `startCapture()` / `takeCapture()` (the output itself, as samples).
That is how the pipeline was verified headless: a replay played in Chromium with test files assigned, captured to a WAV and measured.

## The Sounds menu

The editor's **Sounds** button (beside the file controls).

- **Library**: every uploaded file with ▶, its length, the events that play it, and its credit - source, author, licence. Upload… or drop files anywhere on the menu. **Edit** opens the file's clip editor ([below](#clip-edits)).
- **Events**: each family, collapsible, with its Default and surface rows. Drop files onto a row to upload and assign them in one go, drag a library row onto it, or pick from its `+ sound` list; click a file to hear it, × to unassign.

Every change is heard at once - in the editor's ▶ Test, which shares the menu's copy, and in a game open in another tab, told over a `BroadcastChannel` (`rope.sounds`) - and saved to disk a moment later.

The dev server does the work (`src/server/sounds.ts`): an upload is transcoded by ffmpeg to mono Opus at 48 kHz, 96 kb/s, with any leading silence cut and bit-exact output (Ogg's stream serial is otherwise random, and the same file would never hash the same), keyed by its name and the first 8 hex of its hash, written to `public/sounds/` and pinned in `src/audio/soundAssets.json`.
Both manifests are off vite's watcher (a write would reload the editor), and the service reads them from disk on every request.
A dev server started before the service existed answers the menu with the page; restart it.

### Clip edits

A library row's **Edit** opens its clip editor (`editor/clipEditor.ts`): the file's waveform, with the part that plays cropped by dragging its two edges, and the file's own **volume** (dB) and **pitch** (semitones, + is higher and shorter, as a faster tape).
It changes how the file is PLAYED, never the file: the bytes stay the recording that was uploaded, hashed and credited, and the edit is kept in the bank as `clips`, by library key - `{ start, end, volume, pitch }`, each left out when it changes nothing.
So it holds wherever the file is assigned, multiplying the slot's volume and pitch; Reset removes it.

- A one-shot plays only the window (`AudioBufferSourceNode.start(when, offset, duration)`, in the file's seconds whatever the rate).
- A loop loops within it (`loopStart`/`loopEnd`) and starts at a random point inside it; a running loop takes a changed window, gain and rate on its next step.
- The clip's pitch sits outside a loop's two-octave speed hold rather than eating into it.

A drag moves whichever edge is nearer the press, so a click anywhere sets an edge there.
An edge lands on the nearest **upward zero crossing** within 4 ms (Alt places it exactly): a cut mid-swing clicks, and a loop whose edges are both upward crossings meets itself at the seam going the same way.
Dragged to within 4 px of the file's end, an edge is the end - no crop at all.
Releasing an edge plays the clip; the waveform is drawn as loud as the clip's volume makes it, and a playhead follows an audition, delayed by the context's reported output latency so it tracks what is heard.
The row's length turns accent-coloured and shows what the clip plays for, with the edit in full on hover.

The dev server holds an edit to the library and the file's length and refuses a window under 10 ms; removing a file removes its edit, and `cli assets` fails on an edit of a file the library does not have.

## The library in the store

Sound files are stored binaries like every other ([asset-store](asset-store.md)): `public/sounds/` is gitignored, `just publish` uploads what the release lacks (`assets:publish-stored`), and `assets:fetch` brings them back.
`cli assets` holds the library to three things:

- every entry records **source, author and licence** - an upload leaves them blank, because a guess would be a wrong credit rather than a missing one, and the menu marks the blank fields;
- every sound is **played by some event**, and every assigned sound exists - a file tried and replaced is still fetched by every build until it is removed (Remove is enabled once nothing plays it);
- CREDITS.md, which lists them under Sounds, is current (the service regenerates it).

The licence has to allow redistribution (CC0, CC BY, CC BY-NC are fine; see [asset-store](asset-store.md)), because the release hosts the file itself: Freesound (filter by licence) and Kenney's CC0 packs fit, Sonniss, Zapsplat and Pixabay do not.

## What green cannot see

Whether anything sounds right, which only playing it answers.
Ogg Opus decodes in Chromium and Firefox; Safari's support for it in `decodeAudioData` has not been tried, and a file that fails to decode is a console warning and silence for that event.

## Mix balance

Per-recording clip gain now brings the loudest 50 ms to −20 dBFS before event gain. This compensates the Light recording's roughly 18 dB source-level deficit without rewriting its audio. `tools/audio/balance.py` prints measurements and a proposal; `--apply --server http://127.0.0.1:3100` saves a backup and applies through the Sounds API. Clip trims/pitch remain. This is a transient reference, not perceptual loudness normalization. Rolling is excluded and measured after grain processing/filtering in the browser.

Current event gain/reference-speed pairs: Light −2 dB/1 m/s, Medium 0 dB/3.5 m/s, Heavy +2 dB/8 m/s; loop touch −5 dB/1.5 m/s, sphere return −5 dB/0.8 m/s; attach −2 dB/12 m/s, taut −3 dB/3 m/s; wind 0 dB/3 m/s, wraps −4 dB/1.5 m/s including material overrides, deploy −1 dB/12 m/s, slack −3 dB/1 m/s, roll +3 dB/3 m/s. Master levels and limiter remain unchanged. Only assigned events are calibrated.

Browser capture at Medium measured Light/Medium/Heavy near −28/−24/−22 dBFS over their loudest 50 ms, versus the previous −45/−26/−23. Quiet contacts rose from about −57 to −61 dBFS to around −32. Representative rolling/chain scenarios measured −29 to −34 dBFS. A combined-effects capture at High peaked near −3.2 dBFS, with digital silence after stopping. These are technical measurements, not a subjective balance guarantee.

`playbackLevel.ts` still limits per-link intensity at its reference speed and divides amplitude by the square root of overlapping links (speed / link length × edited playback duration). Faster link emission adds texture without unbounded summed power. Ordinary isolated impacts retain the two-times gain ceiling. Raw candidate matching in the lab remains separate from the game mix.

Landing contact gating ignores speculative contacts with no maximum normal impulse. A new piece whose outward normal aligns with support seen within the last three steps (dot product > 0.9) continues the existing rolling contact rather than emitting a landing. A different-facing wall can still trigger while grounded, and an airborne gap rearms landing. In the supplied `session-254f.json`, this removes 17 seam/speculative-contact cues while retaining the initial landing at frame 9. No simulation state is changed.

The mounting loop tracks force-bearing arrivals separately from the sphere. Its first strike emits `loop-hit` even while the sphere stays grounded; approach speed includes previous angular velocity at the contact arm. The sphere's return uses `ball-settle`, while ordinary/hard landings use the strength mix. Continued support does not repeat these cues. `StrikeCue.source` distinguishes loop from ball for diagnostics.

V15 layers a short, damped metal-object recording onto Light/Medium/Heavy and hook attachment while retaining the underlying chosen impacts at original pitch. The independent mounting-loop strike uses the same impact mix. Chain winding, deployment, slack, taut catch, and wrap variants now use lower-pitched (−17 semitones), low-passed (3 kHz) chain grains, with slightly longer damped tails. Previous chain-event RMS is retained as a mix baseline; wrap material contacts remain separate. These are recording edits awaiting listening feedback, not newly recorded heavy iron links.

V16 revises only the chain recordings after v15 quality feedback: a main detail layer at −10 semitones/8.5 kHz plus a quiet damped weight layer at −18 semitones/1.5 kHz. It avoids pitching and filtering the entire texture as aggressively as v15. The v15 ball/hook impact overlays and mix controls remain assigned. This is still processing of the small-chain original, not a recorded heavy-chain replacement.

V17 replaces the chain source with the user-supplied `209329-EFX_SD_Chain_Movement_02.mp3` at original pitch, with only gentle 45 Hz/14 kHz filtering and short edit fades. Three winding variants and four alternating grains in the deployment/slack loops reduce exact repetition. Taut and all wrap/material variants use the new source too. V15 ball/hook overlays and existing mix controls remain. The original is a 128 kbps MP3; no lossless quality or listening verification is claimed.

## Source-layer editor

Open **Sounds → Edit layers ↗**, **Sound lab → Edit event layers**, or `/sound-layers.html` on the development server. Select an event and its variation. Assigned source recipes are imported into `tools/audio/layer-projects.json`; run `tools/audio/.venv/bin/python tools/audio/seed-layer-projects.py` after registering another offline version. Existing drafts are preserved. Unassigned event families can start with an empty project; material overrides that already have recipes appear separately. Enable **All surfaces** to create an override for any supported material.

The editor uses the original recordings, not flattened preview mixes: nested recorded mixes are expanded, source windows/pitch/filter/fade/normalization settings are editable, and repeated grains are individual timeline clips. Drag clips or their edge handles to move/trim; the layer handle moves all its clips. Click the ruler or enter a playhead time to split a clip there. Arrow keys nudge a focused clip, with Shift for a larger step. Duplicate/delete clips and layers, solo/mute tracks, and undo/redo edits.

Per-layer effects include gain, pitch, pan, high-/low-pass filtering, bass/treble shelves, fades, damping, saturation, compression, delay, and reverb. Preview and export use the same browser OfflineAudioContext renderer. Monitor gain affects listening only. Effect tails are bounded by project length; extend Length to retain them. The peak/RMS meter reports the rendered mix, and **Set −3 dB peak** adjusts mix gain without rewriting sources. Browser biquad filtering/resampling can differ slightly from the original SciPy renderer; this editor's own exported mix is authoritative once applied. Source windows selected for a split get their own fades/normalization; preview the result when splitting a normalized transient.

Edits are preserved as a browser draft. **Save draft** writes the project to disk without changing the game. **New variation** clones the current layers into a new draft. **Apply to game event** renders a lossless float WAV, uploads it through the existing Sounds service, and replaces only the selected variation of that event (or adds a new variation). Slot volume, speed response, other variations, other events, and material aliases remain unchanged. The updated bank is broadcast to open game/editor tabs. Render clipping and silent mixes are rejected before assignment. Existing bank assignments are checked again after upload to avoid overwriting a changed variation. The original WAVs and editable projects remain available; superseded unused game assets are removed through the normal Sounds API.

`/api/sound-layers` is dev-only: GET the catalog, GET `/file?id=…` for a catalogued source within the audio workspace, PUT `/project` to save validated authoring data, POST `/source?name=…` to import an audio recording (64 MB / ten-minute limit). Imported binary originals are ignored under `tools/audio/layer-uploads/`; their metadata lives in the catalog. Source/author/licence fields are preserved, including unknown fields left blank. `/api/sounds?keepLeading=true&stereo=true` retains intentional timeline silence and per-layer stereo panning for exports; ordinary Sounds uploads retain their leading-silence trim.

V18 uses the subsequently supplied `01KJACN9FGFV9BA7QW7J5S2YX0.mp3` for chain effects at original pitch. The original is approximately 18.6 seconds, 48 kHz stereo, 128 kbps MP3. Its four transient windows drive three winding variations, deployment/slack, taut, and wrap/material effects. V15 ball/hook impact overlays and the mix balance are retained. V17 remains archived and editable for comparison.

V19 follows feedback that the impact overlay sounded too sharp and plate-like. Its layer gain drops about 10.5 dB (0.15 → 0.045), with an 800 Hz low-pass, −19 semitone pitch, 1.5 ms fade-in, 20 ms decay, and 70 ms maximum duration. The existing impact bed keeps its original gain/pitch; v18 chains are unchanged. The editor exposes this as its own dull-metal-overlay layer.

V20 replaces that overlay across Light/Medium/Heavy and hook attachment with the fourth impact in the supplied `cannonball_drops.m4a`, source window 5.758–6.078 s. It retains native pitch, uses a quiet normalized layer gain of 0.045 and short edit fades, and preserves the underlying chosen impact beds. Roll now uses the continuous 8.6–13.4 s section of `cannonball_rolls.m4a` at native pitch with 35 ms boundary fades. Existing event levels and rolling speed controls remain; v18 chains are unchanged. Original M4A files, hashes, archived candidates and separate editable layers are retained. Sample peaks are −3 dBFS without full-scale samples; perceived balance and loop smoothness still require listening.

### Mixer workspace and controls

The Just Swing mixer uses the shared midnight authoring theme in `src/styles/studio.css`. Event/variation and searchable source recordings occupy the left dock, the transport and timeline occupy the center, and layer/clip properties occupy the independently scrolling right inspector. Smaller screens stack these areas. Stop stays beside Play mix; Save draft, Export WAV and Apply to game event remain separate actions. Filtering to no sources disables Add layer and explains how to recover.

Mix, tone/envelope and effects use remembered disclosure state for the current page. Gain, pitch, pan and bounded effect amounts pair a slider with exact numeric entry; a slider gesture commits one undoable edit. Muted tracks show their state and dim their waveforms. Mute/solo controls have full accessible names and pressed state. Clip keyboard selection and repeated nudging retain focus; selecting a clip with Space does not also start playback. Native button/disclosure keyboard behavior takes precedence over the workspace playback shortcut. No rendering or game assignment rules change with this interface.
