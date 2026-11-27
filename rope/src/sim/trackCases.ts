// Minecart cases: hand-built levels with the answer written down, run by
// `cli tracks` (docs/minecarts.md).
//
// A cart is a rigid body with one freedom (`engine/track.ts`) and a drive
// whose wheels meet the rail through friction (`level/tracks.ts`), and both
// halves have closed forms: a free cart rolls at its cruise speed, an
// unpowered one rolls down a slope at `m g sin(a) / (m + I_w / r^2)`, a held
// one pushes on what holds it with `mu_k m g` while its wheels spin at the
// cruise speed, and the spawner's carts go out on a fixed beat. These assert
// that arithmetic and the claims that make a cart a cart - it never leaves its
// line, and it leaves the sim at the end of the line.
//
// What these do NOT judge is the feel: the cruise speed, the pull, the grip
// coefficients and the spark rate are guesses to be played, and nothing here
// pins them beyond the law they enter.
//
// Each case builds a level TREE, so the compile (`Track2D` -> `TrackData`) and
// the scale gate are exercised exactly as an authored level's are.

import { Vec2 } from "../engine/vec2";
import { LAYER_CART, RigidBody2D, StaticBody2D } from "../engine/body";
import { GRAVITY } from "../engine/world";
import { BallLevel } from "../level/ballLevel";
import { emptyFrameInput } from "../input/frameInput";
import { WHEEL_KINETIC_FRICTION, type Minecart, type MineTrack } from "../level/tracks";
import type { LevelNode, LevelTree } from "../level/nodes";
import { checkBallInvariants } from "./trace";
import { compileLevel } from "../level/nodes";
import { modelFromDisk, modelToDisk } from "../editor/model";
import { DEFAULT_SURFACE_FRICTION, type TrackData } from "../level/levelFormat";

const DT = 1 / 60;
const PX_PER_M = 100;

export interface TrackResult {
  name: string;
  passed: boolean;
  details: string[];
  expectedFail?: true;
}

class Checks {
  passed = true;
  readonly details: string[] = [];
  check(claim: string, got: boolean): void {
    if (!got) this.passed = false;
    this.details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  }
  result(name: string): TrackResult {
    return { name, passed: this.passed, details: this.details };
  }
}

interface TrackOpts {
  // Track nodes in metres, in the direction of travel.
  verts: Vec2[];
  speed: number;
  pull?: number;
  grip?: number;
  interval?: number;
  max?: number;
  phase?: number;
  // The ball's spawn, metres; far from everything unless a case wants it.
  ball?: Vec2;
  // A wall across the line at this point (metres), on the carts' layer.
  wall?: Vec2;
}

const CART_W = 1.2;
const CART_H = 0.6;
// The cart's body rides this far above the line (its bottom on the wheels).
const RIDE = 0.15;

let ids = 0;
const id = (): string => `n${++ids}`;
const px = (m: number): number => m * PX_PER_M;

function trackTree(o: TrackOpts): LevelTree {
  const start = o.verts[0]!;
  const dir = o.verts[1]!.sub(start).normalized();
  // Placed upright whichever way the line runs, as the editor's Track tool
  // places it: turned with the slope, not with the direction.
  const upright = dir.x < 0 ? dir.neg() : dir;
  const up = new Vec2(upright.y, -upright.x);
  // The cart placed where it sits on the rails at the start, upright on the
  // line: its centre a half height plus the ride above the line.
  const cartAt = start.add(dir.mul(0.6)).add(up.mul(CART_H / 2 + RIDE));
  const ball = o.ball ?? new Vec2(start.x, start.y - 40);
  const nodes: LevelNode[] = [
    { type: "Spawn2D", id: id(), name: "Spawn", x: px(ball.x), y: px(ball.y), radius: 8 } as LevelNode,
    {
      type: "StaticBody2D",
      id: id(),
      name: "Floor",
      order: 1,
      x: px(ball.x),
      y: px(ball.y + 1),
      children: [{ type: "CollisionShape2D", id: id(), name: "Rect", shape: { kind: "rect", w: 400, h: 40 } }],
    } as LevelNode,
    {
      type: "Track2D",
      id: "track",
      name: "Track",
      x: 0,
      y: 0,
      rot: 0,
      verts: o.verts.map((v) => ({ x: px(v.x), y: px(v.y) })),
      speed: px(o.speed),
      ...(o.pull !== undefined ? { pull: o.pull } : {}),
      ...(o.grip !== undefined ? { grip: o.grip } : {}),
      interval: o.interval ?? 1000,
      max: o.max ?? 1,
      ...(o.phase !== undefined ? { phase: o.phase } : {}),
      children: [
        {
          type: "RigidBody2D",
          id: "cart",
          name: "Cart",
          order: 2,
          x: px(cartAt.x),
          y: px(cartAt.y),
          rot: upright.angle(),
          children: [
            { type: "CollisionShape2D", id: id(), name: "Box", shape: { kind: "rect", w: px(CART_W), h: px(CART_H) } },
          ],
        },
      ],
    } as LevelNode,
  ];
  if (o.wall) {
    nodes.push({
      type: "StaticBody2D",
      id: id(),
      name: "Wall",
      order: 3,
      x: px(o.wall.x),
      y: px(o.wall.y),
      children: [{ type: "CollisionShape2D", id: id(), name: "Rect", shape: { kind: "rect", w: 20, h: 300 } }],
    } as LevelNode);
  }
  return { format: 4, nodes };
}

function makeLevel(o: TrackOpts): { level: BallLevel; track: MineTrack } {
  const level = new BallLevel(trackTree(o));
  // The wall is on the carts' layer, which is what lets a static stop one.
  const wall = o.wall;
  if (wall) {
    for (const b of level.world.bodies) {
      if (b instanceof StaticBody2D && b.globalPosition.distanceTo(wall) < 1e-6) {
        for (const s of b.getShapes()) s.layer |= LAYER_CART;
      }
    }
  }
  const track = level.tracks[0];
  if (!track) throw new Error("the level built no track");
  return { level, track };
}

function step(level: BallLevel, frames: number, each?: (f: number) => void): void {
  for (let f = 0; f < frames; f++) {
    level.physicsProcess(emptyFrameInput(), DT);
    each?.(f);
  }
}

// The worst any cart stood off its line this frame, metres / radians / m/s.
function offLine(track: MineTrack): number {
  let worst = 0;
  for (const c of track.carts) {
    const o = c.mount.offLine(c.body);
    worst = Math.max(worst, o.position, o.rotation, o.velocity);
  }
  return worst;
}

function cartSpeed(c: Minecart): number {
  return c.mount.speed(c.body);
}

// A free cart on a flat line rolls at its cruise speed, its wheels gripping,
// on its line every frame.
function caseCruise(): TrackResult {
  const k = new Checks();
  const { level, track } = makeLevel({ verts: [new Vec2(0, 0), new Vec2(30, 0)], speed: 2 });
  let worst = 0;
  step(level, 180, () => (worst = Math.max(worst, offLine(track))));
  const c = track.carts[0];
  k.check("one cart on the line", track.carts.length === 1 && c !== undefined);
  if (!c) return k.result("cruise");
  const v = cartSpeed(c);
  k.check(`rolls at the cruise speed (${v.toFixed(4)} m/s, want 2)`, Math.abs(v - 2) < 1e-3);
  k.check(`its wheels roll, no slip (${c.slip.toExponential(2)} m/s)`, Math.abs(c.slip) < 1e-3);
  k.check(`on its line every frame (worst ${worst.toExponential(2)})`, worst < 1e-9);
  k.check(`level, not pitched (rot ${c.body.globalRotation.toExponential(2)})`, Math.abs(c.body.globalRotation) < 1e-9);
  k.check("no sparks while rolling", level.sparkEvents.length === 0);
  return k.result("cruise");
}

// A line drawn right to left: the cart placed upright on it stays upright,
// drives toward -x at the cruise speed, and leaves at the left end.
function caseRightToLeft(): TrackResult {
  const k = new Checks();
  const { level, track } = makeLevel({ verts: [new Vec2(8, 0), new Vec2(0, 0)], speed: 2 });
  const c = track.carts[0]!;
  const x0 = c.body.globalPosition.x;
  let worst = 0;
  let worstRot = 0;
  let exited = false;
  step(level, 240, () => {
    worst = Math.max(worst, offLine(track));
    for (const cart of track.carts) worstRot = Math.max(worstRot, Math.abs(cart.body.globalRotation));
    for (const e of level.trackExits) if (e.direction.x < -0.999) exited = true;
  });
  k.check(`upright all the way (worst ${worstRot.toExponential(2)} rad)`, worstRot < 1e-9);
  k.check(`on its line every frame (worst ${worst.toExponential(2)})`, worst < 1e-9);
  k.check(`drove left (${(c.body.globalPosition.x - x0).toFixed(2)} m before it left)`, c.body.globalPosition.x < x0 - 3);
  k.check("left at the left end, going left", exited);
  return k.result("right-to-left");
}

// A 30 degree climb with pull to spare: on steel (grip 0.35, 19 degrees) the
// wheels cannot hold it and the cart slips back down, spinning; on a track
// with grip 0.8 (39 degrees) it climbs at its cruise speed.
function caseGripClimb(): TrackResult {
  const k = new Checks();
  const a = Math.PI / 6;
  const top = new Vec2(2 + Math.cos(a) * 5, -Math.sin(a) * 5);
  const verts = [new Vec2(0, 0), new Vec2(2, 0), top, top.add(new Vec2(6, 0))];
  const climbEnd = 2 + 5;
  const run = (grip: number | undefined): { furthest: number; slipped: boolean; climbSpeed: number } => {
    const { level, track } = makeLevel({ verts, speed: 1.5, pull: 5000, ...(grip !== undefined ? { grip } : {}) });
    const c = track.carts[0]!;
    let furthest = c.mount.s;
    let slipped = false;
    let climbSpeed = 0;
    step(level, 420, () => {
      if (!track.carts.includes(c)) return;
      furthest = Math.max(furthest, c.mount.s);
      if (Math.abs(c.slip) > 0.5) slipped = true;
      if (c.mount.s > 4 && c.mount.s < 6) climbSpeed = c.mount.speed(c.body);
    });
    return { furthest, slipped, climbSpeed };
  };
  const steel = run(undefined);
  k.check(`steel: never over the top (furthest ${steel.furthest.toFixed(2)} m, top at ${climbEnd} m)`, steel.furthest < climbEnd);
  k.check("steel: its wheels slip on the climb", steel.slipped);
  const grippy = run(0.8);
  k.check(`grip 0.8: over the top (furthest ${grippy.furthest.toFixed(2)} m)`, grippy.furthest > climbEnd);
  k.check(`grip 0.8: climbs at the cruise speed (${grippy.climbSpeed.toFixed(6)} m/s)`, Math.abs(grippy.climbSpeed - 1.5) < 1e-6);
  k.check("grip 0.8: its wheels never slip", !grippy.slipped);
  return k.result("grip-climb");
}

// Unpowered, released at rest on a slope, a cart rolls down it at
// `a = m g sin(a) / (m + I_w / r^2)`: gravity along the line, the wheels'
// inertia carried through the grip.
function caseSlopeRoll(): TrackResult {
  const k = new Checks();
  const angle = 0.35;
  const L = 30;
  const end = new Vec2(Math.cos(angle) * L, Math.sin(angle) * L);
  const { level, track } = makeLevel({ verts: [new Vec2(0, 0), end], speed: 0, pull: 0 });
  const c = track.carts[0]!;
  const s0 = c.mount.s;
  const T = 1;
  step(level, Math.round(T / DT));
  const r = track.wheelRadius;
  const iw = 4 * 0.5 * 12 * r * r;
  const m = c.body.mass;
  const a = (m * GRAVITY.y * Math.sin(angle)) / (m + iw / (r * r));
  // Semi-implicit Euler's distance after n steps of h: a h^2 n (n + 1) / 2.
  const n = Math.round(T / DT);
  const want = (a * DT * DT * n * (n + 1)) / 2;
  const got = c.mount.s - s0;
  k.check(`rolls ${got.toFixed(4)} m in ${T} s (closed form ${want.toFixed(4)})`, Math.abs(got - want) < 1e-3 * want);
  k.check(`rolling, not sliding (slip ${c.slip.toExponential(2)})`, Math.abs(c.slip) < 1e-3);
  k.check(`pitched with the line (${c.body.globalRotation.toFixed(4)} rad)`, Math.abs(c.body.globalRotation - angle) < 1e-6);
  return k.result("slope-roll");
}

// A cart driven into a wall stops at it; its wheels go on spinning at the
// cruise speed, grind sparks, and push the wall with the kinetic grip `mu_k m g`
// - no more - every frame.
function caseBlocked(): TrackResult {
  const k = new Checks();
  const { level, track } = makeLevel({ verts: [new Vec2(0, 0), new Vec2(30, 0)], speed: 2, wall: new Vec2(5, 0) });
  const c = track.carts[0]!;
  let worst = 0;
  step(level, 240, () => (worst = Math.max(worst, offLine(track))));
  const v = cartSpeed(c);
  k.check(`stopped at the wall (${v.toExponential(2)} m/s)`, Math.abs(v) < 0.02);
  // The motor and the grip are solved together: the grip slips at its limit
  // and the motor holds the wheels at the cruise speed against it, with
  // torque to spare (the pull is twice the sliding grip).
  const rim = c.wheelSpeed * track.wheelRadius;
  k.check(`wheels spin at the cruise speed (${rim.toFixed(6)} m/s)`, Math.abs(rim - 2) < 1e-9);
  k.check(`sliding (slip ${c.slip.toFixed(3)} m/s)`, c.slip > 1.9);
  k.check(`sparks at both wheelsets (${level.sparkEvents.length})`, level.sparkEvents.length === 2);
  let pushed = 0;
  for (const ct of level.world.frameContacts) if (ct.a === c.body || ct.b === c.body) pushed += ct.normalImpulse;
  const want = WHEEL_KINETIC_FRICTION * c.body.mass * GRAVITY.y * DT;
  k.check(`pushes the wall with mu_k m g (${(pushed / DT).toFixed(1)} N, want ${(want / DT).toFixed(1)} N)`, Math.abs(pushed - want) < 0.1 * want);
  const front = c.body.globalPosition.x + CART_W / 2;
  k.check(`not through the wall (front at ${front.toFixed(3)} m, wall face 4.9)`, front < 4.92);
  k.check(`on its line every frame (worst ${worst.toExponential(2)})`, worst < 1e-9);
  return k.result("blocked");
}

// The spawner: carts go out on a fixed beat, never more than the cap, and a
// slot the cap or a blocked start refuses is skipped, not delayed.
function caseSpawnClock(): TrackResult {
  const k = new Checks();
  const { level, track } = makeLevel({ verts: [new Vec2(0, 0), new Vec2(9, 0)], speed: 2, interval: 1.5, max: 3 });
  const spawned: number[] = [];
  let known = new Set<RigidBody2D>(track.carts.map((c) => c.body));
  let most = track.carts.length;
  let exits = 0;
  step(level, 900, (f) => {
    for (const c of track.carts) if (!known.has(c.body)) spawned.push(f + 1);
    known = new Set(track.carts.map((c) => c.body));
    most = Math.max(most, track.carts.length);
    exits += level.trackExits.length;
  });
  k.check(`never more than the cap (most ${most})`, most <= 3);
  const offBeat = spawned.filter((f) => Math.abs((f * DT) / 1.5 - Math.round((f * DT) / 1.5)) > 1e-6);
  k.check(`every spawn on a slot (${spawned.length} spawns, ${offBeat.length} off the beat)`, spawned.length > 0 && offBeat.length === 0);
  k.check(`carts leave at the end (${exits} exits)`, exits > 0);
  // Free carts are a slot apart on the line: speed * interval = 3 m.
  const ss = track.carts.map((c) => c.mount.s).sort((a, b) => a - b);
  const gaps = ss.slice(1).map((s, i) => s - ss[i]!);
  k.check(`spaced a slot apart (${gaps.map((g) => g.toFixed(3)).join(", ")} m)`, gaps.every((g) => Math.abs(g - 3) < 1e-3));
  return k.result("spawn-clock");
}

// A start the ball stands on refuses the slots it covers; once it is clear the
// next cart goes on the same beat as though nothing had happened.
function caseSpawnBlocked(): TrackResult {
  const k = new Checks();
  const { level, track } = makeLevel({
    verts: [new Vec2(0, 0), new Vec2(8, 0)],
    speed: 2,
    interval: 1,
    max: 6,
    ball: new Vec2(0.6, -0.8),
  });
  const ball = level.ball;
  const parked = ball.globalPosition;
  const spawned: number[] = [];
  let known = new Set<RigidBody2D>(track.carts.map((c) => c.body));
  step(level, 420, (f) => {
    // The ball held over the start for the first three seconds, then gone.
    if (f < 180) {
      ball.globalPosition = parked;
      ball.linearVelocity = Vec2.ZERO;
    } else if (f === 180) {
      ball.globalPosition = new Vec2(0, -40);
      ball.linearVelocity = Vec2.ZERO;
    }
    for (const c of track.carts) if (!known.has(c.body)) spawned.push(f + 1);
    known = new Set(track.carts.map((c) => c.body));
  });
  const during = spawned.filter((f) => f <= 180);
  const after = spawned.filter((f) => f > 180);
  k.check(`no cart sent while the ball stands on the start (${during.length})`, during.length === 0);
  k.check(`carts resume on the beat (${after.join(", ")})`, after.length >= 1 && after.every((f) => f % 60 === 0));
  return k.result("spawn-blocked");
}

// A cart that reaches the end leaves the world on that frame, with an exit
// event carrying where it was and how fast.
function caseExit(): TrackResult {
  const k = new Checks();
  const { level, track } = makeLevel({ verts: [new Vec2(0, 0), new Vec2(6, 0)], speed: 2 });
  const c = track.carts[0]!;
  let exit = null as (typeof level.trackExits)[number] | null;
  let frame = -1;
  step(level, 300, (f) => {
    if (exit === null && level.trackExits.length > 0) {
      exit = level.trackExits[0]!;
      frame = f;
    }
  });
  k.check(`left the line (frame ${frame})`, exit !== null);
  k.check("gone from the world", c.body.removed && !level.world.bodies.includes(c.body));
  k.check("gone from what the chain wraps", !level.bodies.includes(c.body));
  if (exit) {
    k.check(`at the cruise speed (${exit.speed.toFixed(3)} m/s)`, Math.abs(exit.speed - 2) < 1e-3);
    k.check(`going along the line (${exit.direction.x.toFixed(3)}, ${exit.direction.y.toFixed(3)})`, exit.direction.x > 0.999);
    k.check("names the cart's node", exit.cartNode === "cart" && exit.track === "track");
  }
  return k.result("exit");
}

// Over a crest and into a dip the cart keeps to its line, pitches with the
// chord its wheelsets make, and is driven at its cruise speed.
function caseCurvedLine(): TrackResult {
  const k = new Checks();
  const { level, track } = makeLevel({
    // 14 degrees up and down: under the steepest the grip climbs at the
    // default pull (`atan(mu_s)`, 19 degrees).
    verts: [new Vec2(0, 0), new Vec2(4, 0), new Vec2(7, -0.75), new Vec2(10, -0.75), new Vec2(13, 0), new Vec2(30, 0)],
    speed: 2,
  });
  let worst = 0;
  let worstSpeed = 0;
  let worstPitch = 0;
  let empty = 0;
  step(level, 360, () => {
    if (track.carts.length === 0) empty++;
    worst = Math.max(worst, offLine(track));
    for (const c of track.carts) {
      worstSpeed = Math.max(worstSpeed, Math.abs(cartSpeed(c) - 2));
      const { front, rear } = c.mount.wheelPoints();
      worstPitch = Math.max(worstPitch, Math.abs(c.body.globalRotation - front.sub(rear).angle()));
    }
  });
  k.check(`a cart on the line every frame (${empty} empty)`, empty === 0);
  k.check(`on its line every frame (worst ${worst.toExponential(2)})`, worst < 1e-9);
  k.check(`pitched with its wheelsets' chord (worst ${worstPitch.toExponential(2)} rad)`, worstPitch < 1e-9);
  k.check(`driven at the cruise speed over the hump (worst ${worstSpeed.toFixed(3)} m/s off)`, worstSpeed < 0.25);
  return k.result("curved-line");
}

// The ball hung from a cart by its chain: the chain's row holds a cart as it
// holds any body (the island steps the cart along its line), the cart carries
// the ball on, and when the cart leaves the end of the line the chain is let
// go of rather than taken with it.
function caseHungFromCart(): TrackResult {
  const k = new Checks();
  const tree = trackTree({ verts: [new Vec2(0, 0), new Vec2(7, 0)], speed: 1, ball: new Vec2(0.6, 1.6) });
  const spawn = tree.nodes.find((n) => n.type === "Spawn2D") as { hang?: boolean };
  spawn.hang = true;
  // No floor: the ball hangs.
  tree.nodes = tree.nodes.filter((n) => n.type !== "StaticBody2D");
  const level = new BallLevel(tree);
  const track = level.tracks[0]!;
  const cart = track.carts[0]!;
  k.check("the chain bit the cart", level.ball.anchoredTo === cart.body);
  const s0 = cart.mount.s;
  const ball0 = level.ball.globalPosition;
  let worst = 0;
  let released = -1;
  let exitFrame = -1;
  let finite = true;
  let cartViolations = 0;
  step(level, 480, (f) => {
    cartViolations += checkBallInvariants(level).filter((v) => v.kind.startsWith("cart-")).length;
    worst = Math.max(worst, offLine(track));
    if (!level.ball.globalPosition.isFinite() || !level.ball.linearVelocity.isFinite()) finite = false;
    if (exitFrame < 0 && level.trackExits.length > 0) exitFrame = f;
    if (released < 0 && level.ball.anchoredTo !== cart.body) released = f;
    if (f === 180) {
      k.check(`the cart drove on with the ball (${(cart.mount.s - s0).toFixed(2)} m)`, cart.mount.s - s0 > 1);
      k.check(`and carried it (${(level.ball.globalPosition.x - ball0.x).toFixed(2)} m)`, level.ball.globalPosition.x - ball0.x > 0.5);
    }
  });
  k.check(`on its line every frame (worst ${worst.toExponential(2)})`, worst < 1e-9);
  k.check("the ball stayed finite", finite);
  k.check(`no cart invariant broken (${cartViolations})`, cartViolations === 0);
  k.check(`the cart left the line (frame ${exitFrame})`, exitFrame >= 0);
  k.check(`the chain let go as it left, not before (frame ${released})`, released === exitFrame);
  return k.result("hung-from-cart");
}

// Through the editor and back: a track loaded into the editor's model (its
// line an item, its cart a body there) and written out again compiles to the
// same track and the same cart, and the cart is a body the editor can select.
function caseEditorRoundTrip(): TrackResult {
  const k = new Checks();
  const tree = trackTree({
    verts: [new Vec2(0, 0), new Vec2(4, 0), new Vec2(7, -0.75)],
    speed: 1.5,
    pull: 400,
    interval: 3,
    max: 2,
    phase: 0.25,
  });
  const before = compileLevel(tree).data.tracks ?? [];
  const model = modelFromDisk(tree);
  const track = model.items.find((i) => i.object === "track");
  k.check("the track is an item", track !== undefined && track.shape.kind === "path" && track.shape.verts.length === 3);
  k.check("its cart is a body in the model", model.tree.nodes.get("cart")?.body !== null && model.tree.nodes.get("cart") !== undefined);
  const after = compileLevel(modelToDisk(model)).data.tracks ?? [];
  // What the sim reads: the editor writes every body's look (colour, opacity)
  // and its friction at the default, which build the same cart.
  const strip = (t: readonly TrackData[]): string =>
    JSON.stringify(
      t.map(({ node: _n, ...rest }) => {
        if (!rest.cart) return rest;
        const { color: _c, opacity: _o, node: _cn, friction, ...cart } = rest.cart;
        return { ...rest, cart: { ...cart, friction: friction ?? DEFAULT_SURFACE_FRICTION } };
      }),
    );
  k.check(`compiles to the same track (${after.length} of ${before.length})`, before.length === 1 && strip(before) === strip(after));
  return k.result("editor-round-trip");
}

// The same level twice is the same game.
function caseDeterministic(): TrackResult {
  const k = new Checks();
  const run = (): string => {
    ids = 0;
    const { level, track } = makeLevel({ verts: [new Vec2(0, 0), new Vec2(9, 0)], speed: 2, interval: 1.5, max: 3, wall: new Vec2(7, 0) });
    step(level, 400);
    return track.carts.map((c) => `${c.mount.s}|${c.wheelSpeed}|${c.body.linearVelocity.x}`).join(";");
  };
  const a = run();
  const b = run();
  k.check("two runs agree to the bit", a === b && a.length > 0);
  return k.result("deterministic");
}

export function runTrackCases(): TrackResult[] {
  return [
    caseCruise(),
    caseRightToLeft(),
    caseSlopeRoll(),
    caseGripClimb(),
    caseBlocked(),
    caseSpawnClock(),
    caseSpawnBlocked(),
    caseExit(),
    caseCurvedLine(),
    caseHungFromCart(),
    caseEditorRoundTrip(),
    caseDeterministic(),
  ];
}
