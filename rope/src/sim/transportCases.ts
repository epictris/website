// The replay transport's cases (`cli transport`, see replayTransport.ts): which
// recorded frame is on screen after a stretch of playing, a speed change, a
// pause, a seek in either direction, and a reset crossed on the way.
//
// Pure, and therefore exact: the transport is arithmetic over a frame list and a
// clock, and the host it drives is a stub that records what it was asked to do.
// What the cases are FOR is the one thing the browser cannot show cheaply - that
// a backward seek lands on the same frame the recording played, from the nearest
// build rather than from frame 0 - because on screen a wrong landing looks like
// a run that simply went differently.

import { Vec2 } from "../engine/vec2";
import { emptyFrameInput, type FrameInput } from "../input/frameInput";
import { ReplayTransport, type ReplayHost } from "./replayTransport";

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// A recording of `n` frames, each stamped with its own index so the host can say
// which frames it was fed rather than only how many.
function recording(n: number): FrameInput[] {
  return Array.from({ length: n }, (_, i) => {
    const input = emptyFrameInput();
    input.mouseWorldPosition = new Vec2(i, 0);
    return input;
  });
}

const frameNumber = (input: FrameInput): number => input.mouseWorldPosition.x;

// A stand-in for main.ts: it counts builds, remembers every frame it stepped,
// and resets itself at the recorded frames a run ended on - which is the whole
// of what the transport needs a level for.
class StubHost implements ReplayHost {
  builds = 0;
  seekEnds = 0;
  readonly stepped: number[] = [];
  transport!: ReplayTransport;

  // `resetsAt` are frame indices (0-based, as `stepped` records them) whose step
  // ended the run, exactly as a kill zone or a jump press does on the page.
  constructor(private readonly resetsAt: readonly number[] = []) {}

  rebuild(): void {
    this.builds++;
  }

  step(input: FrameInput, _seeking: boolean): void {
    const frame = frameNumber(input);
    this.stepped.push(frame);
    if (this.resetsAt.includes(frame)) {
      this.rebuild();
      this.transport.noteReset();
    }
  }

  seekEnded(): void {
    this.seekEnds++;
  }
}

function make(frames: number, resetsAt: readonly number[] = []): [ReplayTransport, StubHost] {
  const host = new StubHost(resetsAt);
  const transport = new ReplayTransport(recording(frames), host);
  // Seeks land inside one pump unless a case says otherwise: a case that timed
  // its own budget would be measuring the machine it runs on.
  transport.seekBudgetMs = Infinity;
  host.transport = transport;
  return [transport, host];
}

// One second of rendered frames at 60 Hz.
function playSeconds(t: ReplayTransport, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) t.pump(1 / 60);
}

const CASES: Record<string, () => string> = {
  "a second of playing is sixty recorded frames": () => {
    const [t, host] = make(600);
    playSeconds(t, 1);
    expect(t.index === 60, `index ${t.index}`);
    expect(host.stepped.length === 60, `stepped ${host.stepped.length}`);
    expect(host.stepped[0] === 0 && host.stepped[59] === 59, `${host.stepped[0]}..${host.stepped[59]}`);
    return `60 rendered frames -> f${t.index}, in recorded order`;
  },

  "paused steps nothing and keeps the frame it is on": () => {
    const [t, host] = make(600);
    playSeconds(t, 0.5);
    const at = t.index;
    t.togglePause();
    playSeconds(t, 2);
    expect(t.index === at, `index ${t.index}, was ${at}`);
    expect(host.stepped.length === at, `stepped ${host.stepped.length}`);
    return `paused at f${at}, two seconds of frames -> f${t.index}`;
  },

  "speed scales the step rate, not the step": () => {
    const [t] = make(2000);
    t.nudgeSpeed(1); // 2x
    t.nudgeSpeed(1); // 4x
    expect(t.speed === 4, `speed ${t.speed}`);
    playSeconds(t, 1);
    expect(t.index === 240, `index ${t.index}`);
    return `1 s at ${t.speed}x -> f${t.index}`;
  },

  "the speed table clamps at both ends": () => {
    const [t] = make(10);
    for (let i = 0; i < 20; i++) t.nudgeSpeed(-1);
    expect(t.speed === 0.1, `slowest ${t.speed}`);
    for (let i = 0; i < 20; i++) t.nudgeSpeed(1);
    expect(t.speed === 16, `fastest ${t.speed}`);
    return `held down -> 0.1x, held up -> 16x`;
  },

  "slow motion interpolates between steps rather than repeating them": () => {
    const [t] = make(600);
    t.nudgeSpeed(-1); // 0.5x
    t.nudgeSpeed(-1); // 0.25x
    const alphas: number[] = [];
    for (let i = 0; i < 4; i++) {
      t.pump(1 / 60);
      alphas.push(t.alpha);
    }
    expect(t.index === 1, `index ${t.index}`);
    expect(new Set(alphas.map((a) => a.toFixed(3))).size === 4, `alphas ${alphas.join(",")}`);
    return `0.25x: one step across four rendered frames, alpha ${alphas.map((a) => a.toFixed(2)).join(" ")}`;
  },

  "a forward seek steps forward without rebuilding": () => {
    const [t, host] = make(600);
    playSeconds(t, 1);
    t.seek(300);
    t.pump(1 / 60);
    expect(t.index === 300, `index ${t.index}`);
    expect(host.builds === 0, `builds ${host.builds}`);
    expect(host.stepped.length === 300, `stepped ${host.stepped.length}`);
    expect(host.seekEnds === 1, `seekEnds ${host.seekEnds}`);
    return `f60 -> f300 by stepping, 0 builds`;
  },

  "a backward seek rebuilds and re-simulates to the target": () => {
    const [t, host] = make(600);
    playSeconds(t, 5);
    expect(t.index === 300, `index ${t.index}`);
    t.seek(120);
    t.pump(1 / 60);
    expect(t.index === 120, `index ${t.index}`);
    expect(host.builds === 1, `builds ${host.builds}`);
    // 300 played, then 120 re-simulated from the build.
    expect(host.stepped.length === 420, `stepped ${host.stepped.length}`);
    expect(host.stepped[300] === 0, `first re-simulated frame ${host.stepped[300]}`);
    expect(host.stepped[419] === 119, `last re-simulated frame ${host.stepped[419]}`);
    return `f300 -> f120: 1 build + 120 steps, on the recorded inputs`;
  },

  "a backward seek inside the last run rebuilds from that run's start": () => {
    // The run ends on recorded frame 199, so the next run begins at f200.
    const [t, host] = make(600, [199]);
    t.seek(400);
    t.pump(1 / 60);
    expect(t.index === 400, `index ${t.index}`);
    const stepsToTarget = host.stepped.length;
    const buildsToTarget = host.builds; // the reset itself
    t.seek(300);
    t.pump(1 / 60);
    expect(t.index === 300, `index ${t.index}`);
    // From f200, not from f0: a hundred steps, not three hundred.
    expect(host.stepped.length - stepsToTarget === 100, `re-simulated ${host.stepped.length - stepsToTarget}`);
    expect(host.stepped[stepsToTarget] === 200, `restarted at f${host.stepped[stepsToTarget]}`);
    expect(host.builds === buildsToTarget + 1, `builds ${host.builds}`);
    return `f400 -> f300 across a run that began at f200: 100 steps`;
  },

  "a seek back past a reset pays for the run before it": () => {
    const [t, host] = make(600, [199]);
    t.seek(400);
    t.pump(1 / 60);
    const stepsToTarget = host.stepped.length;
    t.seek(100);
    t.pump(1 / 60);
    expect(t.index === 100, `index ${t.index}`);
    expect(host.stepped[stepsToTarget] === 0, `restarted at f${host.stepped[stepsToTarget]}`);
    // 100 steps, and the run boundary at f199 is not crossed on the way.
    expect(host.stepped.length - stepsToTarget === 100, `re-simulated ${host.stepped.length - stepsToTarget}`);
    return `f400 -> f100: rebuilt at f0, 100 steps`;
  },

  "a seek is paid off across rendered frames under its budget": () => {
    const [t, host] = make(600);
    t.seekBudgetMs = 0; // one step per pump, which is what a budget of nothing buys
    t.seek(5);
    t.pump(1 / 60);
    expect(t.index === 1, `index ${t.index}`);
    expect(t.seeking, "still seeking after the first frame");
    for (let i = 0; i < 4; i++) t.pump(1 / 60);
    expect(t.index === 5 && !t.seeking, `index ${t.index}, seeking ${t.seeking}`);
    expect(host.seekEnds === 1, `seekEnds ${host.seekEnds}`);
    return `a seek of five frames under a spent budget: five rendered frames, one landing`;
  },

  "seeks are relative to where the transport is headed": () => {
    const [t] = make(600);
    t.seekBudgetMs = 0;
    playSeconds(t, 5);
    t.seekBy(-60);
    t.seekBy(-60);
    expect(t.target === 180, `target ${t.target}`);
    return `two 1 s rewinds from f300 -> f${t.target}`;
  },

  "a seek clamps to the recording": () => {
    const [t] = make(100);
    t.seek(9999);
    t.pump(1 / 60);
    expect(t.index === 100, `index ${t.index}`);
    t.seek(-50);
    t.pump(1 / 60);
    expect(t.index === 0, `index ${t.index}`);
    return `f9999 -> f100, f-50 -> f0`;
  },

  "the end holds the last input and the counter stops": () => {
    const [t, host] = make(10);
    playSeconds(t, 1);
    expect(t.index === 10, `index ${t.index}`);
    expect(t.atEnd, "atEnd");
    // Every step past the end is the final recorded input again.
    expect(host.stepped.length === 60, `stepped ${host.stepped.length}`);
    expect(host.stepped.slice(10).every((f) => f === 9), `held ${host.stepped.slice(10, 14).join(",")}`);
    return `10 recorded frames, 60 steps: f${t.index} held on the last input`;
  },

  "stepping a frame pauses and moves exactly one": () => {
    const [t] = make(600);
    playSeconds(t, 1);
    t.stepFrames(1);
    t.pump(1 / 60);
    expect(t.paused, "paused");
    expect(t.index === 61, `index ${t.index}`);
    t.stepFrames(-1);
    t.pump(1 / 60);
    expect(t.index === 60, `index ${t.index}`);
    return `f60 -> f61 -> f60, paused throughout`;
  },

  "a run boundary is learnt from the reset that was stepped through": () => {
    const [t] = make(600, [199]);
    expect(t.runStarts.join(",") === "0", `before: ${t.runStarts.join(",")}`);
    t.seek(300);
    t.pump(1 / 60);
    expect(t.runStarts.join(",") === "0,200", `after: ${t.runStarts.join(",")}`);
    // Crossed again by a second pass, and still one boundary.
    t.seek(0);
    t.pump(1 / 60);
    t.seek(300);
    t.pump(1 / 60);
    expect(t.runStarts.join(",") === "0,200", `twice: ${t.runStarts.join(",")}`);
    return `reset on f199 -> run starts ${t.runStarts.join(", ")}`;
  },
};

export function runTransportCases(): CaseResult[] {
  return Object.entries(CASES).map(([name, fn]) => {
    try {
      return { name, pass: true, detail: fn() };
    } catch (e) {
      return { name, pass: false, detail: e instanceof Error ? e.message : String(e) };
    }
  });
}
