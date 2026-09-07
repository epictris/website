// InputTrace - the raw DOM button story, carried beside a bundle's frames.
//
// A bundle's frames are what the sim SAMPLED, so a click the browser never
// delivered leaves no mark in one: session-929f, 1346f and 796f each end in
// seconds of aiming with no press, and the frames alone cannot say whether the
// page dropped the press, the browser never had it, or the compositor did.
// The trace that answered 929f was temporary and was removed once it had; the
// drops came back (1346f, 796f, with no second chromium on the machine), so it
// is permanent now. It costs a few bytes per click, and the sim never reads it.
//
// Every entry is one DOM fact: a mousedown or mouseup with its button, a
// mousemove whose `buttons` bitmask differs from the last one seen (the state
// the browser believes in, which is what the sources reconcile against), the
// pointer lock coming and going, focus and visibility, the cursor entering and
// leaving the canvas. `f` is the sim frame the event landed after and `r` the
// run it landed in (how many resets the level had seen), so `cli clicks` can
// lay the story beside the frames and say which layer lost a click.

import type { SerializedFrame } from "../sim/trace";

export type InputTraceKind =
  | "down"
  | "up"
  | "buttons"
  | "lock"
  | "unlock"
  | "lockerror"
  | "focus"
  | "blur"
  | "hidden"
  | "visible"
  | "enter"
  | "leave";

export interface InputTraceEvent {
  t: number; // ms since the page's time origin, to 0.1 ms
  r: number; // the run: resets the level had seen when the event arrived
  f: number; // sim frames that run had stepped when the event arrived
  e: InputTraceKind;
  b?: number; // down/up: the button; buttons: the bitmask
  tgt?: string; // down/up: the target, when it is not the game canvas
}

export interface InputTraceBundle {
  run: number; // the run the bundle's frames belong to
  events: InputTraceEvent[];
}

// Where an event landed, for one that missed the canvas: "#id" when it has
// one, else the tag. The window and the document are where a release goes when
// the cursor is off the page, which is a target and not a miss.
function describeTarget(target: EventTarget | null): string {
  if (typeof Window !== "undefined" && target instanceof Window) return "window";
  if (typeof Document !== "undefined" && target instanceof Document) return "document";
  if (!(target instanceof Element)) return String(target);
  return target.id ? `#${target.id}` : target.tagName.toLowerCase();
}

export class InputTrace {
  private events: InputTraceEvent[] = [];
  private lastButtons = 0;

  // `at` is the run and frame the sim stands at right now; `cap` bounds the
  // buffer, oldest first, so a long session keeps its last few thousand facts
  // rather than growing without end.
  constructor(
    private canvas: HTMLCanvasElement,
    private at: () => { run: number; frame: number },
    private cap = 5000,
  ) {}

  install(): void {
    // Capture phase on the window: before any listener could stop the event,
    // and whatever its target, so a click that landed on an overlay is seen
    // with the overlay named rather than not at all.
    window.addEventListener("mousedown", (e) => this.button("down", e), true);
    window.addEventListener("mouseup", (e) => this.button("up", e), true);
    window.addEventListener(
      "mousemove",
      (e) => {
        if (e.buttons === this.lastButtons) return;
        this.lastButtons = e.buttons;
        this.push("buttons", e.buttons);
      },
      true,
    );
    document.addEventListener("pointerlockchange", () =>
      this.push(document.pointerLockElement === this.canvas ? "lock" : "unlock"),
    );
    document.addEventListener("pointerlockerror", () => this.push("lockerror"));
    window.addEventListener("focus", () => this.push("focus"));
    window.addEventListener("blur", () => this.push("blur"));
    document.addEventListener("visibilitychange", () =>
      this.push(document.visibilityState === "hidden" ? "hidden" : "visible"),
    );
    this.canvas.addEventListener("mouseenter", () => this.push("enter"));
    this.canvas.addEventListener("mouseleave", () => this.push("leave"));
  }

  private button(kind: "down" | "up", e: MouseEvent): void {
    // The event carries the bitmask as of itself, so the next move has nothing
    // new to say unless the browser's belief changes without an event.
    this.lastButtons = e.buttons;
    this.push(kind, e.button, e.target === this.canvas ? undefined : describeTarget(e.target));
  }

  private push(e: InputTraceKind, b?: number, tgt?: string): void {
    const { run, frame } = this.at();
    const ev: InputTraceEvent = { t: Math.round(performance.now() * 10) / 10, r: run, f: frame, e };
    if (b !== undefined) ev.b = b;
    if (tgt !== undefined) ev.tgt = tgt;
    this.events.push(ev);
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);
  }

  bundle(): InputTraceBundle {
    return { run: this.at().run, events: this.events.slice() };
  }
}

// ---- the audit --------------------------------------------------------------
// What the trace says about the bundle's frames, as `cli clicks` prints it.
// Pure over the two, so it has cases (input/inputCases.ts).

export interface ClickAudit {
  lines: string[];
  // A mouseup whose button had no mousedown before it: the browser reported a
  // release for a press it never delivered. The compositor or the mouse lost
  // the press; nothing in the page could have seen it.
  orphanUps: number;
  // A mousedown whose button had no mouseup after it before the next down.
  orphanDowns: number;
  // A move's `buttons` bitmask contradicting the down/up story: the browser
  // believes in a press or a release it never announced as an event.
  bitmaskDisagreements: number;
  // A down on the canvas in the bundle's run that no frame's held bit
  // followed: the DOM delivered it and the page dropped it. A down that landed
  // elsewhere is not counted; the sources listen on the canvas, so the page is
  // right to ignore it, and the line names where it went instead.
  unsampled: number;
  // A held run in the frames with no down or bitmask press behind it in the
  // DOM: the sim saw a press that did not come from the mouse (pad, touch).
  unsourced: number;
}

// The bits a mouse button drives, by button number, as `sim/trace.ts` orders
// them: left is `fire`, right is `retractClick`.
const BUTTON_BIT: Record<number, number> = { 0: 1 << 5, 2: 1 << 6 };
const BUTTON_NAME: Record<number, string> = { 0: "left", 1: "middle", 2: "right" };

const name = (b: number): string => BUTTON_NAME[b] ?? `button${b}`;

function heldAt(frames: SerializedFrame[], f: number, bit: number): boolean | null {
  // A press that arrived after frame f is sampled by frame f+1, which is
  // `frames[f]`; a move that reconciled the bitmask can have put it in a frame
  // earlier, and a queued latch a frame later.
  const window = [f - 1, f, f + 1].filter((i) => i >= 0 && i < frames.length);
  if (window.length === 0) return null;
  return window.some((i) => (frames[i]!.h & bit) !== 0);
}

export function auditClicks(
  trace: InputTraceBundle,
  frames: SerializedFrame[],
  allRuns = false,
): ClickAudit {
  const audit: ClickAudit = {
    lines: [],
    orphanUps: 0,
    orphanDowns: 0,
    bitmaskDisagreements: 0,
    unsampled: 0,
    unsourced: 0,
  };
  const down = new Set<number>();
  // Frame indices (0-based) at which the DOM put a button down, per button:
  // the events a held run in the frames can be traced back to.
  const pressesAt: Record<number, number[]> = { 0: [], 2: [] };

  for (const ev of trace.events) {
    const inRun = ev.r === trace.run;
    const stamp = `r${ev.r} f${ev.f} t=${ev.t.toFixed(1)}ms`;
    let note = "";
    switch (ev.e) {
      case "down": {
        const b = ev.b ?? 0;
        if (down.has(b)) {
          audit.orphanDowns++;
          note = "  <- ORPHAN: no up since the previous down";
        }
        down.add(b);
        if (ev.tgt) note += `  <- landed on ${ev.tgt}, not the canvas`;
        const bit = BUTTON_BIT[b];
        if (inRun && bit !== undefined && !ev.tgt) {
          pressesAt[b]!.push(ev.f);
          const held = heldAt(frames, ev.f, bit);
          if (held === false) {
            audit.unsampled++;
            note += "  <- UNSAMPLED: the DOM delivered it and no frame holds it";
          } else if (held === null) note += "  (after the last frame)";
        }
        if (inRun || allRuns) audit.lines.push(`${stamp}  down ${name(b)}${note}`);
        break;
      }
      case "up": {
        const b = ev.b ?? 0;
        if (!down.has(b)) {
          audit.orphanUps++;
          note = "  <- ORPHAN: no down before it; the browser never had the press";
        }
        down.delete(b);
        // A release is listened for on the window, so where it landed is only
        // worth a word when it was an element other than the canvas.
        if (ev.tgt && ev.tgt !== "window" && ev.tgt !== "document") {
          note += `  <- landed on ${ev.tgt}, not the canvas`;
        }
        if (inRun || allRuns) audit.lines.push(`${stamp}  up ${name(b)}${note}`);
        break;
      }
      case "buttons": {
        const mask = ev.b ?? 0;
        const said = (down.has(0) ? 1 : 0) | (down.has(2) ? 2 : 0) | (down.has(1) ? 4 : 0);
        if (mask !== said) {
          audit.bitmaskDisagreements++;
          note = `  <- DISAGREES: the events said ${said}`;
          // The browser's belief is the truth from here, as the sources treat
          // it: a press it knows about is a press the sim was told of.
          down.clear();
          if (mask & 1) down.add(0);
          if (mask & 2) down.add(2);
          if (mask & 4) down.add(1);
          if (inRun && mask & 1) pressesAt[0]!.push(ev.f);
          if (inRun && mask & 2) pressesAt[2]!.push(ev.f);
        }
        if (inRun || allRuns) audit.lines.push(`${stamp}  buttons=${mask}${note}`);
        break;
      }
      default:
        if (inRun || allRuns) audit.lines.push(`${stamp}  ${ev.e}`);
    }
  }

  // Every held run in the frames wants a DOM press within a frame of its start.
  for (const [bStr, bit] of Object.entries(BUTTON_BIT)) {
    const b = Number(bStr);
    let held = false;
    for (let i = 0; i < frames.length; i++) {
      const now = (frames[i]!.h & bit) !== 0;
      if (now && !held) {
        const sourced = pressesAt[b]!.some((f) => Math.abs(f - i) <= 1);
        if (!sourced) {
          audit.unsourced++;
          audit.lines.push(`frame ${i + 1}  ${name(b)} held with no DOM press behind it (pad or touch?)`);
        }
      }
      held = now;
    }
  }
  return audit;
}

export function auditSummary(a: ClickAudit): string {
  const parts = [
    `${a.orphanUps} orphan up`,
    `${a.orphanDowns} orphan down`,
    `${a.bitmaskDisagreements} bitmask disagreement`,
    `${a.unsampled} unsampled`,
    `${a.unsourced} unsourced`,
  ];
  return parts.join(", ");
}
