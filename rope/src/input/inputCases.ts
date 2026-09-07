// The button latch's cases (`cli latch`, see latch.ts): the queue that carries
// a sub-step click into the next sample. Pure, so the cases are exact. The
// click audit's cases live here too (`cli clicks`, see inputTrace.ts): the
// reading of a bundle's DOM button story against its frames.

import { ButtonLatch } from "./latch";
import { auditClicks, type InputTraceEvent } from "./inputTrace";
import type { SerializedFrame } from "../sim/trace";

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function samples(latch: ButtonLatch, n: number): boolean[] {
  return Array.from({ length: n }, () => latch.sample());
}

const fmt = (b: boolean[]): string => b.map((v) => (v ? "1" : "0")).join("");

const CASES: Record<string, () => string> = {
  "a click shorter than a step is one held frame then a released one": () => {
    const l = new ButtonLatch();
    l.set(true);
    l.set(false);
    const s = samples(l, 3);
    expect(fmt(s) === "100", `sampled ${fmt(s)}`);
    return `down+up between samples -> ${fmt(s)}`;
  },

  "a re-click inside one step while held is a released frame then a held one": () => {
    const l = new ButtonLatch();
    l.set(true);
    expect(l.sample(), "first sample should be held");
    l.set(false);
    l.set(true);
    const s = samples(l, 3);
    expect(fmt(s) === "011", `sampled ${fmt(s)}`);
    return `held, then up+down between samples -> ${fmt(s)}`;
  },

  "a steady hold and a repeated down are one level, not a queue": () => {
    const l = new ButtonLatch();
    l.set(true);
    l.set(true); // key auto-repeat
    l.set(true);
    const s = samples(l, 3);
    expect(fmt(s) === "111", `sampled ${fmt(s)}`);
    l.set(false);
    expect(!l.sample(), "release should be seen at once");
    return `down x3 -> ${fmt(s)}, up -> 0`;
  },

  "an up without a down (the down landed off the canvas) stays released": () => {
    const l = new ButtonLatch();
    l.set(false);
    const s = samples(l, 2);
    expect(fmt(s) === "00", `sampled ${fmt(s)}`);
    expect(!l.level(), "level should be released");
    return `up alone -> ${fmt(s)}`;
  },

  "queued edges play out one per sample and level() reads the newest": () => {
    const l = new ButtonLatch();
    l.set(true);
    l.set(false);
    l.set(true);
    expect(l.level(), "level should be held after down-up-down");
    const s = samples(l, 4);
    expect(fmt(s) === "1011", `sampled ${fmt(s)}`);
    return `down-up-down -> ${fmt(s)}`;
  },

  "reset takes the level and drops the queue": () => {
    const l = new ButtonLatch();
    l.set(true);
    l.set(false);
    l.reset(false);
    expect(!l.sample() && !l.level(), "a reset to released should report nothing");
    l.reset(true);
    expect(l.sample(), "a reset to held should report held");
    return "down-up then reset(false) -> 0; reset(true) -> 1";
  },

  // ---- the click audit ------------------------------------------------------

  "a click the frames sampled audits clean": () => {
    const a = auditClicks(trace(ev("down", 10, 0), ev("up", 20, 0)), frames(30, [11, 21]));
    expect(issues(a) === 0, `audit: ${JSON.stringify(a)}`);
    return `down f10, up f20, held f11-f21 -> clean`;
  },

  "an up with no down before it is an orphan up": () => {
    const a = auditClicks(trace(ev("up", 20, 0)), frames(30, []));
    expect(a.orphanUps === 1, `orphan ups ${a.orphanUps}`);
    expect(issues(a) === 1, `audit: ${JSON.stringify(a)}`);
    return `up f20 alone -> 1 orphan up`;
  },

  "a down no frame holds is unsampled": () => {
    const a = auditClicks(trace(ev("down", 10, 0), ev("up", 12, 0)), frames(30, []));
    expect(a.unsampled === 1, `unsampled ${a.unsampled}`);
    expect(issues(a) === 1, `audit: ${JSON.stringify(a)}`);
    return `down f10 with no held frame -> 1 unsampled`;
  },

  "a held run with no DOM press behind it is unsourced": () => {
    const a = auditClicks(trace(), frames(30, [11, 21]));
    expect(a.unsourced === 1, `unsourced ${a.unsourced}`);
    return `held f11-f21 with an empty trace -> 1 unsourced`;
  },

  "a bitmask the events did not announce is a disagreement, and sources the press": () => {
    const a = auditClicks(trace(ev("buttons", 10, 1), ev("up", 20, 0)), frames(30, [11, 21]));
    expect(a.bitmaskDisagreements === 1, `disagreements ${a.bitmaskDisagreements}`);
    expect(a.orphanUps === 0, "the up matches the press the bitmask announced");
    expect(a.unsourced === 0, "the bitmask press sources the held run");
    return `buttons=1 f10, up f20, held f11-f21 -> 1 disagreement, nothing else`;
  },

  "a down that landed off the canvas is named, not counted unsampled": () => {
    const off = { ...ev("down", 10, 0), tgt: "body" };
    const a = auditClicks(trace(off, ev("up", 12, 0)), frames(30, []));
    expect(a.unsampled === 0, `unsampled ${a.unsampled}`);
    expect(issues(a) === 0, `audit: ${JSON.stringify(a)}`);
    expect(a.lines[0]!.includes("landed on body"), `line: ${a.lines[0]}`);
    return `down f10 on body, up f12, nothing held -> clean, the body named`;
  },

  "events of another run are read for state but not held against the frames": () => {
    const a = auditClicks(trace(ev("down", 10, 0, 0), ev("up", 12, 0, 0)), frames(30, []));
    expect(issues(a) === 0, `audit: ${JSON.stringify(a)}`);
    expect(a.lines.length === 0, "another run's events are not listed by default");
    return `run 0's click against run 1's frames -> clean, unlisted`;
  },
};

// A trace event at frame f of run r (the bundle's run is 1).
function ev(e: InputTraceEvent["e"], f: number, b?: number, r = 1): InputTraceEvent {
  const out: InputTraceEvent = { t: f * 16.7, r, f, e };
  if (b !== undefined) out.b = b;
  return out;
}

function trace(...events: InputTraceEvent[]): { run: number; events: InputTraceEvent[] } {
  return { run: 1, events };
}

// n frames with `fire` held from frame a to frame b inclusive (1-based).
function frames(n: number, held: [number, number] | []): SerializedFrame[] {
  return Array.from({ length: n }, (_, i) => ({
    h: held.length && i + 1 >= held[0] && i + 1 <= held[1] ? 1 << 5 : 0,
    mx: 0,
    my: 0,
  }));
}

function issues(a: ReturnType<typeof auditClicks>): number {
  return a.orphanUps + a.orphanDowns + a.bitmaskDisagreements + a.unsampled + a.unsourced;
}

export function runInputCases(): CaseResult[] {
  return Object.entries(CASES).map(([name, fn]) => {
    try {
      return { name, pass: true, detail: fn() };
    } catch (e) {
      return { name, pass: false, detail: e instanceof Error ? e.message : String(e) };
    }
  });
}
