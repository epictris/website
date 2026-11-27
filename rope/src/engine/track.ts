// Track mounting: a rigid body that rides an authored curve with ONE freedom,
// the arc length along it - a minecart on its rails (docs/minecarts.md).
//
// The textbook statement is the bead on a wire, in reduced coordinates, and it
// is the one this engine already makes twice: a `pivot` is a rigid body with
// translation taken away at the source (`inverseMass` 0) and a `spring` body
// one with rotation taken away (`inverseInertia` 0). A track body keeps
// neither as a freedom of its own. Its pose is a FUNCTION of `s`:
//
//   - the two wheelsets stand on the curve half a wheelbase either side of
//     `s` (`front = P(s + b)`, `rear = P(s - b)`);
//   - the body turns with the chord between them, plus the angle it was built
//     at against that chord;
//   - its origin is carried in the chord's frame from the chord's midpoint.
//
// So it cannot tip, lift or leave the line: there is no coordinate in which it
// could. Over a crest or into a bend the chord is what pitches the body, which
// is what a two-axle cart does and what keeps the body's angle continuous
// across the polyline's kinks (a single point's tangent would turn in a step).
//
// The DYNAMICS are reduced the same way. A point `r` from the origin moves at
// `u(r) * v` per unit of track speed `v = ds/dt`, where
//
//   u(r) = T + kappa * perp(r)        T = d(origin)/ds,  kappa = d(theta)/ds
//
// and the body's kinetic energy is `M v^2 / 2` with the generalised mass
// `M = m |T|^2 + I kappa^2`. An impulse `J` at arm `r` therefore changes the
// track speed by `(u(r) . J) / M` and nothing else - the rail takes the rest,
// which is what a rail is for - and the effective inverse mass of a row along
// unit `n` at `r` is `(u(r) . n)^2 / M`. That is the whole of what a solver
// site needs to treat a track body exactly (`trackResponse`, `applyTrackImpulse`);
// the site keeps its own arithmetic for every other body, so the static path
// and every recorded replay never see this file.
//
// What the rest of the engine writes freely - an area's current, the island's
// once-a-frame damping, a positional push-out - lands in `linearVelocity`,
// `angularVelocity`, `globalPosition` and `globalRotation` like any body's,
// and `absorb` folds it back onto the line: the change is projected onto the
// one freedom by kinetic-energy weight (the mass-weighted least-squares
// projection, the constraint impulse that removes the rest doing no work) and
// the pose is written from `s` again. Off-line motion is never integrated, it
// is only ever the part the rail refuses.

import { Vec2 } from "./vec2";

// A step for the pose's derivatives, metres of arc length. Small against any
// bend a track is drawn with (the polyline is flattened at 25 cm) and large
// against the double rounding of a pose a few hundred metres from the origin.
const DS = 1e-3;

// The authored line, as the flattened polyline in world metres. Past either
// end the line runs on along its end segment, so a cart whose wheelsets
// straddle an end still has a pose; leaving the line is the spawner's to
// answer (the cart is removed), not the pose's.
export class TrackCurve {
  readonly points: readonly Vec2[];
  // Arc length at each point.
  readonly cumulative: readonly number[];
  readonly length: number;

  constructor(points: readonly Vec2[]) {
    if (points.length < 2) throw new Error("a track needs at least two points");
    this.points = points;
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1]! + points[i]!.distanceTo(points[i - 1]!));
    this.cumulative = cum;
    this.length = cum[cum.length - 1]!;
  }

  // The segment holding `s` (the first or last for `s` off either end).
  private segmentAt(s: number): number {
    const cum = this.cumulative;
    const last = cum.length - 2;
    if (s <= 0) return 0;
    if (s >= this.length) return last;
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid]! <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  pointAt(s: number): Vec2 {
    const i = this.segmentAt(s);
    const a = this.points[i]!;
    const b = this.points[i + 1]!;
    const len = this.cumulative[i + 1]! - this.cumulative[i]!;
    if (len <= 0) return a;
    return a.add(b.sub(a).mul((s - this.cumulative[i]!) / len));
  }

  // Unit direction of the line at `s` (the segment's own).
  directionAt(s: number): Vec2 {
    const i = this.segmentAt(s);
    const d = this.points[i + 1]!.sub(this.points[i]!);
    const len = d.length();
    return len > 0 ? d.div(len) : Vec2.RIGHT;
  }
}

export interface TrackPose {
  position: Vec2;
  rotation: number;
}

// The pose and the dynamics of one body on one curve. Owned by the body
// (`RigidBody2D.track`); everything it writes, it writes to that body.
export class TrackMount {
  // Arc length of the chord's midpoint, metres.
  s: number;
  // The derivatives at `s` (see the file comment), refreshed with the pose.
  tangent: Vec2 = Vec2.RIGHT;
  kappa = 0;
  genMass = 1;
  // The pose and velocity last written, so `absorb` can tell what changed.
  private writtenPosition: Vec2 = Vec2.ZERO;
  private writtenRotation = 0;

  constructor(
    readonly curve: TrackCurve,
    s: number,
    // Half the distance between the wheelsets along the line, metres.
    readonly halfBase: number,
    // The body's origin in the chord's frame, from the chord's midpoint.
    readonly originLocal: Vec2,
    // The body's rotation less the chord's.
    readonly rotationOffset: number,
    readonly mass: number,
    readonly inertia: number,
  ) {
    this.s = s;
  }

  // Where the wheelsets stand at `s`.
  wheelPoints(s: number = this.s): { front: Vec2; rear: Vec2 } {
    return { front: this.curve.pointAt(s + this.halfBase), rear: this.curve.pointAt(s - this.halfBase) };
  }

  poseAt(s: number): TrackPose {
    const { front, rear } = this.wheelPoints(s);
    const chord = front.sub(rear);
    const angle = chord.lengthSquared() > 0 ? chord.angle() : this.curve.directionAt(s).angle();
    const mid = front.add(rear).mul(0.5);
    return { position: mid.add(this.originLocal.rotated(angle)), rotation: angle + this.rotationOffset };
  }

  // The derivatives at the current `s`, by central differences of the pose.
  // The angle's difference is unwrapped, so a line running through +-pi has a
  // curvature rather than a 2pi spike.
  private refresh(): TrackPose {
    const here = this.poseAt(this.s);
    const ahead = this.poseAt(this.s + DS);
    const behind = this.poseAt(this.s - DS);
    this.tangent = ahead.position.sub(behind.position).div(2 * DS);
    let dTheta = ahead.rotation - behind.rotation;
    const TAU = 6.283185307179586;
    if (dTheta > TAU / 2) dTheta -= TAU;
    else if (dTheta < -TAU / 2) dTheta += TAU;
    this.kappa = dTheta / (2 * DS);
    this.genMass = this.mass * this.tangent.lengthSquared() + this.inertia * this.kappa * this.kappa;
    return here;
  }

  // The generalised force of impulse `j` at arm `r` (from the body's origin):
  // `u(r) . j`.
  along(j: Vec2, r: Vec2): number {
    return this.tangent.dot(j) + this.kappa * r.cross(j);
  }

  // The track speed a velocity state projects to, by kinetic-energy weight.
  speedOf(linear: Vec2, angular: number): number {
    if (this.genMass <= 0) return 0;
    return (this.mass * this.tangent.dot(linear) + this.inertia * this.kappa * angular) / this.genMass;
  }

  // Place the body at `s` with track speed `v`.
  place(body: TrackBody, s: number, v: number): void {
    this.s = s;
    this.write(body, v);
  }

  // Fold whatever moved the body since the last write back onto the line (see
  // the file comment) and write the pose again. The position change is
  // projected with the derivatives it was made against; the speed is then
  // re-read at the new `s`.
  absorb(body: TrackBody): void {
    const dp = body.globalPosition.sub(this.writtenPosition);
    const dTheta = body.globalRotation - this.writtenRotation;
    if (dp.x !== 0 || dp.y !== 0 || dTheta !== 0) {
      this.s += this.speedOf(dp, dTheta);
    }
    const v = this.speedOf(body.linearVelocity, body.angularVelocity);
    this.write(body, v);
  }

  // Track speed as the body's velocity states it (exact right after a write).
  speed(body: TrackBody): number {
    return this.speedOf(body.linearVelocity, body.angularVelocity);
  }

  // Advance along the line by the body's own speed over `h`, with a
  // generalised force `force` (newtons along the line, e.g. gravity's share)
  // taken first, semi-implicit as every body here integrates.
  integrate(body: TrackBody, gravity: Vec2, h: number): void {
    this.accelerate(body, gravity, h);
    this.advance(body, h);
  }

  // The velocity half of a step: gravity's share along the line. Gravity acts
  // at the centre of mass, the origin, so its generalised force is `m g . T`.
  // The island takes the halves apart, with its rows solved between them.
  accelerate(body: TrackBody, gravity: Vec2, h: number): void {
    this.absorb(body);
    let v = this.speedOf(body.linearVelocity, body.angularVelocity);
    if (this.genMass > 0) v += ((this.mass * gravity.mul(body.gravityScale).dot(this.tangent)) / this.genMass) * h;
    this.write(body, v);
    // The drive's step with the speed gravity has just given, so the position
    // step below moves by what the wheels left - semi-implicit Euler with the
    // grip a force of the step, rather than a frame behind it.
    if (this.drive !== null) this.drive(h);
  }

  // What drives the body along its line, stepped over `h` inside `accelerate`
  // (a powered cart's motor and the wheels' grip, `level/tracks.ts`). Null
  // for a body that is only carried by the line.
  drive: ((h: number) => void) | null = null;

  // The position half: along the line by the body's own speed over `h`.
  advance(body: TrackBody, h: number): void {
    this.absorb(body);
    const v = this.speedOf(body.linearVelocity, body.angularVelocity);
    this.s += v * h;
    this.write(body, v);
  }

  // Change the track speed by a generalised impulse (newton-seconds along the
  // line): the drive's traction.
  push(body: TrackBody, impulse: number): void {
    if (this.genMass <= 0) return;
    const dv = impulse / this.genMass;
    body.linearVelocity = body.linearVelocity.add(this.tangent.mul(dv));
    body.angularVelocity += this.kappa * dv;
  }

  private write(body: TrackBody, v: number): void {
    const pose = this.refresh();
    body.globalPosition = pose.position;
    body.globalRotation = pose.rotation;
    body.linearVelocity = this.tangent.mul(v);
    body.angularVelocity = this.kappa * v;
    this.writtenPosition = body.globalPosition;
    this.writtenRotation = body.globalRotation;
  }

  // Does the body stand exactly where `s` puts it, with a velocity on the
  // line? The invariant behind every write (`cli tracks`).
  offLine(body: TrackBody): { position: number; rotation: number; velocity: number } {
    const pose = this.poseAt(this.s);
    const v = this.speedOf(body.linearVelocity, body.angularVelocity);
    return {
      position: body.globalPosition.distanceTo(pose.position),
      rotation: Math.abs(body.globalRotation - pose.rotation),
      velocity: body.linearVelocity.distanceTo(this.tangent.mul(v)) + Math.abs(body.angularVelocity - this.kappa * v),
    };
  }
}

// What a mount reads and writes of its body - `RigidBody2D`'s fields, named
// here so this file needs nothing from `body.ts`.
export interface TrackBody {
  globalPosition: Vec2;
  globalRotation: number;
  linearVelocity: Vec2;
  angularVelocity: number;
  gravityScale: number;
}

// The effective inverse mass of a track body for a unit impulse along `n` at
// arm `r`: `(u(r) . n)^2 / M`.
export function trackResponse(mount: TrackMount, r: Vec2, n: Vec2): number {
  if (mount.genMass <= 0) return 0;
  const a = mount.along(n, r);
  return (a * a) / mount.genMass;
}

// Apply impulse `j` at arm `r` to a track body: its track speed changes by
// `(u(r) . j) / M`, and nothing else does.
export function applyTrackImpulse(mount: TrackMount, body: TrackBody, j: Vec2, r: Vec2): void {
  mount.push(body, mount.along(j, r));
}
