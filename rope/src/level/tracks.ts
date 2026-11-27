// Minecart tracks (docs/minecarts.md): the spawner's clock, the cart's drive
// and its wheels' grip on the rail, the sparks a slipping wheel grinds, and
// the cart's exit off the end of the line.
//
// The cart's place on the line and how it is pushed about are the engine's
// (`engine/track.ts`: a rigid body with one freedom, so it cannot tip or leave
// the rails, and every contact and the chain load it along the line). This
// file is what makes it a POWERED cart and what decides when there is one.
//
// THE DRIVE is a motor on the wheels, and the wheels meet the rail through
// friction - two bounded rows a frame, the shape a joint's motor and a
// friction contact always have:
//
//   - the motor drives the wheels' spin toward the cruise speed at the rims,
//     with no more torque than `pull * r`;
//   - the rail's grip carries the wheels' rim speed into the cart, with no more
//     than `mu N` - the static coefficient while the wheels roll, the kinetic
//     one once they slip - `N` being the cart's weight into the line.
//
// Nothing else is needed for the behaviour that is the point of a cart. A cart
// running free rolls: the wheels and the cart move as one at the cruise speed.
// A cart something holds - the ball in its way, the chain hooked to it - is
// held by the contact or the chain row, which take away the speed the grip
// gave it; the wheels are not held by anything but the grip, so once the motor
// out-pulls `mu N` they spin up past the cart, and the cart pushes on what
// holds it with exactly the friction limit and no more, its wheels spinning
// and grinding sparks. Let go, the grip catches the cart up to its wheels and
// it rolls on.
//
// THE SPAWNER is a fixed clock (see `TrackData`): a slot every `interval`,
// skipped - never delayed - when the cap is reached or the start of the line
// is not clear, so a player holding carts up delays those carts and no others.
//
// THE EXIT. A cart whose wheelset reaches either end of the line leaves the
// simulation on that frame: its body is removed (a chain hooked to it is let
// go, and its wraps on it are dropped with it), so nothing it was pushing or
// holding is carried anywhere past the end. What the player SEES is a
// `TrackExit` event - where it was, how fast, its wheels - from which the
// renderer drives the drawn cart round a bend out of the play plane and away
// from the camera (`render3d/cartExits.ts`). Render-side by construction.

import { Vec2 } from "../engine/vec2";
import { LAYER_CART, LAYER_ANCHOR, LAYER_SCENERY, MASK_CART, RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { TrackCurve, TrackMount } from "../engine/track";
import { GRAVITY, type World } from "../engine/world";
import { flattenPath, pathNodesOf } from "../lib/path";
import { buildRuntimeRigidBody, type BuiltBody } from "./buildBodies";
import {
  DEFAULT_TRACK_EXIT_RADIUS,
  DEFAULT_TRACK_INTERVAL,
  DEFAULT_TRACK_MAX,
  DEFAULT_TRACK_PULL_G,
  DEFAULT_TRACK_SPEED,
  DEFAULT_TRACK_WHEEL_BASE,
  DEFAULT_TRACK_WHEEL_RADIUS,
  type LevelBodyData,
  type TrackData,
} from "./levelFormat";
import type { SparkEvent } from "./sparkEvents";

// Steel wheels on a steel rail. Dry rail adhesion is 0.25-0.35 and a sliding
// steel tyre about 0.2; guesses at those, to be played.
export const WHEEL_STATIC_FRICTION = 0.35;
export const WHEEL_KINETIC_FRICTION = 0.25;
// Below this slip at the rims (m/s) the wheels are rolling, and the static
// coefficient holds them; above it they are sliding, and the kinetic one
// does. Sparks are reported above it too.
export const WHEEL_ROLL_SLIP = 0.05;
// A cart's wheels: four, each a solid disc of this mass (kg). Only their
// inertia is used - the spin the motor has to win against the grip - and the
// cart's own mass is its body's.
const WHEEL_COUNT = 4;
const WHEEL_MASS = 12;
// The line is flattened finer than a mover's route (10 cm against 25): the
// chord between the wheelsets turns smoothly over a kink, but the pose is read
// at both wheelsets and a coarse bend steps the pitch.
const TRACK_FLATTEN_STEP = 0.1;
// The start of the line is clear for a new cart when no cart's rear is within
// this much of the new cart's front, on top of a cart's own length.
const SPAWN_GAP = 0.25;
// How far in from the start of the line a new cart's rear wheelset stands.
const SPAWN_MARGIN = 0.01;

export interface Minecart {
  readonly body: RigidBody2D;
  readonly mount: TrackMount;
  // The cart as an authored body would be recorded, for what draws it.
  readonly built: BuiltBody;
  // The wheels' spin, rad/s (positive drives the cart along the line), and the
  // angle they have turned through, radians, a running total.
  wheelSpeed: number;
  wheelAngle: number;
  // Rim speed less track speed after the frame's grip, m/s: what the wheels
  // are sliding at. Zero while they roll.
  slip: number;
}

// A cart leaving the line (see the file comment). Everything the renderer
// needs to carry the drawn cart on from where the sim let it go.
export interface TrackExit {
  // The track's node id, and the cart template body's (the drawn cart).
  readonly track: string;
  readonly cartNode: string | null;
  // The engine body that left - its visual is the one to carry on.
  readonly body: PhysicsBody2D;
  readonly position: Vec2;
  readonly rotation: number;
  // Unit direction the cart was going along the line, and its speed (m/s,
  // never negative: a cart pushed back off the start leaves backwards).
  readonly direction: Vec2;
  readonly speed: number;
  readonly wheelAngle: number;
  readonly wheelSpeed: number;
  // The bends' radius out of the plane, metres; the straight between the
  // first bend (away from the camera) and the second (sideways); and which
  // way the second turns, as screen x (+1 right, -1 left).
  readonly exitRadius: number;
  readonly exitDepth: number;
  readonly exitTurn: number;
}

export class MineTrack {
  readonly node: string;
  readonly curve: TrackCurve;
  readonly carts: Minecart[] = [];
  readonly speed: number;
  readonly interval: number;
  readonly max: number;
  readonly phase: number;
  readonly halfBase: number;
  readonly wheelRadius: number;
  readonly exitRadius: number;
  readonly exitDepth: number;
  // "left" / "right", or null for back the way the cart was travelling.
  readonly exitTurn: "left" | "right" | null;
  private readonly template: LevelBodyData;
  private readonly pull: number;
  // The wheels' rolling and sliding friction on this track's rail
  // (`TrackData.grip`): the steel pair by default, a grippier track keeping
  // their ratio so it pushes harder while slipping too.
  readonly gripStatic: number;
  readonly gripKinetic: number;
  private readonly wheelInertia: number;
  // The mount's fixed part, measured once off the template (`measureTemplate`).
  private readonly originLocal: Vec2;
  private readonly rotationOffset: number;
  private readonly mass: number;
  private readonly inertia: number;
  // How far the template reaches from its origin, for the clear test.
  private readonly reach: number;
  // Where a new cart stands: its rear wheelset at the start of the line.
  private readonly spawnS: number;
  // The last slot the clock has dealt with.
  private lastSlot: number;

  constructor(
    private readonly world: World,
    data: TrackData & { node?: string },
    private readonly wrapBodies: PhysicsBody2D[],
    // The ball as the level is built, so the carts already out are not put
    // on top of it.
    private readonly ball: PhysicsBody2D | null = null,
    private readonly ballRadius = 0,
  ) {
    if (!data.cart) throw new Error("a track needs a cart");
    this.node = data.node ?? "";
    const local = flattenPath(pathNodesOf(data.verts), TRACK_FLATTEN_STEP);
    this.curve = new TrackCurve(local.map((p) => p.rotated(data.rot).add(new Vec2(data.x, data.y))));
    this.speed = data.speed ?? DEFAULT_TRACK_SPEED;
    // A slot shorter than a frame would owe more carts than a frame can send.
    this.interval = Math.max(0.1, data.interval ?? DEFAULT_TRACK_INTERVAL);
    this.max = Math.max(0, Math.floor(data.max ?? DEFAULT_TRACK_MAX));
    this.phase = data.phase ?? 0;
    this.halfBase = (data.wheelBase ?? DEFAULT_TRACK_WHEEL_BASE) / 2;
    this.wheelRadius = Math.max(1e-3, data.wheelRadius ?? DEFAULT_TRACK_WHEEL_RADIUS);
    this.exitRadius = data.exitRadius ?? DEFAULT_TRACK_EXIT_RADIUS;
    this.exitDepth = Math.max(0, data.exitDepth ?? 0);
    this.exitTurn = data.exitTurn ?? null;
    this.wheelInertia = WHEEL_COUNT * 0.5 * WHEEL_MASS * this.wheelRadius * this.wheelRadius;
    this.template = data.cart;
    // Its rear wheelset a margin in from the start, so a cart is not born
    // already off the line it leaves by (see `step`).
    this.spawnS = this.halfBase + SPAWN_MARGIN;

    const measured = this.measureTemplate();
    this.originLocal = measured.originLocal;
    this.rotationOffset = measured.rotationOffset;
    this.mass = measured.mass;
    this.inertia = measured.inertia;
    this.reach = measured.reach;
    this.pull = data.pull ?? DEFAULT_TRACK_PULL_G * this.mass * 9.8;
    this.gripStatic = Math.max(0, data.grip ?? WHEEL_STATIC_FRICTION);
    this.gripKinetic = this.gripStatic * (WHEEL_KINETIC_FRICTION / WHEEL_STATIC_FRICTION);

    this.lastSlot = this.slotAt(0);
    this.prewarm();
  }

  // The template built once where it was authored, to read what every cart
  // built from it will be: its mass and inertia, and where its origin (the
  // centre of mass) and its angle stand against the chord its wheelsets make
  // on the line there. Then taken out of the world again; it never steps.
  private measureTemplate(): {
    originLocal: Vec2;
    rotationOffset: number;
    mass: number;
    inertia: number;
    reach: number;
  } {
    const body = buildRuntimeRigidBody(this.world, this.template);
    const origin = body.globalPosition;
    const s = this.nearestS(origin);
    const front = this.curve.pointAt(s + this.halfBase);
    const rear = this.curve.pointAt(s - this.halfBase);
    const angle = front.sub(rear).angle();
    const mid = front.add(rear).mul(0.5);
    let reach = 0;
    for (const shape of body.getShapes()) {
      for (const v of shape.worldVertices()) reach = Math.max(reach, v.distanceTo(origin));
      const ext = shape.extents();
      reach = Math.max(reach, shape.globalPosition.distanceTo(origin) + Math.max(ext.x, ext.y));
    }
    const out = {
      originLocal: origin.sub(mid).rotated(-angle),
      rotationOffset: body.globalRotation - angle,
      mass: body.mass,
      inertia: body.inertia,
      reach,
    };
    this.world.remove(body);
    return out;
  }

  // The arc length of the line's nearest point to `p`.
  private nearestS(p: Vec2): number {
    const pts = this.curve.points;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const d = pts[i + 1]!.sub(a);
      const len2 = d.lengthSquared();
      const t = len2 > 0 ? Math.max(0, Math.min(1, p.sub(a).dot(d) / len2)) : 0;
      const dist = a.add(d.mul(t)).distanceSquaredTo(p);
      if (dist < bestD) {
        bestD = dist;
        best = this.curve.cumulative[i]! + t * Math.sqrt(len2);
      }
    }
    return best;
  }

  // The slot a time falls in: slot k opens at `(k + phase) * interval`.
  private slotAt(time: number): number {
    return Math.floor(time / this.interval - this.phase);
  }

  // The level opens as though the clock had always been running: the slots
  // before the first frame have sent their carts out, each as far down the
  // line as the cruise speed has taken it, up to the cap and short of the end.
  private prewarm(): void {
    const placed: number[] = [];
    for (let k = this.lastSlot; placed.length < this.max; k--) {
      const age = -(k + this.phase) * this.interval;
      const s = this.spawnS + age * this.speed;
      if (s + this.halfBase >= this.curve.length) break;
      // Not on top of the ball: the slot that would have is skipped, as a
      // slot the ball stands in the way of in play is.
      if (this.ball !== null && !this.clearOf(this.ball, this.ballRadius, s)) continue;
      placed.push(s);
    }
    // Furthest first, so build order runs down the line.
    for (let i = placed.length - 1; i >= 0; i--) this.spawnAt(placed[i]!);
  }

  private spawnAt(s: number): Minecart {
    const body = buildRuntimeRigidBody(this.world, this.template);
    // Where it was built - the template's own authored pose - is the frame
    // the drawn cart's look is placed in (`BodyVisual.frame`), as an authored
    // body's is, before the line puts it anywhere.
    const built: BuiltBody = { data: this.template, body, origin: body.globalPosition, rotation: body.globalRotation };
    // A cart meets the ball, the hook, the chain and other carts, and no
    // scenery (`LAYER_CART`).
    for (const shape of body.getShapes()) {
      shape.layer = (shape.layer | LAYER_CART) & ~LAYER_ANCHOR;
      shape.mask = MASK_CART;
      if ((shape.layer & LAYER_SCENERY) === 0) shape.layer |= LAYER_SCENERY;
    }
    const mount = new TrackMount(
      this.curve,
      s,
      this.halfBase,
      this.originLocal,
      this.rotationOffset,
      this.mass,
      this.inertia,
    );
    body.track = mount;
    mount.place(body, s, this.speed);
    this.world.markBroadphaseDirty(body);
    this.wrapBodies.push(body);
    const cart: Minecart = { body, mount, built, wheelSpeed: this.speed / this.wheelRadius, wheelAngle: 0, slip: 0 };
    mount.drive = (h) => this.drive(cart, h);
    this.carts.push(cart);
    return cart;
  }

  // Is the start of the line free for a new cart: no cart's body within a
  // cart's length of it, and the ball not standing where the cart would?
  private spawnClear(ball: PhysicsBody2D, ballRadius: number): boolean {
    const length = 2 * this.reach + SPAWN_GAP;
    for (const c of this.carts) {
      if (Math.abs(c.mount.s - this.spawnS) < length) return false;
    }
    return this.clearOf(ball, ballRadius, this.spawnS);
  }

  // Would a cart at `s` stand clear of the ball?
  private clearOf(ball: PhysicsBody2D, ballRadius: number, s: number): boolean {
    const probe = new TrackMount(
      this.curve,
      s,
      this.halfBase,
      this.originLocal,
      this.rotationOffset,
      this.mass,
      this.inertia,
    ).poseAt(s);
    return ball.globalPosition.distanceTo(probe.position) > this.reach + ballRadius + SPAWN_GAP;
  }

  // One frame, before the world steps: the carts off the end leave and the
  // clock sends out what its slot owes. Each cart's drive and grip are solved
  // inside its own step (`TrackMount.drive`), by the world or by the island
  // that holds it.
  step(
    frame: number,
    dt: number,
    ball: PhysicsBody2D,
    ballRadius: number,
    exits: TrackExit[],
    release: (body: PhysicsBody2D) => void,
  ): void {
    for (let i = this.carts.length - 1; i >= 0; i--) {
      const c = this.carts[i]!;
      const s = c.mount.s;
      if (s + this.halfBase < this.curve.length && s - this.halfBase >= 0) continue;
      exits.push(this.exitOf(c, s - this.halfBase < 0));
      release(c.body);
      this.world.remove(c.body);
      const at = this.wrapBodies.indexOf(c.body);
      if (at >= 0) this.wrapBodies.splice(at, 1);
      this.carts.splice(i, 1);
    }

    const slot = this.slotAt(frame * dt);
    if (slot > this.lastSlot) {
      this.lastSlot = slot;
      if (this.carts.length < this.max && this.spawnClear(ball, ballRadius)) this.spawnAt(this.spawnS);
    }
  }

  // After the frame: the sparks every sliding wheel ground, on the frame's
  // final poses.
  report(sparks: SparkEvent[]): void {
    for (const c of this.carts) {
      if (Math.abs(c.slip) > WHEEL_ROLL_SLIP) this.reportSparks(c, sparks);
    }
  }

  // The motor, then the grip (see the file comment), over a step of `dt`.
  private drive(c: Minecart, dt: number): void {
    const { body, mount } = c;
    const gravity = GRAVITY;
    const r = this.wheelRadius;
    const iw = this.wheelInertia;
    const torqueStep = this.pull * r * dt;
    const target = this.speed / r;
    const along = mount.tangent.lengthSquared() > 0 ? mount.tangent.normalized() : Vec2.RIGHT;
    const press = Math.abs(gravity.cross(along)) * body.gravityScale * this.mass;
    // Stick or slip is the state the wheels ENDED the last step in (`c.slip`),
    // never the slip this step's gravity has just opened: on a slope that is
    // `g sin(a) dt` every step, past `WHEEL_ROLL_SLIP` above 17 degrees, and
    // read here it handed a rolling cart the sliding coefficient on every
    // step of a climb its static grip could hold.
    const mu = Math.abs(c.slip) <= WHEEL_ROLL_SLIP ? this.gripStatic : this.gripKinetic;
    const bound = mu * press * dt;
    // The motor (the wheels toward the cruise speed, within its torque) and
    // the grip (rim against rail, within the friction cone of the cart's
    // weight into the line) solved TOGETHER, exactly: two bounded rows on a
    // two-body chain (motor -> wheels -> cart) have a closed form. Solved one
    // after the other once each, the motor topped the wheels up, the grip drew
    // them down speeding the cart, and the motor never answered: a cart with
    // ten times the pull a 30 degree climb needs held 1.16 m/s of its 1.5, the
    // wheels' own inertia the only drive the grip could draw on. Iterated as
    // sequential impulses it closes only the wheels' share of the pair's
    // inertia (a fifth) per pass.
    //
    // In rim terms: the motor's angular impulse `m` moves the rim by `m r / I`
    // and the grip's linear impulse `g` moves the cart by `g / M` and the rim
    // by `-g / J`, `J = I / r^2` the wheels' mass at the rim.
    const M = mount.genMass;
    const J = iw / (r * r);
    const v = mount.speed(body);
    const w = c.wheelSpeed * r;
    const W = target * r;
    const clampTo = (x: number, b: number): number => Math.max(-b, Math.min(b, x));
    // Both rows free: cart and rim both at the cruise speed.
    let g = M * (W - v);
    let m = ((W - w + g / J) * iw) / r;
    if (Math.abs(m) > torqueStep || Math.abs(g) > bound) {
      // The grip at its limit first: the wheels slip, and the motor needs
      // only what holds them at the cruise speed against it - which may be
      // far less than the free solution asked of it (a held cart: the cart
      // cannot be brought to speed, the wheels can). Tried the other way
      // round, the motor was clamped to its full torque against the free
      // answer and spun the wheels of a held cart up without end.
      const gripLimited = clampTo(g, bound);
      const motorForIt = ((W - w + gripLimited / J) * iw) / r;
      if (Math.abs(g) > bound && Math.abs(motorForIt) <= torqueStep) {
        g = gripLimited;
        m = motorForIt;
      } else {
        // The motor at its limit: the grip makes cart and rim move as one,
        // if it can, and slips at its own limit if it cannot.
        m = clampTo(Math.abs(g) > bound ? motorForIt : m, torqueStep);
        g = clampTo((w + (m * r) / iw - v) / (1 / M + 1 / J), bound);
      }
    }
    c.wheelSpeed += (m - g * r) / iw;
    mount.push(body, g);
    c.slip = c.wheelSpeed * r - mount.speed(body);
    c.wheelAngle += c.wheelSpeed * dt;
  }

  // A sliding wheel grinds sparks off the rail at both wheelsets: the rim
  // slides over the rail at `-slip` along the line, which is the way the
  // sparks are thrown (docs/sparks.md, "along the slide"). The slip is the
  // last step's; the contacts after it may have changed the cart's speed, and
  // the next step's grip is what answers that.
  private reportSparks(c: Minecart, sparks: SparkEvent[]): void {
    const t = c.mount.tangent;
    const along = t.lengthSquared() > 0 ? t.normalized() : Vec2.RIGHT;
    const { front, rear } = c.mount.wheelPoints();
    const centre = c.body.globalPosition;
    let normal = new Vec2(-along.y, along.x);
    if (normal.dot(centre.sub(front.add(rear).mul(0.5))) < 0) normal = normal.neg();
    const vel = along.mul(-c.slip);
    for (const point of [front, rear]) sparks.push({ source: c.body.id, point, normal, vel });
  }

  private exitOf(c: Minecart, backwards: boolean): TrackExit {
    const v = c.mount.speed(c.body);
    const along = c.mount.tangent.lengthSquared() > 0 ? c.mount.tangent.normalized() : Vec2.RIGHT;
    const direction = backwards ? along.neg() : along;
    // Back the way it was travelling unless the track says which side.
    const travel = direction.x >= 0 ? 1 : -1;
    const exitTurn = this.exitTurn === "left" ? -1 : this.exitTurn === "right" ? 1 : travel;
    return {
      track: this.node,
      cartNode: this.template.node?.id ?? null,
      body: c.body,
      position: c.body.globalPosition,
      rotation: c.body.globalRotation,
      direction,
      speed: Math.abs(v),
      wheelAngle: c.wheelAngle,
      wheelSpeed: c.wheelSpeed,
      exitRadius: this.exitRadius,
      exitDepth: this.exitDepth,
      exitTurn,
    };
  }
}

// Every track the level authors, built after its bodies (so no level body's
// build index moves) with the carts the clock has already sent out.
export function buildTracks(
  world: World,
  tracks: readonly TrackData[],
  wrapBodies: PhysicsBody2D[],
  ball: PhysicsBody2D | null = null,
  ballRadius = 0,
): MineTrack[] {
  const out: MineTrack[] = [];
  for (const t of tracks) {
    if (!t.cart) {
      console.warn(`[track] ${(t as { node?: string }).node ?? "a track"} has no cart; nothing runs on it`);
      continue;
    }
    out.push(new MineTrack(world, t, wrapBodies, ball, ballRadius));
  }
  return out;
}
