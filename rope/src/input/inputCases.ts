// The button latch's cases (`cli latch`, see latch.ts): the queue that carries
// a sub-step click into the next sample. Pure, so the cases are exact. The
// click audit's cases live here too (`cli clicks`, see inputTrace.ts): the
// reading of a bundle's DOM button story against its frames.

import { ButtonLatch } from "./latch";
import { alignEvdev, auditClicks, evdevReport, parseEvdev, parseWaylandDebug, type InputTraceEvent } from "./inputTrace";
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

  "an evdev log is aligned by shared presses and places an orphan up's lost press": () => {
    // Three clicks the DOM saw, a fourth the mouse sent and the browser never
    // got (its release reached the DOM as an orphan up), then a click after
    // the log ends. The tool's clock started 1.5 s after the page's.
    const log = [
      "+1.000s\tBTN_LEFT (272) pressed",
      "+1.100s\tBTN_LEFT (272) released",
      "+2.000s\tBTN_LEFT (272) pressed",
      "+2.100s\tBTN_LEFT (272) released",
      "+3.000s\tBTN_LEFT (272) pressed",
      "+3.100s\tBTN_LEFT (272) released",
      "+4.000s\tBTN_LEFT (272) pressed",
      "+4.100s\tBTN_LEFT (272) released",
    ]
      .map((l) => ` event9   POINTER_BUTTON               ${l}, seat count: 1`)
      .join("\n");
    const evd = parseEvdev(log);
    expect(evd.length === 8, `parsed ${evd.length}`);
    const at = (s: number, e: "down" | "up", f: number): InputTraceEvent => ({ ...ev(e, f, 0), t: s * 1000 });
    const t = trace(
      at(2.5, "down", 10), at(2.6, "up", 16),
      at(3.5, "down", 70), at(3.6, "up", 76),
      at(4.5, "down", 130), at(4.6, "up", 136),
      at(5.6, "up", 196), // the orphan
      at(7.0, "down", 280), at(7.1, "up", 286), // after the log
    );
    const align = alignEvdev(t, evd);
    expect(align !== null && Math.abs(align.offset - 1500) < 1, `offset ${align?.offset}`);
    expect(align!.matched === 3, `matched ${align!.matched}`);
    const report = evdevReport(t, evd);
    expect(report.some((l) => l.includes("evdev has the press at 5.500 s")), report.join("\n"));
    return `offset 1.5 s, 3 of 4 matched, orphan at 5.6 s placed on the mouse's press at 5.5 s`;
  },

  "a mouse press under an orphan up is a flipped press": () => {
    const log = [
      "+1.000s\tBTN_LEFT (272) pressed",
      "+1.100s\tBTN_LEFT (272) released",
      "+2.000s\tBTN_LEFT (272) pressed",
      "+2.216s\tBTN_LEFT (272) released",
      "+3.000s\tBTN_LEFT (272) pressed",
      "+3.100s\tBTN_LEFT (272) released",
    ]
      .map((l) => ` event9   POINTER_BUTTON               ${l}, seat count: 1`)
      .join("\n");
    const at = (s: number, e: "down" | "up", f: number): InputTraceEvent => ({ ...ev(e, f, 0), t: s * 1000 });
    // The second click reached the DOM as a lone up at the press's own time.
    const t = trace(at(1.0, "down", 10), at(1.1, "up", 16), at(2.0, "up", 70), at(3.0, "down", 130), at(3.1, "up", 136));
    const report = evdevReport(t, parseEvdev(log));
    const verdict = report.find((l) => l.includes("INVERTED"));
    expect(verdict !== undefined, report.join("\n"));
    expect(verdict!.includes("press at 2.000 s") && verdict!.includes("release at 2.216 s"), verdict!);
    return `press at 2.0 s met by a DOM up at 2.0 s -> INVERTED, its release at 2.216 s reached nothing`;
  },

  "a WAYLAND_DEBUG log parses to the same stream": () => {
    const log = [
      "[3273245.129]  wl_pointer#31.button(33591, 3273245, 272, 1)",
      "[3273245.130]  wl_pointer@31.frame()",
      "[3273461.220]  wl_pointer@31.button(33592, 3273461, 272, 0)",
      "[3273500.000] -> wl_surface@20.commit()",
      "[3273600.500]  wl_pointer@31.button(33593, 3273600, 273, 1)",
    ].join("\n");
    const w = parseWaylandDebug(log);
    expect(w.length === 3, `parsed ${w.length}`);
    expect(w[0]!.e === "down" && w[0]!.b === 0 && Math.abs(w[0]!.t - 3273245.129) < 1e-6, JSON.stringify(w[0]));
    expect(w[1]!.e === "up" && w[2]!.b === 2, JSON.stringify(w.slice(1)));
    return `3 button lines of 5 -> left down, left up, right down`;
  },

  "an orphan up past the end of the evdev log is inconclusive": () => {
    const log = [" event9   POINTER_BUTTON               +1.000s\tBTN_LEFT (272) pressed, seat count: 1", " event9   POINTER_BUTTON               +1.100s\tBTN_LEFT (272) released, seat count: 0"].join("\n");
    const at = (s: number, e: "down" | "up", f: number): InputTraceEvent => ({ ...ev(e, f, 0), t: s * 1000 });
    const t = trace(at(1.0, "down", 10), at(1.1, "up", 16), at(9.0, "up", 500));
    const report = evdevReport(t, parseEvdev(log));
    expect(report.some((l) => l.includes("INCONCLUSIVE")), report.join("\n"));
    return `log ends at 1.1 s, orphan at 9.0 s -> inconclusive`;
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
