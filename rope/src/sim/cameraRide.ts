// Replaying a recorded run through the REAL camera controller, and measuring
// what the screen did.
//
// The camera is render-side and driven by wall-clock dt, so it is the one part
// of the game a bundle does not capture: two replays of the same recording are
// bit-identical in the sim and say nothing at all about whether the camera
// lurched. This is what says it. The sim is stepped exactly as `cli replay`
// steps it, and the controller is driven beside it at a fixed 1/60 with
// `alpha = 1` - the frame the sim just produced, with no interpolation to blur
// what the controller was handed.
//
// What it measures is the camera's own MOTION, because that is what "harsh" is:
// speed, acceleration and jerk are the first three derivatives of what the
// player is looking through, and a rule that steps the target shows up in the
// second and third of them however smooth the rule's own story is. Beside them
// it measures the PROGRESS `s` the target is built from, since a staircase
// there is the cause the camera numbers are only the symptom of (see
// `plans/camera-motion.md`).
//
// Deliberately not a case: a ride is a measurement, and the thresholds that
// turn one into a case are a statement about how the level should FEEL, which
// is written once the feel has been played.

import { Vec2 } from "../engine/vec2";
import { BallLevel } from "../level/ballLevel";
import { CameraController } from "../render/cameraController";
import { BALL_ZOOM, GRAPPLE_ZOOM, type Camera } from "../render/camera";
import { VIEW_HEIGHT, VIEW_WIDTH } from "../render/viewport";
import { levelFromRecording } from "./replay";
import { recordingDeserializer, type Recording } from "./trace";

// The render clock the ride drives the camera on. Fixed, because the whole
// point is that two rides of the same bundle answer the same numbers: a ride
// taken at the wall-clock rate of whatever machine ran it would report the
// display's stutter as the camera's.
export const RIDE_DT = 1 / 60;

// One frame of the ride: what the sim produced, what the controller did with
// it, and the derivatives that make it readable.
export interface RideFrame {
  frame: number;
  // The avatar the camera was following, and where the camera ended up.
  follow: Vec2;
  pos: Vec2;
  zoom: number;
  // The camera's own motion: metres this frame, and the three derivatives in
  // m/s, m/s² and m/s³. Zero on the frames before there is enough history.
  step: number;
  speed: number;
  accel: number;
  jerk: number;
  // The progress the target is built from, and its first two derivatives -
  // the cause, where the three above are the effect.
  s: number;
  leadS: number;
  ds: number;
  dds: number;
  // The smoothed rate of the lead origin, which is what the speed lead is
  // bought with (see `leadFor`).
  rate: number;
  // How many rules were in force, and the kind of the one taking the largest
  // share. "-" when the camera was the plain follow.
  members: number;
  rule: string;
  // The frame-edge guarantee: whether it was shaping the camera this frame,
  // and how far its stick is still holding the aim off the rule's target.
  floor: boolean;
  stickX: number;
  stickY: number;
}

export interface RideResult {
  frames: RideFrame[];
  // The peaks, each with the frame it happened on.
  peak: {
    speed: Peak;
    accel: Peak;
    jerk: Peak;
    step: Peak;
    ds: Peak;
    dds: Peak;
  };
  // The mean of |d²s/dt²| over the run - the number a staircase in the
  // projection moves and a single teleport barely does, which is why it is
  // reported beside the peaks rather than instead of them.
  meanAbsDds: number;
  // The mean of the camera's own |acceleration|. The peak is one event and this
  // is the character, and a camera can be well inside its cap on both and still
  // read as harsh if the mean is half its speed.
  meanAccel: number;
  // What the PLAYER sees, per axis: how much their own position in the frame
  // moves. A camera can be perfectly smooth in its own motion and still read as
  // "wobbly" if the avatar slides about in the frame while it is being smooth,
  // which is exactly what a speed-dependent lead or lag does - so the two
  // measurements are not the same question and both are reported.
  //
  // `sd` is the spread of the offset and `slide` its total variation per
  // second, which is what the eye follows.
  framing: { x: Framing; y: Framing };
}

export interface Framing {
  mean: number;
  sd: number;
  range: number;
  slide: number;
}

function framingOf(frames: readonly RideFrame[], pick: (f: RideFrame) => number): Framing {
  const a = frames.map(pick);
  if (a.length === 0) return { mean: 0, sd: 0, range: 0, slide: 0 };
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  let slide = 0;
  for (let i = 1; i < a.length; i++) slide += Math.abs(a[i]! - a[i - 1]!);
  return {
    mean,
    sd,
    range: Math.max(...a) - Math.min(...a),
    slide: slide / (a.length * RIDE_DT),
  };
}

export interface Peak {
  value: number;
  frame: number;
}

function peakOf(frames: readonly RideFrame[], pick: (f: RideFrame) => number): Peak {
  let best: Peak = { value: 0, frame: 0 };
  for (const f of frames) {
    const v = Math.abs(pick(f));
    if (v > best.value) best = { value: v, frame: f.frame };
  }
  return best;
}

// Replay `rec` through the sim and the camera controller together.
//
// `from` skips the leading frames of the run - what "the tail of a session" is
// - so a bundle whose interesting corner is at the end can be measured without
// the spawn's own settle in the numbers. The sim is still stepped from frame
// one either way; only the measurement starts later, since a camera measured
// from a cold start would report the snap as a jerk.
export function rideRecording(rec: Recording, from = 0): RideResult {
  const level = levelFromRecording(rec);
  const deserialize = recordingDeserializer(rec);
  const camera: Camera = {
    position: Vec2.ZERO,
    zoom: GRAPPLE_ZOOM,
    viewportWidth: VIEW_WIDTH,
    viewportHeight: VIEW_HEIGHT,
  };
  const baseZoom = level instanceof BallLevel ? BALL_ZOOM : GRAPPLE_ZOOM;
  const ctl = new CameraController();

  const frames: RideFrame[] = [];
  let prevPos: Vec2 | null = null;
  let prevVel: Vec2 | null = null;
  let prevAcc: Vec2 | null = null;
  let prevS: number | null = null;
  let prevDs: number | null = null;
  // The path the camera was riding last frame. Arc length is a coordinate on
  // ONE route, so a frame that changes seat has no `ds/dt` to report: the river
  // level's two paths are 22.2 m and 22.9 m long and unrelated, and differencing
  // across the swap read -1140 m/s and took the run's mean |d²s/dt²| from 5 to
  // 192. It is not a discontinuity in the camera - the camera crossed it without
  // a step - it is two different rulers.
  let prevSeat: unknown = null;

  for (let i = 0; i < rec.frames.length; i++) {
    level.physicsProcess(deserialize(rec.frames[i]!), 1 / 60);
    const follow = level.cameraRenderPosition(1);
    ctl.update(camera, RIDE_DT, follow, level.cameraRules, baseZoom, level.cameraAnchored);
    const held = ctl.held;

    const pos = camera.position;
    const vel = prevPos ? pos.sub(prevPos).div(RIDE_DT) : null;
    const acc = vel && prevVel ? vel.sub(prevVel).div(RIDE_DT) : null;
    const jerk = acc && prevAcc ? acc.sub(prevAcc).div(RIDE_DT) : null;
    const seat = held.members.find((m) => m.rule.kind === "path")?.rule ?? null;
    const reseated = seat !== prevSeat;
    const ds = prevS === null || reseated ? null : (held.s - prevS) / RIDE_DT;
    const dds = ds !== null && prevDs !== null ? (ds - prevDs) / RIDE_DT : null;

    if (i >= from) {
      frames.push({
        frame: i + 1,
        follow,
        pos,
        zoom: camera.zoom,
        step: prevPos ? pos.distanceTo(prevPos) : 0,
        speed: vel?.length() ?? 0,
        accel: acc?.length() ?? 0,
        jerk: jerk?.length() ?? 0,
        s: held.s,
        leadS: held.leadS,
        ds: ds ?? 0,
        dds: dds ?? 0,
        rate: held.rate,
        members: held.members.length,
        rule: held.rule?.kind ?? "-",
        floor: held.edge !== null,
        stickX: held.stick.x,
        stickY: held.stick.y,
      });
    }

    prevPos = pos;
    prevVel = vel;
    prevAcc = acc;
    prevS = held.s;
    prevDs = ds;
    prevSeat = seat;
  }

  let sum = 0;
  let accSum = 0;
  for (const f of frames) {
    sum += Math.abs(f.dds);
    accSum += f.accel;
  }
  return {
    frames,
    peak: {
      speed: peakOf(frames, (f) => f.speed),
      accel: peakOf(frames, (f) => f.accel),
      jerk: peakOf(frames, (f) => f.jerk),
      step: peakOf(frames, (f) => f.step),
      ds: peakOf(frames, (f) => f.ds),
      dds: peakOf(frames, (f) => f.dds),
    },
    meanAbsDds: frames.length ? sum / frames.length : 0,
    meanAccel: frames.length ? accSum / frames.length : 0,
    framing: {
      x: framingOf(frames, (f) => f.pos.x - f.follow.x),
      y: framingOf(frames, (f) => f.pos.y - f.follow.y),
    },
  };
}
