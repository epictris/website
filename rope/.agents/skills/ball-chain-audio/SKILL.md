---
name: ball-chain-audio
description: Design, compare, and revise sound effects for the ball and chain game in rope/, preserving editable sources and listening feedback.
---

Read `rope/docs/sound.md` before changing event assignments; the project already has a Sounds menu, clip edits, and live game preview. Its earlier physics-derived runtime synthesis was rejected by ear. Work offline and keep sound out of the simulation.

The user excludes ElevenLabs and has deferred external audio-understanding services. Do not claim to have heard a render based on waveform analysis. Technical measurements establish technical properties, not whether a sound feels good.

Use `rope/tools/audio/audio.py` with its isolated `.venv` for rendering, importing sources with explicit provenance, and analysis. `recipes.json` stores seeded candidate parameters; output includes separate body/metal/detail stems and REAPER projects. Keep earlier versions when revising parameters: give revised candidates a new versioned name. Never replace a favorite just to test a revision.

The comparison page is `/sound-lab.html` on the rope dev server, linked from the editor's Sounds menu. It supports A/B playback, active-RMS matching, repetition, favorites, and local notes exported as JSON with hashes. Matching approximates level; it is not perceptual loudness. Ask for or read concrete feedback tied to a candidate's name/hash, then edit the relevant layer. Let the user assess the candidate in the game before recording subjective expectations in tests.

REAPER is local under `tools/audio/.local/` and launched through `bun run audio:reaper`. Its `.rpp` projects contain the same baked stems used by the offline mix. GUI access is subject to the session's normal permissions. See `tools/audio/README.md` for commands and render automation.

Keep imported originals and source/author/license metadata. Follow the existing game's redistribution rules for recordings. Candidates and downloaded sources live outside the shipping library until selected; add selected sounds through the existing Sounds upload/assignment flow. Do not publish assets or use paid generation services merely because this skill was loaded.
