// Headless bundle recording: a scripted run, serialized as a genuine P-format
// bundle.
//
// Recording used to be browser-only - press P and a file downloads - which meant
// the agent could consume repros but never manufacture one. Every scenario that
// needed a bundle therefore needed a human at a keyboard, and the scenarios that
// most need one are the fiddly ones (wound all the way up against a ceiling,
// wedged between a crate and the floor) that are hardest to perform by hand and
// hardest to perform the same way twice.
//
// The bundle this writes is the same format `cli replay`, `cli scan`, `cli
// query` and the corpus runner read, carrying the level snapshot rather than a
// registry name so it is self-contained: a script's arena is usually authored in
// the script itself and exists nowhere else.

import type { PlaytestResult, PlaytestScript } from "./playtest";
import { runScript, scriptSpec } from "./playtest";
import type { Recording } from "./trace";

export interface RecordedRun {
  recording: Recording;
  result: PlaytestResult;
}

export function recordScript(script: PlaytestScript, git?: string): RecordedRun {
  const spec = scriptSpec(script);
  const result = runScript(script);
  return {
    recording: {
      level: script.level,
      // The level travels WITH the bundle. A script's arena is authored inline
      // and is not in the registry, so a bundle naming it by id would replay
      // against nothing.
      data: spec.data,
      controller: spec.controller === "ball" ? "ball" : "grapple",
      frames: result.serializedFrames,
      digests: result.digests,
      worldDigests: result.worldDigests,
      ...(git ? { git } : {}),
    },
    result,
  };
}
