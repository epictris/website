// Spring-body cases: hand-built scenes with the answer written down, run by
// `cli spring`.
//
// A spring body is a `RigidBody2D` held at its authored position by a two-axis
// spring-damper (see `RigidBody2D.spring`), and what makes it worth asserting
// separately from `cli contacts` is that its whole behaviour is arithmetic with
// a closed form: the self-weight droop is `g/w²`, a load `F` adds `F/(m·w²)`,
// the oscillation period is `1/f` per axis, and an underdamped release
// overshoots by `e^(-zeta·pi/sqrt(1-zeta²))` of the displacement it starts from.
// Every one of those is a number an author reasons about while tuning a plant,
// so every one of them is checked here rather than eyeballed in the browser.
//
// Pure physics - a `World`, one body and a fixed number of steps - so no level,
// no input trace and no bundle, and a regression reads as a number.
//
// The tolerances are BOUNDS, not exact values, with two deliberate exceptions:
// a locked axis and a locked rotation are asserted at `=== 0`, because those are
// held by a snap rather than by a solve and "small" would be the bug.

import { Vec2 } from "../engine/vec2";
import { RigidBody2D, StaticBody2D } from "../engine/body";
import { rectShape, type Shape } from "../engine/shapes";
import { ContactAudit, GRAVITY, World } from "../engine/world";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { SceneChain, stepSceneChains } from "../level/chains";
import { RopeContact } from "../lib/ropeContact";
import { applyHangLoad } from "../classes/states/ledgeLoad";
import { Player } from "../classes/player";
import { mechanicalEnergy } from "./trace";
import {
  buildLevelBodies,
  DEFAULT_SPRING_DAMPING,
  MAX_SPRING_FREQ,
  RIGID_KINETIC_FRICTION,
  RIGID_STATIC_FRICTION,
} from "../level/buildBodies";
import { scaleLevelData } from "../level/levelFormat";
import { buildSceneChains } from "../level/chains";
import { PX as PX_FACTOR } from "../engine/units";
import { modelFromDisk, modelToDisk, settledGhosts } from "../editor/model";
import { BallLevel } from "../level/ballLevel";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import type { RawLevelData } from "../level/levelFormat";

const DT = 1 / 60;
const G = GRAVITY.y;

export interface SpringResult {
  name: string;
  passed: boolean;
  details: string[];
}

function ok(name: string, passed: boolean, details: string[]): SpringResult {
  return { name, passed, details };
}

// The self-weight droop an authored frequency works out to, in metres: the
// equilibrium of `-w²·d + g = 0`. This is the formula `LevelBodyData.springFreqY`
// documents and the editor shows a readout of, written once here so the cases
// assert the same arithmetic an author is given.
function droopOf(freqHz: number): number {
  const w = 2 * Math.PI * freqHz;
  return G / (w * w);
}

// A world with one spring body in it, at the origin, and nothing else unless a
// case adds it. The body carries the coefficients an authored `rigid` level body
// gets, for the same reason `cli contacts` does it: the class defaults are 0 and
// a case built on them would be testing a world no level contains.
class Spring {
  readonly world = new World();
  readonly body: RigidBody2D;
  readonly anchor: Vec2;

  constructor(opts: {
    shape?: Shape;
    anchor?: Vec2;
    freqX: number;
    freqY: number;
    zeta?: number;
  }) {
    const shape = opts.shape ?? rectShape(1.2, 0.12);
    this.anchor = opts.anchor ?? new Vec2(0, -3);
    const b = new RigidBody2D();
    b.globalPosition = this.anchor;
    b.setShape(shape);
    b.mass = ShapeGeometry.computeMass(b.primaryShape());
    b.inertia = ShapeGeometry.computeMomentOfInertia(b.primaryShape(), b.mass);
    b.contactFriction = RIGID_KINETIC_FRICTION;
    b.staticFriction = RIGID_STATIC_FRICTION;
    b.spring = {
      anchor: this.anchor,
      omegaX: 2 * Math.PI * opts.freqX,
      omegaY: 2 * Math.PI * opts.freqY,
      zeta: opts.zeta ?? 0.15,
    };
    this.world.add(b);
    this.body = b;
  }

  get offset(): Vec2 {
    return this.body.globalPosition.sub(this.anchor);
  }

  step(frames: number, onFrame?: (n: number) => void): void {
    for (let i = 0; i < frames; i++) {
      this.world.integrate(DT);
      onFrame?.(i + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// droop: a spring body settles at exactly the height its frequency implies.
//
// The one number an author picks a frequency BY - "how far does this leaf hang
// when nobody is on it" - so if this is wrong the field is unauthorable however
// well the rest of the mechanic behaves. The x axis is asserted alongside it
// because gravity has no x component: a leaf that drifts sideways as it settles
// is a sign term that has picked up the wrong axis's offset.
// ---------------------------------------------------------------------------
function caseDroop(): SpringResult {
  const details: string[] = [];
  let passed = true;
  for (const f of [1, 1.5, 2]) {
    const s = new Spring({ freqX: 1.5, freqY: f });
    // 20 s. The envelope decays as e^(-zeta·w·t), which at zeta 0.15 and 1 Hz is
    // e^-18.8 by then - the slowest case here is settled to well under a micron.
    s.step(1200);
    const want = droopOf(f);
    const dy = Math.abs(s.offset.y - want);
    const dx = Math.abs(s.offset.x);
    const good = dy < 1e-6 && dx < 1e-9;
    passed &&= good;
    details.push(
      `${good ? "ok  " : "BAD "} f=${f} Hz: droop ${(s.offset.y * 100).toFixed(4)} cm ` +
        `(want ${(want * 100).toFixed(4)} = g/w², err ${dy.toExponential(1)} m), ` +
        `x drift ${dx.toExponential(1)} m`,
    );
  }
  return ok("droop — a spring body settles at g/w² under its own weight", passed, details);
}

// ---------------------------------------------------------------------------
// load-release: the hang deepens the droop by F/(m·w²), and letting go overshoots.
//
// The mechanic itself, and it is driven through `applyHangLoad` - the function
// the ledge states actually call - rather than through a hand-rolled force, so
// what is asserted is the path the player's weight really takes. The load is
// applied at an OFF-CENTRE corner for the same reason: that is where a grab
// lands, and a body that answered it with a torque instead of a sag would show
// up here as well as in `rotation-lock`.
//
// The overshoot is the half that cannot be got from the equilibrium alone, and
// it is the half the mechanic is FOR: released from `A` below its rest height an
// underdamped spring returns to `A·e^(-zeta·pi/sqrt(1-zeta²))` ABOVE it, which at
// the default zeta of 0.15 is 62% of the way back up. A critically damped spring
// would sink and return with none of it.
// ---------------------------------------------------------------------------
function caseLoadRelease(): SpringResult {
  const FREQ = 1;
  const s = new Spring({ freqX: 1.5, freqY: FREQ });
  const rest = droopOf(FREQ);
  const w2 = (2 * Math.PI * FREQ) ** 2;
  // Where the corner of the leaf is, in the body's own terms: half its length
  // out, which is where a grab lands.
  const corner = (): Vec2 => s.body.globalPosition.add(new Vec2(0.6, -0.06));

  s.step(1200);
  const settled = Math.abs(s.offset.y - rest) < 1e-6;

  // Hung on for 20 s: the equilibrium deepens by the player's weight over the
  // body's own stiffness, `m_player·g / (m_body·w²)`.
  s.step(1200, () => applyHangLoad(s.body, corner(), DT));
  const extra = s.offset.y - rest;
  const wantExtra = (Player.MASS * G) / (s.body.mass * w2);
  // The DISCRETE equilibrium sits a definite hair above the continuous one, and
  // the hair is worth writing out rather than hiding in a loose tolerance. A
  // per-frame impulse leaves `F·dt/m` of velocity standing in the body at the
  // fixed point, and the damping term charges it `2·zeta·w·dt` of that back, so
  // the discrete answer is `wantExtra·(1 - 2·zeta·w·dt)` - 2.4% shy here, and
  // O(dt) rather than a bias that survives a finer step. The measurement is
  // asserted into that window, which is sharper than a percentage bound and
  // says WHY the two numbers differ.
  const wantDiscrete = wantExtra * (1 - 2 * 0.15 * 2 * Math.PI * FREQ * DT);
  const loaded = Math.abs(extra - wantDiscrete) < 1e-4;

  // Let go: the return must overshoot ABOVE the unloaded rest height, then come
  // back to it.
  const startedFrom = extra;
  let peak = s.offset.y;
  s.step(300, () => {
    peak = Math.min(peak, s.body.globalPosition.y - s.anchor.y);
  });
  const overshoot = rest - peak;
  const wantOvershoot = startedFrom * Math.exp((-0.15 * Math.PI) / Math.sqrt(1 - 0.15 ** 2));
  // A bound, not the value: the damped period and the discrete step both shift
  // it a little, and what is being asserted is that a real overshoot is there.
  const sprang = overshoot > 0.8 * wantOvershoot && overshoot < 1.2 * wantOvershoot;

  s.step(1500);
  const settledBack = s.offset.y;
  const returned = Math.abs(settledBack - rest) < 1e-4;

  const passed = settled && loaded && sprang && returned;
  return ok("load-release — a hung player deepens the droop, and letting go springs back", passed, [
    `${settled ? "ok  " : "BAD "} unloaded rest at ${(rest * 100).toFixed(2)} cm`,
    `${loaded ? "ok  " : "BAD "} ${Player.MASS} kg hung on a ${s.body.mass.toFixed(2)} kg leaf: ` +
      `sags a further ${(extra * 100).toFixed(2)} cm (want ${(wantDiscrete * 100).toFixed(2)}, ` +
      `the discrete form of F/(m·w²) = ${(wantExtra * 100).toFixed(2)})`,
    `${sprang ? "ok  " : "BAD "} released: overshoots ${(overshoot * 100).toFixed(2)} cm above rest ` +
      `(want ~${(wantOvershoot * 100).toFixed(2)} from ${(startedFrom * 100).toFixed(2)} cm down)`,
    `${returned ? "ok  " : "BAD "} and settles back to ${(settledBack * 100).toFixed(4)} cm`,
  ]);
}

// Frames between the first two upward zero crossings of a history about `about`,
// linearly interpolated, or null if it does not cross twice. A period measured
// from crossings rather than from peaks because a crossing is where the signal
// moves fastest and so is the least sensitive to the sample rate.
function periodFrames(history: readonly number[], about: number): number | null {
  const crossings: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1]! - about;
    const b = history[i]! - about;
    if (a < 0 && b >= 0) crossings.push(i - 1 + a / (a - b));
    if (crossings.length === 2) return crossings[1]! - crossings[0]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// axes: each axis oscillates at its OWN authored frequency, and neither drives
// the other.
//
// Two statements in one scene, because they fail together. The body starts at
// the y equilibrium and is struck purely horizontally, so a correct engine
// leaves y at exactly its droop for ever while x rings at `fx` - and a sign or
// index slip that reads one axis's offset into the other's force shows up as
// both a y that moves and an x whose period is wrong.
//
// Undamped (zeta 0), which is what makes the period a number rather than a
// decaying approximation of one. Semi-implicit Euler's discrete frequency is
// `2·asin(w·dt/2)/dt`, 0.2% high at 2 Hz on the 1/60 step, so the bound is 2%.
// ---------------------------------------------------------------------------
function caseAxes(): SpringResult {
  const details: string[] = [];
  let passed = true;
  const FREQ_Y = 1;
  const rest = droopOf(FREQ_Y);
  for (const fx of [2, 1, 0.5]) {
    const s = new Spring({ freqX: fx, freqY: FREQ_Y, zeta: 0 });
    // Started AT the y equilibrium, so y has nothing to do and any motion in it
    // came from the x axis.
    s.body.globalPosition = s.anchor.add(new Vec2(0, rest));
    s.body.linearVelocity = new Vec2(1.5, 0);
    const xs: number[] = [];
    let yDrift = 0;
    s.step(900, () => {
      xs.push(s.offset.x);
      yDrift = Math.max(yDrift, Math.abs(s.offset.y - rest));
    });
    const period = periodFrames(xs, 0);
    const want = 60 / fx;
    const err = period === null ? Infinity : Math.abs(period - want) / want;
    const good = err < 0.02 && yDrift < 1e-9;
    passed &&= good;
    details.push(
      `${good ? "ok  " : "BAD "} fx=${fx} Hz: x period ${period?.toFixed(2) ?? "none"} frames ` +
        `(want ${want.toFixed(2)}, err ${(err * 100).toFixed(2)}%), ` +
        `y held at its droop to ${yDrift.toExponential(1)} m`,
    );
  }
  return ok("axes — each axis rings at its own frequency and leaves the other alone", passed, details);
}

// ---------------------------------------------------------------------------
// locked-axis: frequency 0 pins that axis to the anchor, exactly.
//
// The useful degenerate case - a leaf that only bobs vertically - and it is
// asserted at `=== 0` rather than at a tolerance because it is held by a snap
// rather than by a solve. Anything else means the pin is really a very stiff
// spring, which is the thing an author would have written a large frequency for.
// The impulse is deliberately violent: a pin that holds a nudge and yields to a
// blow is a pin that will fail the first time a cannonball reaches it.
// ---------------------------------------------------------------------------
function caseLockedAxis(): SpringResult {
  const s = new Spring({ freqX: 0, freqY: 1 });
  let maxX = 0;
  let maxVx = 0;
  s.step(1200, (n) => {
    // Measured at the top of the frame, BEFORE the blow lands: the frame a body
    // is struck it carries the impulse's velocity until the next integrate
    // snaps it, and asserting inside that gap would be asserting that
    // `applyImpulse` does not do what it says. What must be exactly 0 is what
    // the axis is left holding once the step has run.
    maxX = Math.max(maxX, Math.abs(s.offset.x));
    maxVx = Math.max(maxVx, Math.abs(s.body.linearVelocity.x));
    if (n === 60) s.body.applyImpulse(new Vec2(4000, 0));
  });
  const pinned = maxX === 0 && maxVx === 0;
  const rest = droopOf(1);
  const stillDroops = Math.abs(s.offset.y - rest) < 1e-6;
  return ok("locked-axis — frequency 0 pins that axis to the anchor", pinned && stillDroops, [
    `${pinned ? "ok  " : "BAD "} a 4000 N·s horizontal blow leaves x at ${maxX} m ` +
      `and ${maxVx} m/s at every step boundary (want exactly 0)`,
    `${stillDroops ? "ok  " : "BAD "} the free axis still droops to ${(s.offset.y * 100).toFixed(4)} cm ` +
      `(want ${(rest * 100).toFixed(4)})`,
  ]);
}

// ---------------------------------------------------------------------------
// rotation-lock: a spring body does not spin, whatever it is hit with.
//
// The freedom a spring body gives up, and the mirror of what `pivot` gives up.
// It is removed at the source (`inverseInertia` reads 0), so this is one
// assertion standing for every impulse path there is - and the direct write is
// covered too, since `World.integrate` zeroes the angular velocity rather than
// trusting it to stay zero.
// ---------------------------------------------------------------------------
function caseRotationLock(): SpringResult {
  const s = new Spring({ freqX: 1.5, freqY: 1 });
  const inv = s.body.inverseInertia;
  let maxRot = 0;
  let maxSpin = 0;
  s.step(600, (n) => {
    // Measured at the top of the frame, for the same reason `locked-axis` does:
    // what must be exactly 0 is what the body is left holding once the step has
    // run, not what a caller managed to write into it a microsecond earlier.
    maxRot = Math.max(maxRot, Math.abs(s.body.globalRotation));
    maxSpin = Math.max(maxSpin, Math.abs(s.body.angularVelocity));
    // An off-centre blow, and a direct spin write on top of it: the first is
    // what an impulse path does, the second is what water's angular drag does.
    if (n === 60) s.body.applyImpulse(new Vec2(0, -800), new Vec2(0.6, 0));
    if (n === 120) s.body.angularVelocity = 12;
  });
  // The blow was off-centre and downward, so it must still have moved the body.
  const moved = s.offset.y > droopOf(1);
  const passed = inv === 0 && maxRot === 0 && maxSpin === 0 && moved;
  return ok("rotation-lock — a spring body translates and never turns", passed, [
    `${inv === 0 ? "ok  " : "BAD "} inverseInertia ${inv} (want exactly 0)`,
    `${maxRot === 0 && maxSpin === 0 ? "ok  " : "BAD "} an off-centre blow and a direct spin ` +
      `write leave rotation ${maxRot} rad at ${maxSpin} rad/s (want exactly 0)`,
    `${moved ? "ok  " : "BAD "} the same blow still pushed it down to ${(s.offset.y * 100).toFixed(2)} cm`,
  ]);
}

// ---------------------------------------------------------------------------
// contact-load: a box resting on the leaf depresses it, and the solve stays
// audited.
//
// The reason a spring body is a `RigidBody2D` at all: every load path in the
// engine already speaks to one through impulses, so a rock left on the leaf must
// weigh on it with no plumbing of its own. And the audit is the other half -
// `auditImpulses` exempts the ANGULAR side for a spring body (the rotation lock's
// reaction, which nothing models) and keeps the linear side in full, so a spring
// force that leaked into the contact window would report here.
// ---------------------------------------------------------------------------
function caseContactLoad(): SpringResult {
  const s = new Spring({ shape: rectShape(2, 0.2), freqX: 1.5, freqY: 1 });
  s.step(600);
  const bare = s.offset.y;

  const box = new RigidBody2D();
  box.globalPosition = s.body.globalPosition.add(new Vec2(0, -0.5));
  box.setShape(rectShape(0.5, 0.5));
  box.mass = ShapeGeometry.computeMass(box.primaryShape());
  box.inertia = ShapeGeometry.computeMomentOfInertia(box.primaryShape(), box.mass);
  box.contactFriction = RIGID_KINETIC_FRICTION;
  box.staticFriction = RIGID_STATIC_FRICTION;
  s.world.add(box);

  ContactAudit.enabled = true;
  ContactAudit.reset();
  s.step(900);
  ContactAudit.enabled = false;

  const loaded = s.offset.y;
  // The box's weight over the leaf's stiffness. A bound rather than the value:
  // the box is resting through a contact solve rather than bolted on, so it
  // carries a little of its own settling.
  const wantExtra = (box.mass * G) / (s.body.mass * (2 * Math.PI) ** 2);
  const extra = loaded - bare;
  const depressed = extra > 0.5 * wantExtra && extra < 1.5 * wantExtra;
  // ...and it must be RESTING on the leaf, not fallen through it.
  // y is measured DOWNWARD, so a box resting on top of the leaf sits at the
  // smaller y - and a box that fell through it would read the other way round,
  // which is exactly the failure this line is here to catch.
  const riding = box.globalPosition.y < s.body.globalPosition.y;
  const clean = ContactAudit.violations.length === 0;
  const passed = depressed && riding && clean;
  return ok("contact-load — a box resting on a spring body weighs on it, audited", passed, [
    `${depressed ? "ok  " : "BAD "} a ${box.mass.toFixed(1)} kg box depresses the leaf a further ` +
      `${(extra * 100).toFixed(2)} cm (want ~${(wantExtra * 100).toFixed(2)} = F/(m·w²))`,
    `${riding ? "ok  " : "BAD "} the box rides on top of it`,
    clean
      ? "ok   the contact solve writes only what it applied"
      : `BAD  ${ContactAudit.violations.length} audit violations: ${ContactAudit.violations[0]}`,
  ]);
}

// ---------------------------------------------------------------------------
// chain-load: a weight hung from a spring body by a chain sags it by the SAME
// F/(m·w²) the player's hang does.
//
// The chain is the one load path that does not go through `applyImpulse`. It is
// a positional (PBD) constraint that writes the body's transform directly and
// then pays it a velocity credit, and it is the path `getDynamicBodyState` had
// to be taught about - a spring body's rotation is locked, so it is handed to
// the solve as `inertia: Infinity` and the whole correction lands in
// translation. That is a change to how much of each correction the OTHER end of
// the chain absorbs, which is felt as how much a swing on it is slowed, so the
// question "is it physically accurate" has to be asked of a number rather than
// of the feel.
//
// The number is the same closed form as everywhere else: at rest the leaf hangs
// where the spring balances its own weight plus the weight on the chain, and
// nothing about the chain being a constraint rather than a force may change
// that. It cannot be asserted as tightly as the impulse path is - the chain
// solves to a 5 mm tolerance of its own (`CHAIN_TOLERANCE`) and a hung weight
// rings on it - so the bound is 3 cm, which is a tenth of the sag being
// measured and still far inside the "the chain is loading it wrong" regime.
// ---------------------------------------------------------------------------
function caseChainLoad(): SpringResult {
  const s = new Spring({ shape: rectShape(2, 0.2), freqX: 1.5, freqY: 1 });
  s.step(600);
  const bare = s.offset.y;

  // Hung off the leaf's right arm, well clear of it so the two never touch.
  const weight = new RigidBody2D();
  weight.globalPosition = s.body.globalPosition.add(new Vec2(0.8, 1));
  weight.setShape(rectShape(0.4, 0.4));
  weight.mass = ShapeGeometry.computeMass(weight.primaryShape());
  weight.inertia = ShapeGeometry.computeMomentOfInertia(weight.primaryShape(), weight.mass);
  weight.contactFriction = RIGID_KINETIC_FRICTION;
  weight.staticFriction = RIGID_STATIC_FRICTION;
  s.world.add(weight);
  const top = s.body.globalPosition.add(new Vec2(0.8, 0.1));
  const bottom = weight.globalPosition.add(new Vec2(0, -0.2));
  const chain = new SceneChain(
    RopeContact.at(s.body, top),
    RopeContact.at(weight, bottom),
    top.distanceTo(bottom),
    null,
  );

  let peak = 0;
  let maxSpin = 0;
  s.step(1800, () => {
    stepSceneChains([chain], s.world, DT);
    peak = Math.max(peak, weight.linearVelocity.length());
    maxSpin = Math.max(maxSpin, Math.abs(s.body.angularVelocity));
  });

  const extra = s.offset.y - bare;
  const w2 = (2 * Math.PI) ** 2;
  const wantExtra = (weight.mass * G) / (s.body.mass * w2);
  const sagged = Math.abs(extra - wantExtra) < 0.03;
  // The chain must be HOLDING it, not have dropped it: a weight that slipped
  // its constraint falls for ever and would leave the leaf at its bare droop,
  // which is a passing `sagged` if the tolerance were loose enough.
  const held = Math.abs(weight.globalPosition.y - s.body.globalPosition.y - 1) < 0.1;
  const bounded = Number.isFinite(peak) && peak < 10;
  const stillLocked = maxSpin === 0 && s.body.globalRotation === 0;
  const passed = sagged && held && bounded && stillLocked;
  return ok("chain-load — a chain-hung weight sags the leaf by the same F/(m·w²)", passed, [
    `${sagged ? "ok  " : "BAD "} a ${weight.mass.toFixed(1)} kg weight on the chain sags it a further ` +
      `${(extra * 100).toFixed(2)} cm (want ${(wantExtra * 100).toFixed(2)} = F/(m·w²))`,
    `${held ? "ok  " : "BAD "} and the chain still holds it 1 m below (${(weight.globalPosition.y - s.body.globalPosition.y).toFixed(3)} m)`,
    `${bounded ? "ok  " : "BAD "} the rig stays bounded: peak weight speed ${peak.toFixed(2)} m/s`,
    `${stillLocked ? "ok  " : "BAD "} and the chain's torque arm turns the leaf ${s.body.globalRotation} rad (want exactly 0)`,
  ]);
}

// ---------------------------------------------------------------------------
// chain-drain: a swing anchored to a spring body must not die faster than the
// same swing anchored to a wall.
//
// This case exists for a specific report - "a swing on the springy platform is
// being slowed too much" - and it exists in this form because the obvious way to
// ask it does not work. The obvious way is an energy budget: a PBD length
// constraint is a rigid link, does no work, and so may remove nothing beyond
// what the spring's own dashpot accounts for. But the chain rewrites the leaf's
// velocity twice a frame (the integrate step, then the solve's credit), so the
// dashpot's `2·zeta·w·m·v²` integrates to a different number depending on which
// of the two you sample - a three-fold spread here - and an assertion cannot be
// built on a quantity that ambiguous.
//
// What IS unambiguous is the comparison. Two rigs identical in every respect
// but the anchor - the same weight, the same chain, the same taut pendulum, the
// same kick - one hung from a `StaticBody2D` and one from a spring body. The
// static rig is the rope solver's own baseline, and this engine's chain is
// genuinely lossy: a pendulum on a rock-solid wall gives up 97% of its kick in
// 20 seconds, which is a property of the PBD solve and not of anything here. So
// the question "does the spring mounting slow the swing more than it should"
// has a checkable answer - not more than the wall does - and the sizing
// question disappears with it.
//
// The measured answer is that it does not: 15.83 J against the wall's 15.69 J,
// with the spring rig's weight left moving four times faster at the end. What
// makes a swing on an authored spring body feel dead is the authored damping
// itself, which at zeta 0.15 and 1 Hz on a heavy body is a dashpot of a few
// hundred N·s/m sitting between the chain and the world - a real energy sink
// doing exactly what it says.
// ---------------------------------------------------------------------------
function caseChainDrain(): SpringResult {
  // One taut pendulum, hung from whatever `anchor` is: a weight on a chain from
  // a point on the anchor's right arm, settled, then kicked sideways. The kick
  // is small enough that `v²/L` stays well under g, so the chain carries tension
  // through the whole arc and never goes slack - a chain that snaps taut is a
  // perfectly inelastic event, and a rig that does it measures the snap.
  const KICK = 1.2;
  const swing = (spring: boolean): { lost: number; gained: number; left: number; mass: number } => {
    const world = new World();
    const anchor = spring ? new RigidBody2D() : new StaticBody2D();
    anchor.globalPosition = new Vec2(0, -3);
    anchor.setShape(rectShape(2, 0.2));
    if (anchor instanceof RigidBody2D) {
      anchor.mass = ShapeGeometry.computeMass(anchor.primaryShape());
      anchor.inertia = ShapeGeometry.computeMomentOfInertia(anchor.primaryShape(), anchor.mass);
      anchor.spring = {
        anchor: anchor.globalPosition,
        omegaX: 2 * Math.PI * 1.5,
        omegaY: 2 * Math.PI,
        zeta: 0.15,
      };
    }
    world.add(anchor);

    const weight = new RigidBody2D();
    weight.globalPosition = anchor.globalPosition.add(new Vec2(0.8, 1));
    weight.setShape(rectShape(0.4, 0.4));
    weight.mass = ShapeGeometry.computeMass(weight.primaryShape());
    weight.inertia = ShapeGeometry.computeMomentOfInertia(weight.primaryShape(), weight.mass);
    world.add(weight);
    const top = anchor.globalPosition.add(new Vec2(0.8, 0.1));
    const bottom = weight.globalPosition.add(new Vec2(0, -0.2));
    const chain = new SceneChain(
      RopeContact.at(anchor, top),
      RopeContact.at(weight, bottom),
      top.distanceTo(bottom),
      null,
    );
    const step = (n: number, onFrame?: () => void): void => {
      for (let i = 0; i < n; i++) {
        world.integrate(DT);
        stepSceneChains([chain], world, DT);
        onFrame?.();
      }
    };

    // Settle the rig - the leaf dropping into its droop, the chain taking up
    // the weight - so what is measured afterwards is the swing alone.
    step(1800);
    weight.linearVelocity = weight.linearVelocity.add(new Vec2(KICK, 0));
    const e0 = mechanicalEnergy(world);
    let prev = e0;
    let gained = 0;
    step(1200, () => {
      const e = mechanicalEnergy(world);
      gained = Math.max(gained, e - prev);
      prev = e;
    });
    return {
      lost: e0 - prev,
      gained,
      left: weight.linearVelocity.length(),
      mass: anchor instanceof RigidBody2D ? anchor.mass : Infinity,
    };
  };

  const wall = swing(false);
  const leaf = swing(true);
  const kick = 0.5 * 22.4 * KICK * KICK;
  // Half again the wall's loss. Generous on purpose: what this is a detector for
  // is a spring body that ABSORBS the swing - a wrong effective mass in the
  // solve's split, say, which is the thing `getDynamicBodyState` handing it
  // `inertia: Infinity` changes - and that reads as a multiple, not as a few
  // per cent.
  const notWorse = leaf.lost <= wall.lost * 1.5;
  // Neither rig may GAIN, which is the other bug and the one `EnergyMonitor`
  // fires on. Against the wall's own worst frame rather than a bare number, so
  // the bound is the solver's noise floor rather than a guess at it.
  const noPump = leaf.gained <= Math.max(wall.gained, 0.01 * kick) * 2;
  const passed = notWorse && noPump;
  return ok("chain-drain — a swing on a spring body dies no faster than one on a wall", passed, [
    `${notWorse ? "ok  " : "BAD "} a ${kick.toFixed(1)} J kick gives up ${leaf.lost.toFixed(3)} J ` +
      `on a ${leaf.mass.toFixed(1)} kg spring body against ${wall.lost.toFixed(3)} J on a static ` +
      `one (bar ${(wall.lost * 1.5).toFixed(3)})`,
    `${notWorse ? "ok  " : "BAD "} and the weight is left at ${leaf.left.toFixed(3)} m/s against ` +
      `${wall.left.toFixed(3)} m/s on the wall`,
    `${noPump ? "ok  " : "BAD "} worst single-frame gain ${leaf.gained.toFixed(4)} J against the ` +
      `wall's ${wall.gained.toFixed(4)} J`,
  ]);
}

// ---------------------------------------------------------------------------
// energy: the elastic term makes a released spring body's energy fall, not rise.
//
// `EnergyMonitor` reads an unforced rise in `mechanicalEnergy` as a bug, and a
// spring body converts stored elastic energy into kinetic and gravitational as
// it springs back - so without the elastic term in the sum, the mechanic itself
// would report as one. Undamped, the total is conserved; damped, it may only
// ever fall, which is what keeps the monitor's one-sided bound valid.
//
// "Conserved" for a symplectic integrator means conserved WITHOUT DRIFT rather
// than constant: semi-implicit Euler holds a shadow Hamiltonian, so the measured
// energy ripples along the orbit by O(w·dt) - 16% at 1.5 Hz on the 1/60 step -
// and does not walk. Both halves are asserted, because the ripple alone would
// pass a term that is simply missing and the drift alone would pass one that is
// wildly mis-scaled.
// ---------------------------------------------------------------------------
function caseEnergy(): SpringResult {
  const details: string[] = [];

  const free = new Spring({ freqX: 1.5, freqY: 1, zeta: 0 });
  free.body.linearVelocity = new Vec2(2, -1.5);
  let lo = Infinity;
  let hi = -Infinity;
  let early = 0;
  let late = 0;
  const WINDOW = 300;
  free.step(1200, (n) => {
    const e = mechanicalEnergy(free.world);
    lo = Math.min(lo, e);
    hi = Math.max(hi, e);
    // Compared as MEANS over 5 s at each end rather than as instants: the
    // ripple is several periods of both axes wide over that window, so it
    // averages out and what is left in the difference is drift.
    if (n <= WINDOW) early += e;
    if (n > 1200 - WINDOW) late += e;
  });
  // Against the SWING rather than against the total: the total is dominated by a
  // gravitational datum measured from y=0, which says nothing about the sim.
  const swing = 0.5 * free.body.mass * (2 ** 2 + 1.5 ** 2);
  const ripple = (hi - lo) / swing;
  const drift = Math.abs(late - early) / WINDOW / swing;
  // The ripple bound is the integrator's, not the mechanic's: w·dt is 0.157 at
  // 1.5 Hz, so 25% leaves room without admitting a term that is simply absent
  // (which reads as a swing-sized excursion, not a fifth of one).
  const conserved = ripple < 0.25 && drift < 0.005;
  details.push(
    `${conserved ? "ok  " : "BAD "} undamped 20 s: energy ripples ${(ripple * 100).toFixed(2)}% ` +
      `of the ${swing.toFixed(2)} J put in (the symplectic O(w·dt), want < 25%) and drifts ` +
      `${(drift * 100).toFixed(4)}% between the first and last 5 s (want < 0.5%)`,
  );

  const damped = new Spring({ freqX: 1.5, freqY: 1, zeta: 0.15 });
  damped.body.linearVelocity = new Vec2(2, -1.5);
  let prev = mechanicalEnergy(damped.world);
  let worstRise = 0;
  damped.step(1200, () => {
    const e = mechanicalEnergy(damped.world);
    worstRise = Math.max(worstRise, e - prev);
    prev = e;
  });
  // A frame may not GAIN energy at all beyond float noise: damping only removes.
  const monotone = worstRise < 1e-9 * swing;
  details.push(
    `${monotone ? "ok  " : "BAD "} damped 20 s: worst single-frame gain ${worstRise.toExponential(2)} J`,
  );

  return ok("energy — the elastic term is in the sum, so springing back is not a gain", conserved && monotone, details);
}

// ---------------------------------------------------------------------------
// authored: the level format's three fields reach the built body, and the
// exclusion with `pivot` is resolved the way it says it is.
//
// Authored state nothing checks is authored state that quietly stops being read:
// a build ignoring `springFreqY` produces a level that looks identical, plays as
// a rigid leaf, and violates no invariant. The control body is what stops this
// passing by nothing being built at all.
// ---------------------------------------------------------------------------
function caseAuthored(): SpringResult {
  const world = new World();
  const rect = { kind: "rect" as const, w: 1.2, h: 0.12 };
  const data = scaleLevelData(
    {
      player: { x: 0, y: 0, radius: 0.08 },
      bodies: [
        {
          kind: "rigid",
          x: 0,
          y: -3,
          rot: 0,
          springFreqX: 1.5,
          springFreqY: 1,
          springDamping: 0.4,
          objects: [{ type: "collision", x: 0, y: 0, rot: 0, shape: rect }],
        },
        // Out of range at both ends: clamped, not trusted.
        {
          kind: "rigid",
          x: 4,
          y: -3,
          rot: 0,
          springFreqX: 99,
          springFreqY: -5,
          springDamping: 7,
          objects: [{ type: "collision", x: 0, y: 0, rot: 0, shape: rect }],
        },
        // Both flags: `pivot` wins and the spring is dropped.
        {
          kind: "rigid",
          x: 8,
          y: -3,
          rot: 0,
          pivot: true,
          springFreqY: 1,
          objects: [{ type: "collision", x: 0, y: 0, rot: 0, shape: rect }],
        },
        // The control: no spring at all, and it must still fall.
        {
          kind: "rigid",
          x: 12,
          y: -3,
          rot: 0,
          objects: [{ type: "collision", x: 0, y: 0, rot: 0, shape: rect }],
        },
      ],
    },
    1,
  );
  const [leaf, clamped, both, control] = buildLevelBodies(world, data, () => {}).bodies.map(
    (b) => b.body,
  ) as RigidBody2D[];

  const s = leaf!.spring;
  const readOk =
    s !== null &&
    Math.abs(s.omegaX - 2 * Math.PI * 1.5) < 1e-12 &&
    Math.abs(s.omegaY - 2 * Math.PI) < 1e-12 &&
    s.zeta === 0.4 &&
    // The anchor is the body's AUTHORED centre of mass - the body itself
    // spawns a droop below it (`applyRestPose`), so the two differ by exactly
    // g/w² on the sprung axis.
    s.anchor.x === leaf!.globalPosition.x &&
    Math.abs(s.anchor.y - (leaf!.globalPosition.y - droopOf(1))) < 1e-12;

  const c = clamped!.spring;
  const clampOk =
    c !== null &&
    Math.abs(c.omegaX - 2 * Math.PI * MAX_SPRING_FREQ) < 1e-12 &&
    c.omegaY === 0 &&
    c.zeta === 1;

  const exclusiveOk = both!.pivot === true && both!.spring === null;

  for (let i = 0; i < 1200; i++) world.integrate(DT);
  const droops = Math.abs(leaf!.globalPosition.y - (-3 + droopOf(1))) < 1e-6;
  const fell = control!.spring === null && control!.globalPosition.y > 0;

  const passed = readOk && clampOk && exclusiveOk && droops && fell;
  return ok("authored — the level fields reach the body, clamped, and exclude pivot", passed, [
    `${readOk ? "ok  " : "BAD "} springFreqX/Y/Damping read as w=(${s?.omegaX.toFixed(4)}, ${s?.omegaY.toFixed(4)}) rad/s, zeta ${s?.zeta}, anchored at the centre of mass`,
    `${clampOk ? "ok  " : "BAD "} 99 Hz clamps to ${MAX_SPRING_FREQ}, -5 Hz to 0 (a pinned axis), damping 7 to 1`,
    `${exclusiveOk ? "ok  " : "BAD "} a body authoring both keeps pivot and drops the spring (pivot=${both!.pivot}, spring=${both!.spring})`,
    `${droops ? "ok  " : "BAD "} and the authored leaf hangs at its g/w² droop after 20 s`,
    `${fell ? "ok  " : "BAD "} a body with neither field still falls (control dropped ${(control!.globalPosition.y + 3).toFixed(2)} m)`,
  ]);
}

// ---------------------------------------------------------------------------
// no-spring: every body without the field integrates exactly as it always did.
//
// The hard requirement of the whole change - every existing level and every
// recorded replay is bit-identical - stated as a case rather than left to the
// bundle corpus alone, so a regression names itself here instead of showing up
// as drift four hundred frames into a recording.
// ---------------------------------------------------------------------------
function caseNoSpring(): SpringResult {
  const world = new World();
  const ground = new StaticBody2D();
  ground.globalPosition = Vec2.ZERO;
  ground.setShape(rectShape(40, 1));
  world.add(ground);
  const b = new RigidBody2D();
  b.globalPosition = new Vec2(0, -3);
  b.setShape(rectShape(0.5, 0.5));
  b.mass = ShapeGeometry.computeMass(b.primaryShape());
  b.inertia = ShapeGeometry.computeMomentOfInertia(b.primaryShape(), b.mass);
  b.contactFriction = RIGID_KINETIC_FRICTION;
  b.staticFriction = RIGID_STATIC_FRICTION;
  b.angularVelocity = 3;
  world.add(b);

  // One frame of free fall, against the closed form the engine had before the
  // spring arm existed: v = g·dt, y = y0 + v·dt, and the spin integrates.
  world.integrate(DT);
  const wantV = G * DT;
  const exact =
    b.spring === null &&
    b.linearVelocity.y === wantV &&
    b.globalPosition.y === -3 + wantV * DT &&
    b.globalRotation === 3 * DT &&
    b.inverseInertia === 1 / b.inertia;
  return ok("no-spring — a body without the field integrates bit-for-bit as before", exact, [
    `${exact ? "ok  " : "BAD "} one frame of free fall: v=${b.linearVelocity.y} (want ${wantV}), ` +
      `y=${b.globalPosition.y}, rot=${b.globalRotation}, inverseInertia=${b.inverseInertia}`,
  ]);
}

// ---------------------------------------------------------------------------
// The PIVOT half of the suite: an off-centre bearing and its torsion return
// spring (`LevelBodyData.pivotX` / `pivotFreq`). It lives here rather than in
// `cli contacts` beside `pivot-body` because, like the linear spring, its whole
// behaviour is arithmetic with a closed form - the droop is the root of
// `I·w²·Δθ = m·g·d·cos(θ)`, the free pendulum's period is `2π·sqrt(I/(m·g·d))`,
// the torsion oscillator's is `1/f` - and every one of those is a number an
// author reasons about while tuning a branch.
// ---------------------------------------------------------------------------

// A branch: a 1.2 m rect hinged at its left end, built through the REAL level
// loader so the case exercises the authored fields, the re-origin onto the
// bearing and the parallel-axis inertia together.
function buildBranch(opts: {
  rot?: number;
  freq?: number;
  damping?: number;
}): { world: World; body: RigidBody2D } {
  const world = new World();
  const data = scaleLevelData(
    {
      player: { x: 0, y: 0, radius: 0.08 },
      bodies: [
        {
          kind: "rigid" as const,
          x: 0,
          y: -3,
          rot: opts.rot ?? 0,
          pivot: true,
          pivotX: -0.6,
          pivotY: 0,
          ...(opts.freq !== undefined ? { pivotFreq: opts.freq } : {}),
          ...(opts.damping !== undefined ? { pivotDamping: opts.damping } : {}),
          objects: [
            {
              type: "collision" as const,
              x: 0,
              y: 0,
              rot: 0,
              shape: { kind: "rect" as const, w: 1.2, h: 0.12 },
            },
          ],
        },
      ],
    },
    1,
  );
  const body = buildLevelBodies(world, data, () => {}).bodies[0]!.body as RigidBody2D;
  return { world, body };
}

// ---------------------------------------------------------------------------
// pivot-droop: a sprung branch settles at exactly the angle its frequency
// implies - the root of `I·w²·Δθ = m·g·d·cos(θ)`, gravity's torque about the
// bearing against the torsion spring's. The one number an author picks the
// frequency BY ("how far does this branch sag on its own"), asserted at three
// frequencies; the axle is asserted at === 0 drift, because the bearing is held
// by `inverseMass` 0 rather than by a solve, and "small" would be the bug.
// ---------------------------------------------------------------------------
function casePivotDroop(): SpringResult {
  const details: string[] = [];
  let passed = true;
  for (const f of [0.5, 1, 2]) {
    const { world, body } = buildBranch({ freq: f, damping: 0.5 });
    const axle0 = body.globalPosition;
    for (let i = 0; i < 2400; i++) world.integrate(DT);
    const w = 2 * Math.PI * f;
    const d = body.pivotComOffset.length();
    // The equilibrium is transcendental, so the expectation is bisected from
    // the same statement the sim integrates rather than linearised.
    let lo = 0;
    let hi = Math.PI / 2;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (body.inertia * w * w * mid - body.mass * G * d * Math.cos(mid) < 0) lo = mid;
      else hi = mid;
    }
    const err = Math.abs(body.globalRotation - lo);
    const axleDrift = body.globalPosition.sub(axle0).length();
    const good = err < 1e-9 && axleDrift === 0;
    passed &&= good;
    details.push(
      `${good ? "ok  " : "BAD "} f=${f} Hz: droop ${((body.globalRotation * 180) / Math.PI).toFixed(3)}° ` +
        `(want ${((lo * 180) / Math.PI).toFixed(3)}°, err ${err.toExponential(1)} rad), axle drift ${axleDrift}`,
    );
  }
  return ok("pivot-droop — a sprung branch settles where its frequency says", passed, details);
}

// ---------------------------------------------------------------------------
// pivot-pendulum: a FREE off-centre bearing is a physical pendulum. Small
// oscillations about hanging must run at `2π·sqrt(I/(m·g·d))` - which is only
// true if the build put the origin at the bearing, the inertia carries the
// parallel-axis term AND gravity's torque reads the swung centre of mass - and
// `mechanicalEnergy` over the swing must be flat, which is what pins the
// energy accounting to the centre of mass rather than to the origin (a bearing
// origin never moves, so PE read off it turns the whole KE↔PE exchange into an
// unforced gain `EnergyMonitor` would fire on).
// ---------------------------------------------------------------------------
function casePivotPendulum(): SpringResult {
  // A free bearing SPAWNS hanging (`applyRestPose`), so the swing is started
  // by displacing the built body 0.05 rad off its equilibrium - the case is
  // about the dynamics, and the spawn pose is `spawn-at-rest`'s to assert.
  const { world, body } = buildBranch({});
  body.globalRotation = Math.PI / 2 - 0.05;
  const axle0 = body.globalPosition;
  const d = body.pivotComOffset.length();
  const want = 2 * Math.PI * Math.sqrt(body.inertia / (body.mass * G * d));
  let last = body.globalRotation - Math.PI / 2;
  const crossings: number[] = [];
  const e0 = mechanicalEnergy(world);
  let eMin = e0;
  let eMax = e0;
  for (let i = 0; i < 1200; i++) {
    world.integrate(DT);
    const cur = body.globalRotation - Math.PI / 2;
    if (last < 0 !== cur < 0) crossings.push(i * DT);
    last = cur;
    const e = mechanicalEnergy(world);
    eMin = Math.min(eMin, e);
    eMax = Math.max(eMax, e);
  }
  const got =
    crossings.length > 2
      ? (2 * (crossings[crossings.length - 1]! - crossings[0]!)) / (crossings.length - 1)
      : NaN;
  const periodOk = Math.abs(got - want) < 0.005;
  const axleOk = body.globalPosition.sub(axle0).length() === 0;
  // The KE↔PE exchange itself is ~0.15 J at this amplitude; the integrator's
  // residual is measured at 8.6e-3 J over 20 s, so 0.05 is a bound with room
  // that still fails outright if PE is read off the origin (spread = the whole
  // exchange).
  const energyOk = eMax - eMin < 0.05;
  const passed = periodOk && axleOk && energyOk;
  return ok("pivot-pendulum — a free off-centre bearing swings at 2π·sqrt(I/mgd)", passed, [
    `${periodOk ? "ok  " : "BAD "} period ${got.toFixed(4)} s (want ${want.toFixed(4)})`,
    `${axleOk ? "ok  " : "BAD "} axle drift over 1200 frames: ${body.globalPosition.sub(axle0).length()}`,
    `${energyOk ? "ok  " : "BAD "} mechanicalEnergy spread ${(eMax - eMin).toExponential(1)} J over the swing (PE reads the centre of mass, not the bearing)`,
  ]);
}

// ---------------------------------------------------------------------------
// pivot-period: the torsion spring on its own - a bearing AT the centre of
// mass, so gravity has no leverage and the oscillator is pure. Undamped it must
// run at `1/f` with `mechanicalEnergy` flat (the elastic term `0.5·I·w²·Δθ²`,
// without which the swing reads as energy flickering in and out of existence),
// and damped it must overshoot its rest angle and then settle back onto it.
// ---------------------------------------------------------------------------
function casePivotPeriod(): SpringResult {
  const details: string[] = [];
  const mk = (zeta: number): { world: World; body: RigidBody2D } => {
    const world = new World();
    const b = new RigidBody2D();
    b.setShape(rectShape(1.2, 0.12));
    b.mass = ShapeGeometry.computeMass(b.primaryShape());
    b.inertia = ShapeGeometry.computeMomentOfInertia(b.primaryShape(), b.mass);
    b.pivot = true;
    b.globalPosition = new Vec2(0, -3);
    b.pivotSpring = { restAngle: 0, omega: 2 * Math.PI * 1.5, zeta };
    b.globalRotation = 0.3;
    world.add(b);
    return { world, body: b };
  };

  const free = mk(0);
  let last = free.body.globalRotation;
  const crossings: number[] = [];
  const e0 = mechanicalEnergy(free.world);
  let eMin = e0;
  let eMax = e0;
  const samples: number[] = [];
  for (let i = 0; i < 1200; i++) {
    free.world.integrate(DT);
    if (last < 0 !== free.body.globalRotation < 0) crossings.push(i * DT);
    last = free.body.globalRotation;
    const e = mechanicalEnergy(free.world);
    samples.push(e);
    eMin = Math.min(eMin, e);
    eMax = Math.max(eMax, e);
  }
  const got = (2 * (crossings[crossings.length - 1]! - crossings[0]!)) / (crossings.length - 1);
  const periodOk = Math.abs(got - 1 / 1.5) < 0.005;
  // Symplectic Euler's energy RIPPLES within a period (O(w·dt), the same bound
  // `energy` accepts for the linear spring) and must not DRIFT. The elastic
  // term missing is not a ripple: the spread becomes the whole exchanged
  // 0.5·I·w²·θ0², 100%, and the case is red.
  const exchanged = 0.5 * free.body.inertia * free.body.pivotSpring!.omega ** 2 * 0.3 * 0.3;
  const ripple = (eMax - eMin) / exchanged;
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const drift =
    Math.abs(mean(samples.slice(-300)) - mean(samples.slice(0, 300))) / exchanged;
  const energyOk = ripple < 0.3 && drift < 0.005;
  details.push(`${periodOk ? "ok  " : "BAD "} undamped period ${got.toFixed(4)} s (want ${(1 / 1.5).toFixed(4)})`);
  details.push(
    `${energyOk ? "ok  " : "BAD "} undamped 20 s: energy ripples ${(ripple * 100).toFixed(2)}% of the ${exchanged.toFixed(2)} J exchanged (symplectic O(w·dt), want < 30%) and drifts ${(drift * 100).toFixed(4)}% (want < 0.5%; the elastic term missing reads as 100% ripple)`,
  );

  const damped = mk(0.15);
  let overshot = false;
  for (let i = 0; i < 1200; i++) {
    damped.world.integrate(DT);
    if (damped.body.globalRotation < 0) overshot = true;
  }
  const settled = Math.abs(damped.body.globalRotation) < 1e-6 && Math.abs(damped.body.angularVelocity) < 1e-6;
  details.push(
    `${overshot ? "ok  " : "BAD "} underdamped release overshoots the rest angle (the visible spring-back)`,
  );
  details.push(
    `${settled ? "ok  " : "BAD "} and settles back onto it: Δθ ${damped.body.globalRotation.toExponential(1)}, ω ${damped.body.angularVelocity.toExponential(1)}`,
  );
  return ok("pivot-period — the torsion oscillator runs at 1/f and returns", periodOk && energyOk && overshot && settled, details);
}

// ---------------------------------------------------------------------------
// pivot-authored: the fields reach the body through the loader, and what they
// build is checkable - the origin IS the authored bearing, the kept
// centre-of-mass offset points back at the pieces, the inertia carries the
// parallel-axis term, the frequency clamps, the point scales as a length while
// the frequency does not, and a plain centre-of-mass pivot is left BIT-FOR-BIT
// what it always was, which is the hard requirement of the whole change.
// ---------------------------------------------------------------------------
function casePivotAuthored(): SpringResult {
  const world = new World();
  const rect = { kind: "rect" as const, w: 1.2, h: 0.12 };
  const raw = {
    player: { x: 0, y: 0, radius: 0.08 },
    bodies: [
      {
        kind: "rigid" as const,
        x: 0,
        y: -3,
        rot: 0,
        pivot: true,
        pivotX: -0.6,
        pivotY: 0,
        pivotFreq: 99,
        objects: [{ type: "collision" as const, x: 0, y: 0, rot: 0, shape: rect }],
      },
      // The control: a plain pivot, no point and no spring - the windmill every
      // recorded replay contains.
      {
        kind: "rigid" as const,
        x: 4,
        y: -3,
        rot: 0,
        pivot: true,
        objects: [{ type: "collision" as const, x: 0, y: 0, rot: 0, shape: rect }],
      },
    ],
  };
  const data = scaleLevelData(raw, 1);
  const [branch, windmill] = buildLevelBodies(world, data, () => {}).bodies.map(
    (b) => b.body,
  ) as RigidBody2D[];

  const comI =
    ShapeGeometry.computeMomentOfInertia(branch!.primaryShape(), branch!.mass) ;
  const originOk =
    branch!.globalPosition.x === -0.6 &&
    branch!.globalPosition.y === -3 &&
    branch!.pivotComOffset.x === 0.6 &&
    branch!.pivotComOffset.y === 0;
  const inertiaOk = Math.abs(branch!.inertia - (comI + branch!.mass * 0.36)) < 1e-12;
  const s = branch!.pivotSpring;
  const clampOk =
    s !== null && s.omega === 2 * Math.PI * MAX_SPRING_FREQ && s.zeta === DEFAULT_SPRING_DAMPING && s.restAngle === 0;

  // The length/rate split, asserted on the DATA rather than the build: a
  // bearing left in pixels is a branch hinged a hundred times too far out.
  const scaled = scaleLevelData(raw, 0.5).bodies[0]!;
  const scaleOk =
    scaled.pivotX === -0.3 && scaled.pivotY === 0 && scaled.pivotFreq === 99 &&
    scaled.pivotDamping === undefined;

  // The control integrates exactly as every pivot always has: no gravity, no
  // torque from nowhere, the spin it is given is the spin it keeps.
  windmill!.angularVelocity = 3;
  const w0 = windmill!.globalPosition;
  world.integrate(DT);
  const exact =
    windmill!.pivotComOffset.x === 0 &&
    windmill!.pivotComOffset.y === 0 &&
    windmill!.pivotSpring === null &&
    windmill!.angularVelocity === 3 &&
    windmill!.globalRotation === 3 * DT &&
    windmill!.globalPosition.sub(w0).length() === 0;

  // The editor rewrites the whole file every 750 ms, so a field it does not
  // carry is gone from disk before anyone notices it was read - the round trip
  // is asserted here because the camera suite's round-trip cases compare
  // camera fields alone.
  const rt = modelToDisk(
    modelFromDisk({
      player: { x: 0, y: 0, radius: 8 },
      bodies: [
        {
          kind: "rigid" as const,
          x: 0,
          y: -300,
          rot: 0,
          pivot: true,
          pivotX: -50,
          pivotY: 25,
          pivotFreq: 1.25,
          pivotDamping: 0.4,
          objects: [
            {
              type: "collision" as const,
              x: 0,
              y: 0,
              rot: 0,
              shape: { kind: "rect" as const, w: 120, h: 12 },
            },
          ],
        },
      ],
    }),
  ).bodies[0]!;
  const roundTripOk =
    rt.pivot === true &&
    rt.pivotX === -50 &&
    rt.pivotY === 25 &&
    rt.pivotFreq === 1.25 &&
    rt.pivotDamping === 0.4;

  const passed = originOk && inertiaOk && clampOk && scaleOk && roundTripOk && exact;
  return ok("pivot-authored — the bearing fields reach the body, scaled and clamped", passed, [
    `${roundTripOk ? "ok  " : "BAD "} the editor's modelFromDisk/modelToDisk carries all four fields (got pivotX=${rt.pivotX}, pivotY=${rt.pivotY}, freq=${rt.pivotFreq}, damping=${rt.pivotDamping})`,
    `${originOk ? "ok  " : "BAD "} origin at the authored bearing (-0.6, -3), centre of mass kept at local (0.6, 0)`,
    `${inertiaOk ? "ok  " : "BAD "} inertia ${branch!.inertia.toFixed(6)} = I_com + m·d² (${(comI + branch!.mass * 0.36).toFixed(6)})`,
    `${clampOk ? "ok  " : "BAD "} 99 Hz clamps to ${MAX_SPRING_FREQ}, damping defaults to ${DEFAULT_SPRING_DAMPING}, rest angle is the built rotation`,
    `${scaleOk ? "ok  " : "BAD "} the point is a length and scales; the frequency is a rate and does not`,
    `${exact ? "ok  " : "BAD "} a plain centre-of-mass pivot integrates bit-for-bit as before`,
  ]);
}

// ---------------------------------------------------------------------------
// spawn-at-rest: a sprung body SPAWNS at the rest pose the suite's other cases
// prove it settles to, so a level does not open with its leaves and branches
// visibly falling into place (`applyRestPose`). Asserted at frame ZERO against
// the closed forms, then over 300 frames as near-zero movement - the vine
// suite's "a span spawns at rest" statement, made for spring and pivot bodies.
// The controls are the other half: a centre-of-mass pivot and a plain rigid
// body spawn EXACTLY at their authored pose, which is the bit-identity rule.
//
// The chain clause covers the piece nothing else can see: an anchor on a
// sprung body must ride the settle (`anchorWorldPoint` resolves the material
// point through the authored frame), so a taut chain's derived length is the
// distance between the anchors AS THEY LAND - measured against the authored
// pose instead, the chain spawns slack by the droop and yanks on frame one.
//
// The ghost clause is the editor's half of the same statement: `settledGhosts`
// reads its displacement off this very build, and the case pins the ghost to
// the same closed forms, plus that the controls produce no ghost at all.
// ---------------------------------------------------------------------------
function caseSpawnAtRest(): SpringResult {
  const rect = { kind: "rect" as const, w: 1.2, h: 0.12 };
  const px = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      // The chain's ground end, with its anchor on the top face.
      {
        kind: "static" as const,
        x: 0,
        y: 0,
        rot: 0,
        objects: [
          { type: "collision" as const, x: 0, y: 0, rot: 0, shape: { kind: "rect" as const, w: 400, h: 100 } },
          { type: "anchor" as const, id: 1, x: 0, y: -50 },
        ],
      },
      // The leaf: sprung at 1 Hz vertically, with the chain's other anchor on
      // its top edge.
      {
        kind: "rigid" as const,
        x: 0,
        y: -300,
        rot: 0,
        springFreqX: 1.5,
        springFreqY: 1,
        springDamping: 0.4,
        objects: [
          { type: "collision" as const, x: 0, y: 0, rot: 0, shape: { kind: "rect" as const, w: 120, h: 12 } },
          { type: "anchor" as const, id: 2, x: 0, y: -6 },
        ],
      },
      // The branch: hinged at its left end with a torsion spring.
      {
        kind: "rigid" as const,
        x: 400,
        y: -300,
        rot: 0,
        pivot: true,
        pivotX: -60,
        pivotY: 0,
        pivotFreq: 1,
        pivotDamping: 0.5,
        objects: [{ type: "collision" as const, x: 0, y: 0, rot: 0, shape: rect }],
      },
      // The pendulum: the same hinge, free - it hangs.
      {
        kind: "rigid" as const,
        x: 800,
        y: -300,
        rot: 0,
        pivot: true,
        pivotX: -60,
        pivotY: 0,
        objects: [{ type: "collision" as const, x: 0, y: 0, rot: 0, shape: rect }],
      },
      // The controls: a centre-of-mass pivot and a plain rigid body.
      {
        kind: "rigid" as const,
        x: 1200,
        y: -300,
        rot: 0,
        pivot: true,
        objects: [{ type: "collision" as const, x: 0, y: 0, rot: 0, shape: rect }],
      },
      {
        kind: "rigid" as const,
        x: 1600,
        y: -300,
        rot: 0,
        objects: [{ type: "collision" as const, x: 0, y: 0, rot: 0, shape: rect }],
      },
    ],
    chains: [{ a: 1, b: 2 }],
  };
  const data = scaleLevelData(px, PX_FACTOR);
  const world = new World();
  const built = buildLevelBodies(world, data, () => {});
  const [, leaf, branch, pendulum, windmill, free] = built.bodies.map((b) => b.body) as [
    unknown,
    RigidBody2D,
    RigidBody2D,
    RigidBody2D,
    RigidBody2D,
    RigidBody2D,
  ];

  const droop = droopOf(1);
  const leafAt0 =
    leaf.globalPosition.x === 0 && Math.abs(leaf.globalPosition.y - (-3 + droop)) < 1e-12;

  // The branch's settled angle, bisected independently of the build's own
  // arithmetic (the same statement `pivot-droop` makes about the sim).
  const w = 2 * Math.PI;
  const d = branch.pivotComOffset.length();
  let lo = 0;
  let hi = Math.PI / 2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (branch.inertia * w * w * mid - branch.mass * G * d * Math.cos(mid) < 0) lo = mid;
    else hi = mid;
  }
  const branchAt0 = Math.abs(branch.globalRotation - lo) < 1e-9;
  const pendulumAt0 = Math.abs(pendulum.globalRotation - Math.PI / 2) < 1e-12;
  const controlsAt0 =
    windmill.globalRotation === 0 &&
    windmill.globalPosition.x === 12 &&
    windmill.globalPosition.y === -3 &&
    free.globalPosition.x === 16 &&
    free.globalPosition.y === -3;

  // The chain went taut between the anchors as they LAND: static top face to
  // the leaf's settled top edge.
  const chains = buildSceneChains(data, built);
  const settledDist = Math.abs(-0.5 - (-3.06 + droop));
  const authoredDist = Math.abs(-0.5 - -3.06);
  const chainLen = chains[0]?.rope.maxRopeLength ?? NaN;
  const chainOk =
    Math.abs(chainLen - settledDist) < 1e-9 && Math.abs(chainLen - authoredDist) > 0.2;

  // 5 s untouched: a body spawned at its rest pose has nothing to settle.
  const before = [leaf, branch, pendulum].map((b) => ({
    p: b.globalPosition,
    r: b.globalRotation,
  }));
  let moved = 0;
  for (let i = 0; i < 300; i++) {
    world.integrate(DT);
    for (let k = 0; k < before.length; k++) {
      const b = [leaf, branch, pendulum][k]!;
      moved = Math.max(
        moved,
        b.globalPosition.sub(before[k]!.p).length(),
        Math.abs(b.globalRotation - before[k]!.r),
      );
    }
  }
  const stillOk = moved < 1e-9;

  // The editor's ghost reads the same displacements off the same build, and
  // reads NOTHING off the controls.
  const ghosts = settledGhosts(modelFromDisk(px));
  const ghostLeaf = ghosts.find((g) => Math.abs(g.dpos.y - droop) < 1e-12 && g.drot === 0);
  const ghostBranch = ghosts.find((g) => Math.abs(g.drot - lo) < 1e-9);
  const ghostPendulum = ghosts.find((g) => Math.abs(g.drot - Math.PI / 2) < 1e-12);
  const ghostOk = ghosts.length === 3 && !!ghostLeaf && !!ghostBranch && !!ghostPendulum;

  const passed = leafAt0 && branchAt0 && pendulumAt0 && controlsAt0 && chainOk && stillOk && ghostOk;
  return ok("spawn-at-rest — sprung bodies open the level already settled", passed, [
    `${leafAt0 ? "ok  " : "BAD "} the leaf spawns at its g/w² droop (y=${leaf.globalPosition.y.toFixed(6)}, want ${(-3 + droop).toFixed(6)})`,
    `${branchAt0 ? "ok  " : "BAD "} the branch spawns at its settled angle (${branch.globalRotation.toFixed(6)}, want ${lo.toFixed(6)})`,
    `${pendulumAt0 ? "ok  " : "BAD "} the free pendulum spawns hanging (${pendulum.globalRotation.toFixed(6)}, want ${(Math.PI / 2).toFixed(6)})`,
    `${controlsAt0 ? "ok  " : "BAD "} a centre-of-mass pivot and a plain rigid spawn exactly as authored`,
    `${chainOk ? "ok  " : "BAD "} a taut chain measures its length between the anchors as they land (${chainLen.toFixed(4)}, settled ${settledDist.toFixed(4)}, authored ${authoredDist.toFixed(4)})`,
    `${stillOk ? "ok  " : "BAD "} 300 untouched frames move the settled bodies ${moved.toExponential(1)} (want < 1e-9)`,
    `${ghostOk ? "ok  " : "BAD "} the editor's ghosts read the same three displacements and nothing for the controls (${ghosts.length} ghosts)`,
  ]);
}

// ---------------------------------------------------------------------------
// winch-load: a wind-up bears DOWN on the sprung body it hangs from.
//
// The ball's spin-share rollback (`BallLevel`, session-265f) undoes the chain
// solve's motion of every free body the winch's kinematic spin would otherwise
// export momentum to. Its premise - "the unwind is about to refuse the spin,
// and the anchor keeps whatever it was given" - fails on both halves for a
// SPRUNG anchor under a hanging ball: the winch genuinely hauls (the spin is
// paid for by the ball rising, nothing is refused), and a spring answers every
// displacement rather than keeping it. Rolled back anyway, the branch carries
// nothing for exactly as long as the winch works, so a ball winding itself up
// a chain pulled the pivoting log UP past its unloaded rest angle while
// hanging off it (session-454f).
//
// So each rig here is the same scene twice over one question: hook a hanging
// ball to a sprung body, load it, then wind up - and the body must go on
// carrying the load. Asserted against the body's own measured LOADED
// deflection, not a closed form, because during a haul the tension exceeds the
// static weight and the exact trajectory is the solve's; what must never
// happen is the deflection collapsing back to (or past) the unloaded rest pose
// while the ball still hangs below the mount.
// ---------------------------------------------------------------------------
function caseWinchLoad(): SpringResult {
  const details: string[] = [];
  let passed = true;
  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  // Drive one rig: fire at `aimPx` (scene px), hold 240 frames, then wind the
  // aim a full turn per 4 s for 600 frames. `deflection` reads the sprung
  // body's displacement in its droop direction (positive = loaded further).
  const run = (
    label: string,
    data: RawLevelData,
    body: (level: BallLevel) => RigidBody2D,
    deflection: (b: RigidBody2D) => number,
  ): void => {
    const level = new BallLevel(data);
    const target = body(level);
    let prev = emptyFrameInput();
    const feed = (fire: boolean, aim: Vec2): void => {
      const input: FrameInput = {
        ...emptyFrameInput(),
        fire: button(fire, prev.fire),
        mouseWorldPosition: aim,
      };
      prev = input;
      level.physicsProcess(input, DT);
    };

    // Spawn IS the rest pose (spawn-at-rest), so the unloaded datum is frame 0.
    const rest = deflection(target);
    const aimAt = target.globalPosition.add(
      target.pivotComOffset.rotated(target.globalRotation),
    );
    for (let f = 0; f < 240; f++) feed(true, aimAt);
    check(
      `${label}: the chain is anchored to the sprung body`,
      level.ball.chain?.end.contact.obj === target,
    );
    const loaded = deflection(target) - rest;
    check(
      `${label}: hanging off it deflects it ${loaded.toFixed(3)} in the droop direction`,
      loaded > 0.05,
    );

    // Wind, at a hand's pace (a full turn per 6 s). The first 60 frames are
    // the transient of the haul biting; after that, every frame the ball
    // still hangs a chain's length below the mount is a frame the body must
    // carry it. The window ends when the ball closes to within a metre: from
    // there the chain is short enough that a swing's tension direction whips
    // right round per orbit (and past it, the ball presses INTO the body by
    // contact) - different regimes with their own police.
    const start = level.ball.loopDirection.angle();
    const startGap = level.ball.globalPosition.distanceTo(aimAt);
    let closest = startGap;
    let held = 0;
    let worst = Infinity;
    let sum = 0;
    let wound = 0;
    for (wound = 0; wound < 900; wound++) {
      const angle = start + (wound / 360) * Math.PI * 2;
      const aim = level.ball.globalPosition.add(
        new Vec2(Math.cos(angle), Math.sin(angle)).mul(2),
      );
      feed(true, aim);
      const gap = level.ball.globalPosition.distanceTo(aimAt);
      closest = Math.min(closest, gap);
      if (gap < 1.0) break;
      const anchored = level.ball.chain?.end.contact.obj === target;
      const below = level.ball.globalPosition.y > target.globalPosition.y;
      if (wound >= 60 && anchored && below) {
        held++;
        worst = Math.min(worst, deflection(target) - rest);
        sum += deflection(target) - rest;
      }
    }
    check(
      `${label}: the wind-up hauled the ball in (${closest.toFixed(2)} m of ${startGap.toFixed(2)})`,
      closest < startGap * 0.8,
    );
    check(`${label}: the ball hung below the mount for ${held} wind frames (need 150)`, held >= 150);
    // A swing transient may momentarily unload the body; standing at (or
    // sprung past) the unloaded rest pose while the ball hangs may not.
    check(
      `${label}: it never sprang past its rest pose while the ball hung (worst ${worst.toFixed(3)}, tol -0.06)`,
      worst >= -0.06,
    );
    check(
      `${label}: and carried the load on average (mean ${(sum / Math.max(1, held)).toFixed(3)} of ${loaded.toFixed(3)} loaded, floor ${(0.3 * loaded).toFixed(3)})`,
      sum / Math.max(1, held) >= 0.3 * loaded,
    );

    // The wound-tight endgame: keep winding for 300 more frames with the ball
    // riding right at the body. This is the regime where session-1010f's log
    // was pumped to -4 rad/s with the ball surfing its tip at 13 m/s and
    // flinging off on release - a phantom weight impulse applied while the
    // CONTACT was already carrying the ball, aimed along a line that rotates
    // with the wound-up orbit. Nothing here may run away: the body's droop
    // rate stays at spring-swing scale and the ball is never flung.
    let bodyRate = 0;
    let ballPeak = 0;
    let prevDefl = deflection(target);
    for (let f = 0; f < 600; f++) {
      // A hand whipping the cursor round (a turn per 1.5 s), which is the
      // recorded session's pace, not the measured window's gentle one.
      const angle = start + (wound / 360 + f / 90) * Math.PI * 2;
      const aim = level.ball.globalPosition.add(
        new Vec2(Math.cos(angle), Math.sin(angle)).mul(2),
      );
      feed(true, aim);
      const d = deflection(target);
      bodyRate = Math.max(bodyRate, Math.abs(d - prevDefl) * 60);
      prevDefl = d;
      ballPeak = Math.max(ballPeak, level.ball.linearVelocity.length());
    }
    check(
      `${label}: wound tight and still winding, the body is never whipped (peak ${bodyRate.toFixed(2)}/s, bar 2.5)`,
      bodyRate < 2.5,
    );
    check(
      `${label}: and the ball is never flung (peak ${ballPeak.toFixed(1)} m/s, bar 8)`,
      ballPeak < 8,
    );
  };

  // Rig 1: the pivoting log - a 3 m bough hinged at its left end with a
  // torsion return spring, the ball hung from its underside. Deflection is the
  // hinge angle, signed toward droop (rotation is unwrapped, so a plain
  // difference is exact).
  const logPx: RawLevelData = {
    player: { x: 60, y: -150, radius: 12 },
    bodies: [
      {
        kind: "rigid",
        x: 0,
        y: -400,
        rot: 0,
        pivot: true,
        pivotX: -140,
        pivotFreq: 0.5,
        pivotDamping: 0.15,
        objects: [
          { type: "collision", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 300, h: 24 } },
        ],
      },
    ],
  };
  {
    const level0 = new BallLevel(logPx);
    const log = level0.bodies.find(
      (b): b is RigidBody2D => b instanceof RigidBody2D && b.pivotSpring !== null,
    )!;
    // The droop direction: where gravity takes the hinge from its rest angle.
    // Read off the spawn (settled) pose against the authored angle 0.
    const droopSign = Math.sign(log.globalRotation - 0) || -1;
    run(
      "log",
      logPx,
      (lvl) =>
        lvl.bodies.find(
          (b): b is RigidBody2D => b instanceof RigidBody2D && b.pivotSpring !== null,
        )!,
      (b) => droopSign * b.globalRotation,
    );
  }

  // Rig 2: the spring leaf - sprung vertically at 1 Hz, x pinned. Deflection
  // is how far below its rest height it hangs (+y is down).
  const leafPx: RawLevelData = {
    // Within CHAIN_MAX_LENGTH (1.8 m) of the leaf's settled height.
    player: { x: 20, y: -150, radius: 12 },
    bodies: [
      // Heavy and well damped on purpose: the case is about the LOAD standing,
      // so the rig must settle rather than ring - a light leaf under a 52 kg
      // ball is a pumped oscillator and its swings are not the question here.
      {
        kind: "rigid",
        x: 0,
        y: -300,
        rot: 0,
        springFreqY: 1,
        springDamping: 0.5,
        objects: [
          { type: "collision", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 200, h: 30 } },
        ],
      },
    ],
  };
  run(
    "leaf",
    leafPx,
    (lvl) => lvl.bodies.find((b): b is RigidBody2D => b instanceof RigidBody2D && b.spring !== null)!,
    (b) => b.globalPosition.y,
  );

  return ok("winch-load — a wind-up bears down on the sprung body it hangs from", passed, details);
}

export function runSpringCases(): SpringResult[] {
  return [
    caseDroop(),
    caseLoadRelease(),
    caseAxes(),
    caseLockedAxis(),
    caseRotationLock(),
    caseContactLoad(),
    caseChainLoad(),
    caseChainDrain(),
    caseEnergy(),
    caseAuthored(),
    caseNoSpring(),
    casePivotDroop(),
    casePivotPendulum(),
    casePivotPeriod(),
    casePivotAuthored(),
    caseSpawnAtRest(),
    caseWinchLoad(),
  ];
}
