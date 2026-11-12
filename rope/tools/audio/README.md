# Ball & chain audio workstation

**v40 rolling refinement** follows listening feedback: v39 variant 2 is preferred,
but contains unrelated bumps and intermittent high ringing. Run
`tools/audio/.venv/bin/python tools/audio/refine-roll.py` after building v39.
In the lab select **v40**: 1 preferred reference, 2 short peaks attenuated,
3 the same with time-varying narrow resonance reduction. All retain chronological
playback and native pitch, with matching RMS. Peak-to-RMS falls from 24.22 to
about 18.3 dB; this measures transient reduction, not perceptual success.
No game assignment changes. Larger surface bumps should come from game contact
events; these auditions aim to supply a less eventful continuous texture.

**v39 rolling comparison**: run `tools/audio/.venv/bin/python tools/audio/compare-roll.py`,
then load rendered candidates in `/sound-lab.html` and select **v39**. Compare
1 original (8.6–13.4 s), 2 assigned processed OGG, 3 production granular renderer
at steady reference speed, and 4 minimally processed continuous loop. Files share
an RMS target with a −3 dBFS sample-peak ceiling; this is not perceptual loudness
matching. Candidate 4 uses a measurement-selected 10.35–12.35 s source window,
35 Hz high-pass and 100 ms complementary loop crossfade. Selection cannot identify
background sounds by meaning; listening approval is pending. Candidate 3 includes
the reference-speed tone filter but excludes spatialization and motion envelopes.
Source hashes, edits, measurements, and REAPER projects accompany each WAV.
Game assignments are unchanged. The main renderer rebuilds the manifest, so rerun
this comparison builder afterward to restore these entries.

**v32 chain retract** (2026-11-09): `tools/audio/.venv/bin/python tools/audio/build-retract.py` cuts the released chain's **zip** (three ~110 ms windows of the full rattle, 0.08-0.31 s) from the deploy's own source, `large_iron_chain_drop_1.m4a`, unfiltered at native gain with a 10 ms fade in, and assigns **Chain retract** at the volume that puts it 7 dB under the deploy by measured RMS (−16 dB since the deploy went to −9 dB; rerun it after changing the deploy's volume). v31 low-passed them at 3 kHz and they sounded wet. There is no seat (a sound as the chain's end reaches the loop): a cut of the source's last settling link, the Chain link impact clinks and one Wind link were each rejected by ear, and the slot was removed. Windows are recorded in `retract-cuts.json`; rebuilding replaces the previous cuts. Waveform-selected and level-matched, awaiting listening (docs/sound.md, Retract).

Latest: **v26 distinct quiet loop/sphere contacts**, **v25 cleaned rolling texture**, **v20 impact beds**, and **v18 chains**. Rolling uses random short grains instead of repeating the recording's multi-second envelope. The fourth drop remains the impact overlay source. All retain native pitch, archived originals and editable authoring sources. Open `/sound-layers.html` to edit event layers, preview, save drafts and apply mixes.

Current chain source is the user’s **209329-EFX_SD_Chain_Movement_02.mp3**, used for **v17** at original pitch. It is a 44.1 kHz stereo, 128 kbps MP3, about 159 seconds long. Original bytes and hash are archived; author/licence remain unverified. Four transient windows supply three winding variations, varied deployment/slack sequences, a taut catch, and all six wrap/material designs. The previous small-chain layers are removed; existing material contacts remain. Event RMS is matched approximately to v16, and v15 ball/hook metal overlays remain. These are waveform-selected cuts awaiting listening assessment.

Current chain revision is **v16**, following feedback that v15 sounded low quality. It restores a detailed main grain at −10 semitones with an 8.5 kHz low-pass and adds a quieter, damped weight layer at −18 semitones/1.5 kHz, instead of deeply pitching and dulling the entire recording. All ten chain candidates retain event timing, material layers, and approximately matched event RMS. V15 ball-impact and hook-attachment overlays remain assigned. This still derives from a small-chain source; perceived fidelity and heavy-link realism require listening assessment.

Current set is **v15**: Light/Medium/Heavy ball impacts and hook attachment retain their existing recordings with a separate short, damped metallic overlay from the supplied metal-object recording. Winding, deployment, slack, taut catch, and all material wrap variants use the chain source at −17 semitones (previously −9), a 3 kHz low-pass, and slightly longer damped grains. Chain event RMS is matched to the preceding renders to preserve the recent mix balance; this is a technical level match, not listening verification. Wrap contact layers and event gating remain intact. Swinging creaks stay unassigned. Register using `python3 tools/audio/register.py --version v15 --local-preview`; filter **v15** in the lab to compare all 14 revisions.

Current Heavy landing is **v14**, replacing the v13 heavy file with the user's `314632-Rock_impact_-single_stone_5.mp3`. The source window is 0.024–0.165 s, with a 20 ms tail fade, cutting before the later noisy scraping/handling section. Original pitch and the initial impact are retained. Light v14 now uses the same 314625 stone-4 source as Medium at original pitch, with a 2.8 kHz low-pass, 4 ms fade-in, and shortened 0.020–0.160 s window with a 20 ms tail fade. This follows the user's request for Light to sound more like Medium; it replaces the previous dull metal Light. Medium remains v13 and velocity-layer selection is unchanged. `python3 tools/audio/register.py --version v14 --local-preview` registers Heavy and Light. Previous recordings remain in the lab for comparison.

Current landing set is **v13**, selected by velocity rather than randomly choosing a strength or playing one thud at different volumes. Heavy uses the user's `314636-Rock_impact_-single_stone_9.mp3`, Medium uses `314625-Rock_impact_-single_stone_-light_4.mp3`, both at original pitch with leading silence removed and peaks kept below clipping. Light is a distinct deeper/duller metal-object contact using a short, pitched-down/damped cut of `581592__samsterbirdies__saw-metal-bounce-1.wav` plus a short low contact body from the concrete recording. It contains no winding/chain sample. Original files are retained and pinned in `local-sources.json`; author/licence fields remain unverified where not supplied.

The lab's **Test game landing** control uses the actual game playback/mixer. Enter 0.8, 3.5, or 8 m/s for pure Light, Medium, or Heavy. Speeds 1.2–2.4 m/s blend Light/Medium; 4.5–6.5 m/s blend Medium/Heavy with equal-power weights. The test honors the Output level but does not apply candidate RMS matching. Changing the monitor level or pressing Stop cancels the test, including a pending decode. Individual candidate playback's **Candidate gain** remains a simple monitor adjustment. Surface-specific overrides resolve within each strength. A legacy bank with only Land still plays its single fallback once. `python3 tools/audio/register.py --version v13 --local-preview` registers the complete set and unassigns obsolete single-thud landing files, while preserving other events. Their old WAVs remain in the lab.

Current user choice: swinging creaks are disabled for now. The Creak slot has no assigned files; its original candidate WAVs and recipes remain available for later review. Other sound assignments, including geometry-wrap, remain enabled. Do not rerun v10/v11 registration to re-enable swinging unless the user asks to resume it.

Current geometry-wrap audio is **v12**, a set of short link/material impacts with no swing-creak source. **v12 → Once** auditions six designs: plain links (fallback), stone/brick, wood/vine, metal, earth/moss, and soft mud/rubber. Each is a 65 ms event built from the approved winding grain plus a short contact layer appropriate to the available recordings. Rare unassigned materials such as glass/ice currently use plain links. These are provisional designed layers; they are not recordings of a chain hitting every material. `python3 tools/audio/register.py --version v12 --local-preview` registers the material aliases without re-enabling swinging. The wrap observer now emits on initial loaded contact and per link of actual surface travel, with sub-step timing; bend changes alone no longer trigger impacts.

Run commands below from `rope/`. Everything is local; there is no ElevenLabs integration or external listening service.

## Audition and feedback

Current balance: `tools/audio/.venv/bin/python tools/audio/balance.py` reports a proposed source/event calibration; add `--apply --server http://127.0.0.1:3100` to apply through the Sounds API with a backup. Source trim/pitch are retained; assigned recordings use a −20 dBFS loudest-50-ms baseline, except rolling which is measured after runtime processing. Event levels preserve Light/Medium/Heavy progression and make both quiet contacts audible. See `docs/sound.md#mix-balance` for levels and browser output measurements. Source gain lives in each clip's Volume, while event Volume remains independently adjustable. Unassigned events are not enabled by calibration.

To reproduce current rolling: run `tools/audio/.venv/bin/python tools/audio/dering-roll.py` before `audio.py render`, then register v25. It preserves broadband texture while reducing narrow source modes rather than applying the rejected bass-only low-pass. V26 uses separate 100 ms loop ticks and 160 ms lower sphere thuds; register v26 and rerun calibration after assigning new files. Earlier v24 shared taps and v23 muffled candidates remain archived.

**V24 gentle contacts** assigns one short, softened cannonball tap to two independent events: **Mounting loop impact** and **Ball returns from loop**, each at −30 dB initially. The latter bypasses the harsh normal landing mix for a short return after loop-only support. Hard or delayed falls keep normal landings. Register with `python3 tools/audio/register.py --version v24 --local-preview`. Originals and previous candidates remain archived. Rolling playback now uses random level-controlled 160 ms recording grains rather than repeating the recording's multi-second swell; its contact-motion observer and resonance filtering remain render-side.

The bass-only **v23** rolling candidate was rejected as muffled and is **not assigned**. The game retains the original v20 recording with narrow runtime cuts at measured ringing peaks (1570/3217/4740 Hz), preserving surrounding texture. Rolling intensity now measures geometric contact-patch travel for both the sphere and mounting loop relative to the supporting surface; see `docs/sound.md` for the approximation and replay measurements.

**V22 mounting-loop impact** is a separate `loop-hit` event, using a short, softened fourth-cannonball-drop cut rather than the ball's layered landing mix. **Sounds → Mounting loop impact** controls it independently, initially −30 dB at 3 m/s. Register with `python3 tools/audio/register.py --version v22 --local-preview`; the existing ball impact assignments are preserved.

The natural-speed **v21** rolling candidates are separate stereo cuts of the first rundown in `fast_to_slow_roll.m4a`: Fast 0.3–2.8 s, Medium 3.2–5.7 s, Slow 6.0–8.0 s. Run `tools/audio/.venv/bin/python tools/audio/cut-roll-speeds.py` to reproduce them and add them to the lab manifest (rerun after the main renderer, which rebuilds that manifest). Original levels and native pace/pitch are preserved, with 35 ms edge fades. Each output has its source-window metadata and a REAPER project. These are chronological speed bands for listening review, not calibrated velocities or certified seamless loops. They are not assigned as random Roll variations; speed crossfading would require a separate playback change.

Start `bun run dev`, open `/sound-lab.html`, and press **Load rendered candidates**. The editor's **Sounds → Compare sounds ↗** opens the same page. Drop any audio file to compare it, including individual stems or a REAPER export.

Click **All**, **v1**, **v2**, or **v3** to filter loaded candidates. Version buttons are generated from filenames, so later versions appear automatically. The selected filter survives a reload. Notes and favorites are preserved while filtering; A/B selections stay selected so they can compare different versions. Export includes all loaded candidates and records the selected filter. Each card identifies the gameplay event; chain-foley is the ball landing on a metal surface.

Set candidates to A/B, choose light/medium/heavy gain, and compare once, looping, or at six impacts per second. The repetition test bounds the sum by reducing each hit's gain according to the maximum number of overlapping tails; it is a texture/repetition test, not the game's actual event mix. Use the editor's **▶ Test** for gameplay timing, collision speeds, and the final mix.

Active-RMS matching excludes samples below a relative −40 dB gate and uses one shared target/peak ceiling for the loaded candidates. This is an approximate level comparison, not perceptual loudness matching. Output starts at −12 dB. Stop or changing playback settings cancels all preview voices; a hidden tab stops them too.

Favorites and notes stay in browser storage, indexed by the input file's SHA-256. **Export feedback** downloads names, full hashes, notes, favorites, A/B choices, and playback settings. A revised render has a new hash and its own notes. Export before clearing browser storage. Files themselves are not retained by the browser or uploaded. **Download WAV** exports the decoded candidate at its original level, without audition gain or strength; keep the source WAV for archival quality.

The starter set contains three procedural landing directions, a short winding-link cue, and a landing with a recorded chain layer. Both v1 and v2 remain available for comparison. The feedback in `feedback/2026-11-08-v1.json` asks for heavy metallic thuds without sustained ringing, and a short winding clink without its laser-like layer. The v2 landings use lower body frequencies, no pitch sweep, and metallic layers cut at 25–50 ms. The winding v2 removes its body oscillator and ends its metallic layer at 22 ms. The recorded chain layer is cut at 55 ms.

The v2 feedback is archived in `feedback/2026-11-08-v2.json`: landings sound too hollow and should be denser; winding should be softer, less harsh, more metallic, and have a slightly longer tail. V3 replaces most of each landing's bass oscillator with short band-limited contact noise, retaining a brief metallic attack. Winding v3 has a lower metallic fundamental, less noise, a gentler attack, and a longer decay. These changes await listening feedback.

The v3 feedback is archived in `feedback/2026-11-08-v3.json`: add much more bass for a heavy iron sphere hitting concrete, and make winding softer and more metallic. V4 retains the short contact layers and adds an independent damped bass stem. The winding cue removes the noise layer, softens the metallic attack, and lowers the original output level by 5 dB. Active-RMS matching in the lab compensates level differences; turn it off to compare the original playback levels.

V4 still sounded hollow and high pitched to the user. Their preferred winding timbre was the actual recorded chain layer in the metal landing. V5 changes the approach: `recordedLayers` bypasses the procedural generator entirely. Landings use a cropped real hammer/concrete impact, pitched down into separate contact and low-body stems, low-pass filtered and damped before later bounces. There are no oscillators or synthetic ringing modes. Winding uses the same source, pitch, low-pass filter, and 55 ms crop/fade as the preferred chain layer, normalized to a quieter −12 dBFS peak. Its waveform matches that layer up to overall gain. V5 also replaces the metal landing's old synthesized body while retaining the chain detail. These are recording-led candidates for the user's listening assessment, not a claim that the desired timbre has been achieved.

The user then provided `Rock Drop On Dirt Thud 05.mp3` and requested trying that source. V6 uses this recording at its original pitch, converted to mono and trimmed by 52 ms to remove leading silence. The baseline adds no EQ, synthesized layers, or pitch shift. The metal-surface variant adds a quiet layer of the preferred chain recording. Its embedded metadata identifies the publisher as Vadi Sound and album as Crash Course; the download URL and licence are still unconfirmed. `local-sources.json` pins the exact original bytes, retained under `sources/rock-drop-dirt-05.mp3`. This local source is not downloaded by `audio:sources`; another checkout needs the user's original file. Licence fields remain blank pending source details, rather than claiming CC0.

The winding v5 timbre was close to the user's goal but sounded low quality. V7 preserves the original source and −9 semitone pitch, widens the low-pass from 2.2 to 7.5 kHz, and extends the recording window from 55 to 85 ms with a 12 ms tail fade. It retains the −12 dBFS peak. This is a bandwidth/envelope revision for listening comparison; it does not establish perceptual fidelity or recover detail absent from the source recording.

The user approved winding v7 and requested deploy and moving-slack rattles from that base, then a cue when the chain goes taut. V8 adds two looping recordings built from the identical processed source grain, with irregular timing and small pitch/level variations: dense deploy (0.72 s), quieter slack (2.4 s). Events crossing the loop boundary wrap into the start; there is no overall fade that would cause a periodic volume dip. A separate 80 ms taut catch is a short overlapping cluster of that same grain. In the lab choose **v8**, with **Playback → Loop** for the rattles or **Once** for the catch. **Chain deploy** follows flight/payout; **Slack chain** follows the cosmetic drape's relative node motion, including airborne slack and dragging, and becomes silent when settled, taut, or stowed. **Chain goes taut** is a one-shot with slack hysteresis, not repeated while tension is held. Volume, reference speed, and pace can be adjusted in the game's Sounds menu. `python3 tools/audio/register.py --version v8` registers just these three new slots, leaving winding and landings unchanged.

V9 uses the user's `41584-FOLEY_IMPACT_EARTH_DIRT_SCATTER_01.mp3` as the default **Attach** sound, at original pitch with no EQ and the first 22 ms removed for responsiveness. It retains the impact and scatter tail. `local-sources.json` pins its original bytes; source URL, author, and licence are not yet supplied, so unknown metadata stays blank. `python3 tools/audio/register.py --version v9 --local-preview` registers the local audition in Attach only, leaving the other slots unchanged. Surface-specific Attach assignments can override this default through the Sounds menu. In the lab select **v9 → Once** to hear it separately.

V10 uses `461978-Swing-Seat-Chains-Hit-Move-Balance-Metal-Squeak-Park-Playground.mp3` for **Taut-chain creak**. The original is retained as `sources/swing-chain-creak-rz-post.mp3` and pinned in `local-sources.json`; embedded artist metadata is RZ Post, with source URL/licence not yet provided. Three tonal passages are cut from 1.285–1.405 s, 1.82–1.98 s, and 2.51–2.79 s, avoiding the large early impacts. Short fades and mild band limiting soften cut edges and remove outdoor rumble. The two-second loop uses these separate `creak-a`, `creak-b`, and `creak-c` stems at irregular intervals, retaining source pitch. Windows were selected from the spectrogram and transient/tonality measurements; their perceptual suitability needs listening feedback. **v10 → Loop** auditions the result. `python3 tools/audio/register.py --version v10 --local-preview` registers Creak only. During play it follows angular movement under measured tension, and fades while still or slack; it does not replace the v8 taut catch.

The user found the loop unrealistic and requested better event emission and sound at taut geometry wraps. V11 is the current implementation: **Creak** is a one-shot family with three short, independent source cuts, played from their beginnings. Loaded angular travel triggers phrases; continuous tension alone never repeats audio. Parameters in `src/audio/soundObserver.ts` are `CREAK_ONSET_TRAVEL` (0.03 rad), `CREAK_CONTINUE_TRAVEL` (0.18 rad), `CREAK_GAP` (0.25 s), and `CREAK_REARM_REST` (0.12 s). Increasing travel thresholds makes movement quieter/sparser; increasing the gap reduces overlapping or chattering phrases. Playback level follows angular speed and load, while the sampled pitch is kept stable.

V11 also adds **Chain wraps geometry**, with per-surface slots and a friction/contact recording derived from a creak cut plus quiet winding detail. The observer tracks real scenery-wrap shapes and material arc length, emits at the corner position on a new loaded contact, and retriggers only after meaningful sliding/bend travel and cooldown. Stable shape identity and a short disappearance grace prevent per-frame node recreation or seam flicker from sounding like fresh impacts. Coil nodes on the ball are excluded. These are read-only contact/movement proxies, not a link-level friction simulation. In the lab select **v11 → Once** to compare phrases. `python3 tools/audio/register.py --version v11 --local-preview` replaces Creak and registers Wrap, preserving other events. The v10 loop remains available for comparison; its old registration command is historical and should not be used with the current one-shot family.

For local in-game testing, v6 rock thud is registered as default Land, v6 rock/chain as Land / Metal, and v7 recorded chain as Wind link. Reload an already-open game to load the assignments. `python3 tools/audio/register.py --version v6 --local-preview` registers the landings, and `python3 tools/audio/register.py --version v7` registers winding. The explicit local-preview flag allows missing provenance to remain blank; asset validation will report it until the source/licence is supplied. Normal registration rejects incomplete provenance. The script backs up the previous bank/library under `out/` and verifies the readback. Available registration versions and event slots are discovered from the render manifest; unmodified slots retain their current sounds. Superseded, unassigned entries leave the shipping library; original WAVs remain in `out/` for comparisons. Registration does not publish assets. These assignments are for listening feedback, not an assertion of sound quality.

For later choices, upload a WAV through **Sounds**, fill its source/author/license, and assign its event there. The existing `scripts/sfx.ts` can render candidates for every event, including rolling and water (`bun scripts/sfx.ts tools/audio/out/legacy`).

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

[Hammer fall on concrete](https://bigsoundbank.com/hammer-fall-on-concrete-s1108.html), Joseph SARDIN, CC0-1.0. Original WAV: 48 kHz mono. V5 crops a single transient starting at 0.2115 seconds, then pitches, filters, and damps separate contact and weight layers. The untouched original and SHA-256 pin are retained in the source library. Winding v5 uses the chain at −9 semitones and a 2.2 kHz low-pass, matching the v2 landing's chain layer; v5 derivatives are entirely CC0 recording edits.

[Nail and Hammer #1](https://bigsoundbank.com/clou-et-marteau-1-s0005.html), Joseph SARDIN, CC0-1.0. Recorded hammer/nail impacts on a wooden board. V12 uses a short, unclipped early transient at 1.822–1.863 s as a wood-contact layer beneath the chain grain. `source-library.json` pins the original bytes.

## Edit sources and layers in the browser

Open `/sound-layers.html`, linked from the sound lab and editor Sounds menu. It exposes event variations, original source windows, waveform tracks, clip movement/trimming/splitting, solo/mute, undo/redo, and editable gain/pitch/filter/EQ/fade/damping/saturation/compression/delay/reverb controls. Preview and Export WAV share one offline browser renderer; Monitor affects listening only. Save draft keeps an editable project on disk; Apply to game renders and assigns the selected variation with its event controls preserved. Extend Length for effect tails; Set −3 dB peak measures and adjusts mix headroom.

`tools/audio/layer-projects.json` holds source metadata and editable projects. `tools/audio/.venv/bin/python tools/audio/seed-layer-projects.py` imports newly assigned offline recipes without replacing existing projects. Binary imports live in ignored `layer-uploads/`. The source recordings must remain available locally. See [sound architecture](../../docs/sound.md#source-layer-editor) for persistence, renderer differences, and assignment semantics.

Latest chain revision **v18** uses the newer `01KJACN9FGFV9BA7QW7J5S2YX0.mp3` at native pitch. V17 and earlier remain archived; the layer editor exposes both source recordings. V18's original is 48 kHz stereo, 128 kbps MP3, approximately 18.6 seconds; no lossless-source fidelity is claimed.

V19 softens the ball/hook metallic overlay: relative layer gain is reduced from 0.15 to 0.045 (about 10.5 dB), low-pass is 800 Hz, pitch is −19 semitones, and the attack/damped tail are softened. The underlying selected impacts retain their level and pitch. These controls are editable as the separate dull-metal-overlay track in the browser.
