# Ball & chain audio workstation

Run commands below from `rope/`. Everything is local; there is no ElevenLabs integration or external listening service.

## Audition and feedback

Start `bun run dev`, open `/sound-lab.html`, and press **Load rendered candidates**. The editor's **Sounds → Compare sounds ↗** opens the same page. Drop any audio file to compare it, including individual stems or a REAPER export.

Set candidates to A/B, choose light/medium/heavy gain, and compare once, looping, or at six impacts per second. The repetition test bounds the sum by reducing each hit's gain according to the maximum number of overlapping tails; it is a texture/repetition test, not the game's actual event mix. Use the editor's **▶ Test** for gameplay timing, collision speeds, and the final mix.

Active-RMS matching excludes samples below a relative −40 dB gate and uses one shared target/peak ceiling for the loaded candidates. This is an approximate level comparison, not perceptual loudness matching. Output starts at −12 dB. Stop or changing playback settings cancels all preview voices; a hidden tab stops them too.

Favorites and notes stay in browser storage, indexed by the input file's SHA-256. **Export feedback** downloads names, full hashes, notes, favorites, A/B choices, and playback settings. A revised render has a new hash and its own notes. Export before clearing browser storage. Files themselves are not retained by the browser or uploaded. **Download WAV** exports the decoded candidate at its original level, without audition gain or strength; keep the source WAV for archival quality.

The starter set contains three procedural landing directions, a short winding-link cue, and a landing with a recorded chain layer. These are listening candidates, not approved sounds. The game bank remains separate: upload a chosen WAV through **Sounds**, fill its source/author/license, and assign its event there. The existing `scripts/sfx.ts` can render candidates for every event, including rolling and water (`bun scripts/sfx.ts tools/audio/out/legacy`).

## Render and analyze

```sh
bun run audio:setup
bun run audio:sources
bun run audio:render
bun run audio:analyze tools/audio/out/land-weighty-v1/land-weighty-v1.wav
```

Python dependencies are pinned in `requirements.txt`; `.venv`, `.local`, `out`, and `sources` are ignored. FFmpeg is needed to import formats SoundFile cannot decode. Sources are fetched only by the explicit `audio:sources` command; each recording is pinned by SHA-256 and has explicit provenance in `source-library.json`.

Edit `recipes.json` to make a revision, giving it a **new versioned name**. The renderer refuses to overwrite a candidate whose recipe differs. A render writes the mix, separate float WAV stems, an editable REAPER project, its recipe, and a measurement report. The recorded layer supports pitch, low-pass frequency, and gain independently of the synthesized layers. Stem gains are baked with one common scale, so their sum is the intended mix. Seeds and recipes make repeated local renders bit-identical; dependency/platform changes should be checked by hash rather than assumed identical.

To rerender one candidate from its saved recipe into another directory:

```sh
tools/audio/.venv/bin/python tools/audio/audio.py render \
  --recipe tools/audio/out/land-chain-foley-v1/recipe.json --out /tmp/audio-revision
```

To import another licensed recording while retaining the original and its credit:

```sh
tools/audio/.venv/bin/python tools/audio/audio.py import /path/to/recording.wav \
  --source 'original source URL or recording details' --author 'recordist' --license 'CC0-1.0'
```

Analysis reports sample peak, RMS, gated RMS, crest factor, DC, spectral centroid, relative onset/tail, full-scale samples, and loop boundary jump. It cannot establish timbre quality, true-peak safety, or perceptual loop smoothness. Nothing in this workflow claims that an agent has listened.

## REAPER

REAPER 7.85 Linux x86_64 is extracted locally under `.local/reaper_linux_x86_64/REAPER/`. The wrapper uses an isolated configuration under `.local/config/`; no system install is required. REAPER is evaluation software; this setup does not purchase or provide a license. Official download: <https://www.reaper.fm/download.php>.

```sh
bun run audio:reaper /absolute/path/to/candidate.rpp
bun run audio:reaper -peaktest /absolute/path/to/candidate.rpp
bun run audio:reaper -renderproject /absolute/path/to/candidate.rpp
```

The generated project renders to `<candidate>-reaper.wav`, separately from its original mix. Use the project's body/metal/detail/recording track controls for revisions. Save your edited project under a new name before preserving another version. Absolute paths avoid REAPER's resource-directory changes. GUI/render commands require access outside a restricted sandbox; a dry peak test works without a GUI here.

For scripted rendering of a project with current track edits, `render.lua` configures a 48 kHz mono WAV and triggers REAPER's render action:

```sh
bun run audio:reaper /absolute/path/to/candidate.rpp \
  /absolute/path/to/rope/tools/audio/render.lua
```

For a new checkout, extract the official Linux x86_64 archive under `.local/` before using the wrapper. This workstation used <https://www.reaper.fm/files/7.x/reaper785_linux_x86_64.tar.xz>, archive SHA-256 `b962c40a51535d2faf9796f56270f9e331c9d424b5741472277d7bfd6c4893ac`.

## Recorded source

[Small metal chain #4](https://bigsoundbank.com/small-metal-chain-4-s0358.html), DenisChardonnet, CC0-1.0. The source page explicitly permits editing and redistribution. Original WAV: 44.1 kHz stereo; the candidate's recorded layer is folded to mono, pitched down five semitones, and low-pass filtered. See `source-library.json` for its original-byte hash and download URL. This credit must travel with an uploaded derivative alongside the project's procedural contribution.
