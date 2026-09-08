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

import { ACTIONS, type Action, type SerializedFrame } from "../sim/trace";

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
  // Which action bit each mouse button drove on the controller that recorded
  // this (see BUTTON_BITS). The audit's whole question is whether a press in
  // the DOM reached a frame, and that question needs the bit the press was
  // supposed to set - which is not the same on both controllers. Absent on
  // bundles recorded before the field existed, which were all grapple-mapped
  // or ball bundles whose only deploy button was the left one.
  bits?: Record<number, number>;
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

  // `at` is the run and frame the sim stands at right now; `bits` is the button
  // map of the controller being played, read at export because the editor can
  // switch controller between tests; `cap` bounds the buffer, oldest first, so a
  // long session keeps its last few thousand facts rather than growing without
  // end.
  constructor(
    private canvas: HTMLCanvasElement,
    private at: () => { run: number; frame: number },
    private bits: () => Record<number, number> = () => BUTTON_BITS.grapple,
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
    return { run: this.at().run, events: this.events.slice(), bits: this.bits() };
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

// The bits a mouse button drives, by button number, in the frames' held mask
// (the ACTIONS order of `sim/trace.ts`). The grapple controller binds the two
// buttons to different actions; the ball controller has only the chain to
// deploy, so every button drives `fire` and a right-click there is a deploy and
// not a dropped press.
const bitOf = (a: Action): number => 1 << ACTIONS.indexOf(a);
export const BUTTON_BITS: Record<"grapple" | "ball", Record<number, number>> = {
  grapple: { 0: bitOf("fire"), 2: bitOf("retractClick") },
  ball: { 0: bitOf("fire"), 1: bitOf("fire"), 2: bitOf("fire") },
};
const BUTTON_NAME: Record<number, string> = { 0: "left", 1: "middle", 2: "right" };

const name = (b: number): string => BUTTON_NAME[b] ?? `button${b}`;

// The buttons that drive one bit, named as one thing: "left", or "left/middle/
// right" where they are interchangeable, so a line about a held run says which
// press could have been behind it.
const namesFor = (bits: Record<number, number>, bit: number): string =>
  Object.keys(bits)
    .filter((b) => bits[Number(b)] === bit)
    .map((b) => name(Number(b)))
    .join("/");

// The DOM button a `buttons` bitmask bit stands for.
const MASK_BUTTON: Record<number, number> = { 1: 0, 2: 2, 4: 1 };

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
  const bits = trace.bits ?? BUTTON_BITS.grapple;
  const down = new Set<number>();
  // Frame indices (0-based) at which the DOM put a press behind an action bit:
  // the events a held run in the frames can be traced back to. Keyed by BIT
  // rather than by button, because on the ball controller three buttons drive
  // the same one and any of them sources the hold.
  const pressesAt = new Map<number, number[]>();
  const pressed = (bit: number, f: number): void => {
    const at = pressesAt.get(bit);
    if (at) at.push(f);
    else pressesAt.set(bit, [f]);
  };

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
        const bit = bits[b];
        if (inRun && bit !== undefined && !ev.tgt) {
          pressed(bit, ev.f);
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
          for (const [maskBit, b] of Object.entries(MASK_BUTTON)) {
            if ((mask & Number(maskBit)) === 0) continue;
            down.add(b);
            const bit = bits[b];
            if (inRun && bit !== undefined) pressed(bit, ev.f);
          }
        }
        if (inRun || allRuns) audit.lines.push(`${stamp}  buttons=${mask}${note}`);
        break;
      }
      default:
        if (inRun || allRuns) audit.lines.push(`${stamp}  ${ev.e}`);
    }
  }

  // Every held run in the frames wants a DOM press within a frame of its start.
  // Once per BIT, not once per button: three buttons driving `fire` is one
  // question about the frames, asked once.
  for (const bit of new Set(Object.values(bits))) {
    const at = pressesAt.get(bit) ?? [];
    let held = false;
    for (let i = 0; i < frames.length; i++) {
      const now = (frames[i]!.h & bit) !== 0;
      if (now && !held) {
        const sourced = at.some((f) => Math.abs(f - i) <= 1);
        if (!sourced) {
          audit.unsourced++;
          audit.lines.push(
            `frame ${i + 1}  ${namesFor(bits, bit)} held with no DOM press behind it (pad or touch?)`,
          );
        }
      }
      held = now;
    }
  }
  return audit;
}

// ---- the evdev half ---------------------------------------------------------
// What the mouse itself sent, as `libinput debug-events --device /dev/input/eventN`
// prints it, laid against the DOM trace. The trace ends at the browser: an
// orphan up says the browser never had the press, and this says whether the
// mouse sent one. Its clock is the tool's own ("+84.544s" since it started),
// so the two streams are aligned by matching the clicks they share.

export interface EvdevEvent {
  t: number; // ms since the tool started
  b: number; // button as the DOM numbers it: 0 left, 1 middle, 2 right
  e: "down" | "up";
}

const EVDEV_BUTTON: Record<string, number> = { BTN_LEFT: 0, BTN_MIDDLE: 1, BTN_RIGHT: 2 };
const EVDEV_LINE = /\+(\d+\.\d+)s\s+(BTN_\w+) \(\d+\) (pressed|released)/;

export function parseEvdev(text: string): EvdevEvent[] {
  const out: EvdevEvent[] = [];
  for (const line of text.split("\n")) {
    const m = EVDEV_LINE.exec(line);
    if (!m) continue;
    const b = EVDEV_BUTTON[m[2]!];
    if (b === undefined) continue;
    out.push({ t: parseFloat(m[1]!) * 1000, b, e: m[3] === "pressed" ? "down" : "up" });
  }
  return out;
}

// The same stream one layer up: what the compositor sent the browser, as
// `WAYLAND_DEBUG=1` on the browser prints it, one line per protocol event:
//   [3273245.129] wl_pointer#31.button(33591, 3273245, 272, 1)
// The bracketed stamp is the client's clock in ms, then serial, the
// compositor's time, the evdev button code, and the state (1 pressed).
// libwayland prints the object as `wl_pointer#3` (older builds `wl_pointer@3`).
const WAYLAND_LINE = /\[\s*(\d+\.\d+)\]\s+(?:->\s+)?wl_pointer[@#]\d+\.button\(\d+,\s*\d+,\s*(\d+),\s*(\d)\)/;
const WAYLAND_BUTTON: Record<string, number> = { "272": 0, "273": 2, "274": 1 };

export function parseWaylandDebug(text: string): EvdevEvent[] {
  const out: EvdevEvent[] = [];
  for (const line of text.split("\n")) {
    const m = WAYLAND_LINE.exec(line);
    if (!m) continue;
    const b = WAYLAND_BUTTON[m[2]!];
    if (b === undefined) continue;
    out.push({ t: parseFloat(m[1]!), b, e: m[3] === "1" ? "down" : "up" });
  }
  return out;
}

// A DOM press and an evdev press are the same click when they land within this
// of each other once aligned: USB polling, the compositor and the browser's
// input thread between them are a few ms, and a hand cannot click twice in it.
const ALIGN_TOLERANCE_MS = 20;

export interface EvdevAlignment {
  offset: number; // ms to add to an evdev time to get a DOM time
  matched: number; // DOM presses with an evdev press under them
  domPresses: number;
  ends: number; // the last evdev event, in DOM time
}

// Align by the left button's presses: every pairing of an early DOM press with
// an early evdev press is a candidate offset, and the one under which the most
// presses coincide is the alignment. Null when nothing coincides at all.
export function alignEvdev(trace: InputTraceBundle, evdev: EvdevEvent[]): EvdevAlignment | null {
  const dom = trace.events.filter((e) => e.e === "down" && (e.b ?? 0) === 0 && !e.tgt).map((e) => e.t);
  const evd = evdev.filter((e) => e.e === "down" && e.b === 0).map((e) => e.t);
  if (dom.length === 0 || evd.length === 0) return null;
  const coincide = (offset: number): number =>
    dom.filter((t) => evd.some((u) => Math.abs(t - (u + offset)) <= ALIGN_TOLERANCE_MS)).length;
  let best: EvdevAlignment | null = null;
  for (const t of dom.slice(0, 10)) {
    for (const u of evd.slice(0, 10)) {
      const offset = t - u;
      const matched = coincide(offset);
      if (!best || matched > best.matched) {
        best = { offset, matched, domPresses: dom.length, ends: evdev[evdev.length - 1]!.t + offset };
      }
    }
  }
  return best && best.matched > 0 ? best : null;
}

// The lines `cli clicks --evdev` adds: the alignment, then every orphan up in
// the bundle's run with the two streams merged over the seconds before it and
// a verdict on which layer lost the press.
// `label` names the stream the lines speak of: "evdev" for the mouse's own,
// "wayland" for what the compositor sent the browser (see parseWaylandDebug).
export function evdevReport(trace: InputTraceBundle, evdev: EvdevEvent[], label = "evdev"): string[] {
  const lines: string[] = [];
  const align = alignEvdev(trace, evdev);
  if (!align) {
    lines.push(`${label}: no left-button press in the log coincides with one in the trace; are they the same session?`);
    return lines;
  }
  const { offset, matched, domPresses, ends } = align;
  lines.push(
    `${label}: ${evdev.length} events, aligned at ${(offset / 1000).toFixed(3)} s; ` +
      `${matched} of ${domPresses} DOM presses have the ${label} press under them; ` +
      `the log ends at DOM t=${(ends / 1000).toFixed(1)} s`,
  );
  const inRun = trace.events.filter((e) => e.r === trace.run);
  const domDowns = inRun.filter((e) => e.e === "down" && (e.b ?? 0) === 0 && !e.tgt).map((e) => e.t);
  const evdDowns = evdev.filter((e) => e.e === "down" && e.b === 0).map((e) => e.t + offset);
  const near = (t: number, list: number[]): boolean => list.some((u) => Math.abs(t - u) <= ALIGN_TOLERANCE_MS);

  // Presses one side has and the other lacks, inside the span both cover.
  const first = evdev[0]!.t + offset;
  const domOnly = domDowns.filter((t) => t >= first && t <= ends && !near(t, evdDowns));
  const evdOnly = evdDowns.filter((u) => !near(u, domDowns) && u >= (inRun[0]?.t ?? 0));
  if (domOnly.length) lines.push(`${label}: ${domOnly.length} DOM press(es) with no ${label} press under them at ${domOnly.map((t) => (t / 1000).toFixed(3) + " s").join(", ")}`);
  if (evdOnly.length) lines.push(`${label}: ${evdOnly.length} ${label} press(es) the DOM never saw at ${evdOnly.map((t) => (t / 1000).toFixed(3) + " s").join(", ")}`);

  // Each orphan up, with both streams over the seconds before it.
  const down = new Set<number>();
  for (const ev of trace.events) {
    if (ev.e === "down") down.add(ev.b ?? 0);
    else if (ev.e === "buttons") {
      down.clear();
      if ((ev.b ?? 0) & 1) down.add(0);
      if ((ev.b ?? 0) & 2) down.add(2);
    } else if (ev.e === "up") {
      const b = ev.b ?? 0;
      const orphan = !down.has(b);
      down.delete(b);
      if (!orphan || ev.r !== trace.run) continue;
      lines.push(`orphan up at f${ev.f}, DOM t=${(ev.t / 1000).toFixed(3)} s:`);
      const from = ev.t - 2500;
      const merged = [
        ...inRun.filter((e) => (e.e === "down" || e.e === "up") && e.t >= from && e.t <= ev.t + 500).map((e) => ({ t: e.t, src: "DOM".padEnd(7), e: `${e.e} ${name(e.b ?? 0)}` })),
        ...evdev.filter((e) => e.t + offset >= from && e.t + offset <= ev.t + 500).map((e) => ({ t: e.t + offset, src: label.padEnd(7), e: `${e.e} ${name(e.b)}` })),
      ].sort((a, b) => a.t - b.t);
      for (const m of merged) lines.push(`    ${(m.t / 1000).toFixed(3).padStart(9)} s  ${m.src}  ${m.e}`);
      if (ev.t > ends) {
        lines.push(`  -> INCONCLUSIVE: the ${label} log ends ${((ev.t - ends) / 1000).toFixed(1)} s before it`);
        continue;
      }
      const s = (t: number): string => `${(t / 1000).toFixed(3)} s`;
      // The mouse's press under the very release: the press reached the
      // browser with its state flipped (session-1192f: a press at 23.420 s
      // arrived as a release, and the release 216 ms later as nothing).
      const under = evdev.find((e) => e.e === "down" && e.b === b && Math.abs(e.t + offset - ev.t) <= ALIGN_TOLERANCE_MS);
      if (under) {
        const after = evdev.find((e) => e.e === "up" && e.b === b && e.t > under.t);
        lines.push(
          `  -> INVERTED: ${label} has a press at ${s(under.t + offset)} where the browser received a release` +
            (after ? `; its release at ${s(after.t + offset)} reached nothing` : "") +
            `: flipped between ${label} and the DOM`,
        );
        continue;
      }
      const sent = evdev.filter((e) => e.e === "down" && e.b === b && e.t + offset >= from && e.t + offset <= ev.t + ALIGN_TOLERANCE_MS && !near(e.t + offset, domDowns));
      if (sent.length) {
        lines.push(`  -> ${label} has the press at ${s(sent[0]!.t + offset)} and the browser never got it: lost between ${label} and the DOM`);
      } else {
        lines.push(`  -> no press in ${label} either: nothing was sent`);
      }
    }
  }
  return lines;
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
