// The Sounds menu's CLIP EDITOR (docs/sound.md#clip-edits): one library file's
// waveform, with the window that plays cropped by dragging its two edges, and
// the file's own volume and pitch.
//
// It edits how the file is PLAYED - `SoundBank.clips` - never the file: the
// game plays the window, at the gain and rate, wherever the file is assigned.
//
// A drag moves whichever edge is nearer the press, so a click anywhere sets an
// edge there. An edge lands on the nearest upward zero crossing within
// `SNAP_SECONDS` (Alt to place it exactly): a cut there starts and stops the
// wave at rest instead of mid-swing, which would click, and both edges of a
// loop on upward crossings meet at the seam with the wave going the same way.
// Releasing an edge plays the clip.
//
// The editor is rebuilt with the menu on every committed change; what must
// outlive that - the decoded file and the audition's playhead - is the menu's.

import type { Audition } from "../audio/audioOut";
import type { SoundAsset } from "../audio/library";
import {
  CLIP_MIN_SECONDS,
  CLIP_PITCH_RANGE,
  CLIP_VOLUME_RANGE,
  type ClipEdit,
} from "../audio/slots";

// How far from a press an edge is snapped to a zero crossing, seconds: a few
// cycles of a low hum, well under a pixel at most zooms of a long file.
const SNAP_SECONDS = 0.004;
// An edge dragged within this many CSS pixels of the file's end is the end -
// no crop at all, rather than a crop a hair short of it.
const END_SNAP_PX = 4;
const HANDLE_GRAB_PX = 8;

const COLOURS = {
  bg: "#161a22",
  axis: "#313244",
  kept: "#65bddb",
  cut: "#3c445c",
  shade: "rgba(10, 12, 18, 0.45)",
  handle: "#cbccc6",
  playhead: "#e0af68",
};

export interface ClipEditorOpts {
  asset: SoundAsset;
  edit: ClipEdit;
  buffer: Promise<AudioBuffer | null>;
  // A finished change. `audition` asks for it to be played once it has been
  // applied, which an edge's release does.
  onCommit: (edit: ClipEdit, audition: boolean) => void;
  onPlay: () => void;
  // The audition playing for this file, if any (the menu's, so a playhead
  // survives the editor being rebuilt under it).
  audition: () => Audition | null;
}

export class ClipEditor {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly status: HTMLElement;
  private readonly fields: Record<"start" | "end", HTMLInputElement>;
  private buffer: AudioBuffer | null = null;
  // Min and max per device pixel column, for the width they were taken at.
  private peaks: { width: number; min: Float32Array; max: Float32Array } | null = null;
  // The edit as it is being dragged, before it is committed.
  private draft: ClipEdit;
  private dragging: "start" | "end" | null = null;
  private raf = 0;
  private readonly resize: ResizeObserver;

  constructor(private readonly opts: ClipEditorOpts) {
    this.draft = { ...opts.edit };
    this.el = div("snd-clip");

    const wave = div("snd-wave");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "snd-wave-canvas";
    this.canvas.title = "Drag an edge to crop what plays (the nearer edge follows a press). Alt places it exactly, without snapping to a zero crossing.";
    wave.appendChild(this.canvas);
    const axis = div("snd-wave-axis snd-muted");
    const zero = document.createElement("span");
    zero.textContent = "0 s";
    const full = document.createElement("span");
    full.textContent = `${opts.asset.seconds.toFixed(3)} s`;
    axis.append(zero, full);

    const play = button("▶", () => opts.onPlay());
    play.title = "Play the clip as the game plays it (at the event's volume when opened from an event)";
    this.fields = {
      start: this.num("start", "s", 0, opts.asset.seconds, 0.001, "Where it starts playing, seconds into the file"),
      end: this.num("end", "s", 0, opts.asset.seconds, 0.001, "Where it stops playing, seconds into the file"),
    };
    const volume = this.num(
      "volume",
      "dB",
      CLIP_VOLUME_RANGE[0],
      CLIP_VOLUME_RANGE[1],
      0.5,
      "This file's own gain, on top of the event's volume",
    );
    const pitch = this.num(
      "pitch",
      "st",
      CLIP_PITCH_RANGE[0],
      CLIP_PITCH_RANGE[1],
      0.5,
      "This file's own pitch in semitones, on top of the event's: + is higher and shorter, as a faster tape",
    );
    this.status = div("snd-muted snd-clip-status");
    const reset = button("Reset", () => opts.onCommit({}, false));
    reset.title = "Play the whole file as it is";
    reset.disabled = !Object.keys(opts.edit).length;
    // The window on one line, with what it plays for; the file's level and
    // pitch on the next.
    this.fields.start.classList.add("time");
    this.fields.end.classList.add("time");
    const crop = div("snd-clip-line");
    crop.append(play, label(this.fields.start, "start"), label(this.fields.end, "end"), this.status);
    const tone = div("snd-clip-line");
    const resetWrap = div("snd-clip-status");
    resetWrap.appendChild(reset);
    tone.append(label(volume, "volume"), label(pitch, "pitch"), resetWrap);
    this.el.append(wave, axis, crop, tone);

    this.canvas.addEventListener("pointerdown", (e) => this.press(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.release(e));
    this.canvas.addEventListener("pointercancel", () => {
      this.dragging = null;
      this.draft = { ...this.opts.edit };
      this.refresh();
    });
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(this.canvas);

    void opts.buffer.then((b) => {
      this.buffer = b;
      this.peaks = null;
      if (!b) this.status.textContent = "could not decode the file";
      this.draw();
    });
    this.refresh();
    this.tick();
  }

  // The menu is rebuilding: let go of what keeps this one alive.
  dispose(): void {
    this.resize.disconnect();
    cancelAnimationFrame(this.raf);
  }

  // ---------------------------------------------------------------------------

  private get seconds(): number {
    return this.buffer?.duration ?? this.opts.asset.seconds;
  }

  private window(): { start: number; end: number } {
    const end = Math.min(this.seconds, this.draft.end ?? this.seconds);
    return { start: Math.min(this.draft.start ?? 0, end - CLIP_MIN_SECONDS), end };
  }

  private num(
    field: keyof ClipEdit,
    unit: string,
    min: number,
    max: number,
    step: number,
    help: string,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ed-num";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.unit = unit;
    input.title = help;
    const value = field === "end" ? (this.draft.end ?? this.opts.asset.seconds) : (this.draft[field] ?? 0);
    input.value = String(Math.round(value * 1000) / 1000);
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      const next = { ...this.opts.edit, [field]: Math.min(max, Math.max(min, v)) };
      // A typed edge that would cross the other pushes nothing: it stops short.
      if (field === "start") next.start = Math.min(next.start!, (next.end ?? this.seconds) - CLIP_MIN_SECONDS);
      if (field === "end") next.end = Math.max(next.end!, (next.start ?? 0) + CLIP_MIN_SECONDS);
      this.opts.onCommit(next, false);
    });
    return input;
  }

  private timeAt(clientX: number): { t: number; atEdge: "start" | "end" | null } {
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left;
    if (x <= END_SNAP_PX) return { t: 0, atEdge: "start" };
    if (x >= r.width - END_SNAP_PX) return { t: this.seconds, atEdge: "end" };
    return { t: (x / r.width) * this.seconds, atEdge: null };
  }

  private xOf(t: number): number {
    return (t / this.seconds) * this.canvas.getBoundingClientRect().width;
  }

  private press(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const { start, end } = this.window();
    const x = e.clientX - this.canvas.getBoundingClientRect().left;
    this.dragging = Math.abs(x - this.xOf(start)) <= Math.abs(x - this.xOf(end)) ? "start" : "end";
    this.canvas.setPointerCapture(e.pointerId);
    this.place(e);
  }

  private move(e: PointerEvent): void {
    if (this.dragging) {
      this.place(e);
      return;
    }
    const { start, end } = this.window();
    const x = e.clientX - this.canvas.getBoundingClientRect().left;
    const near = Math.min(Math.abs(x - this.xOf(start)), Math.abs(x - this.xOf(end))) <= HANDLE_GRAB_PX;
    this.canvas.style.cursor = near ? "ew-resize" : "pointer";
  }

  private release(e: PointerEvent): void {
    if (!this.dragging) return;
    this.place(e);
    this.dragging = null;
    this.canvas.releasePointerCapture(e.pointerId);
    this.opts.onCommit(this.draft, true);
  }

  // Put the edge being dragged at the pointer, snapped, and kept on its side
  // of the other edge.
  private place(e: PointerEvent): void {
    const edge = this.dragging!;
    let { t, atEdge } = this.timeAt(e.clientX);
    if (!atEdge && !e.altKey) t = this.snap(t);
    const { start, end } = this.window();
    if (edge === "start") {
      t = Math.max(0, Math.min(t, end - CLIP_MIN_SECONDS));
      this.draft.start = atEdge === "start" ? undefined : t;
    } else {
      t = Math.min(this.seconds, Math.max(t, start + CLIP_MIN_SECONDS));
      this.draft.end = atEdge === "end" ? undefined : t;
    }
    this.refresh();
  }

  // The nearest upward zero crossing to `t` within `SNAP_SECONDS`, or `t`.
  private snap(t: number): number {
    const b = this.buffer;
    if (!b) return t;
    const d = b.getChannelData(0);
    const i = Math.round(t * b.sampleRate);
    const reach = Math.round(SNAP_SECONDS * b.sampleRate);
    for (let k = 0; k <= reach; k++) {
      for (const j of [i - k, i + k]) {
        if (j > 0 && j < d.length && d[j - 1]! < 0 && d[j]! >= 0) return j / b.sampleRate;
      }
    }
    return t;
  }

  // The numbers and the picture, from the draft.
  private refresh(): void {
    const { start, end } = this.window();
    this.fields.start.value = start.toFixed(3);
    this.fields.end.value = end.toFixed(3);
    const rate = Math.pow(2, (this.draft.pitch ?? 0) / 12);
    if (this.buffer || !this.status.textContent) {
      this.status.textContent = `plays ${((end - start) / rate).toFixed(3)} s`;
    }
    this.draw();
  }

  private tick(): void {
    this.raf = requestAnimationFrame(() => this.tick());
    if (this.opts.audition()) this.draw();
  }

  private draw(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d");
    if (!g) return;
    g.fillStyle = COLOURS.bg;
    g.fillRect(0, 0, w, h);
    const mid = h / 2;
    g.fillStyle = COLOURS.axis;
    g.fillRect(0, Math.floor(mid), w, Math.max(1, Math.round(dpr)));

    const peaks = this.peaksFor(w);
    const { start, end } = this.window();
    const x0 = (start / this.seconds) * w;
    const x1 = (end / this.seconds) * w;
    if (peaks) {
      // The kept window drawn as loud as the clip's volume makes it - clamped
      // to the frame, since full scale is where the picture runs out, not
      // where the game does (the output has a limiter, and every slot scales).
      const gain = Math.pow(10, (this.draft.volume ?? 0) / 20);
      for (let x = 0; x < w; x++) {
        const kept = x + 1 > x0 && x < x1;
        const k = kept ? gain : 1;
        const top = mid - Math.min(1, peaks.max[x]! * k) * (mid - 1);
        const bottom = mid - Math.max(-1, peaks.min[x]! * k) * (mid - 1);
        g.fillStyle = kept ? COLOURS.kept : COLOURS.cut;
        g.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    }
    g.fillStyle = COLOURS.shade;
    g.fillRect(0, 0, x0, h);
    g.fillRect(x1, 0, w - x1, h);

    const lw = Math.max(1, Math.round(dpr * 1.5));
    const tab = Math.round(5 * dpr);
    g.fillStyle = COLOURS.handle;
    for (const [x, dir] of [
      [x0, 1],
      [x1, -1],
    ] as const) {
      const at = Math.round(Math.min(w - lw, Math.max(0, dir > 0 ? x : x - lw)));
      g.fillRect(at, 0, lw, h);
      // A tab pointing into the window, so which edge is which reads at a glance.
      g.beginPath();
      g.moveTo(at + (dir > 0 ? 0 : lw), 0);
      g.lineTo(at + (dir > 0 ? tab : lw - tab), 0);
      g.lineTo(at + (dir > 0 ? 0 : lw), tab);
      g.closePath();
      g.fill();
    }

    const a = this.opts.audition();
    if (a) {
      const t = a.start + ((performance.now() - a.startedAt) / 1000) * a.rate;
      if (t >= a.start && t <= a.end) {
        g.fillStyle = COLOURS.playhead;
        g.fillRect(Math.round((t / this.seconds) * w), 0, Math.max(1, Math.round(dpr)), h);
      }
    }
  }

  private peaksFor(width: number): { min: Float32Array; max: Float32Array } | null {
    const b = this.buffer;
    if (!b) return null;
    if (this.peaks?.width === width) return this.peaks;
    const d = b.getChannelData(0);
    const min = new Float32Array(width);
    const max = new Float32Array(width);
    const per = d.length / width;
    for (let x = 0; x < width; x++) {
      const from = Math.floor(x * per);
      const to = Math.max(from + 1, Math.floor((x + 1) * per));
      let lo = 0;
      let hi = 0;
      for (let i = from; i < to && i < d.length; i++) {
        const v = d[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[x] = lo;
      max[x] = hi;
    }
    this.peaks = { width, min, max };
    return this.peaks;
  }
}

function label(input: HTMLInputElement, name: string): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "snd-num";
  wrap.title = input.title;
  const n = document.createElement("span");
  n.textContent = name;
  const u = document.createElement("span");
  u.textContent = input.dataset.unit ?? "";
  wrap.append(n, input, u);
  return wrap;
}

function div(cls: string): HTMLElement {
  const e = document.createElement("div");
  e.className = cls;
  return e;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "ed-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
