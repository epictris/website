// THE RECORDED ARRIVALS: the input streams levels open on.
//
// A level whose spawn names one (`SpawnData.arrival`) does not start with the
// ball standing at its spawn, nor rolling in from off to one side
// (`SpawnData.roll`) - it starts with a RECORDED RUN being played back by the
// sim, from the point that run started, with the player's hands off the ball
// until the stream is spent (see `BallLevel.startArrival` and
// docs/ball-rolling.md#the-recorded-arrival).
//
// The stream is nothing but input: the held-bits and the aim point of every
// frame that was played, which is what a session bundle records. Fed back into
// the same deterministic sim on the same level, it produces the same run - so
// the opening is authored by PLAYING it, which is the only way to author a
// swing through a cave that looks like someone swinging through a cave.
//
// Generated from a bundle by `scripts/make-arrival.ts`, which is also what
// checks that the bundle was recorded on the level as it now stands. The bundle
// itself is kept in `playtests/arrivals/`, where `cli replay` can be pointed at
// it to ask whether the tree still reproduces the run the stream was cut from;
// what is here is only what the browser has to download to play it.
//
// COMPILED IN rather than fetched, like the level files themselves (see
// `registry.ts`): the arrival is the first second of the level, and a level
// that has to wait for a second download before it can open is a level that
// opens on a blank screen for as long as the network feels like.

import { Vec2 } from "../engine/vec2";
import { inputDeserializer, type SerializedFrame } from "../sim/trace";
import type { FrameInput } from "../input/frameInput";
import { PX } from "../engine/units";
// The cave's arrival: the ball dropped into the back of the cave and swung out
// to the mouth of it on five throws (`session-449f`, 7.5 s). The cave stopped
// opening on it on 2026-09-23; it is kept for the entry cases, which play it on
// a frozen copy of the cave (`sim/caveArrivalLevel.json`).
import caveArrival from "./arrivals/cave.json";

// One arrival as it is stored on disk (see `scripts/make-arrival.ts`).
export interface ArrivalStream {
  // The level file the run was recorded on, which is the only level it replays
  // on. Carried so the generator's check is visible in the file it wrote.
  level: string;
  // Where the ball starts, in the level file's own pixels - the spawn the
  // recording was played from, which is somewhere else entirely from the spawn
  // the level hands the player their ball at.
  from: { x: number; y: number };
  // The hand the recording began with, for the pressed/released edges of its
  // first frame (see `Recording.heldAtStart`).
  heldAtStart?: number;
  // Where this came from, for the next person to wonder what they are looking
  // at - and how long that recording was, when the stream is the shorter cut of
  // it that ends where the ball stopped moving (see `scripts/make-arrival.ts`).
  // Never read by the sim.
  recorded?: { bundle: string; git?: string; srcHash?: string; frames?: number };
  frames: SerializedFrame[];
}

// The arrival streams, by the name a spawn asks for them by.
const ARRIVALS: Record<string, ArrivalStream> = {
  cave: caveArrival as ArrivalStream,
};

// One arrival, ready to be played: the ball's starting point in METRES, and the
// stream deserialized into the frames the sim is stepped with.
export interface Arrival {
  from: Vec2;
  frames: FrameInput[];
}

// Look an arrival up by name, or null for a name nothing answers to - which is
// a level asking for an opening that is not in the build, and is worth a
// warning and an ordinary start rather than a level that will not open.
//
// Deserialized per call rather than once per name: the frames carry the
// pressed/released edges the sim reads, deriving them is a diff against the
// previous frame, and a shared array of them would be one run's input handed to
// the next. A build is the only caller, and a level is built once a run.
export function resolveArrival(name: string): Arrival | null {
  const stream = ARRIVALS[name];
  if (!stream) {
    console.warn(
      `[arrival] this level's spawn opens on an arrival named "${name}", which is not one of ` +
        `${Object.keys(ARRIVALS).join(", ") || "(none)"}: starting at the spawn instead.`,
    );
    return null;
  }
  const deserialize = inputDeserializer(stream.heldAtStart ?? 0);
  return {
    // Scaled exactly as `scaleLevelData` scales the spawn it replaces, so the
    // ball is placed on the same double the recorded run started from - which
    // is what makes the playback the run that was recorded rather than one that
    // starts a rounding error away from it.
    from: new Vec2(stream.from.x * PX, stream.from.y * PX),
    frames: stream.frames.map(deserialize),
  };
}
