// The replay transport bar: where in the recording the picture is, and what the
// transport is doing with it (see sim/replayTransport.ts).
//
// It is drawn in screen space on the 2D overlay, like the perf panel, and it is
// the only piece of interface the replay page has - so it also has to say what
// the keys are. A transport nobody can find is a transport that does not exist,
// and a replay is watched by whoever was handed the link rather than by whoever
// wrote the key list.
//
// The geometry lives in one place and is read by both the drawing and the
// hit-test (`replayBarFrame`): a scrub bar whose knob is drawn a few pixels from
// where a click on it seeks to is a bar that fights the hand holding it.

import type { ViewTransform } from "./viewport";

// Panel geometry, in view pixels of the fixed 1920x1080 frame (see viewport.ts).
// Three rows inside it - what the transport is doing, the track, and the keys -
// each given the same air above and below, because a bar crammed against the
// bottom of the picture reads as something that fell off it.
const MARGIN = 48;
const BOTTOM = 32;
const HEIGHT = 92;
const PAD = 16;
const FONT = "16px monospace";
// Rows, as offsets from the panel's top.
const STATUS_TOP = 16;
const TRACK_TOP = 46;
const TRACK_H = 8;
const KEYS_TOP = 64;
// How far above the panel a pointer still counts as being on the bar. The track
// is eight pixels tall and a run tick is two wide; asking a hand to land inside
// that is asking it to aim, and nothing here is worth aiming at.
const GRAB_SLOP = 16;

const BG = "rgba(24, 28, 38, 0.86)";
const BORDER = "#313244";
const TRACK = "#313244";
const LABEL = "#8a93a3";
const DIM = "#5a6472";
const ACCENT = "#65bddb";
const FG = "#cbccc6";

// The recording's own clock. Every frame is a step of 1/60, whatever speed it is
// being watched at.
const FPS = 60;

export interface ReplayHudState {
  // The frame on screen and the recording's length, in recorded frames.
  index: number;
  total: number;
  paused: boolean;
  speed: number;
  // Where a seek is headed, or null when the transport is just playing.
  target: number | null;
  // Frame boundaries where a run began (see ReplayTransport.runStarts).
  runStarts: readonly number[];
  // The recording has run out and its last input is being held (see
  // ReplayTransport.atEnd). Worth saying, because the world carries on moving
  // there and a bar that still read "playing" would be claiming there are
  // recorded frames left to play.
  atEnd: boolean;
  // The frame under the pointer, or null when the pointer is elsewhere.
  hover: number | null;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function panelRect(view: ViewTransform): Rect {
  return {
    x: MARGIN,
    y: view.height - BOTTOM - HEIGHT,
    w: view.width - MARGIN * 2,
    h: HEIGHT,
  };
}

function trackRect(view: ViewTransform): Rect {
  const panel = panelRect(view);
  return { x: panel.x + PAD, y: panel.y + TRACK_TOP, w: panel.w - PAD * 2, h: TRACK_H };
}

// The recorded frame a point in view space picks, or null when the point is not
// on the bar. The whole panel is the target, not the track inside it.
export function replayBarFrame(view: ViewTransform, x: number, y: number, total: number): number | null {
  const panel = panelRect(view);
  if (y < panel.y - GRAB_SLOP || y > panel.y + panel.h) return null;
  if (x < panel.x || x > panel.x + panel.w) return null;
  return replayBarFrameAtX(view, x, total);
}

// The same, from the horizontal alone: a drag that has already grabbed the bar
// follows the pointer wherever it goes, because a hand dragging a scrubber
// wanders off it vertically and expects the scrubber to keep tracking - and
// the frame it means is still the one under it.
export function replayBarFrameAtX(view: ViewTransform, x: number, total: number): number {
  const track = trackRect(view);
  const t = Math.max(0, Math.min(1, (x - track.x) / track.w));
  return Math.round(t * total);
}

// Seconds of recording as `m:ss.s`, or `ss.s` under a minute. A replay is
// discussed in frames (every tool speaks in them) and watched in seconds, so the
// bar carries both rather than choosing.
function clock(frames: number): string {
  const seconds = frames / FPS;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, "0")}`;
}

function speedText(speed: number): string {
  return `${speed < 1 ? speed.toString() : speed.toFixed(0)}x`;
}

export function drawReplayHud(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  state: ReplayHudState,
): void {
  const panel = panelRect(view);
  const track = trackRect(view);
  // An empty recording has nothing to place on a bar, and dividing by its length
  // would put the knob everywhere at once.
  const total = Math.max(1, state.total);
  const atFrame = (frame: number): number => track.x + (Math.max(0, Math.min(total, frame)) / total) * track.w;

  ctx.setTransform(view.scale, 0, 0, view.scale, view.originX, view.originY);
  ctx.save();
  ctx.font = FONT;
  ctx.textBaseline = "top";

  ctx.fillStyle = BG;
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeRect(panel.x + 0.5, panel.y + 0.5, panel.w - 1, panel.h - 1);

  // Status: what the transport is doing, and how fast. Seeking says where it is
  // going, because a seek across a long run takes frames to arrive and a bar
  // that only shows where it IS looks stuck.
  const seeking = state.target !== null;
  ctx.textAlign = "left";
  ctx.fillStyle = seeking ? ACCENT : state.paused ? LABEL : FG;
  const status = seeking
    ? `>> seeking f${state.target}`
    : state.atEnd && !state.paused
      ? `>  end of recording, holding the last input`
      : `${state.paused ? "|| paused" : ">  playing"}  ${speedText(state.speed)}`;
  ctx.fillText(status, panel.x + PAD, panel.y + STATUS_TOP);

  // Position, in the two units a replay is talked about in.
  ctx.textAlign = "right";
  ctx.fillStyle = FG;
  ctx.fillText(
    `f${state.index} / ${state.total}   ${clock(state.index)} / ${clock(state.total)}`,
    panel.x + panel.w - PAD,
    panel.y + STATUS_TOP,
  );

  // The track, then what has been played of it.
  ctx.fillStyle = TRACK;
  ctx.fillRect(track.x, track.y, track.w, track.h);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(track.x, track.y, atFrame(state.index) - track.x, track.h);

  // Run boundaries: every reset the transport has stepped through is a fresh
  // build, which is both a landmark in the run and the cheapest place to seek
  // back to. Frame 0 is one of them and is left off - it is the track's own end.
  ctx.fillStyle = FG;
  for (const start of state.runStarts) {
    if (start <= 0 || start >= total) continue;
    ctx.fillRect(Math.round(atFrame(start)), track.y - 3, 2, track.h + 6);
  }

  // Where a seek is headed, while it is on its way there.
  if (state.target !== null) {
    ctx.fillStyle = ACCENT;
    ctx.fillRect(Math.round(atFrame(state.target)) - 1, track.y - 5, 2, track.h + 10);
  }

  // The playhead.
  ctx.fillStyle = FG;
  ctx.fillRect(Math.round(atFrame(state.index)) - 2, track.y - 6, 4, track.h + 12);

  // The frame under the pointer, so a click can be aimed before it is made. The
  // label goes ABOVE the panel rather than inside it, where the status line
  // already is - a readout that lands on top of another readout is worse than
  // none - and carries its own plate, because the scene behind it is whatever
  // the level happens to be.
  if (state.hover !== null) {
    const hx = Math.round(atFrame(state.hover));
    ctx.fillStyle = LABEL;
    ctx.fillRect(hx, track.y - 8, 1, track.h + 16);
    const text = `f${state.hover}`;
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = BG;
    ctx.fillRect(hx - w / 2, panel.y - 28, w, 24);
    ctx.fillStyle = FG;
    ctx.textAlign = "center";
    ctx.fillText(text, hx, panel.y - 24);
  }

  // The keys. Dim, because they are read once.
  ctx.textAlign = "left";
  ctx.fillStyle = DIM;
  ctx.fillText(
    "space play/pause  <-/-> seek 1s (shift 10s)  , . step a frame  [ ] speed  home/end first/last",
    panel.x + PAD,
    panel.y + KEYS_TOP,
  );

  ctx.restore();
}
