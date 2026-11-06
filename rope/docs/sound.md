# Sound

The game's sound is recorded files, assigned to the game's sound **events** in the editor's **Sounds** menu.
Nothing is synthesised: a first version (2026-11-06) generated every sound from physics - Hertz contact times, modal synthesis, roughness profiles played at the rolling speed - and was rejected on first listen as sounding awful.
What survived it is everything upstream of the sound itself: the events, the surfaces, the timing.

## The boundary

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
- **reference speed**, m/s: a one-shot at this speed plays at its volume, scaling in proportion with speed up to twice as loud; a loop plays at its own pitch and volume there;
- **pitch ±** (one-shots): random detune per play, in semitones;
- **pitch follows** (loops): 0 never changes pitch, 1 is pitch in proportion to speed, held within two octaves.

A loop's level grows with speed in proportion, except the whoosh, which grows as its square (moving air's pressure goes as the dynamic pressure), and each fades in from rest.

## Playing it

`audio/audioOut.ts`.
A rendered frame's steps are queued and scheduled together, each at its own place on the 60 Hz clock with the last 25 ms ahead of the audio clock, so a frame that ran three steps does not land their sounds in a lump.
A frame that runs no steps (paused, frozen, the settings panel) fades the loops; a hidden tab suspends the context; the editor fades them on leaving ▶ Test.
The bank is re-resolved every step, so a changed assignment is heard on the next one.
The context starts on the page's first press (browsers keep audio off until then), sounds are panned by where they happen relative to the camera, and a limiter catches what would clip.
**S → Sound** sets the volume (Off, Low, Medium, High; Medium by default).

`window.__sound` is a live handle: `stats()` (what has played, the loops running and on which file, the output's level) and `startCapture()` / `takeCapture()` (the output itself, as samples).
That is how the pipeline was verified headless: a replay played in Chromium with test files assigned, captured to a WAV and measured.

## The Sounds menu

The editor's **Sounds** button (beside the file controls).

- **Library**: every uploaded file with ▶, its length, the events that play it, and its credit - source, author, licence. Upload… or drop files anywhere on the menu.
- **Events**: each family, collapsible, with its Default and surface rows. Drop files onto a row to upload and assign them in one go, drag a library row onto it, or pick from its `+ sound` list; click a file to hear it, × to unassign.

Every change is heard at once - in the editor's ▶ Test, which shares the menu's copy, and in a game open in another tab, told over a `BroadcastChannel` (`rope.sounds`) - and saved to disk a moment later.

The dev server does the work (`src/server/sounds.ts`): an upload is transcoded by ffmpeg to mono Opus at 48 kHz, 96 kb/s, with any leading silence cut and bit-exact output (Ogg's stream serial is otherwise random, and the same file would never hash the same), keyed by its name and the first 8 hex of its hash, written to `public/sounds/` and pinned in `src/audio/soundAssets.json`.
Both manifests are off vite's watcher (a write would reload the editor), and the service reads them from disk on every request.
A dev server started before the service existed answers the menu with the page; restart it.

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
