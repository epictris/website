// The button latch's cases (`cli latch`, see latch.ts): the queue that carries
// a sub-step click into the next sample. Pure, so the cases are exact.

import { ButtonLatch } from "./latch";

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
};

export function runInputCases(): CaseResult[] {
  return Object.entries(CASES).map(([name, fn]) => {
    try {
      return { name, pass: true, detail: fn() };
    } catch (e) {
      return { name, pass: false, detail: e instanceof Error ? e.message : String(e) };
    }
  });
}
