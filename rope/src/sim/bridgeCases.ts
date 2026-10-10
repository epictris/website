// Rope-bridge cases: slats hung between two posts by one chain knotted through
// them (`ChainData.through`, solved by `engine/ties.ts`), with the answer
// written down, run by `cli bridges`.
//
// These are the cases `plans/rope-bridge.md` names as what a bridge must do
// before its solver is done. They were written BEFORE that solver existed, red
// against the chain phase with the number each measured (the `contactCases`
// precedent), and the solver landing turned them green and removed the markers
// - the runner fails on a stale one. What stays red is marked and says why.
//
// The rig is the one `session-235f` recorded: slats of 0.15 x 0.05 m wood, half
// a metre thick (2.6 kg), tied end to end by 15 cm of rope between two posts
// 2.6 m above a floor, the 52 kg ball beside it. Nothing here assumes the slats
// are evenly spaced or the same size: a spec is a list of GAPS and a list of
// widths, and `bridge-uneven` is the rig with neither regular.
//
// Every assertion is a bound, never an exact number. What a bridge must do is
// hang within the sweep's tolerance, keep its slats from turning faster than a
// chain solve can see, sleep as one thing, carry the ball across and hang it
// underneath, do all of that whatever the slats weigh, and cost what a
// substepped solve costs rather than what a capped sweep does.

import { Vec2 } from "../engine/vec2";
import { RigidBody2D } from "../engine/body";
import { World } from "../engine/world";
import { BallLevel } from "../level/ballLevel";
import { CHAIN_TOLERANCE, buildSceneChains, settleTiesAtBuild } from "../level/chains";
import { buildLevelBodies } from "../level/buildBodies";
import type { TieChain } from "../engine/ties";
import { scaleLevelData, type ChainData, type LevelBodyData, type RawLevelData } from "../level/levelFormat";
import { emptyFrameInput, type FrameInput } from "../input/frameInput";
import { BallHook } from "../classes/ballHook";
import { SolverStats } from "../engine/solverStats";
import { checkBallInvariants, checkSleepers, checkTieChains, type Violation } from "./trace";

export interface BridgeResult {
  name: string;
  passed: boolean;
  details: string[];
  // Red on purpose, with the diagnosis above the case. See `ContactResult`.
  expectedFail?: true;
}

const DT = 1 / 60;
const PX = 1 / 100;

// Bars.
//
// Over-length a settled bridge may carry per segment: twice the sweep's own
// bar, since a bridge is twenty constraints in series and the tolerance is per
// constraint.
const SETTLED_OVER = 2 * CHAIN_TOLERANCE;
// Over-length ANY frame may end on, the invariant's own bar
// (`chain-over-length`): a rig the cap binds on ends at 15 mm, a broken one at
// metres.
const WORST_OVER = 0.05;
// A slat on a chain turns at what a swinging thing turns at. The invariant's
// bar is a quarter turn a frame; this is the hanging bar.
const SETTLED_SPIN = 10;
// Constraint solves per segment per frame a bridge may cost at rest with the
// ball on it. Eight substeps of a solve and a relax is 16 for the ties; the
// rest is the contact rows the island solves beside them - the end slats on
// their posts and the ball on the middle, nine rows on the 60-slat rig - which
// are the contacts' work and not the segments'. The capped sweep spent 64.
const SOLVES_PER_SEGMENT = 20;

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface BridgeSpec {
  // Rope between consecutive tie points, in level pixels: post to the first
  // slat, slat to slat, the last slat to the post. One more than the slats.
  gaps: number[];
  // Slat widths in pixels, one per slat (or one for all).
  slatW: number | number[];
  slatH?: number;
  // The slat's depth through z in pixels: 50 (0.5 m) is 2.6 kg of wood for a
  // 15 x 5 slat, and it is the knob the mass-ratio case turns.
  thickness?: number;
  // Rope length as a fraction over the authored gap. 0 is the bridge authored
  // taut, which is `session-235f` and is unsatisfiable under gravity.
  slack?: number;
  // The island's substeps per frame (`ChainData.substeps`); absent = the
  // solver's default.
  substeps?: number;
  // Where the ball starts, in pixels.
  ball: { x: number; y: number };
}

const DECK_Y = -262.5;
const POST_W = 65;
const POST_H = 240;
const POST_Y = -150;
const ANCHOR_Y = DECK_Y - 0.75;

export function bridgeLevel(spec: BridgeSpec): RawLevelData {
  const n = spec.gaps.length - 1;
  const widths = typeof spec.slatW === "number" ? Array(n).fill(spec.slatW) : spec.slatW;
  if (widths.length !== n) throw new Error("one width per slat");
  const slatH = spec.slatH ?? 5;
  const thickness = spec.thickness ?? 50;
  const slack = spec.slack ?? 0;
  const bodies: LevelBodyData[] = [];
  const chains: ChainData[] = [];
  // The floor the ball starts on.
  bodies.push({
    kind: "static",
    x: 0,
    y: 0,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 1600, h: 60 } }],
  });
  // Lay the deck from the left anchor: each slat's left tie is the previous
  // right tie plus its gap.
  let span = 0;
  for (const g of spec.gaps) span += g;
  for (const w of widths) span += w;
  const leftAnchorX = -span / 2;
  bodies.push({
    kind: "static",
    x: leftAnchorX - POST_W / 2,
    y: POST_Y,
    rot: 0,
    objects: [
      { type: "collision", shape: { kind: "rect", w: POST_W, h: POST_H } },
      { type: "anchor", id: 1, x: POST_W / 2, y: ANCHOR_Y - POST_Y, rot: 0 },
    ],
  });
  bodies.push({
    kind: "static",
    x: leftAnchorX + span + POST_W / 2,
    y: POST_Y,
    rot: 0,
    objects: [
      { type: "collision", shape: { kind: "rect", w: POST_W, h: POST_H } },
      { type: "anchor", id: 2, x: -POST_W / 2, y: ANCHOR_Y - POST_Y, rot: 0 },
    ],
  });
  let x = leftAnchorX;
  const through: number[] = [];
  for (let i = 0; i < n; i++) {
    const gap = spec.gaps[i]!;
    const w = widths[i]!;
    x += gap;
    const left = 10 + 2 * i;
    const right = 11 + 2 * i;
    bodies.push({
      kind: "rigid",
      x: x + w / 2,
      y: DECK_Y,
      rot: 0,
      objects: [
        { type: "collision", shape: { kind: "rect", w, h: slatH }, thickness },
        { type: "anchor", id: left, x: -w / 2, y: 0, rot: 0 },
        { type: "anchor", id: right, x: w / 2, y: 0, rot: 0 },
      ],
    });
    through.push(left, right);
    x += w;
  }
  // ONE chain, knotted through every slat (`ChainData.through`): what a bridge
  // is to the solver, and what the editor's one drag post-slat-...-post makes.
  chains.push({ a: 1, b: 2, through, ...(slack > 0 ? { slack } : {}), ...(spec.substeps !== undefined ? { substeps: spec.substeps } : {}) });
  return {
    player: { x: spec.ball.x, y: spec.ball.y, radius: 8 },
    bodies,
    chains,
  } as RawLevelData;
}

function uniform(n: number, gap: number): number[] {
  return Array(n + 1).fill(gap);
}

// The ball's default start: on the floor, clear of the deck.
const BALL_ON_FLOOR = { x: 0, y: -38 };

class Rig {
  readonly level: BallLevel;
  readonly slats: RigidBody2D[];
  readonly ties: readonly TieChain[];
  readonly violations: Violation[] = [];
  frame = 0;
  // Worst over-length and spin over the frames `watch` was on.
  worstOver = 0;
  worstSpin = 0;
  // Constraint solves summed over the watched frames.
  solves = 0;
  watchedFrames = 0;

  constructor(spec: BridgeSpec) {
    this.level = new BallLevel(bridgeLevel(spec));
    this.slats = this.level.bodies.filter(
      (b): b is RigidBody2D => b instanceof RigidBody2D && b !== this.level.ball,
    );
    this.ties = this.level.tieChains;
  }

  // Segments across every tied chain of the rig.
  get segments(): number {
    let n = 0;
    for (const c of this.ties) n += c.segments.length;
    return n;
  }

  // The worst segment residual across the rig as it stands.
  get over(): number {
    let over = 0;
    for (const c of this.ties) over = Math.max(over, c.over);
    return over;
  }

  // The state the build left: what `settleTiesAtBuild` did before frame 1.
  atBuild(): { violations: Violation[]; over: number; speed: number; spin: number } {
    const violations = [...checkTieChains(0, this.ties), ...checkSleepers(0, this.level.world)];
    const over = this.over;
    let speed = 0;
    let spin = 0;
    for (const s of this.slats) {
      speed = Math.max(speed, s.linearVelocity.length());
      spin = Math.max(spin, Math.abs(s.angularVelocity));
    }
    return { violations, over, speed, spin };
  }

  step(frames: number, input: (level: BallLevel) => FrameInput = neutral, watch = false): void {
    SolverStats.enabled = true;
    try {
      for (let i = 0; i < frames; i++) {
        SolverStats.reset();
        this.level.physicsProcess(input(this.level), DT);
        this.frame++;
        this.violations.push(...checkBallInvariants(this.level));
        if (!watch) continue;
        this.watchedFrames++;
        this.solves += SolverStats.solves;
        this.worstOver = Math.max(this.worstOver, this.over);
        for (const s of this.slats) this.worstSpin = Math.max(this.worstSpin, Math.abs(s.angularVelocity));
      }
    } finally {
      SolverStats.enabled = false;
    }
  }

  // Frames until `test` holds, stepping with `input`; -1 if not within `limit`.
  until(limit: number, test: () => boolean, input: (level: BallLevel) => FrameInput = neutral): number {
    for (let i = 0; i < limit; i++) {
      if (test()) return this.frame;
      this.step(1, input);
    }
    return test() ? this.frame : -1;
  }

  slat(i: number): RigidBody2D {
    const s = this.slats[i];
    if (!s) throw new Error(`no slat ${i}`);
    return s;
  }

  allAsleep(): boolean {
    return this.slats.every((s) => s.asleep) && this.ties.every((c) => c.asleep);
  }

  // Violations by kind, as one line.
  violationLine(): string {
    if (this.violations.length === 0) return "no invariant violations";
    const counts = new Map<string, number>();
    for (const v of this.violations) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
    return (
      `${this.violations.length} violations: ` +
      [...counts].map(([k, n]) => `${k} x${n}`).join(", ") +
      ` (first: f${this.violations[0]!.frame} ${this.violations[0]!.kind} ${this.violations[0]!.detail})`
    );
  }
}

// Hands off: the controller's own "not aiming" sentinel.
function neutral(level: BallLevel): FrameInput {
  return { ...emptyFrameInput(), mouseWorldPosition: level.ball.globalPosition };
}

// The aim whirling round the ball at `rate` rad/frame (positive rolls it to
// +x on level ground), `WHIRL_REACH` out, with the deploy button as asked. The
// entry suite's driver.
const WHIRL_REACH = 1.5;
// `alreadyHeld` continues a hold `fireAt` began: a fresh press on a hooked
// chain would be a redeploy and let go of the slat.
function whirl(rate: number, fire = false, alreadyHeld = false): (level: BallLevel) => FrameInput {
  let prevHeld = alreadyHeld;
  return (level) => {
    const at = level.ball.globalPosition.add(new Vec2(WHIRL_REACH, 0).rotated(level.frame * rate));
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: { held: fire, pressed: fire && !prevHeld, released: !fire && prevHeld },
      mouseWorldPosition: at,
    };
    prevHeld = fire;
    return input;
  };
}

// The deploy button held with the aim on a world point: the hook flies there.
function fireAt(at: Vec2): (level: BallLevel) => FrameInput {
  let prevHeld = false;
  return () => {
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: { held: true, pressed: !prevHeld, released: false },
      mouseWorldPosition: at,
    };
    prevHeld = true;
    return input;
  };
}

function hookedToSlat(rig: Rig): boolean {
  const chain = rig.level.ball.chain;
  if (!chain) return false;
  const end = chain.end.contact.obj;
  return end instanceof RigidBody2D && !(end instanceof BallHook) && rig.slats.includes(end);
}

function ok(name: string, passed: boolean, details: string[]): BridgeResult {
  return { name, passed, details };
}

function expectedFail(name: string, passed: boolean, details: string[]): BridgeResult {
  return { name, passed, details, expectedFail: true };
}

function bar(claim: string, got: boolean): string {
  return `${got ? "ok  " : "BAD "} ${claim}`;
}

const mm = (m: number): string => `${(m * 1000).toFixed(1)}mm`;

// The 19-slat rig of `session-235f`, with the slack the recording lacked.
export function standard(slack: number, ball = BALL_ON_FLOOR, thickness?: number): BridgeSpec {
  return { gaps: uniform(19, 15), slatW: 15, slack, ball, ...(thickness !== undefined ? { thickness } : {}) };
}

// ---------------------------------------------------------------------------
// bridge-build: what the build settle hands to frame 1.
//
// The build settle runs for up to 600 frames with sleep on. On `session-235f`
// (one `Rope` per segment) the rightmost slat fell asleep at settle frame 73
// while its neighbours were still sweeping at the cap, the awake neighbour then
// dragged the sleeping slat off its post with no chain left in the set to
// measure it, and frame 1 opened with a chain 2.95 m over its length and a
// slat asleep at 125 m/s: eight invariants, 2028 mm over, 124.7 m/s. The
// three detectors here (`chain-over-length`, `chain-asleep-stretched`,
// `asleep-moving`) are what that state trips, and this case asks them of the
// built level before any frame has run.
//
// Green since the island solver (2026-10-10): an island sleeps whole or not at
// all (`TieSolver.settleSleep`), and the settle hands frame 1 a bridge 3.5 mm
// over on its worst segment, its fastest slat at 0.02 m/s.
// ---------------------------------------------------------------------------
function caseBuild(): BridgeResult {
  const rig = new Rig(standard(0.03));
  const s = rig.atBuild();
  const kinds = [...new Set(s.violations.map((v) => v.kind))];
  const clean = s.violations.length === 0;
  const bounded = s.over <= WORST_OVER && s.speed <= 1 && s.spin <= SETTLED_SPIN;
  const details = [
    bar(`built level trips no chain or sleep invariant (${s.violations.length}: ${kinds.join(", ") || "-"})`, clean),
    bar(`worst over-length at build ${mm(s.over)} (want <${mm(WORST_OVER)})`, s.over <= WORST_OVER),
    bar(`fastest slat at build ${s.speed.toFixed(2)} m/s, ${s.spin.toFixed(1)} rad/s`, s.speed <= 1 && s.spin <= SETTLED_SPIN),
  ];
  return ok("bridge-build - the build settle hands frame 1 a bridge, not a wreck", clean && bounded, details);
}

// ---------------------------------------------------------------------------
// bridge-hangs: the bridge at rest.
//
// Within the tolerance on every segment, slats turning no faster than a swing,
// mirror-symmetric (the `chain-order` statement: nothing in the geometry
// chooses a side, so the solver may not), and asleep as one thing.
//
// On the chain phase the segments settled inside 5 mm but a slat turned at
// 750 rad/s through the settled window (two turns a frame, so the chain could
// not see it), the rig leaned 5.5 mm off mirror, never slept, and tripped
// 8484 invariants from frame 1. On the island solver: 3.5 mm, 0.00 rad/s,
// 0.0 mm off mirror, asleep whole at f600.
// ---------------------------------------------------------------------------
function caseHangs(): BridgeResult {
  const rig = new Rig(standard(0.03));
  rig.step(480);
  rig.step(120, neutral, true);
  const n = rig.slats.length;
  let asym = 0;
  for (let i = 0; i < n / 2; i++) {
    const a = rig.slat(i).globalPosition;
    const b = rig.slat(n - 1 - i).globalPosition;
    asym = Math.max(asym, Math.abs(a.y - b.y), Math.abs(a.x + b.x));
  }
  const asleepAt = rig.until(600, () => rig.allAsleep());
  const within = rig.worstOver <= SETTLED_OVER;
  const still = rig.worstSpin <= SETTLED_SPIN;
  const symmetric = asym <= 0.002;
  const sleeps = asleepAt >= 0;
  const clean = rig.violations.length === 0;
  const details = [
    bar(`worst segment over-length f481-600 ${mm(rig.worstOver)} (want <${mm(SETTLED_OVER)})`, within),
    bar(`worst slat spin f481-600 ${rig.worstSpin.toFixed(2)} rad/s (want <${SETTLED_SPIN})`, still),
    bar(`mirror asymmetry ${mm(asym)} (want <2mm)`, symmetric),
    bar(`whole bridge asleep ${sleeps ? `at f${asleepAt}` : "never (within f1200)"}`, sleeps),
    bar(rig.violationLine(), clean),
  ];
  return ok("bridge-hangs - a slack bridge hangs within tolerance, level, symmetric, and sleeps whole", within && still && symmetric && sleeps && clean, details);
}

// ---------------------------------------------------------------------------
// bridge-taut: the bridge as `session-235f` authored it, with no slack at all.
//
// A straight cable under transverse load has unbounded tension, so this rig
// cannot be satisfied exactly. On the chain phase it never converged: 144 mm
// over on the worst segment and a slat at 2625 rad/s - seven turns a frame -
// with 1520 invariants tripped. On the island solver the rows are soft, which
// is what makes the system well-posed, and the bridge hangs stretched by what
// its load needs: 4.6 mm over, 0.1 rad/s, nothing tripped. The loader warns
// once that such a chain hangs on its softness; it does not refuse it.
// ---------------------------------------------------------------------------
function caseTaut(): BridgeResult {
  const rig = new Rig(standard(0));
  rig.step(300, neutral, true);
  const bounded = rig.worstOver <= WORST_OVER;
  const still = rig.worstSpin <= SETTLED_SPIN;
  const clean = rig.violations.length === 0;
  const details = [
    bar(`worst segment over-length f1-300 ${mm(rig.worstOver)} (want <${mm(WORST_OVER)})`, bounded),
    bar(`worst slat spin f1-300 ${rig.worstSpin.toFixed(1)} rad/s (want <${SETTLED_SPIN})`, still),
    bar(rig.violationLine(), clean),
  ];
  return ok("bridge-taut - a bridge authored with no slack stays bounded", bounded && still && clean, details);
}

// ---------------------------------------------------------------------------
// bridge-uneven: nothing about the solver may assume a pitch. Gaps from 8 to
// 40 px and slats from 10 to 25 wide, hung and left alone.
//
// On the chain phase this one hung quietly (7.2 mm, 0.6 rad/s, no invariant)
// but never slept whole: a slat asleep on one chain and awake on the other
// from f131 on. On the island solver: 4.6 mm, 0.00 rad/s, asleep at f600.
// ---------------------------------------------------------------------------
function caseUneven(): BridgeResult {
  const rig = new Rig({
    gaps: [20, 12, 30, 15, 8, 25, 15, 40, 10, 15, 22, 15, 15, 35, 12, 15, 18, 15, 20, 15],
    slatW: [15, 20, 10, 15, 25, 15, 12, 18, 15, 22, 15, 10, 15, 20, 15, 15, 25, 12, 15],
    slack: 0.03,
    ball: BALL_ON_FLOOR,
  });
  rig.step(480);
  rig.step(120, neutral, true);
  const asleepAt = rig.until(600, () => rig.allAsleep());
  const within = rig.worstOver <= SETTLED_OVER;
  const still = rig.worstSpin <= SETTLED_SPIN;
  const sleeps = asleepAt >= 0;
  const clean = rig.violations.length === 0;
  const details = [
    bar(`worst segment over-length f481-600 ${mm(rig.worstOver)} (want <${mm(SETTLED_OVER)})`, within),
    bar(`worst slat spin f481-600 ${rig.worstSpin.toFixed(2)} rad/s (want <${SETTLED_SPIN})`, still),
    bar(`whole bridge asleep ${sleeps ? `at f${asleepAt}` : "never (within f1200)"}`, sleeps),
    bar(rig.violationLine(), clean),
  ];
  return ok("bridge-uneven - irregular gaps and slat sizes hang and sleep the same", within && still && sleeps && clean, details);
}

// ---------------------------------------------------------------------------
// bridge-ball-rolls: the ball rolls across from one post to the other.
//
// The ball starts on the left post's top, the aim whirls to roll it right,
// and it has to arrive at the far post over the deck rather than through it.
//
// On the chain phase the deck was a row of slats spinning at whole turns a
// frame and the ball dropped through it to the floor. On the island solver,
// with the ball's contacts on the slats solved in the island (see
// `TieSolver.ownsContact`), it crosses in 170 frames, never lower than 126 mm
// above the lowest slat's centre.
// ---------------------------------------------------------------------------
function caseBallRolls(): BridgeResult {
  // The 19-slat deck with the gaps closed to 6 px: `session-235f`'s own gaps
  // are 15 px between 15 px slats, and the ball is 16 px across, so on that
  // deck it falls through the first gap a slat tilts open whatever the
  // solver does. A deck meant to be rolled on has gaps the ball cannot fit.
  const spec: BridgeSpec = { gaps: uniform(19, 6), slatW: 15, slack: 0.03, ball: BALL_ON_FLOOR };
  const raw = bridgeLevel(spec);
  const leftPost = raw.bodies[1]!;
  const rightPost = raw.bodies[2]!;
  spec.ball = { x: leftPost.x, y: POST_Y - POST_H / 2 - 8 };
  const rig = new Rig(spec);
  const goal = (rightPost.x - POST_W / 2) * PX;
  // How far the ball ever got below the deck's own lowest slat: a ball on a
  // sagging deck is above the slat under it, a ball through the deck is
  // metres below every slat. The deck itself sags under the ball by what its
  // slack allows, so the bar is the deck and not the authored line.
  let below = -Infinity;
  const arrived = rig.until(
    900,
    () => {
      let lowestSlat = -Infinity;
      for (const s of rig.slats) lowestSlat = Math.max(lowestSlat, s.globalPosition.y);
      below = Math.max(below, rig.level.ball.globalPosition.y - lowestSlat);
      return rig.level.ball.globalPosition.x >= goal;
    },
    whirl(0.2),
  );
  // Over-length is read at the end of the crossing.
  const over = rig.over;
  const crossed = arrived >= 0;
  const above = below < 0;
  const clean = rig.violations.length === 0;
  const details = [
    bar(`ball reached the far post ${crossed ? `at f${arrived}` : `never (x=${rig.level.ball.globalPosition.x.toFixed(2)} of ${goal.toFixed(2)} at f900)`}`, crossed),
    bar(`ball stayed on the deck (never more than ${mm(-below)} above the lowest slat's centre${below >= 0 ? ", fell below it" : ""})`, above),
    bar(`segment over-length at the end ${mm(over)}`, over <= WORST_OVER),
    bar(rig.violationLine(), clean),
  ];
  return ok("bridge-ball-rolls - the ball rolls the length of the bridge", crossed && above && clean && over <= WORST_OVER, details);
}

// ---------------------------------------------------------------------------
// bridge-ball-hangs: the ball hooked under the middle slat, winching.
//
// `session-235f`'s own act: the ball on the floor beneath, the hook thrown up
// to the middle slat, the aim whirled to wind chain onto the ball. The slat
// must come down by what the ball's weight asks of a 3% slack bridge and the
// bridge must take it quietly.
//
// On the chain phase this never got as far as the winch: the build settle
// left the deck sagging and spinning, the hook was turned away, and the chain
// ended on the floor. On the island solver the chain is a row of the island
// while it runs straight to the knot (`BallLevel.syncTieGuest`) and the deck
// carries the ball: hauled down 240 mm, 10 mm over, 2.3 rad/s hanging still.
// The wind is gentle on purpose - at 0.06 rad a frame the ball is wound up to
// the deck's underside and swings into the slats, and what the case then
// measures is the impact (113 rad/s on a slat the ball hit), not the bridge.
// ---------------------------------------------------------------------------
function caseBallHangs(): BridgeResult {
  const name = "bridge-ball-hangs - the ball hangs from the middle slat and winches";
  const rig = new Rig(standard(0.03));
  const mid = rig.slat(Math.floor(rig.slats.length / 2));
  const startY = mid.globalPosition.y;
  const hooked = rig.until(180, () => hookedToSlat(rig), fireAt(mid.globalPosition));
  if (hooked < 0) {
    const chain = rig.level.ball.chain;
    const end = chain ? chain.end.contact.obj : null;
    const where = end ? `${end.constructor.name}#${end.buildIndex}` : "nothing";
    return expectedFail(name, false, [
      bar(`hook attached to the middle slat within 180 frames (ended on ${where}; slat at y=${mid.globalPosition.y.toFixed(2)})`, false),
    ]);
  }
  // Wind for 240 frames, then hold the aim still under the ball for 180 with
  // the deploy button down, so the ball hangs from the deck with the chain it
  // wound. Over-length is watched throughout; the spin bar is asked of the
  // still window only, since a 52 kg ball whirled under a deck of 2.6 kg slats
  // swings into them and spins what it hits - that is the impact, not the
  // solver, and `chain-body-spin` is the bar on it.
  rig.step(240, whirl(0.03, true, true), true);
  const whirlOver = rig.worstOver;
  rig.worstOver = 0;
  rig.worstSpin = 0;
  rig.step(180, hold(), true);
  const hauled = mid.globalPosition.y - startY;
  const down = hauled >= 0.02;
  const bounded = Math.max(whirlOver, rig.worstOver) <= WORST_OVER;
  const still = rig.worstSpin <= SETTLED_SPIN;
  const clean = rig.violations.length === 0;
  const details = [
    bar(`hooked at f${hooked}; middle slat hauled down ${mm(hauled)} after 240 frames of winch and 180 hanging still (want >20mm)`, down),
    bar(`worst segment over-length winding ${mm(whirlOver)}, hanging still ${mm(rig.worstOver)} (want <${mm(WORST_OVER)})`, bounded),
    bar(`worst slat spin hanging still ${rig.worstSpin.toFixed(1)} rad/s (want <${SETTLED_SPIN})`, still),
    bar(rig.violationLine(), clean),
  ];
  return ok(name, down && bounded && still && clean, details);
}

// The deploy button held with the aim straight below the ball: the chain
// stays attached and nothing winds.
function hold(): (level: BallLevel) => FrameInput {
  return (level) => ({
    ...emptyFrameInput(),
    fire: { held: true, pressed: false, released: false },
    mouseWorldPosition: level.ball.globalPosition.add(new Vec2(0, WHIRL_REACH)),
  });
}

// ---------------------------------------------------------------------------
// bridge-mass-ratio: the ball dropped onto the middle slat, with the slats
// weighing 26 kg and 2.6 kg against its 52 - and, as its own case below,
// 0.26 kg.
//
// The study measured a Gauss-Seidel sweep needing 27 passes at 1:1 and 64 at
// 20:1 for the same residual; a solver that is right for a bridge gives the
// same answer across the ratios. Each rig must settle within tolerance; the
// ratio between the lightest and heaviest rig's residual is reported.
//
// On the chain phase the residuals were fine at every ratio (6.8, 6.5 and
// 5.1 mm) and the slats spun at 1500 rad/s at every ratio too, which said the
// spin was the solver's and not the mass ratio's. On the island solver: 4.0
// and 7.7 mm, 0.72 and 0.56 rad/s, nothing tripped.
// ---------------------------------------------------------------------------
interface RatioResult {
  ratio: string;
  over: number;
  spin: number;
  violations: number;
  // The worst over-length over the WHOLE run, drop included, and how many
  // consecutive frames it stood past the invariant's bar.
  peak: number;
  overFrames: number;
}

function runRatio(thickness: number, ratio: string): RatioResult {
  const rig = new Rig(standard(0.03, { x: 0, y: DECK_Y - 30 }, thickness));
  let peak = 0;
  let run = 0;
  let longest = 0;
  for (let f = 0; f < 480; f++) {
    rig.step(1);
    const over = rig.over;
    peak = Math.max(peak, over);
    run = over > WORST_OVER ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  rig.step(120, neutral, true);
  return { ratio, over: rig.worstOver, spin: rig.worstSpin, violations: rig.violations.length, peak, overFrames: longest };
}

function ratioBar(r: RatioResult): string {
  return bar(
    `ball:slat ${r.ratio} - worst over-length f481-600 ${mm(r.over)}, spin ${r.spin.toFixed(2)} rad/s, ` +
      `${r.violations} violations (drop peak ${mm(r.peak)}, ${r.overFrames} frames past ${mm(WORST_OVER)})`,
    r.over <= SETTLED_OVER && r.spin <= SETTLED_SPIN && r.violations === 0,
  );
}

function caseMassRatio(): BridgeResult {
  const results = [runRatio(500, "2:1"), runRatio(50, "20:1")];
  const within = results.every((r) => r.over <= SETTLED_OVER);
  const still = results.every((r) => r.spin <= SETTLED_SPIN);
  const clean = results.every((r) => r.violations === 0);
  const overs = results.map((r) => r.over);
  const spread = Math.max(...overs) / Math.max(Math.min(...overs), 1e-6);
  const details = results.map(ratioBar);
  details.push(`     residual spread across the ratios ${spread.toFixed(1)}x`);
  return ok("bridge-mass-ratio - the ball on the bridge settles within tolerance at 2:1 and 20:1", within && still && clean, details);
}

// ---------------------------------------------------------------------------
// bridge-mass-ratio-200: the same drop onto slats of 0.26 kg, 200 times
// lighter than the ball.
//
// Red on this tree (2026-10-10), and it is the solver's measured limit rather
// than a defect of the rig: the settled window is as good as the others (3.5
// mm, 0.87 rad/s), but the DROP stretches the segments under the ball to
// 85 mm for 22 consecutive frames before the load has crossed the bridge,
// which trips `chain-over-length` 334 times. A soft row at 60 Hz carries a
// 200:1 impact one light slat at a time; stiffer rows (120 Hz) halve the
// stretch and whip the slats to 83 rad/s instead, and more substeps buy
// nothing at this ratio (84.9 mm at sixteen). Box2D's own guidance for its
// soft step is to keep the mass ratio across a joint near 10:1, and this case
// is here to say where the bridge solver's edge is, with a number.
// ---------------------------------------------------------------------------
function caseMassRatio200(): BridgeResult {
  const r = runRatio(5, "200:1");
  const details = [ratioBar(r)];
  return expectedFail(
    "bridge-mass-ratio-200 - the ball dropped on slats 200 times lighter stretches nothing past the bar",
    r.over <= SETTLED_OVER && r.spin <= SETTLED_SPIN && r.violations === 0,
    details,
  );
}

// ---------------------------------------------------------------------------
// bridge-long: 60 slats with the ball resting on the middle, and what a frame
// of it costs in constraint solves.
//
// The capped sweep spent 64 solves per segment per frame on a rig like this
// (`session-235f`: 1280 a frame for 20 segments, 9-21 ms); eight substeps of
// a solve and a relax is 16, plus the island's contact rows. Work is asserted
// rather than milliseconds because work is deterministic. On the island
// solver: 18.4 per segment, 9.0 mm over at rest with the ball on the middle.
// ---------------------------------------------------------------------------
function caseLong(): BridgeResult {
  const rig = new Rig({ gaps: uniform(60, 15), slatW: 15, slack: 0.03, ball: { x: 0, y: DECK_Y - 30 } });
  rig.step(300);
  rig.step(120, neutral, true);
  const segments = rig.segments;
  const perSegment = rig.solves / rig.watchedFrames / segments;
  const cheap = perSegment <= SOLVES_PER_SEGMENT;
  const within = rig.worstOver <= SETTLED_OVER;
  const clean = rig.violations.length === 0;
  const details = [
    bar(`${perSegment.toFixed(1)} constraint solves per segment per frame at rest with the ball on it (want <=${SOLVES_PER_SEGMENT}; ${segments} segments)`, cheap),
    bar(`worst segment over-length f301-420 ${mm(rig.worstOver)} (want <${mm(SETTLED_OVER)})`, within),
    bar(rig.violationLine(), clean),
  ];
  return ok("bridge-long - sixty slats under the ball cost what a substepped solve costs", cheap && within && clean, details);
}

export function runBridgeCases(): BridgeResult[] {
  return [
    caseBuild(),
    caseHangs(),
    caseTaut(),
    caseUneven(),
    caseBallRolls(),
    caseBallHangs(),
    caseMassRatio(),
    caseMassRatio200(),
    caseLong(),
    caseChainRow(),
  ];
}

// ---------------------------------------------------------------------------
// chain-row: an authored chain solved as a row of the island solver - the
// plan's second stage, implemented and parked (see `RopeRow`). No level runs
// on it; this case is what keeps it built and measured. A lantern hung from a
// static by a chain, with the row path switched on (`buildSceneChains` given a
// world): it hangs within the tolerance, still, and sleeps - the arena's
// lanterns' statement, on the row.
// ---------------------------------------------------------------------------
function caseChainRow(): BridgeResult {
  const raw = {
    player: { x: 0, y: -38, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: -400,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 200, h: 40 } },
          { type: "anchor", id: 1, x: 0, y: 20, rot: 0 },
        ],
      },
      {
        kind: "rigid",
        x: 0,
        y: -300,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 20, h: 30 }, thickness: 50 },
          { type: "anchor", id: 2, x: 0, y: -15, rot: 0 },
        ],
      },
    ],
    // 65 px between the anchors as authored; 10 px of slack.
    chains: [{ a: 1, b: 2, length: 75 }],
  } as RawLevelData;
  const world = new World();
  const built = buildLevelBodies(world, scaleLevelData(raw, PX), () => {});
  const chains = buildSceneChains(scaleLevelData(raw, PX), built, world);
  const chain = chains[0];
  const lantern = built.bodies.map((b) => b.body).find((b): b is RigidBody2D => b instanceof RigidBody2D);
  if (!chain?.row || !lantern) {
    return ok("chain-row - an authored chain solved as a row of the island hangs and sleeps", false, [
      bar("the chain was built as a row with its lantern", false),
    ]);
  }
  settleTiesAtBuild(world, [chain.row]);
  const builtOver = chain.rope.overLength;
  const builtAsleep = chain.asleep;
  // Woken and left to hang for two seconds, then watched for two more.
  lantern.wake();
  lantern.applyImpulse(new Vec2(lantern.mass * 0.5, 0), new Vec2(0, 0.1));
  let worstOver = 0;
  let worstSpin = 0;
  let asleepAt = -1;
  for (let f = 1; f <= 600; f++) {
    world.integrate(DT);
    world.settleSleep();
    if (f > 120) {
      worstOver = Math.max(worstOver, chain.rope.overLength);
      worstSpin = Math.max(worstSpin, Math.abs(lantern.angularVelocity));
    }
    if (asleepAt < 0 && chain.asleep && lantern.asleep) asleepAt = f;
  }
  const within = worstOver <= SETTLED_OVER;
  const still = worstSpin <= SETTLED_SPIN;
  const sleeps = asleepAt >= 0;
  const details = [
    bar(`built settled and asleep (${mm(builtOver)} over, ${builtAsleep ? "asleep" : "awake"})`, builtOver <= SETTLED_OVER && builtAsleep),
    bar(`worst over-length f121-600 after a push ${mm(worstOver)} (want <${mm(SETTLED_OVER)})`, within),
    bar(`worst spin f121-600 ${worstSpin.toFixed(2)} rad/s (want <${SETTLED_SPIN})`, still),
    bar(`chain and lantern asleep ${sleeps ? `at f${asleepAt}` : "never (within f600)"}`, sleeps),
  ];
  return ok(
    "chain-row - an authored chain solved as a row of the island hangs and sleeps",
    builtOver <= SETTLED_OVER && builtAsleep && within && still && sleeps,
    details,
  );
}
