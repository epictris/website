# Sound

The game's sound is files, assigned to the game's sound **events** in the editor's **Sounds** menu.
Nothing is synthesised at run time: a first version (2026-11-06) generated every sound in the browser from physics - Hertz contact times, modal synthesis, roughness profiles played at the rolling speed - and was rejected on first listen as sounding awful.
What survived it is everything upstream of the sound itself: the events, the surfaces, the timing.

Where the files come from is the library's business, not the game's: recordings (Freesound's CC0 search, Kenney's packs), or files rendered offline.
`scripts/sfx.ts` renders one designed sound per event (`bun scripts/sfx.ts <outdir>`): layered noise bursts, pitch-swept thumps, inharmonic rings and granular grit with hand-chosen envelopes, the way an effect is built in a DAW rather than derived from the sim's numbers, seeded so a sound renders bit-identically.
Its output is uploaded through the menu like any other file, and whether it sounds right is judged by ear, as with everything here.

## The boundary

For offline creation and feedback, see [the audio workstation](../tools/audio/README.md): editable stems and REAPER projects, repeatable recipes, source provenance, technical analysis, and `/sound-lab.html` for matched-level A/B comparisons and exportable listening notes. It is linked from **Sounds → Compare sounds ↗**. Candidates stay outside the game's library until uploaded and assigned.

**Sound never touches the sim**, the sparks' rule ([sparks](sparks.md)) held the same way.
`audio/soundObserver.ts` reads a `BallLevel` after every step and writes nothing back; it is fed by `stepLevel` in `main.ts` beside the sparks, the debris and the reeling chain, skipped where they are (a replay seeking), and by the editor's ▶ Test loop.

Most of what is heard is read straight off the world: the ball's contacts (`World.frameContacts`), its velocity, how deep it is in water (`submerged`), and the coil (`Rope.coiledLength`, a read-only getter).
The hook's touches are the exception, because the sim keeps them to itself - an attach removes the hook inside its own step, and a bounce is reflected before the contact solver sees it - so they come through `BallLevel.soundEvents` (`level/soundEvents.ts`), a per-frame list cleared at the top of every `physicsProcess`, written from the hook's attach and bounce callbacks in `spawnBody`, and never read by the sim.
The bounce callback carries the struck piece for this, and every mounted shape carries its authored `material` (`CollisionShape2D.material`), which nothing in the sim reads either.
`replay selftest` stays bit-exact and the bundle corpus replays as before.

## What is heard

Per step, `SoundObserver` reports:

- **Roll**: each surface the ball is in contact with, and how fast the contact moves across it (the ball's velocity relative to the surface, along it).
- **Land**: the ball arriving on a piece it had not touched for 3 steps, at its speed INTO the piece - last step's velocity plus this step's gravity, because by the end of the step the contact solve has cancelled the arrival.
- **Attach** and **Bounce**: the cuff's arrivals. A bounce is a strike only when it ends a flight or follows 2 silent steps (a dragged tip is re-deflected every step, and those normals are the face's facets, not new hits - the sparks' rule again), at its speed into the face; an attach at the cuff's whole speed, which it spends stopping in what it bit.
- **Wind**: one cue per chain link (3.8 cm) the coil grows by, placed within the step where the link landed, at the winding speed. Unwinding is silent, and the count restarts from wherever the coil is.
- **Whoosh**: the ball's speed through the air (none of it under water).
- **Splash** and **Wade**: going into water (the downward speed), and moving through its surface (speed relative to the flow, weighted by how much of the ball is at the surface).

Strikes under 0.15 m/s are not played: a settling body reports a great many of them.

## Surfaces

`audio/surfaces.ts` classifies a piece, most specific first: mud (`viscosity`), rubber (a belt), vine, wood (a root), the piece's authored `material`, metal (a rail), stone (hook-proof), wood (any moving body, whose mass was computed as wood), and otherwise **moss** - scenery the cuff bites.
In `BALL` that puts the dark rocks and boulders on stone, the mossy rocks on moss and the roots on wood.
Authoring `material` on a piece is how to give it a different sound.

## Events and slots

`audio/slots.ts` lists the events (`FAMILIES`).
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

A loop's file is played at a **pace** and a **pitch** set apart, because a rolling ball's sound is two things that answer the speed differently.
The roughness of the ball and the surface is struck at the contact at a rate in proportion to the speed: roll twice as fast and the bumps arrive twice as often, which is the texture, the grit and rumble.
The ball and the surface ring at their own natural frequencies, set by their size, shape and material and not by the speed: rolling faster strikes them harder and more often, it does not retune them.
So a faster roll is a quicker, louder texture at the same pitch - Roll's defaults, **pace follows 1, pitch follows 0**.

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
