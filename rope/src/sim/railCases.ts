// Rail cases: hand-built scenes with the answer written down, run by
// `cli rails`.
//
// A rail is a thin bar the manacle clamps around and slides along
// (`lib/rail.ts`), and what makes it worth a suite of its own is that its
// behaviour has a CLOSED FORM: a massless ring on a frictionless bar keeps the
// chain plumb and the ball coasting, one with friction `mu` trails the chain at
// `atan(mu)` and decelerates the ball at `mu·g`, and a ring inside the static
// cone does not move at all. Every one of those is a number, so every one is
// asserted here rather than eyeballed in the browser - and, like every other
// case suite, it exists because a clamp reaches no invariant: a build that
// quietly stopped sliding, or stopped stopping at the lid, renders a level that
// looks identical and plays differently.
//
// Every assertion is a BOUND, never an exact number, with the geometry cases
// as the exception: a centreline is arithmetic and is held to a micron.
//
// What is deliberately NOT asserted is the friction coefficients' feel. The two
// constants are guesses to be played, and a case pinning the deceleration to
// `0.3·g` would be a case rewritten on the next tuning pass; what is pinned is
// the SHAPE - stuck inside the cone, sliding outside it, slower than the
// frictionless run, and no faster than the coefficient allows.

import { Vec2 } from "../engine/vec2";
import { dmath } from "../engine/dmath";
import { RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { polyArea, polyShape } from "../engine/shapes";
import { GRAVITY, World } from "../engine/world";
import { buildLevelBodies } from "../level/buildBodies";
import { scaleLevelData, type RawLevelData, type LevelBodyData } from "../level/levelFormat";
import { BallLevel } from "../level/ballLevel";
import { BallHook } from "../classes/ballHook";
import { BallPlayer } from "../classes/ballPlayer";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import {
  RopeClamp,
  slideStep,
  RAIL_KINETIC_FRICTION,
  RAIL_STATIC_FRICTION,
  RIM_FLIP_LEAN,
} from "../lib/rail";
import { MANACLE_BORE, MANACLE_REACH } from "../lib/manacle";
import { strokeCurve, STROKE_TOLERANCE } from "../lib/stroke";
import { cubicAt, pathNodesOf } from "../lib/path";
import { PX } from "../engine/units";
import { modelFromDisk, modelToDisk } from "../editor/model";
import { isCollisionObject } from "../level/levelFormat";
import { checkBallInvariants, TunnelMonitor, type Violation } from "./trace";

const DT = 1 / 60;
const G = GRAVITY.y;

export interface RailResult {
  name: string;
  passed: boolean;
  details: string[];
  expectedFail?: true;
}

function ok(name: string, passed: boolean, details: string[]): RailResult {
  return { name, passed, details };
}

// A claim list with one verdict, the pattern the other suites use.
function claims(): { check: (claim: string, got: boolean) => void; details: string[]; passed: () => boolean } {
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
// The rig: the ball hanging from a rail directly above it, driven through the
// real deploy wiring, with the aim held on the anchor once it has one so the
// chain always leaves the loop radially and nothing winds.
// ---------------------------------------------------------------------------

// A level authored in pixels, as every level is, around the ball at the origin.
// `bodies` are pixel-authored `LevelBodyData`.
function level(bodies: LevelBodyData[], playerX = 0): BallLevel {
  return new BallLevel({
    player: { x: playerX, y: 0, radius: 8 },
    bodies,
  } as RawLevelData);
}

// A static rail bar, `w` px long and 3 px thick, centred at (`x`, `y`) px,
// turned by `rot` radians, with the body's authored friction. A straight
// two-node curve, which is what a plain bar is now: one authored line, stroked
// into the single quad that tiles it.
function bar(
  x: number,
  y: number,
  w: number,
  friction: number,
  rot = 0,
  extra: Partial<LevelBodyData> = {},
): LevelBodyData {
  return {
    kind: "static",
    x,
    y,
    rot,
    friction,
    objects: [
      {
        type: "collision",
        shape: { kind: "curve", width: 3, verts: [{ x: -w / 2, y: 0 }, { x: w / 2, y: 0 }] },
        rail: true,
      },
    ],
    ...extra,
  } as LevelBodyData;
}

// A static floor, `w` px wide, whose top surface is `top` px below the origin
// (positive is down), for a ball that is to stand rather than hang.
function floor(top: number, w = 600): LevelBodyData {
  return {
    kind: "static",
    x: 0,
    y: top + 20,
    rot: 0,
    friction: 1,
    objects: [{ type: "collision", shape: { kind: "rect", w, h: 40 } }],
  } as LevelBodyData;
}

class Rig {
  readonly level: BallLevel;
  private prev: FrameInput = emptyFrameInput();
  readonly violations: Violation[] = [];
  private tunnel = new TunnelMonitor();
  // Where the throw is aimed before the chain clamps: straight up from the
  // ball unless a case says otherwise (metres, world).
  throwAt: Vec2 | null = null;

  constructor(bodies: LevelBodyData[], playerX = 0) {
    this.level = level(bodies, playerX);
  }

  get ball(): BallPlayer {
    return this.level.ball;
  }

  get clamp(): RopeClamp | null {
    const end = this.level.ball.chain?.end;
    return end instanceof RopeClamp ? end : null;
  }

  // One frame with the deploy held and the aim at `aim` (metres, world).
  step(aim: Vec2): void {
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: button(true, this.prev.fire),
      mouseWorldPosition: aim,
    };
    this.prev = input;
    this.level.physicsProcess(input, DT);
    this.violations.push(...checkBallInvariants(this.level));
    const tunnel = this.tunnel.push(this.level);
    if (tunnel) this.violations.push(tunnel);
  }

  // The aim once clamped: at the anchor, so the chain leaves the loop radially.
  // Before that, straight up from the ball, which is where the rail is.
  aimAtAnchor(): Vec2 {
    const clamp = this.clamp;
    return clamp ? clamp.contact.globalPosition : (this.throwAt ?? this.ball.globalPosition.add(new Vec2(0, -1.2)));
  }

  // Throw straight up and hang until the ball has settled under the clamp.
  hang(frames = 180): void {
    for (let f = 0; f < frames; f++) this.step(this.aimAtAnchor());
  }

  // Run `frames` more, calling `each` after every one.
  run(frames: number, each?: (f: number) => void): void {
    for (let f = 0; f < frames; f++) {
      this.step(this.aimAtAnchor());
      each?.(f);
    }
  }

  // The chain's angle off the plumb, degrees, positive when the ball is to the
  // +x side of its anchor.
  lean(): number {
    const clamp = this.clamp;
    if (!clamp) return 0;
    const d = this.ball.globalPosition.sub(clamp.contact.globalPosition);
    return (dmath.atan2(d.x, d.y) * 180) / Math.PI;
  }
}

// ---------------------------------------------------------------------------
// stroke - the geometry every rail stands on: a curve with a width, as the
// convex pieces that tile it and the line the cuff rides.
// ---------------------------------------------------------------------------
function caseStroke(): RailResult {
  const c = claims();
  const nodes = (
    verts: { x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }[],
  ) => pathNodesOf(verts);

  // A straight bar is ONE piece however many nodes it was drawn with: the
  // flattening's collinear samples are simplified away, so an author who
  // clicked five times down a wall does not pay for five collision pieces.
  const straight = strokeCurve(nodes([{ x: -0.5, y: 0 }, { x: 0.5, y: 0 }]), 0.04);
  c.check(
    `a straight 1 m bar is one quad (${straight.pieces.length}) on a two-point line (${straight.line.length})`,
    straight.pieces.length === 1 && straight.line.length === 2,
  );
  c.check(
    `...1 m x 4 cm of it (area ${polyArea(straight.pieces[0]!).toFixed(5)})`,
    Math.abs(polyArea(straight.pieces[0]!) - 0.04) < 1e-9 && straight.halfWidth === 0.02,
  );
  const strung = strokeCurve(
    nodes([{ x: -0.5, y: 0 }, { x: -0.2, y: 0 }, { x: 0.1, y: 0 }, { x: 0.5, y: 0 }]),
    0.04,
  );
  c.check(
    `a bar drawn with four collinear nodes is still one piece (${strung.pieces.length})`,
    strung.pieces.length === 1,
  );

  // A bend: the pieces TILE the bar - they meet edge to edge, so their areas
  // sum to the outline's and neither overlap nor leave a gap, which is what
  // lets the build weigh a curve exactly as it weighs a decomposed polygon.
  const bend = strokeCurve(
    nodes([{ x: -1, y: 0 }, { x: 0, y: 0, outX: 0.5, inX: -0.5 }, { x: 1, y: -1 }]),
    0.06,
  );
  const summed = bend.pieces.reduce((a, p) => a + polyArea(p), 0);
  const outline = polyArea(bend.outline);
  c.check(
    `a bent bar's ${bend.pieces.length} pieces tile it exactly (${summed.toFixed(6)} against the outline's ${outline.toFixed(6)})`,
    Math.abs(summed - outline) < 1e-6,
  );
  c.check(
    "...and every one of them is convex",
    bend.pieces.every((p) => {
      try {
        polyShape(p);
        return true;
      } catch {
        return false;
      }
    }),
  );
  c.check(
    `...with one piece per segment of the line (${bend.pieceAt.length} of ${bend.line.length - 1})`,
    bend.pieceAt.length === bend.line.length - 1 &&
      bend.pieceAt.every((i) => i >= 0 && i < bend.pieces.length),
  );

  // The line the pieces are built from is the CURVE, to the tolerance the
  // simplification is allowed: every sample of the authored cubic lies within
  // it of the polyline the cuff will ride.
  const a = new Vec2(-1, 0);
  const b = new Vec2(1, -1);
  const h = new Vec2(0.5, -0.6);
  const bow = strokeCurve(
    nodes([
      { x: a.x, y: a.y, outX: h.x, outY: h.y },
      { x: b.x, y: b.y, inX: -h.x, inY: h.y },
    ]),
    0.06,
  );
  let worst = 0;
  for (let i = 0; i <= 400; i++) {
    const p = cubicAt(a, a.add(h), b.add(new Vec2(-h.x, h.y)), b, i / 400);
    let best = Infinity;
    for (let k = 0; k + 1 < bow.line.length; k++) {
      best = Math.min(best, distanceToSegment(p, bow.line[k]!, bow.line[k + 1]!));
    }
    worst = Math.max(worst, best);
  }
  c.check(
    `the line follows the cubic to ${(worst * 1000).toFixed(2)} mm (tolerance ${(STROKE_TOLERANCE * 1000).toFixed(0)} mm)`,
    worst <= STROKE_TOLERANCE + 1e-9,
  );

  // A right angle is still mitred - the spike is only half again the bar's own
  // thickness - so an elbow is its two quads and nothing between them.
  const elbow = strokeCurve(nodes([{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: -1 }]), 0.06);
  const elbowSum = elbow.pieces.reduce((acc, p) => acc + polyArea(p), 0);
  c.check(
    `a right-angled elbow mitres into ${elbow.pieces.length} pieces that tile it (${elbowSum.toFixed(6)} against ${polyArea(elbow.outline).toFixed(6)})`,
    elbow.pieces.length === 2 && Math.abs(elbowSum - polyArea(elbow.outline)) < 1e-6,
  );
  // A hairpin is not: past the mitre limit the spike would be longer than the
  // bar is thick, so the outer side is bevelled and the wedge between the two
  // quads becomes a piece of its own - which keeps the tiling exact there too.
  const hairpin = strokeCurve(
    nodes([{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: -0.8, y: -0.5 }]),
    0.06,
  );
  const hairpinSum = hairpin.pieces.reduce((acc, p) => acc + polyArea(p), 0);
  c.check(
    `a hairpin bevels instead (${hairpin.pieces.length} pieces, ${hairpinSum.toFixed(6)} against ${polyArea(hairpin.outline).toFixed(6)})`,
    hairpin.pieces.length === 3 && Math.abs(hairpinSum - polyArea(hairpin.outline)) < 1e-6,
  );
  return ok(
    "rail-stroke — a curve with a width is the convex pieces that tile it, on the line the cuff rides",
    c.passed(),
    c.details,
  );
}

// The distance from a point to a segment - the stroke case's own measure of how
// far the simplified line strays from the curve it came from.
function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const d = b.sub(a);
  const len2 = d.lengthSquared();
  if (len2 < 1e-18) return p.distanceTo(a);
  const t = Math.min(1, Math.max(0, p.sub(a).dot(d) / len2));
  return p.distanceTo(a.add(d.mul(t)));
}

// ---------------------------------------------------------------------------
// slide-step - the cone arithmetic.
// ---------------------------------------------------------------------------
function caseSlideStep(): RailResult {
  const c = claims();
  const t = Vec2.RIGHT;
  const mus = 0.4;
  const muk = 0.3;
  // A pull 1 m long at 10° off the plumb (across = cos, along = sin): inside a
  // 21.8° static cone, so a stuck ring stays stuck.
  const pull = (deg: number): Vec2 => {
    const r = (deg * Math.PI) / 180;
    return new Vec2(dmath.sin(r), -dmath.cos(r));
  };
  c.check("a pull 10° off the plumb leaves a stuck ring stuck (static cone 21.8°)", slideStep(pull(10), t, false, mus, muk) === 0);
  c.check("...and a RUNNING ring inside the kinetic cone (16.7°) stops", slideStep(pull(10), t, true, mus, muk) === 0);
  const ds = slideStep(pull(30), t, false, mus, muk);
  // The ring runs toward the ball's plumb until the pull meets the kinetic
  // cone: along − muk·across = sin30 − 0.3·cos30.
  const want = dmath.sin(Math.PI / 6) - muk * dmath.cos(Math.PI / 6);
  c.check(`a pull 30° off runs the ring ${want.toFixed(4)} m toward the ball's side (got ${ds.toFixed(4)})`, Math.abs(ds - want) < 1e-12);
  c.check("...and the other way for a ball on the other side", Math.abs(slideStep(pull(-30), t, false, mus, muk) + want) < 1e-12);
  c.check("a running ring at 20° (inside static, outside kinetic) keeps running", slideStep(pull(20), t, true, mus, muk) > 0);
  c.check("a stuck ring at 20° stays stuck", slideStep(pull(20), t, false, mus, muk) === 0);
  c.check("frictionless, the ring goes to the plumb", Math.abs(slideStep(pull(30), t, false, 0, 0) - dmath.sin(Math.PI / 6)) < 1e-12);
  return ok("rail-slide-step — stuck inside the cone, run to the kinetic edge outside it", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// clamp - a thrown hook clamps the bar on its centreline, and the hook body is
// gone; a peg holds the ring at its centre.
// ---------------------------------------------------------------------------
function caseClamp(): RailResult {
  const c = claims();
  const rig = new Rig([bar(0, -120, 1000, 1)]);
  rig.hang(60);
  const clamp = rig.clamp;
  c.check("a hook thrown at a rail comes back as a clamp", clamp !== null);
  if (clamp) {
    const at = clamp.contact.globalPosition;
    // The ring RESTS on the bar: its centre hangs the bore's slack below the
    // centreline - the ring's inner radius less the bar's own half-width - and
    // that puts the inside of the ring exactly on the bar's top surface. A
    // cuff drawn on the centreline instead is a ring welded through the middle
    // of a bar it is only hanging on.
    const halfWidth = 1.5 * PX;
    const clearance = MANACLE_BORE / 2 - halfWidth;
    c.check(
      `the ring hangs the bore's slack below the centreline (${((at.y + 1.2) * 100).toFixed(2)} cm, want ${(clearance * 100).toFixed(2)})`,
      Math.abs(at.y + 1.2 - clearance) < 1e-9,
    );
    c.check(
      `...resting on the bar's top surface (${clamp.restPoint().y.toFixed(5)}, want ${(-1.2 - halfWidth).toFixed(5)})`,
      clamp.restPoint().distanceTo(new Vec2(at.x, -1.2 - halfWidth)) < 1e-9,
    );
    c.check(
      `...a bore's radius above the cuff's centre (${(at.distanceTo(clamp.restPoint()) * 100).toFixed(3)} cm, want ${((MANACLE_BORE / 2) * 100).toFixed(3)})`,
      Math.abs(at.distanceTo(clamp.restPoint()) - MANACLE_BORE / 2) < 1e-9,
    );
    // Pulled straight up through the bar it does NOT cross the bore: the ring
    // never swaps sides of the bar (see `RopeClamp.side`), and a pull square
    // through it leaves the hang where it was.
    clamp.seat(new Vec2(at.x, -2), 1);
    c.check(
      `pulled from above, the ring stays under the bar (y=${clamp.contact.globalPosition.y.toFixed(5)})`,
      Math.abs(clamp.contact.globalPosition.y - at.y) < 1e-9 && clamp.side === -1,
    );
    clamp.seat(at, 1);
    c.check(`...and hangs there still`, Math.abs(clamp.contact.globalPosition.y - at.y) < 1e-9);
    c.check(`...within the bar (x=${at.x.toFixed(3)})`, Math.abs(at.x) < 0.1);
    // The cuff is a ring seen edge-on hanging from the bar, and its facing is
    // the way it HANGS - the end of the ring the chain leaves over, where the
    // hinge is - so under a level bar with the ball plumb below it the hinge
    // points straight down, and the drawn cuff's centre is the chain's own end
    // node with the rest point a bore's radius above it. Seated toward the ball
    // first: the pulls above left the ring hanging from the pull that was not
    // the ball's, as the game's own settle never would.
    clamp.seat(rig.ball.globalPosition, Infinity);
    const facing = rig.ball.manacleFacing(1);
    c.check(
      `the cuff faces the way it hangs, hinge toward the ball (${facing?.x.toFixed(3)}, ${facing?.y.toFixed(3)})`,
      rig.ball.manacleOnRail && facing !== null && facing.y > 0.999 && Math.abs(facing.length() - 1) < 1e-9,
    );
    const pose = rig.ball.manaclePose(1);
    c.check(
      "...drawn centred on the chain's own end node, clamped around the bar",
      pose !== null && pose.onRail && pose.clamped && pose.centre.distanceTo(at) < 1e-9,
    );
    // A bar that ends in the air at both ends is OPEN at both, so the range is
    // the whole bar: the ring runs off either end (see rail-open-end).
    c.check(
      `the range is the whole bar, open at both ends (${clamp.range.min.toFixed(3)}..${clamp.range.max.toFixed(3)})`,
      clamp.range.min === 0 && clamp.range.max === 10 && clamp.range.openMin && clamp.range.openMax,
    );
    // The ring starts square on the bar, hanging straight down toward the
    // ball, and never past the angle the bar's thickness jams it at.
    c.check(`...hanging square (tilt ${((clamp.tilt * 180) / Math.PI).toFixed(2)}°)`, Math.abs(clamp.tilt) < 1e-9);
    const wantJam = (dmath.acos(halfWidth / (MANACLE_BORE / 2)) * 180) / Math.PI;
    c.check(
      `...on a bar it can tilt ${((clamp.tiltMax * 180) / Math.PI).toFixed(1)}° on (want acos(h/R) = ${wantJam.toFixed(1)})`,
      Math.abs((clamp.tiltMax * 180) / Math.PI - wantJam) < 1e-9,
    );
  }
  c.check("the hook body is out of the world", !rig.level.world.bodies.some((b) => b instanceof BallHook));
  c.check(`no invariant fired while it hung (${rig.violations.length})`, rig.violations.length === 0);

  // A peg: a bar shorter than it is thick, which has no room for the cuff to
  // stand anywhere but its middle. The ring hangs on it and pivots, and does
  // not slide.
  const peg = new Rig([
    {
      kind: "static",
      x: 0,
      y: -120,
      rot: 0,
      friction: 1,
      objects: [
        {
          type: "collision",
          shape: { kind: "curve", width: 6, verts: [{ x: -1, y: 0 }, { x: 1, y: 0 }] },
          rail: true,
        },
      ],
    } as LevelBodyData,
  ]);
  peg.hang(120);
  const pc = peg.clamp;
  c.check("a peg is clamped too", pc !== null);
  if (pc) {
    // 6 px thick against a 7.3 cm bore: the ring has 6.5 mm of slack to hang
    // in, and no length of bar to hang anywhere ALONG.
    const pegSeat = new Vec2(0, -1.2 + MANACLE_BORE / 2 - 3 * PX);
    c.check(`...at its centre (${pc.contact.globalPosition.x.toFixed(4)}, ${pc.contact.globalPosition.y.toFixed(4)})`, pc.contact.globalPosition.distanceTo(pegSeat) < 1e-9);
    c.check(
      `...with nowhere to slide to (range ${pc.range.min.toFixed(4)}..${pc.range.max.toFixed(4)})`,
      pc.range.min === pc.range.max,
    );
    peg.ball.linearVelocity = new Vec2(1, 0);
    let maxLean = 0;
    let pegSwing = 0;
    let pegOffBore = 0;
    const pegS = pc.s;
    peg.run(120, () => {
      maxLean = Math.max(maxLean, Math.abs(peg.lean()));
      const rest = pc.restPoint();
      pegSwing = Math.max(pegSwing, Math.abs(pc.contact.globalPosition.x - rest.x));
      pegOffBore = Math.max(pegOffBore, Math.abs(pc.contact.globalPosition.distanceTo(rest) - MANACLE_BORE / 2));
    });
    c.check(`kicked, the ball swings on it (${maxLean.toFixed(1)}°)`, maxLean > 10);
    c.check(`...and the ring never leaves the peg's middle (s=${pc.s.toFixed(4)})`, pc.s === pegS);
    const wantPegSwing = (MANACLE_BORE / 2) * dmath.sin((maxLean * Math.PI) / 180);
    c.check(
      `...the cuff pivoting on the point it rests on (swung ${(pegSwing * 1000).toFixed(2)} mm, want R·sin(${maxLean.toFixed(1)}°) = ${(wantPegSwing * 1000).toFixed(2)}, ${(pegOffBore * 1000).toFixed(6)} um off the bore)`,
      pegSwing > 0.005 && Math.abs(pegSwing - wantPegSwing) < 5e-4 && pegOffBore < 1e-9,
    );
  }
  return ok("rail-clamp — the hook clamps a bar on its curve, and a peg holds the ring at its centre", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// stick - a pull inside the static cone moves the ring by nothing.
// ---------------------------------------------------------------------------
function caseStick(): RailResult {
  const c = claims();
  const rig = new Rig([bar(0, -120, 1000, 1)]);
  rig.hang();
  const clamp = rig.clamp;
  c.check("clamped", clamp !== null);
  if (!clamp) return ok("rail-stick", false, c.details);
  const s0 = clamp.s;
  // A nudge worth an 8° swing on a 1.25 m chain, against a static cone of
  // atan(0.35) = 19.3°: the ring must not move at all.
  rig.ball.linearVelocity = new Vec2(0.5, 0);
  let maxLean = 0;
  let moved = 0;
  // The cuff swings on the bar while the ring itself stays put: the point it
  // rests on never moves off the bar's top surface, the cuff's centre stays a
  // bore's radius from that point, and what travels is the cuff - the arc it
  // hangs on, which is what a link laid over a rod does.
  let swung = 0;
  let offBore = 0;
  let offBar = 0;
  const rest0 = clamp.restPoint();
  rig.run(240, () => {
    maxLean = Math.max(maxLean, Math.abs(rig.lean()));
    moved = Math.max(moved, Math.abs(clamp.s - s0));
    const rest = clamp.restPoint();
    swung = Math.max(swung, Math.abs(clamp.contact.globalPosition.x - rest.x));
    offBore = Math.max(offBore, Math.abs(clamp.contact.globalPosition.distanceTo(rest) - MANACLE_BORE / 2));
    offBar = Math.max(offBar, rest.distanceTo(rest0));
  });
  const cone = (dmath.atan(RAIL_STATIC_FRICTION) * 180) / Math.PI;
  c.check(`the ball swings (${maxLean.toFixed(1)}°) inside the static cone (${cone.toFixed(1)}°)`, maxLean > 5 && maxLean < cone);
  c.check(`the ring moved by ${moved.toExponential(2)} m (want 0)`, moved === 0);
  // The swing is the closed form of a pivot: the cuff's centre is a bore's
  // radius from the point it rests on, so a chain leaning `a` off the bar's
  // normal carries it `R·sin a` along the bar - and nothing at all if the ring
  // were spinning about its own centre instead.
  const wantSwing = (MANACLE_BORE / 2) * dmath.sin((maxLean * Math.PI) / 180);
  c.check(
    `...while the cuff PIVOTED on it: swung ${(swung * 1000).toFixed(2)} mm along the bar, want R·sin(${maxLean.toFixed(1)}°) = ${(wantSwing * 1000).toFixed(2)}`,
    swung > 0.003 && Math.abs(swung - wantSwing) < 5e-4,
  );
  c.check(
    `...on the one point of the bar it rests on, a bore's radius away throughout (worst ${(offBore * 1000).toFixed(6)} um)`,
    offBore < 1e-9,
  );
  c.check(`...which never left the bar's top surface (worst ${(offBar * 1000).toFixed(6)} um)`, offBar < 1e-9);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  return ok("rail-stick — a pull inside the static cone moves the ring by nothing", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// zipline - frictionless, the ring keeps the chain plumb and the ball coasts.
// ---------------------------------------------------------------------------
function caseZipline(): RailResult {
  const c = claims();
  const rig = new Rig([bar(0, -120, 1200, 0)]);
  rig.hang();
  const clamp = rig.clamp;
  c.check("clamped", clamp !== null);
  if (!clamp) return ok("rail-zipline", false, c.details);
  const v = 3;
  rig.ball.linearVelocity = new Vec2(v, 0);
  const s0 = clamp.s;
  let minVx = Infinity;
  let maxVx = -Infinity;
  let maxLean = 0;
  rig.run(60, () => {
    minVx = Math.min(minVx, rig.ball.linearVelocity.x);
    maxVx = Math.max(maxVx, rig.ball.linearVelocity.x);
    maxLean = Math.max(maxLean, Math.abs(rig.lean()));
  });
  c.check(`the ball coasts: vx stays within 5% of ${v} m/s (${minVx.toFixed(3)}..${maxVx.toFixed(3)})`, minVx > v * 0.95 && maxVx < v * 1.05);
  c.check(`the chain stays plumb (worst lean ${maxLean.toFixed(2)}°)`, maxLean < 2);
  c.check(`the ring travelled with it (${(clamp.s - s0).toFixed(2)} m of ${(v * 1).toFixed(2)})`, clamp.s - s0 > v * 0.9);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  return ok("rail-zipline — frictionless, the ring keeps the chain plumb and the ball coasts", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// friction - a rail with grip lets the ring go past the static cone and then
// brakes the ball, slower than frictionless and no harder than mu_k·g.
// ---------------------------------------------------------------------------
function caseFriction(): RailResult {
  const c = claims();
  const V = 4;
  // The bar's authored friction is chosen so the effective static cone sits at
  // 19°: gentle enough that a 4 m/s ball releases early and settles into a
  // steady slide the closed forms describe, and under 1 so the case also
  // exercises the scaling. At the full coefficients the same kick swings the
  // ball to 45° before the cuff gives way, and the release then frees 30 cm of
  // chain - the ball flies, lands and swings, which is the design (see
  // `RopeClamp.slide`) but is not a steady slide to measure a law against.
  const GRIP = 0.35 / RAIL_STATIC_FRICTION;
  const run = (
    friction: number,
  ): { travel: number; slid: number; maxLean: number; midLean: number; violations: number } => {
    // Thirty metres of bar, so neither run reaches an end.
    const rig = new Rig([bar(0, -120, 3000, friction)]);
    rig.hang();
    const clamp = rig.clamp!;
    rig.ball.linearVelocity = new Vec2(V, 0);
    const s0 = clamp.s;
    let maxLean = 0;
    let travel = 0;
    let midLean = 0;
    rig.run(150, (f) => {
      maxLean = Math.max(maxLean, Math.abs(rig.lean()));
      travel = Math.max(travel, rig.ball.globalPosition.x);
      if (f === 30) midLean = rig.lean();
    });
    return { travel, slid: clamp.s - s0, maxLean, midLean, violations: rig.violations.length };
  };
  const free = run(0);
  const gripped = run(GRIP);
  const muk = RAIL_KINETIC_FRICTION * GRIP;
  const mus = RAIL_STATIC_FRICTION * GRIP;
  const deg = (mu: number): number => (dmath.atan(mu) * 180) / Math.PI;
  // Coulomb's closed form, written against the coefficient rather than a
  // number so the case follows a re-tuned constant: a ball braked at mu_k·g
  // from V stops after V²/(2·mu_k·g).
  const stop = (V * V) / (2 * muk * G);
  c.check(`the ring ran (${gripped.slid.toFixed(2)} m)`, gripped.slid > 1);
  c.check(
    `the ball was braked: ${gripped.travel.toFixed(2)} m of travel against ${free.travel.toFixed(2)} frictionless`,
    gripped.travel < free.travel - 1,
  );
  c.check(
    `...at about mu_k·g: within 0.8..1.25 of Coulomb's ${stop.toFixed(2)} m`,
    gripped.travel > 0.8 * stop && gripped.travel < 1.25 * stop,
  );
  c.check(
    `while running the chain trails at atan(mu_k) = ${deg(muk).toFixed(1)}° (f30: ${gripped.midLean.toFixed(1)}°)`,
    Math.abs(gripped.midLean - deg(muk)) < 1.5,
  );
  c.check(
    `the ring broke away at the static cone, ${deg(mus).toFixed(1)}° (worst lean ${gripped.maxLean.toFixed(1)}°)`,
    gripped.maxLean > deg(mus) && gripped.maxLean < deg(mus) + 6,
  );
  c.check(`no invariant fired (${gripped.violations} + ${free.violations})`, gripped.violations === 0 && free.violations === 0);
  return ok("rail-friction — grip brakes the ball at mu_k·g with the chain trailing at atan(mu_k)", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// range - the lantern: the ring stops where its disc meets the lid, the lid
// itself bounces the hook, and the handle still clamps beside it.
// ---------------------------------------------------------------------------
function lantern(friction: number): LevelBodyData {
  // A 60 cm handle from x = -30 to +30 px, and a 20 cm hook-proof lid from
  // x = 30 to 50, abutting it, both in ONE body.
  return {
    kind: "static",
    x: 0,
    y: -120,
    rot: 0,
    friction,
    objects: [
      {
        type: "collision",
        x: 0,
        y: 0,
        shape: { kind: "curve", width: 2, verts: [{ x: -30, y: 0 }, { x: 30, y: 0 }] },
        rail: true,
      },
      { type: "collision", x: 40, y: 0, shape: { kind: "rect", w: 20, h: 20 }, impermeable: true },
    ],
  } as LevelBodyData;
}

function caseRange(): RailResult {
  const c = claims();
  const rig = new Rig([lantern(0)]);
  rig.hang();
  const clamp = rig.clamp;
  c.check("the handle clamps", clamp !== null);
  if (!clamp) return ok("rail-range", false, c.details);
  // The curve runs x = -0.3..0.3, so arc length 0 is its left end; the cuff's
  // bar meets the lid's face at x = 0.3 when its centre is at 0.3 - MANACLE_REACH.
  const wantMax = 0.6 - MANACLE_REACH;
  c.check(`the range is clipped where the cuff meets the lid (max=${clamp.range.max.toFixed(4)}, want ${wantMax.toFixed(4)})`, Math.abs(clamp.range.max - wantMax) < 1e-6);
  c.check(
    `...and open at the far end, which ends in the air (min=${clamp.range.min}, open=${clamp.range.openMin}/${clamp.range.openMax})`,
    clamp.range.min === 0 && clamp.range.openMin && !clamp.range.openMax,
  );
  rig.ball.linearVelocity = new Vec2(2, 0);
  let maxS = -Infinity;
  let stillClamped = true;
  // What meets the lid is the ring's FAR side: the rest point stops the
  // ring's reach along the bar short of the range's end, and the ring may not
  // lean into the lid past it.
  rig.run(60, () => {
    maxS = Math.max(maxS, clamp.s + clamp.reach());
    if (rig.clamp !== clamp) stillClamped = false;
  });
  c.check(`the ring reached the lid (max s+reach=${maxS.toFixed(4)})`, Math.abs(maxS - clamp.range.max) < 1e-9);
  c.check("...and never past it", maxS <= clamp.range.max + 1e-12);
  c.check(`...which is a closed end (openMax=${clamp.range.openMax})`, !clamp.range.openMax);
  c.check("...and is still clamped", stillClamped);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);

  // The lid itself: a hook thrown straight at it bounces and clamps nothing.
  const lid = new Rig([lantern(0)], 40);
  lid.hang(60);
  const end = lid.ball.chain?.end;
  c.check("a hook thrown at the hook-proof lid does not anchor", lid.ball.chain === null || end?.contact.obj instanceof BallHook);
  return ok("rail-range — the ring stops where its disc meets the lid, which the hook itself bounces off", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// fall - a ring threaded onto a vertical bar falls the frame it is threaded,
// under its own weight, whatever the chain is doing.
// ---------------------------------------------------------------------------
function caseFall(): RailResult {
  const c = claims();
  // A 3 m frictionless bar standing on end, x = 0, from y = -50 px down to
  // -350 px... (y is down, so the bar runs from 0.5 m to 3.5 m above the
  // origin), with a block welded to its lower end so the ring has somewhere
  // to stop. The ball stands on a floor 40 cm to the side and throws at the
  // bar's middle.
  const upright = bar(0, -200, 300, 0, Math.PI / 2, {
    objects: [
      {
        type: "collision",
        shape: { kind: "curve", width: 3, verts: [{ x: -150, y: 0 }, { x: 150, y: 0 }] },
        rail: true,
      },
      { type: "collision", x: 160, y: 0, shape: { kind: "rect", w: 20, h: 20 } },
    ],
  } as Partial<LevelBodyData>);
  const rig = new Rig([upright, floor(8)], 40);
  rig.throwAt = new Vec2(0, -2);
  let clampedAt = -1;
  let s0 = 0;
  const speeds: number[] = [];
  const sAt: number[] = [];
  for (let f = 0; f < 120 && clampedAt < 0; f++) {
    rig.step(rig.aimAtAnchor());
    const clamp = rig.clamp;
    if (clamp) {
      clampedAt = f;
      s0 = clamp.s;
    }
  }
  const clamp = rig.clamp;
  c.check(`the hook threads onto the upright (frame ${clampedAt})`, clamp !== null);
  if (!clamp) return ok("rail-fall", false, c.details);
  c.check(
    `...part way up it (s=${s0.toFixed(2)} of ${clamp.length.toFixed(2)}), with the ball standing on the floor`,
    s0 > 0.5 && s0 < clamp.length - 0.5 && rig.ball.linearVelocity.length() < 0.05,
  );
  c.check(
    `...jammed at the tilt the bar's thickness allows (${((clamp.tilt * 180) / Math.PI).toFixed(1)}° of ${((clamp.tiltMax * 180) / Math.PI).toFixed(1)})`,
    Math.abs(Math.abs(clamp.tilt) - clamp.tiltMax) < 1e-9,
  );
  // The pull is straight along the bar, so no cone can hold the ring and
  // nothing but the bar's end can stop it: it falls at g from the first frame.
  const frames = 24;
  rig.run(frames, () => {
    speeds.push(clamp.speed);
    sAt.push(clamp.s);
  });
  const t = frames * DT;
  const want = G * t;
  const fell = sAt[sAt.length - 1]! - s0;
  c.check(
    `it falls from the first frame (${(speeds[0]! * 100).toFixed(1)} cm/s after one)`,
    speeds[0]! > G * DT * 0.5,
  );
  c.check(
    `...at g: ${speeds[speeds.length - 1]!.toFixed(2)} m/s after ${t.toFixed(2)} s (want ${want.toFixed(2)})`,
    Math.abs(speeds[speeds.length - 1]! - want) < want * 0.1,
  );
  c.check(
    `...and has fallen ${fell.toFixed(3)} m (want ½gt² = ${(0.5 * G * t * t).toFixed(3)})`,
    Math.abs(fell - 0.5 * G * t * t) < 0.5 * G * t * t * 0.15,
  );
  // Then it lands on the block at the bar's foot and stays there, still on
  // the bar - that end is not open.
  let landed = -1;
  rig.run(90, (f) => {
    if (landed < 0 && clamp.s + clamp.reach() >= clamp.range.max - 1e-9) landed = f;
  });
  c.check(
    `it lands on the block at the bar's foot, far side first (s=${clamp.s.toFixed(3)} + reach ${clamp.reach().toFixed(3)} = max ${clamp.range.max.toFixed(3)})`,
    landed >= 0,
  );
  c.check(
    `...and stops there (speed ${clamp.speed.toFixed(3)})`,
    clamp.speed === 0 && Math.abs(clamp.s + clamp.reach() - clamp.range.max) < 1e-9,
  );
  c.check("...still threaded on the bar, which ends in the block", rig.clamp === clamp && !clamp.range.openMax);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  return ok("rail-fall — a ring threaded onto a vertical bar falls at g and lands on the bar's foot", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// open end - a ring driven off the end of a bar that ends in the air is loose:
// it is the dangling chain tip again, clear of the bar, with the speed it left
// at, and it catches nothing until it is thrown again.
// ---------------------------------------------------------------------------
function caseOpenEnd(): RailResult {
  const c = claims();
  // The floor is a metre below the hanging ball, so the ball swings freely
  // and the loose tip has somewhere to land.
  const rig = new Rig([bar(0, -120, 100, 0), floor(100)]);
  rig.hang();
  const clamp = rig.clamp;
  c.check("clamped on a short frictionless bar", clamp !== null);
  if (!clamp) return ok("rail-open-end", false, c.details);
  c.check(`...open at both ends (${clamp.range.min}..${clamp.range.max})`, clamp.range.openMin && clamp.range.openMax);
  rig.ball.linearVelocity = new Vec2(2, 0);
  const drop: { frame: number; at: Vec2 | null; speed: number; maxS: number } = { frame: -1, at: null, speed: 0, maxS: 0 };
  rig.run(120, (f) => {
    if (rig.clamp === clamp) drop.maxS = Math.max(drop.maxS, clamp.s);
    if (drop.frame < 0 && rig.clamp !== clamp) {
      drop.frame = f;
      const tip = rig.ball.chainTip;
      drop.at = tip?.globalPosition ?? null;
      drop.speed = tip?.linearVelocity.length() ?? 0;
    }
  });
  const { frame: dropped, at: tipAtDrop, speed: tipSpeed, maxS } = drop;
  c.check(`the ring reaches the bar's end (s=${maxS.toFixed(3)} of ${clamp.length.toFixed(3)})`, maxS === clamp.length);
  c.check(`...and runs off it (frame ${dropped})`, dropped >= 0);
  c.check("...becoming the dangling chain tip again", rig.ball.chainTip !== null && rig.clamp === null);
  c.check(
    `...spawned clear of the bar's end (x=${tipAtDrop?.x.toFixed(3)}, end at 0.500)`,
    tipAtDrop !== null && tipAtDrop.x > 0.5 + MANACLE_REACH,
  );
  c.check(`...moving at the speed it left with (${tipSpeed.toFixed(2)} m/s)`, tipSpeed > 1);
  c.check("...on the chain the ball still has", rig.ball.chain !== null && rig.ball.chain.end.contact.obj === rig.ball.chainTip);
  // Loose, it lands on the floor and lies there: a weight on the end of the
  // chain, not something that re-catches the bar.
  rig.run(120);
  c.check("...and lies on the floor, still the tip", rig.ball.chainTip !== null && rig.clamp === null);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  return ok("rail-open-end — a ring driven off a bar's open end is the dangling tip again", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// jam - the ring swings on the point it rests on toward the pull, and no
// further than the bar's thickness lets it; pulled from the far side of the
// bar it rolls over to rest on the other surface.
// ---------------------------------------------------------------------------
function caseJam(): RailResult {
  const c = claims();
  const rig = new Rig([bar(0, -120, 1000, 1)]);
  rig.hang(60);
  const clamp = rig.clamp;
  c.check("clamped", clamp !== null);
  if (!clamp) return ok("rail-jam", false, c.details);
  const halfWidth = 1.5 * PX;
  const R = MANACLE_BORE / 2;
  const rest0 = clamp.restPoint();
  const onSurface = () => Math.abs(clamp.restPoint().y - (-1.2 + halfWidth * clamp.side)) < 1e-9;
  c.check(`the ring rests on the bar's top surface (y=${rest0.y.toFixed(4)})`, clamp.side === -1 && Math.abs(rest0.y - (-1.2 - halfWidth)) < 1e-9);
  // Pulled hard along the bar: the ring tilts to the jam and stops there,
  // still resting on the same point, its centre a bore's radius from it.
  clamp.seat(new Vec2(5, -1.2), 10);
  const at = clamp.contact.globalPosition;
  c.check(
    `pulled along the bar it jams at ${((clamp.tilt * 180) / Math.PI).toFixed(1)}° (tiltMax ${((clamp.tiltMax * 180) / Math.PI).toFixed(1)})`,
    clamp.tilt === clamp.tiltMax,
  );
  c.check(`...still resting on the same point (${(clamp.restPoint().distanceTo(rest0) * 1000).toFixed(3)} mm off)`, clamp.restPoint().distanceTo(rest0) < 1e-9 && onSurface());
  c.check(
    `...its centre a bore's radius from it (${(at.distanceTo(rest0) * 100).toFixed(3)} cm, want ${(R * 100).toFixed(3)})`,
    Math.abs(at.distanceTo(rest0) - R) < 1e-9,
  );
  c.check(`...swung R·sin(a) = ${(R * dmath.sin(clamp.tiltMax) * 1000).toFixed(1)} mm along the bar (${((at.x - rest0.x) * 1000).toFixed(1)})`, Math.abs(at.x - rest0.x - R * dmath.sin(clamp.tiltMax)) < 1e-9);
  // The swing is bounded in rate: a pull that reverses does not flip the ring
  // in one frame, it turns it at no more than RAIL_TILT_RATE.
  const before = clamp.tilt;
  clamp.seat(new Vec2(-5, -1.2), DT);
  c.check(
    `a reversed pull turns it by one frame's worth (${((before - clamp.tilt) * 180 / Math.PI).toFixed(2)}°), not to the other jam`,
    clamp.tilt < before && clamp.tilt > -clamp.tiltMax,
  );
  // Pulled from ABOVE the bar the ring does NOT change sides - it is a ring
  // on this side of the bar for as long as it is threaded - it stays resting
  // on the top surface, and a pull straight up through the bar leaves its tilt
  // where it was.
  const tiltBefore = clamp.tilt;
  clamp.seat(new Vec2(clamp.contact.globalPosition.x, -3), 10);
  c.check(`pulled straight up through the bar it stays on the top surface (side ${clamp.side}, rest y=${clamp.restPoint().y.toFixed(4)})`, clamp.side === -1 && Math.abs(clamp.restPoint().y - (-1.2 - halfWidth)) < 1e-9);
  c.check(`...with its tilt left as it was (${((clamp.tilt * 180) / Math.PI).toFixed(1)}°)`, clamp.tilt === tiltBefore);
  // Pulled from above and along the bar it leans as far as the jam lets it
  // toward the pull's run, still on its side.
  clamp.seat(new Vec2(clamp.contact.globalPosition.x - 5, -3), 10);
  c.check(`pulled from above and back along the bar it jams that way (${((clamp.tilt * 180) / Math.PI).toFixed(1)}°, side ${clamp.side})`, clamp.tilt === -clamp.tiltMax && clamp.side === -1);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  return ok("rail-jam — the ring swings on the point it rests on and jams at the bar's thickness", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// rim - which END of the ring the chain leaves over is state with hysteresis.
// The rim is a sign, and a sign read off a quantity sitting on zero is noise:
// a ring jammed square against a lid with the chain running along the bar had
// its pull within a few thousandths of square to the ring's axis, and the
// drawn chain hopped the ring's whole length every few frames as the lantern
// swung (`session-821f`). The law: a pull anywhere inside `RIM_FLIP_LEAN` of
// square leaves the chain on the end it was on, whichever side of square it
// is; a pull committed past the band to the other end moves it; a slack
// chain (the gravity stand-in) moves it nowhere. The ring is frozen (dt 0) so
// the pulls are read against one hang.
function caseRim(): RailResult {
  const c = claims();
  const rig = new Rig([bar(0, -120, 1000, 1)]);
  rig.hang(60);
  const clamp = rig.clamp;
  c.check("clamped", clamp !== null);
  if (!clamp) return ok("rail-rim", false, c.details);
  const rimOf = () => (clamp.rimLocal().dot(clamp.hangLocal()) > 0 ? 1 : -1);
  const hang = clamp.hangLocal().rotated(clamp.body.globalRotation);
  const t = clamp.tangent()!;
  // A pull whose lean against the hang is exactly `lean`, run along the bar
  // for the rest of it.
  const pullAt = (lean: number, pulling = true) => {
    const p = t.mul(Math.sqrt(1 - lean * lean)).add(hang.mul(lean));
    return clamp.seat(clamp.contact.globalPosition.add(p), 0, pulling);
  };
  const inside = RIM_FLIP_LEAN * 0.5;
  const outside = Math.min(0.999, RIM_FLIP_LEAN * 2);
  c.check(`hung under the ball the chain leaves over the end toward it (rim ${rimOf()})`, rimOf() === 1);
  pullAt(-inside);
  c.check(`a pull leaning ${(-inside).toFixed(3)} against the hang, inside the band, leaves it there (rim ${rimOf()})`, rimOf() === 1);
  pullAt(0);
  c.check(`...a pull exactly square to the ring's axis too (rim ${rimOf()})`, rimOf() === 1);
  pullAt(-outside);
  c.check(`a pull committed to the other end (lean ${(-outside).toFixed(3)}) re-hooks the chain over it (rim ${rimOf()})`, rimOf() === -1);
  pullAt(inside);
  c.check(`...and a pull leaning ${inside.toFixed(3)} back, inside the band, does not undo it (rim ${rimOf()})`, rimOf() === -1);
  pullAt(1, false);
  c.check(`a slack chain hanging straight along the far end moves it nowhere (rim ${rimOf()})`, rimOf() === -1);
  pullAt(outside);
  c.check(`a real pull past the band brings it back (rim ${rimOf()})`, rimOf() === 1);
  c.check(`the ring itself never moved (tilt ${clamp.tilt.toFixed(4)})`, clamp.tilt === 0);
  return ok("rail-rim — the end of the ring the chain leaves over holds inside the band, follows a committed pull, ignores slack", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// bend - one authored curve that turns: the ring runs round the bend, crossing
// from one of the bar's pieces onto the next without noticing.
// ---------------------------------------------------------------------------
function caseBend(): RailResult {
  const c = claims();
  // A bar running level from x = -200 px and then rising 15° to the right for
  // another 200 px of run, as ONE curve with a corner node at the origin.
  const rise = Math.PI / 12;
  const body: LevelBodyData = {
    kind: "static",
    x: 0,
    y: -120,
    rot: 0,
    friction: 0,
    objects: [
      {
        type: "collision",
        shape: {
          kind: "curve",
          width: 3,
          verts: [
            { x: -200, y: 0 },
            { x: 0, y: 0 },
            { x: 200, y: -200 * dmath.tan(rise) },
          ],
        },
        rail: true,
      },
    ],
  } as LevelBodyData;
  const rig = new Rig([body], -150);
  rig.hang();
  const clamp = rig.clamp;
  c.check("clamped on the level stretch", clamp !== null && clamp.contact.shapeIndex === 0);
  if (!clamp) return ok("rail-bend", false, c.details);
  c.check(
    `the bar built as several pieces on one curve (${clamp.body.getShapes().length})`,
    clamp.body.getShapes().length > 1 &&
      clamp.body.getShapes().every((sh) => sh.rail === clamp.curve),
  );
  rig.ball.linearVelocity = new Vec2(2.5, 0);
  let crossedAt = -1;
  rig.run(90, (f) => {
    if (crossedAt < 0 && clamp.contact.shapeIndex !== 0) crossedAt = f;
  });
  c.check(`the ring ran round the bend onto another piece (at f${crossedAt})`, crossedAt >= 0);
  c.check("...and is still the same clamp on the same curve", rig.clamp === clamp);
  c.check(`the ball went up the slope (x=${rig.ball.globalPosition.x.toFixed(2)})`, rig.ball.globalPosition.x > 0.5);
  // On the rising stretch, and hanging the bore's slack UNDER it: the seat is
  // perpendicular to the bar wherever the ring has got to, so a sloped stretch
  // carries the ring off the centreline in x as well as in y.
  const anchor = clamp.contact.globalPosition;
  const corner = new Vec2(0, -1.2);
  const underLine =
    (anchor.y - corner.y + anchor.x * dmath.tan(rise)) * dmath.cos(rise);
  // A ball hanging plumb under a bar that rises at `rise` tilts the ring by
  // exactly that angle, so its centre hangs `R·cos(rise)` under the point it
  // rests on, which is itself a half-width above the line.
  const wantUnder = (MANACLE_BORE / 2) * dmath.cos(rise) - 1.5 * PX;
  c.check(
    `the anchor is on the rising stretch (x=${anchor.x.toFixed(3)}) hanging ${(underLine * 100).toFixed(2)} cm under it (want ${(wantUnder * 100).toFixed(2)})`,
    anchor.x > 0.1 && Math.abs(underLine - wantUnder) < 2e-3,
  );
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  return ok("rail-bend — the ring runs round a bend in one authored curve", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// format - the flag survives every gate a level passes through, and hook-proof
// wins over it.
// ---------------------------------------------------------------------------
function caseFormat(): RailResult {
  const c = claims();
  const curve = (x0: number, x1: number, bow = 0) => ({
    kind: "curve" as const,
    width: 4,
    verts: [
      { x: x0, y: 0, outX: bow, outY: -bow },
      { x: x1, y: 0, inX: -bow, inY: -bow },
    ],
  });
  const raw = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        objects: [
          { type: "collision", x: 0, y: 0, shape: curve(-50, 50, 20), rail: true },
          { type: "collision", x: 100, y: 0, shape: { kind: "rect", w: 20, h: 20 }, rail: true },
          { type: "collision", x: 200, y: 0, shape: curve(-50, 50), rail: true, impermeable: true },
        ],
      },
    ],
  } as RawLevelData;
  const data = scaleLevelData(raw, PX);
  const objs = data.bodies[0]!.objects.filter(isCollisionObject);
  const first = objs[0]!.shape;
  c.check(
    "scaleLevelData carries `rail` through px -> m",
    objs[0]!.rail === true && objs[1]!.rail === true && objs[2]!.rail === true,
  );
  c.check(
    `...and scales a curve's points, its handles and its width (${first.kind === "curve" ? `${first.width}, ${first.verts[0]!.outX}` : "not a curve"})`,
    first.kind === "curve" &&
      first.width === 0.04 &&
      Math.abs(first.verts[0]!.x + 0.5) < 1e-12 &&
      Math.abs((first.verts[0]!.outX ?? 0) - 0.2) < 1e-12 &&
      Math.abs((first.verts[0]!.outY ?? 0) + 0.2) < 1e-12 &&
      Math.abs((first.verts[1]!.inX ?? 0) + 0.2) < 1e-12,
  );
  const world = new World();
  const built = buildLevelBodies(world, data, () => {});
  const shapes = built.bodies[0]!.body!.getShapes();
  const bowed = shapes.filter((sh) => sh.rail !== null);
  c.check(
    `the build gives every piece of the bowed curve the one rail curve it belongs to (${bowed.length} pieces)`,
    bowed.length > 1 && bowed.every((sh) => sh.rail === bowed[0]!.rail),
  );
  // The RECT in the middle authored the flag and is not a curve: there is no
  // centreline to ride, so the flag means nothing on it.
  const box = shapes.find((sh) => sh.shape.kind === "rect");
  c.check("a `rail` flag on a shape that is not a curve is ignored", box !== undefined && box.rail === null);
  // ...and so is one on a HOOK-PROOF curve: a hook that bounces off a piece
  // never clamps it.
  c.check(
    "a hook-proof curve builds no rail either",
    shapes.filter((sh) => sh.impermeable).every((sh) => sh.rail === null),
  );
  // Hook-proof wins: a hook thrown at the third object is deflected, never clamped.
  const hook = new BallHook();
  hook.globalPosition = new Vec2(2, 0.5);
  hook.linearVelocity = new Vec2(0, -BallPlayer.HOOK_SPEED);
  let attached = false;
  hook.registerAttachmentCallback(() => {
    attached = true;
  });
  world.add(hook);
  for (let f = 0; f < 30 && !attached; f++) {
    hook.physicsStep(DT);
    if (attached) break;
    world.integrate(DT);
    hook.physicsStep(DT);
  }
  c.check("a hook-proof rail deflects the hook (hook-proof wins)", !attached);
  // The editor's round trip.
  const rt = modelToDisk(modelFromDisk(raw));
  const rtObjs = rt.bodies[0]!.objects.filter(isCollisionObject);
  const rtFirst = rtObjs[0]!.shape;
  c.check("the editor's modelFromDisk/modelToDisk keeps the flag", rtObjs[0]!.rail === true);
  c.check(
    `...and the curve it is on, handles and width included (${rtFirst.kind})`,
    rtFirst.kind === "curve" &&
      rtFirst.width === 4 &&
      rtFirst.verts.length === 2 &&
      Math.abs((rtFirst.verts[0]!.outX ?? 0) - 20) < 1e-9 &&
      Math.abs((rtFirst.verts[1]!.inX ?? 0) + 20) < 1e-9,
  );
  return ok("rail-format — the flag survives the format, the build and the editor, and hook-proof wins", c.passed(), c.details);
}

export function runRailCases(): RailResult[] {
  return [
    caseStroke(),
    caseSlideStep(),
    caseClamp(),
    caseStick(),
    caseZipline(),
    caseFriction(),
    caseRange(),
    caseFall(),
    caseOpenEnd(),
    caseJam(),
    caseRim(),
    caseBend(),
    caseFormat(),
  ];
}

// Referenced so a future case can reach for them without re-importing; the
// suite's rig is the ball level and these are what a bare-world case needs.
export type { PhysicsBody2D, RigidBody2D };
