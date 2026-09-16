// Breakable-geometry cases: hand-built scenes with the answer written down,
// run by `cli breaks`.
//
// Breaking reaches no invariant, and cannot: a level in which a floor quietly
// stopped counting hits, or counted one per frame, replays with every energy,
// length and embedding check green and plays like a different game. So what is
// pinned here is the SHAPE of the rule rather than the feel of any threshold -
// a hit under the bar counts nothing, a strike counts once however many frames
// it lands over, a body resting on it is one hit and not sixty a second, a drag
// is not a hit at all, and a bounce is a fresh one every time it comes back.
//
// The first case is the MEASUREMENT the rest are written against, and it is the
// table an author needs: a contact reports `m·Δv/dt` plus the weight it was
// already carrying, so a threshold in newtons is a statement about a mass and a
// speed and nothing else. It is asserted against the closed form rather than
// against a recorded number, so it stays true of a solver that changes.

import { Vec2 } from "../engine/vec2";
import { GRAVITY, World } from "../engine/world";
import { RigidBody2D, StaticBody2D, type PhysicsBody2D } from "../engine/body";
import { circleShape, rectShape } from "../engine/shapes";
import { Density, ShapeGeometry } from "../lib/shapeGeometry";
import { BallLevel } from "../level/ballLevel";
import { BreakTracker, removeBrokenBody, type BreakEvent } from "../level/breakable";
import { buildLevelBodies } from "../level/buildBodies";
import { scaleLevelData, type LevelBodyData, type RawLevelData } from "../level/levelFormat";
import { modelFromDisk, modelToDisk } from "../editor/model";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import { PX } from "../engine/units";
import { checkBallInvariants, type Violation } from "./trace";

const DT = 1 / 60;
const G = GRAVITY.y;

export interface BreakResult {
  name: string;
  passed: boolean;
  details: string[];
  expectedFail?: true;
}

function ok(name: string, passed: boolean, details: string[]): BreakResult {
  return { name, passed, details };
}

// A claim list with one verdict, the pattern the other suites use.
function claims(): {
  check: (claim: string, got: boolean) => void;
  details: string[];
  passed: () => boolean;
} {
  const details: string[] = [];
  let passed = true;
  return {
    details,
    check: (claim, got) => {
      if (!got) passed = false;
      details.push(`${got ? "ok  " : "BAD "} ${claim}`);
    },
    passed: () => passed,
  };
}

// ---------------------------------------------------------------------------
// The rig: a breakable floor, a thing to drop on it, and the level's own
// end-of-step scan run by hand.
//
// The tracker rather than a `BallLevel` for everything below, deliberately: it
// IS the mechanism (both level drivers do exactly this and then release their
// chain), and a rig with no avatar in it cannot have the ball's own rolling,
// steering or chain phase move a number this suite is reading.
// ---------------------------------------------------------------------------
class Rig {
  readonly world = new World();
  readonly floor: StaticBody2D;
  readonly bodies: PhysicsBody2D[] = [];
  private readonly tracker = new BreakTracker();
  readonly breaks: BreakEvent[] = [];
  // Every frame's contact load on the floor, in newtons.
  readonly load: number[] = [];

  constructor(breakForce: number, durability = 1) {
    this.floor = new StaticBody2D();
    this.floor.globalPosition = Vec2.ZERO;
    this.floor.setShape(rectShape(40, 1));
    this.floor.breakForce = breakForce;
    this.floor.durability = durability;
    this.world.add(this.floor);
    this.bodies.push(this.floor);
  }

  // A box `size` metres square, `drop` metres above the floor's top face,
  // arriving with `vy` downward.
  box(size: number, drop: number, vy = 0, bounce = 0): RigidBody2D {
    const b = new RigidBody2D();
    b.setShape(rectShape(size, size));
    b.globalPosition = new Vec2(0, -(0.5 + size / 2 + drop));
    b.mass = ShapeGeometry.computeMass(b.primaryShape());
    b.inertia = ShapeGeometry.computeMomentOfInertia(b.primaryShape(), b.mass);
    b.linearVelocity = new Vec2(0, vy);
    b.restitution = bounce;
    this.world.add(b);
    this.bodies.push(b);
    return b;
  }

  // One frame, ending exactly as a level's does: integrate, then scan the
  // frame's contacts and destroy whatever they finished off.
  step(): void {
    this.world.integrate(DT);
    this.load.push(this.floorLoad());
    for (const event of this.tracker.scan(this.world, DT)) {
      this.breaks.push(event);
      removeBrokenBody(this.world, this.bodies, event.body);
    }
  }

  run(frames: number, each?: (f: number) => void): void {
    for (let f = 0; f < frames; f++) {
      this.step();
      each?.(f);
    }
  }

  private floorLoad(): number {
    let pn = 0;
    for (const c of this.world.frameContacts) {
      if (c.a === this.floor || c.b === this.floor) pn += c.normalImpulse;
    }
    return pn / DT;
  }

  get hits(): number {
    return this.floor.impactHits;
  }

  get broken(): boolean {
    return this.floor.removed;
  }
}

// ---------------------------------------------------------------------------
// load - what a contact actually reports, which is the whole of what a
// threshold is written against.
// ---------------------------------------------------------------------------
function caseLoad(): BreakResult {
  const c = claims();
  // A resting body presses with its weight and nothing else, for ever.
  const rest = new Rig(0);
  const box = rest.box(1, 0.01);
  rest.run(120);
  const weight = box.mass * G;
  const settled = rest.load.slice(-30);
  const restErr = Math.max(...settled.map((f) => Math.abs(f - weight) / weight));
  c.details.push(
    `      a ${box.mass.toFixed(0)} kg box at rest presses with ${settled[settled.length - 1]!.toFixed(0)} N (mg = ${weight.toFixed(0)} N)`,
  );
  c.check("a body at rest presses with its weight, to 1%", restErr < 0.01);

  // ...and an arriving one adds `m·v/dt` to it, in ONE frame. That is the
  // whole law: the solver cancels the approach within the step, so the impulse
  // it accumulates is the momentum it removed and the force is that over dt.
  const table: string[] = [];
  let lawHeld = true;
  let widthHeld = true;
  for (const v of [2, 5, 10, 20]) {
    const rig = new Rig(0);
    const b = rig.box(1, 0.01, v);
    rig.run(90);
    const peak = Math.max(...rig.load);
    const predicted = b.mass * v * 60 + b.mass * G;
    if (Math.abs(peak - predicted) / predicted > 0.02) lawHeld = false;
    // ...and it is over in one frame: the very next one is back to the weight.
    const at = rig.load.indexOf(peak);
    const after = rig.load[at + 1] ?? 0;
    if (after > 2 * b.mass * G) widthHeld = false;
    table.push(
      `      ${b.mass.toFixed(0)} kg at ${String(v).padStart(2)} m/s: ${peak.toFixed(0)} N (m·v/dt + mg = ${predicted.toFixed(0)} N), next frame ${after.toFixed(0)} N`,
    );
  }
  for (const row of table) c.details.push(row);
  c.check("an arrival reports m·v/dt plus the weight, to 2%", lawHeld);
  c.check("...and it is one frame wide: the next is back to the weight", widthHeld);

  // The ball the game is actually played with (8 cm, cast iron - `radius: 8` in
  // every level file's `player`), as the number an author is choosing.
  const ball = new RigidBody2D();
  ball.setShape(circleShape(0.08));
  ball.mass = ShapeGeometry.computeMass(ball.primaryShape(), Density.CAST_IRON);
  c.details.push(
    `      the 8 cm cast-iron ball is ${ball.mass.toFixed(1)} kg, so it hits at ${(ball.mass * 60).toFixed(0)} N per m/s and rests at ${(ball.mass * G).toFixed(0)} N`,
  );
  c.details.push(
    `      -> 5 m/s needs ${(ball.mass * 5 * 60 + ball.mass * G).toFixed(0)} N, 10 m/s ${(ball.mass * 10 * 60 + ball.mass * G).toFixed(0)} N, 20 m/s ${(ball.mass * 20 * 60 + ball.mass * G).toFixed(0)} N`,
  );
  return ok("break-load — a contact reports the weight it carries plus m·v/dt of arrival", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// threshold - under the bar is nothing, over it is exactly one.
// ---------------------------------------------------------------------------
function caseThreshold(): BreakResult {
  const c = claims();
  // A 1 m oak box is 140 kg; landing at 2 m/s it reports about 18.2 kN.
  const under = new Rig(30_000, 5);
  under.box(1, 0.01, 2);
  under.run(180);
  c.details.push(`      peak load ${Math.max(...under.load).toFixed(0)} N against a 30 kN threshold`);
  c.check("a hit under the threshold counts nothing", under.hits === 0 && !under.broken);

  const over = new Rig(10_000, 5);
  over.box(1, 0.01, 2);
  over.run(180);
  c.details.push(
    `      peak load ${Math.max(...over.load).toFixed(0)} N against a 10 kN threshold, ${over.hits} hit(s) in 180 frames`,
  );
  c.check("a hit over it counts exactly one", over.hits === 1 && !over.broken);

  // The resting load is over this one, which is a crust that gives under a
  // weight rather than under a blow. It is still ONE hit: the body pressing on
  // it is one continuous load, not a hit a frame.
  const resting = new Rig(1_000, 5);
  resting.box(1, 0.01);
  resting.run(300);
  c.details.push(
    `      a 1372 N resting weight on a 1 kN threshold: ${resting.hits} hit(s) in 300 frames`,
  );
  c.check("a resting load over the threshold is one hit, not one a frame", resting.hits === 1);
  return ok("break-threshold — under the bar counts nothing, over it counts once", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// durability - the count, and what the break leaves behind.
// ---------------------------------------------------------------------------
function caseDurability(): BreakResult {
  const c = claims();
  const rig = new Rig(10_000, 3);
  const box = rig.box(1, 0.01, 2);
  const hitsAt: number[] = [];
  let last = 0;
  // Three strikes, the box picked up and dropped again between them - which is
  // also the re-arm test: a pair that stops touching goes cold.
  for (let strike = 0; strike < 3; strike++) {
    box.globalPosition = new Vec2(0, -1.6);
    box.linearVelocity = new Vec2(0, 2);
    box.angularVelocity = 0;
    box.asleep = false;
    rig.run(40, () => {
      if (rig.hits !== last) {
        last = rig.hits;
        hitsAt.push(rig.load.length - 1);
      }
    });
    if (rig.broken) break;
  }
  c.details.push(`      hits landed on frames [${hitsAt.join(", ")}] of a 3-durability floor`);
  c.check("three strikes count three hits", rig.floor.impactHits === 3);
  c.check("...and the third one breaks it", rig.broken && rig.breaks.length === 1);
  const event = rig.breaks[0];
  c.check(
    "the body leaves the world and the level's body list",
    !!event && !rig.world.bodies.includes(rig.floor) && !rig.bodies.includes(rig.floor),
  );
  if (event) {
    c.details.push(
      `      the finishing hit: ${event.force.toFixed(0)} N at (${event.point.x.toFixed(2)}, ${event.point.y.toFixed(2)}), normal (${event.normal.x.toFixed(2)}, ${event.normal.y.toFixed(2)})`,
    );
    c.check("the event carries the force that broke it, over the threshold", event.force >= event.threshold);
    // Out of the broken body, toward what hit it: the box came down onto the
    // floor's top face, so the normal points up (negative y is up here).
    c.check("...and a normal out of the broken surface", event.normal.y < -0.9);
    c.check("...at a point on the face that was struck", Math.abs(event.point.y - -0.5) < 0.05);
  }
  // Nothing more can happen to a body that has broken.
  const before = rig.floor.impactHits;
  rig.run(60);
  c.check("a broken body takes no further hits", rig.floor.impactHits === before && rig.breaks.length === 1);
  return ok("break-durability — the count runs out and the body leaves the world", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// bounce - a body that comes back hits it again.
// ---------------------------------------------------------------------------
function caseBounce(): BreakResult {
  const c = claims();
  const rig = new Rig(10_000, 20);
  rig.box(1, 0.01, 6, 0.7);
  rig.run(300);
  const peaks = rig.load.filter((f) => f >= 10_000).length;
  c.details.push(`      ${rig.hits} hits over ${peaks} frames of load above the threshold`);
  c.check("a bouncing body hits it more than once", rig.hits >= 2);
  c.check("...and once per bounce, not once per frame over the bar", rig.hits <= peaks);
  return ok("break-bounce — a body that leaves and comes back is a fresh hit", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// drag - sliding along a face is not hitting it.
// ---------------------------------------------------------------------------
function caseDrag(): BreakResult {
  const c = claims();
  // The threshold is over the box's resting weight (1372 N) and far under any
  // real strike, so what is being asked is exactly whether a slide registers.
  const rig = new Rig(3_000, 5);
  const box = rig.box(1, 0.01);
  rig.run(60);
  const settled = rig.hits;
  box.linearVelocity = new Vec2(8, 0);
  box.asleep = false;
  rig.run(180);
  const peak = Math.max(...rig.load.slice(60));
  c.details.push(`      the slide's peak load is ${peak.toFixed(0)} N against a 3 kN threshold`);
  c.check("the box settled without a hit", settled === 0);
  c.check("...and dragging it across the face is still no hit", rig.hits === 0 && !rig.broken);
  return ok("break-drag — a body sliding along a face is not hitting it", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// chain - the ball's chain lets go of what breaks under it.
// ---------------------------------------------------------------------------
function slab(x: number, y: number, w: number, h: number, extra: Partial<LevelBodyData> = {}): LevelBodyData {
  return {
    kind: "static",
    x,
    y,
    rot: 0,
    friction: 1,
    objects: [{ type: "collision", shape: { kind: "rect", w, h } }],
    ...extra,
  } as LevelBodyData;
}

function caseChain(): BreakResult {
  const c = claims();
  // A ceiling to hang from, breakable at a threshold a dropped crate clears
  // and the hanging ball does not, and a floor to land on.
  const level = new BallLevel({
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      // Within the chain's 1.8 m, or there is nothing to hang from.
      slab(0, -150, 400, 40, { breakForce: 8_000, durability: 1 }),
      slab(0, 300, 800, 40),
      // The crate, parked on the floor well clear of the ball until the chain
      // is on the ceiling and it is picked up and dropped on it.
      {
        kind: "rigid",
        x: 300,
        y: 240,
        rot: 0,
        objects: [{ type: "collision", shape: { kind: "rect", w: 80, h: 80 }, material: "stone" }],
      } as LevelBodyData,
    ],
  } as RawLevelData);

  const violations: Violation[] = [];
  let prev: FrameInput = emptyFrameInput();
  const step = (fire: boolean): void => {
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: button(fire, prev.fire),
      mouseWorldPosition: new Vec2(0, -1.7),
    };
    prev = input;
    level.physicsProcess(input, DT);
    violations.push(...checkBallInvariants(level));
  };

  // `chainAnchored` is the looser statement (the throw is over, even if what it
  // ended as is a dangling tip); what this case is about is the chain BOLTED to
  // the ceiling, which is `anchoredTo`.
  let anchoredAt = -1;
  for (let f = 0; f < 240 && anchoredAt < 0; f++) {
    step(true);
    if (level.ball.anchoredTo !== null) anchoredAt = f;
  }
  const ceiling = level.world.bodies.find((b) => b.breakForce > 0) ?? null;
  c.details.push(
    `      the chain anchored on frame ${anchoredAt}, to build index ${level.ball.anchoredTo?.buildIndex ?? "-"} (the ceiling is ${ceiling?.buildIndex ?? "-"})`,
  );
  c.check("the ball is hanging from the breakable ceiling", anchoredAt >= 0 && level.ball.anchoredTo === ceiling);
  const hangingHits = ceiling?.impactHits ?? -1;

  // Hanging on it is not hitting it: the chain's pull reaches the ceiling as no
  // contact at all (the rope moves bodies, it does not press on them), which is
  // exactly why breaking under an anchor's LOAD is a separate feature.
  for (let f = 0; f < 60; f++) step(true);
  c.check("hanging from it is not a hit", hangingHits === 0 && (ceiling?.impactHits ?? -1) === 0);

  // Now drop the crate on it.
  const crate =
    level.world.bodies.find((b): b is RigidBody2D => b instanceof RigidBody2D && b !== level.ball) ??
    null;
  if (crate) {
    crate.globalPosition = new Vec2(0, -4);
    crate.linearVelocity = new Vec2(0, 6);
    crate.asleep = false;
  }
  let brokeAt = -1;
  for (let f = 0; f < 180 && brokeAt < 0; f++) {
    step(true);
    if (level.breakEvents.length > 0) brokeAt = f;
  }
  c.details.push(`      the crate broke it ${brokeAt} frames after it was dropped`);
  c.check("the crate breaks the ceiling", brokeAt >= 0 && !!ceiling?.removed);
  c.check("...the chain lets go of it", level.ball.chain === null && level.ball.anchoredTo === null);
  c.check(
    "...and the ceiling is out of the world and out of the level's bodies",
    !!ceiling && !level.world.bodies.includes(ceiling) && !level.bodies.includes(ceiling),
  );
  // The ball is now falling with no chain: the rest of the level must carry on
  // as an ordinary level does.
  for (let f = 0; f < 180; f++) step(false);
  c.check(`no invariant fired (${violations.length})`, violations.length === 0);
  for (const v of violations.slice(0, 3)) c.details.push(`      ${v.kind} f${v.frame}: ${v.detail}`);
  return ok("break-chain — the chain lets go of geometry that breaks under it", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// guard - a body something is authored to hang FROM cannot break.
// ---------------------------------------------------------------------------
function caseGuard(): BreakResult {
  const c = claims();
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  let level: BallLevel;
  try {
    level = new BallLevel({
      player: { x: 0, y: 0, radius: 8 },
      bodies: [
        slab(-200, -300, 80, 40, { breakForce: 5_000, durability: 1 }),
        slab(200, -300, 80, 40, { breakForce: 5_000, durability: 1 }),
        slab(0, 300, 800, 40),
      ],
      chains: [
        { a: { body: 0, x: -200, y: -280 }, b: { body: 1, x: 200, y: -280 } },
      ],
    } as unknown as RawLevelData);
  } finally {
    console.warn = realWarn;
  }
  const breakable = level.world.bodies.filter((b) => b.breakForce > 0);
  c.details.push(`      ${warned.length} warning(s): ${warned[0] ?? "-"}`);
  c.check("a chain anchor loses its threshold", breakable.length === 0);
  c.check("...loudly", warned.length === 2 && warned.every((w) => w.includes("[breakable]")));
  return ok("break-guard — a body a chain hangs from cannot break out from under it", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// format - the pair survives the format, the build and the editor.
// ---------------------------------------------------------------------------
function caseFormat(): BreakResult {
  const c = claims();
  const raw = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      slab(0, 0, 100, 40, { breakForce: 12_500, durability: 3 }),
      slab(200, 0, 100, 40),
      slab(400, 0, 100, 40, { breakForce: 800 }),
      slab(600, 0, 100, 40, { breakForce: -5, durability: 0.4 }),
    ],
  } as RawLevelData;
  const data = scaleLevelData(raw, PX);
  c.check(
    "scaleLevelData carries the newtons and the count through px -> m, unscaled",
    data.bodies[0]!.breakForce === 12_500 &&
      data.bodies[0]!.durability === 3 &&
      data.bodies[1]!.breakForce === undefined,
  );
  const world = new World();
  const built = buildLevelBodies(world, data, () => {});
  const bodies = built.bodies.map((b) => b.body!);
  c.check(
    "the build sets the pair on the body that authored it and no other",
    bodies[0]!.breakForce === 12_500 &&
      bodies[0]!.durability === 3 &&
      bodies[1]!.breakForce === 0 &&
      bodies[1]!.durability === 1,
  );
  c.check("a threshold with no durability breaks on the first hit", bodies[2]!.durability === 1);
  c.check(
    "nonsense is clamped rather than obeyed: no negative threshold, no fractional durability",
    bodies[3]!.breakForce === 0 && bodies[3]!.durability === 1,
  );
  const rt = modelToDisk(modelFromDisk(raw));
  c.check(
    "the editor's modelFromDisk/modelToDisk keeps the pair, and writes it only where it is set",
    rt.bodies[0]!.breakForce === 12_500 &&
      rt.bodies[0]!.durability === 3 &&
      rt.bodies[1]!.breakForce === undefined &&
      rt.bodies[1]!.durability === undefined,
  );
  return ok("break-format — the pair survives the format, the build and the editor", c.passed(), c.details);
}

export function runBreakCases(): BreakResult[] {
  return [
    caseLoad(),
    caseThreshold(),
    caseDurability(),
    caseBounce(),
    caseDrag(),
    caseChain(),
    caseGuard(),
    caseFormat(),
  ];
}
