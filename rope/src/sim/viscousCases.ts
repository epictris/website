// Viscous cases: hand-built scenes with the answer written down, run by
// `cli viscous`.
//
// A viscous face - mud - is one the manacle bites and then CREEPS through
// under the chain's pull (`lib/viscous.ts`), and what makes it worth a suite
// of its own is that, like a rail, it reaches no invariant: a build in which
// the cuff quietly stopped creeping, or stopped dropping out, renders a level
// that looks identical and plays differently. And like a rail its law has a
// closed form to hold it to: a hanging ball's steady creep is
// `VISCOUS_CREEP_SPEED` exactly, since the tension left once the creep is
// absorbed is the ball's weight and nothing else.
//
// Every sim assertion is a BOUND, never an exact number, and what is
// deliberately NOT asserted is the constants' feel: the creep speed and the
// exponent are guesses to be played, so what is pinned is the SHAPE - a hang
// creeps at the law's own speed, a catch slips far more than a hang and is
// not arrested in a frame, a cuff whose mouth has crept clear drops out.

import { Vec2 } from "../engine/vec2";
import { GRAVITY, World } from "../engine/world";
import { buildLevelBodies } from "../level/buildBodies";
import { scaleLevelData, type RawLevelData, type LevelBodyData } from "../level/levelFormat";
import { BallLevel } from "../level/ballLevel";
import { BallHook } from "../classes/ballHook";
import { StaticBody2D } from "../engine/body";
import { BallPlayer } from "../classes/ballPlayer";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import {
  creepSpeed,
  RopeEmbed,
  slipDistance,
  VISCOUS_CREEP_LOAD,
  VISCOUS_CREEP_SPEED,
  VISCOUS_EXPONENT,
} from "../lib/viscous";
import { MANACLE_MOUTH, MANACLE_REACH } from "../lib/manacle";
import { PX } from "../engine/units";
import { modelFromDisk, modelToDisk } from "../editor/model";
import { isCollisionObject } from "../level/levelFormat";
import { checkBallInvariants, TunnelMonitor, type Violation } from "./trace";

const DT = 1 / 60;
const G = GRAVITY.y;

export interface ViscousResult {
  name: string;
  passed: boolean;
  details: string[];
  expectedFail?: true;
}

function ok(name: string, passed: boolean, details: string[]): ViscousResult {
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
// The rig: the ball and a piece of mud, driven through the real deploy wiring
// with the deploy held so the chain is kept.
// ---------------------------------------------------------------------------

// A static mud slab, `w` by `h` px, centred at (`x`, `y`) px, of the
// reference viscosity unless a case says otherwise.
function mud(x: number, y: number, w: number, h: number, viscosity = 1): LevelBodyData {
  return {
    kind: "static",
    x,
    y,
    rot: 0,
    friction: 1,
    objects: [{ type: "collision", shape: { kind: "rect", w, h }, viscosity }],
  } as LevelBodyData;
}

class Rig {
  readonly level: BallLevel;
  private prev: FrameInput = emptyFrameInput();
  readonly violations: Violation[] = [];
  private tunnel = new TunnelMonitor();

  // A level authored in pixels around the ball at (`playerX`, `playerY`).
  constructor(bodies: LevelBodyData[], playerX = 0, playerY = 0) {
    this.level = new BallLevel({
      player: { x: playerX, y: playerY, radius: 8 },
      bodies,
    } as RawLevelData);
  }

  get ball(): BallPlayer {
    return this.level.ball;
  }

  get embed(): RopeEmbed | null {
    const end = this.level.ball.chain?.end;
    return end instanceof RopeEmbed ? end : null;
  }

  get tip(): BallHook | null {
    return this.level.ball.chainTip;
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

  // The aim once embedded: at the pin, so the chain leaves the loop radially
  // and nothing winds. Before that, `throwAt` from the ball.
  aim(throwAt: Vec2): Vec2 {
    const embed = this.embed;
    return embed ? embed.contact.globalPosition : this.ball.globalPosition.add(throwAt);
  }

  // Run `frames`, throwing `throwAt` (metres, from the ball) until the cuff has
  // embedded and holding the aim on the pin from there. Returns the frame the
  // cuff embedded on, or -1.
  throwUntilEmbedded(throwAt: Vec2, frames = 120): number {
    for (let f = 0; f < frames; f++) {
      this.step(this.aim(throwAt));
      if (this.embed) return f;
    }
    return -1;
  }

  // Run `frames` more with the aim on the pin, calling `each` after every one.
  run(frames: number, throwAt: Vec2, each?: (f: number) => void): void {
    for (let f = 0; f < frames; f++) {
      this.step(this.aim(throwAt));
      each?.(f);
    }
  }
}

// ---------------------------------------------------------------------------
// law - the creep arithmetic.
// ---------------------------------------------------------------------------
function caseLaw(): ViscousResult {
  const c = claims();
  c.check("no load, no creep", creepSpeed(0) === 0 && creepSpeed(-1) === 0);
  c.check(
    `the quoted load creeps at the quoted speed (${(creepSpeed(VISCOUS_CREEP_LOAD) * 100).toFixed(2)} cm/s)`,
    Math.abs(creepSpeed(VISCOUS_CREEP_LOAD) - VISCOUS_CREEP_SPEED) < 1e-12,
  );
  const doubled = creepSpeed(2 * VISCOUS_CREEP_LOAD) / VISCOUS_CREEP_SPEED;
  c.check(
    `twice the load creeps 2^${VISCOUS_EXPONENT} = ${doubled.toFixed(3)} times as fast`,
    Math.abs(doubled - Math.pow(2, VISCOUS_EXPONENT)) < 1e-9,
  );
  // The viscosity scales the LOAD the law reads: mud twice as viscous creeps
  // under twice the load as the reference does under the quoted one, and
  // under the quoted load creeps 2^p times slower.
  const stiff = creepSpeed(VISCOUS_CREEP_LOAD, 2) / VISCOUS_CREEP_SPEED;
  c.check(
    `mud at viscosity 2 creeps 2^-${VISCOUS_EXPONENT} = ${stiff.toFixed(4)} times the speed under the quoted load`,
    Math.abs(stiff - Math.pow(2, -VISCOUS_EXPONENT)) < 1e-9 &&
      Math.abs(creepSpeed(2 * VISCOUS_CREEP_LOAD, 2) - VISCOUS_CREEP_SPEED) < 1e-12,
  );
  c.check("no viscosity, no creep", creepSpeed(VISCOUS_CREEP_LOAD, 0) === 0 && slipDistance(0.01, 52, DT, 0) === 0);
  c.check("no error, no slip", slipDistance(0, 52, DT) === 0 && slipDistance(-0.01, 52, DT) === 0);
  // A ball whose weight is the quoted load, hanging still: the frame's error is
  // one frame of creep plus one of gravity (the ball descends with the cuff),
  // and the slip the law answers is exactly one frame of creep - the tension
  // left once it is absorbed being the ball's weight and nothing else.
  const mass = VISCOUS_CREEP_LOAD / G;
  const hangError = (VISCOUS_CREEP_SPEED + G * DT) * DT;
  const hangSlip = slipDistance(hangError, mass, DT);
  c.check(
    `a steady hang slips one frame of creep (${(hangSlip / DT * 100).toFixed(3)} cm/s of ${(VISCOUS_CREEP_SPEED * 100).toFixed(3)})`,
    Math.abs(hangSlip - VISCOUS_CREEP_SPEED * DT) < 1e-9,
  );
  // A catch: a ball arriving at 5 m/s on a taut chain is 5 m/s × dt over
  // length, and the mud gives far more than a hang's worth - but never the
  // whole error, since past that there is no tension to drive it.
  const catchError = 5 * DT;
  const catchSlip = slipDistance(catchError, mass, DT);
  c.check(
    `a 5 m/s catch slips ${(catchSlip * 100).toFixed(2)} cm in the frame, more than ten hangs' worth and less than the error`,
    catchSlip > 10 * hangSlip && catchSlip < catchError,
  );
  let monotone = true;
  let last = 0;
  for (let i = 1; i <= 50; i++) {
    const s = slipDistance(i * 0.005, mass, DT);
    if (s < last) monotone = false;
    last = s;
  }
  c.check("the slip grows with the error", monotone);
  c.check(
    "...and shrinks with the viscosity",
    slipDistance(catchError, mass, DT, 2) < slipDistance(catchError, mass, DT, 1) &&
      slipDistance(catchError, mass, DT, 0.5) > slipDistance(catchError, mass, DT, 1),
  );
  // A cuff LOCKED to a line - a ring on a vine - creeps under the tension's
  // component along the line alone: square to it nothing drives the ring, at
  // 60° it creeps under half the load, and along it (`along` = 1) the
  // arithmetic is the mud's own, bit for bit.
  const half = slipDistance(catchError, mass, DT, 1, 0.5);
  c.check(
    `a ring pulled square to its line does not creep, and at 60° creeps ${(half / catchSlip).toFixed(3)} of the mud's slip`,
    slipDistance(catchError, mass, DT, 1, 0) === 0 && half > 0 && half < catchSlip,
  );
  c.check(
    "...and pulled along it, exactly the mud's",
    slipDistance(catchError, mass, DT, 1, 1) === catchSlip && slipDistance(hangError, mass, DT, 1, 1) === hangSlip,
  );
  return ok("viscous-law — the creep is a power of the load, and a hang creeps at the quoted speed", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// hang - a ball hanging under a mud ceiling creeps the cuff down out of it at
// the law's own speed, and drops when the mouth clears.
// ---------------------------------------------------------------------------
function caseHang(): ViscousResult {
  const c = claims();
  // A mud slab whose underside is 1.2 m above the ball, and no floor: the ball
  // hangs from the moment the cuff bites.
  const rig = new Rig([mud(0, -150, 400, 60)]);
  const up = new Vec2(0, -1.2);
  const bit = rig.throwUntilEmbedded(up);
  c.check(`the cuff bites the slab's underside (frame ${bit})`, bit >= 0);
  const embed = rig.embed;
  if (!embed) return ok("viscous-hang", false, c.details);
  c.check(
    `...square to it and sunk in to the hinge: the pin on the face (${(embed.contact.globalPosition.y + 1.2).toFixed(4)} m under it), the mouth ${(-(embed.mouth().y + 1.2)).toFixed(4)} m deep (the cuff's own ${MANACLE_MOUTH.toFixed(4)})`,
    Math.abs(embed.facing().x) < 0.05 &&
      Math.abs(embed.contact.globalPosition.y + 1.2) < 0.01 &&
      Math.abs(embed.mouth().y - (-1.2 - MANACLE_MOUTH)) < 0.01,
  );
  // Let the catch settle, then watch a window of steady hanging.
  rig.run(45, up);
  const settledPin = embed.contact.globalPosition;
  const settledBall = rig.ball.globalPosition;
  const window = 30;
  let dropped = -1;
  rig.run(window, up, (f) => {
    if (dropped < 0 && rig.embed === null) dropped = f;
  });
  c.check(`still embedded through the window`, dropped < 0 && rig.embed === embed);
  const crept = embed.contact.globalPosition.sub(settledPin);
  const rate = crept.y / (window * DT);
  c.check(
    `the cuff creeps straight down at the law's speed (${(rate * 100).toFixed(2)} cm/s of ${(VISCOUS_CREEP_SPEED * 100).toFixed(2)}, ${(Math.abs(crept.x) * 1000).toFixed(2)} mm sideways)`,
    Math.abs(rate - VISCOUS_CREEP_SPEED) < VISCOUS_CREEP_SPEED * 0.25 && Math.abs(crept.x) < 0.002,
  );
  const ballRate = rig.ball.globalPosition.sub(settledBall).y / (window * DT);
  c.check(
    `...and the ball descends with it (${(ballRate * 100).toFixed(2)} cm/s)`,
    Math.abs(ballRate - rate) < VISCOUS_CREEP_SPEED * 0.25,
  );
  // Then the mouth clears the underside and the cuff drops out, leaving the
  // ball to fall on a chain that now ends in a loose tip.
  const expect = MANACLE_MOUTH / VISCOUS_CREEP_SPEED;
  let dropAt = -1;
  for (let f = 0; f < Math.ceil(expect / DT) * 2 && dropAt < 0; f++) {
    rig.step(rig.aim(up));
    if (rig.embed === null) dropAt = f;
  }
  const sinceBite = (dropAt + 45 + window) * DT;
  c.check(
    `it drops out ${sinceBite.toFixed(2)} s after biting (the cuff's length over the creep is ${expect.toFixed(2)} s)`,
    dropAt >= 0 && sinceBite > expect * 0.5 && sinceBite < expect * 2,
  );
  c.check("...as the dangling tip, with the chain still out", rig.tip !== null && rig.ball.chain !== null);
  const tip = rig.tip;
  c.check(
    `...clear of the slab (tip at y=${tip ? tip.globalPosition.y.toFixed(3) : "-"}, face at -1.2)`,
    tip !== null && tip.globalPosition.y > -1.2 - 1e-6,
  );
  const vBefore = rig.ball.linearVelocity.y;
  rig.run(20, up);
  c.check(
    `...and the ball falls (${vBefore.toFixed(2)} -> ${rig.ball.linearVelocity.y.toFixed(2)} m/s)`,
    rig.ball.linearVelocity.y > vBefore + G * 20 * DT * 0.5,
  );
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  for (const v of rig.violations.slice(0, 3)) c.details.push(`      ${v.kind} f${v.frame}: ${v.detail}`);
  return ok("viscous-hang — a hanging ball creeps the cuff out of a mud ceiling at the quoted speed, and it drops out", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// catch - a falling ball caught on a mud wall drags the cuff a long way down
// it before it is slowed to a hang, and creeps from there.
// ---------------------------------------------------------------------------
function caseCatch(): ViscousResult {
  const c = claims();
  // A tall mud wall whose face is 30 cm to the ball's right, the ball in the
  // air already falling at 6 m/s, and the throw straight at the wall.
  const rig = new Rig([mud(130, 0, 200, 2000)]);
  rig.ball.linearVelocity = new Vec2(0, 6);
  const right = new Vec2(0.4, 0);
  const bit = rig.throwUntilEmbedded(right, 30);
  c.check(`the cuff bites the wall (frame ${bit})`, bit >= 0);
  const embed = rig.embed;
  if (!embed) return ok("viscous-catch", false, c.details);
  const vCatch = rig.ball.linearVelocity.y;
  const pin0 = embed.contact.globalPosition;
  // The ball's speed AWAY from the pin: what the chain is arresting. Its
  // vertical speed is not that, since once caught the ball also swings in
  // under the pin, and a swing gains vertical speed on its way down.
  const receding = () => {
    const ball = rig.ball;
    const away = ball.globalPosition.sub(embed.contact.globalPosition).normalized();
    return ball.linearVelocity.dot(away);
  };
  const ballSpeed: number[] = [];
  const pinY: number[] = [];
  const early = 20;
  rig.run(early, right, () => {
    ballSpeed.push(receding());
    pinY.push(embed.contact.globalPosition.y - pin0.y);
  });
  c.check(`still embedded after the catch`, rig.embed === embed);
  const slipped = pinY[early - 1]!;
  const creep = early * DT * VISCOUS_CREEP_SPEED;
  c.check(
    `the cuff is dragged ${(slipped * 100).toFixed(1)} cm down the wall in the first ${early} frames, against ${(creep * 100).toFixed(2)} cm of creep`,
    slipped > 5 * creep,
  );
  c.check(
    `the ball is not arrested in a frame: falling at ${vCatch.toFixed(2)} m/s at the bite, still ${ballSpeed[0]!.toFixed(2)} after one`,
    ballSpeed[0]! > 5 * VISCOUS_CREEP_SPEED,
  );
  // Slowed over frames rather than in one. (The recession is not asserted to
  // fall monotonically: caught on a short chain the ball whips in under the
  // pin and meets the wall, and that contact is the wall's, not the mud's.)
  c.details.push(`      recession after the bite: ${ballSpeed.map((v) => v.toFixed(2)).join(" ")}`);
  // Then a hang: the cuff creeps down the wall at the law's speed.
  rig.run(60, right);
  const pinBefore = embed.contact.globalPosition.y;
  const window = 30;
  rig.run(window, right);
  const rate = (embed.contact.globalPosition.y - pinBefore) / (window * DT);
  c.check(
    `then hangs, creeping down the wall at ${(rate * 100).toFixed(2)} cm/s (law ${(VISCOUS_CREEP_SPEED * 100).toFixed(2)})`,
    rig.embed === embed && Math.abs(rate - VISCOUS_CREEP_SPEED) < VISCOUS_CREEP_SPEED * 0.5,
  );
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  for (const v of rig.violations.slice(0, 3)) c.details.push(`      ${v.kind} f${v.frame}: ${v.detail}`);
  return ok("viscous-catch — a falling ball caught on a mud wall drags the cuff down it, is slowed over frames, and hangs", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// corner - a cuff that creeps up to a corner the chain bends round creeps on
// round it, rather than sitting on the wrap node with nowhere to go.
// ---------------------------------------------------------------------------
function caseCorner(): ViscousResult {
  const c = claims();
  // A mud blob whose top face slopes up to the right and whose left face
  // overhangs, running down and to the left from the top-left corner. The
  // ball starts in the air above and left of that corner and throws down onto
  // the top face just right of it, then falls past the corner and hangs
  // under the overhang, so the chain bends round the corner and the pull on
  // the cuff runs along the top face toward it. Runny mud (viscosity 0.5),
  // so the creep gets there within the case.
  const blob: LevelBodyData = {
    kind: "static",
    x: 0,
    y: 0,
    rot: 0,
    friction: 1,
    objects: [
      {
        type: "collision",
        shape: {
          kind: "poly",
          verts: [
            { x: -100, y: -260 },
            { x: 100, y: -300 },
            { x: 100, y: -150 },
            { x: -160, y: -180 },
          ],
        },
        viscosity: 0.5,
      },
    ],
  } as LevelBodyData;
  const corner = new Vec2(-1.0, -2.6);
  const rig = new Rig([blob], -130, -330);
  const throwAt = new Vec2(0.45, 0.67);
  const bit = rig.throwUntilEmbedded(throwAt, 30);
  c.check(`the cuff bites the top face (frame ${bit})`, bit >= 0);
  const embed = rig.embed;
  if (!embed) return ok("viscous-corner", false, c.details);
  const pin0 = embed.contact.globalPosition;
  c.check(
    `...to the right of the corner (pin at x=${pin0.x.toFixed(3)}, corner at ${corner.x.toFixed(1)})`,
    pin0.x > corner.x + 0.05,
  );
  // The ball falls past the corner and the chain bends round it.
  let wrapped = false;
  let reached = -1;
  let nodesAtReach = 0;
  for (let f = 0; f < 400 && reached < 0; f++) {
    rig.step(rig.aim(throwAt));
    const nodes = rig.ball.chain?.path().length ?? 0;
    if (nodes >= 3) wrapped = true;
    if (rig.embed === embed && embed.contact.globalPosition.distanceTo(corner) < 0.005) {
      reached = f;
      nodesAtReach = nodes;
    }
  }
  c.check(`the chain bends round the corner while the cuff creeps toward it`, wrapped);
  c.check(`the cuff creeps up to the corner (frame ${reached}, ${nodesAtReach} nodes)`, reached >= 0);
  if (reached < 0) return ok("viscous-corner", false, c.details);
  // ...and on round it: the wrap node it reached is rounded, and the pin goes
  // on creeping along the overhang under the pull from the ball, rather than
  // sitting on the node with a pull of no direction.
  let stuck = 0;
  let farthest = 0;
  rig.run(120, throwAt, () => {
    if (rig.embed !== embed) return;
    const d = embed.contact.globalPosition.distanceTo(corner);
    farthest = Math.max(farthest, d);
    if (d < 1e-4) stuck++;
  });
  const pin = embed.contact.globalPosition;
  c.check(`still embedded`, rig.embed === embed);
  c.check(
    `...and creeping on past the corner: ${(farthest * 100).toFixed(1)} cm from it two seconds later, down the overhang (pin at (${pin.x.toFixed(3)}, ${pin.y.toFixed(3)}))`,
    farthest > 0.03 && pin.x < corner.x && pin.y > corner.y,
  );
  c.check(`...never parked on the wrap node (${stuck} frames within 0.1 mm of it)`, stuck <= 2);
  const nodes = rig.ball.chain?.path().length ?? 0;
  c.check(`...with the corner no longer a wrap (${nodes} nodes)`, nodes === 2);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  for (const v of rig.violations.slice(0, 3)) c.details.push(`      ${v.kind} f${v.frame}: ${v.detail}`);
  return ok("viscous-corner — a cuff that creeps up to a corner the chain bends round creeps on round it", c.passed(), c.details);
}

// A solid static slab, `w` by `h` px, centred at (`x`, `y`) px: stone for the
// dropped cuff to land on.
function stone(x: number, y: number, w: number, h: number): LevelBodyData {
  return {
    kind: "static",
    x,
    y,
    rot: 0,
    friction: 1,
    objects: [{ type: "collision", shape: { kind: "rect", w, h } }],
  } as LevelBodyData;
}

// ---------------------------------------------------------------------------
// drop - a cuff that has crept out of mud is still a cuff: it does not
// re-bite the face it left, and it bites the stone it lands on.
// ---------------------------------------------------------------------------
function caseDrop(): ViscousResult {
  const c = claims();
  // The hang's mud ceiling, with a stone floor a metre under the ball for the
  // ball and the cuff to fall to once the mud lets go.
  const rig = new Rig([mud(0, -150, 400, 60), stone(0, 120, 600, 40)]);
  const up = new Vec2(0, -1.2);
  const bit = rig.throwUntilEmbedded(up);
  c.check(`the cuff bites the slab's underside (frame ${bit})`, bit >= 0);
  const embed = rig.embed;
  if (!embed) return ok("viscous-drop", false, c.details);
  const mudBody = embed.body;
  let dropAt = -1;
  for (let f = 0; f < 600 && dropAt < 0; f++) {
    rig.step(rig.aim(up));
    if (rig.embed === null) dropAt = f;
  }
  c.check(`it creeps out and drops (frame ${dropAt} after the bite)`, dropAt >= 0);
  const tip = rig.tip;
  if (dropAt < 0 || !tip) return ok("viscous-drop", false, c.details);
  // The frame it drops the cuff is touching the face it left: the mouth is
  // one frame of creep clear of the underside, well inside the resting
  // probe's margin. Re-bitten there it would sink to the hinge again and hang
  // for another three seconds, for as long as it lay against the face.
  const mouth = tip.globalPosition.sub(Vec2.RIGHT.rotated(tip.globalRotation).mul(MANACLE_REACH));
  const gap = mouth.y - -1.2;
  c.check(
    `...with the mouth ${(gap * 1000).toFixed(2)} mm under the face it left, inside the probe's margin`,
    gap > -1e-6 && gap < 0.5 * PX,
  );
  let rebit = -1;
  rig.run(10, up, (f) => {
    if (rebit < 0 && rig.embed !== null) rebit = f;
  });
  c.check(`it does not re-bite the mud (${rebit < 0 ? "never" : `re-embedded ${rebit} frames later`})`, rebit < 0);
  c.check("...and is the dangling tip still", rig.tip === tip && rig.ball.chain !== null);
  // Then the ball and the tip fall to the floor, and the tip bites it: a
  // dropped cuff is still armed, as a missed throw's is.
  let landed = -1;
  let anchor: unknown = null;
  for (let f = 0; f < 240 && landed < 0; f++) {
    rig.step(rig.aim(up));
    const end = rig.ball.chain?.end;
    if (end && end.contact.obj instanceof StaticBody2D) {
      landed = f;
      anchor = end.contact.obj;
    }
  }
  const floor = anchor instanceof StaticBody2D ? anchor : null;
  c.check(`the tip bites the stone floor it lands on (${landed} frames after the drop)`, floor !== null);
  c.check(
    "...the floor and not the mud, as a plain bite rather than an embed",
    floor !== null && floor !== mudBody && !floor.getShapes().some((s) => s.viscous) && rig.embed === null,
  );
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  for (const v of rig.violations.slice(0, 3)) c.details.push(`      ${v.kind} f${v.frame}: ${v.detail}`);
  return ok("viscous-drop — a dropped cuff does not re-bite the mud it left, and bites the stone it lands on", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// format - the flag survives the format, the build and the editor, and
// hook-proof wins.
// ---------------------------------------------------------------------------
function caseFormat(): ViscousResult {
  const c = claims();
  const raw = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        objects: [
          { type: "collision", x: 0, y: 0, shape: { kind: "rect", w: 40, h: 40 }, viscosity: 2.5 },
          { type: "collision", x: 100, y: 0, shape: { kind: "rect", w: 40, h: 40 } },
          { type: "collision", x: 200, y: 0, shape: { kind: "rect", w: 40, h: 40 }, viscosity: 1, impermeable: true },
        ],
      },
    ],
  } as RawLevelData;
  const data = scaleLevelData(raw, PX);
  const objs = data.bodies[0]!.objects.filter(isCollisionObject);
  c.check(
    "scaleLevelData carries `viscosity` through px -> m, unscaled",
    objs[0]!.viscosity === 2.5 && objs[1]!.viscosity === undefined && objs[2]!.viscosity === 1,
  );
  const world = new World();
  const built = buildLevelBodies(world, data, () => {});
  const shapes = built.bodies[0]!.body!.getShapes();
  c.check(
    "the build sets it on the pieces that authored it and no other",
    shapes[0]!.viscosity === 2.5 && shapes[1]!.viscosity === 0 && !shapes[1]!.viscous && shapes[2]!.viscous,
  );
  // Hook-proof wins: a hook thrown at the third piece is deflected, never embedded.
  const hook = new BallHook();
  hook.globalPosition = new Vec2(2, 0.6);
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
  c.check("a hook-proof mud face deflects the hook (hook-proof wins)", !attached);
  const rt = modelToDisk(modelFromDisk(raw));
  const rtObjs = rt.bodies[0]!.objects.filter(isCollisionObject);
  c.check(
    "the editor's modelFromDisk/modelToDisk keeps the number, and writes it only where it is set",
    rtObjs[0]!.viscosity === 2.5 && rtObjs[1]!.viscosity === undefined,
  );
  return ok("viscous-format — the flag survives the format, the build and the editor, and hook-proof wins", c.passed(), c.details);
}

export function runViscousCases(): ViscousResult[] {
  return [caseLaw(), caseHang(), caseCatch(), caseCorner(), caseDrop(), caseFormat()];
}
