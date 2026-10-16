// The glass ball's broken pieces, SIMULATED: the rigid-body world they fall,
// bounce, tumble and come to rest in (Tris, 2026-10-16: "actual chunks of ball
// that bounce around the level geometry realistically ... as realistic as
// possible"). It runs in a worker (glassShardsWorker.ts), and everything it is
// told and tells is plain data (`ToWorker`, `FromWorker`): the page's side,
// which reads the level and draws the pieces, is glassShards.ts.
//
// THE PIECES are cut once, as the level loads (render/glassFracture.ts): the
// ball as wedges and fines of solid quartz, or curved shards of its wall when
// it is hollow (each colliding as a few convex parts), its loop as arcs of bar (its chain
// and hook do not break: they simply go, see `BallLevel.shatterIfStruck`). A break
// picks a ball pattern and turns it so its crushed pole faces the contact, so
// the frame a ball breaks on builds no geometry.
//
// THE MOTION is Rapier's (a 3D physics engine, WASM): every piece is a convex
// body of quartz's density, with the mass and the rotational inertia of its own
// shape, colliding with the level, with the other pieces and with the ball. A
// piece tumbles because its corners strike, rocks on a flat face before it
// settles, slides down a slope and piles against its neighbours - none of which
// a particle per piece can do, and all of which is most of what makes a shower
// of broken glass read as real.
//
// THE LEVEL is what the 3D scene draws, as triangles (render3d/
// shardCollision.ts; Tris, 2026-10-16: "They should have 3D physics"): the
// scene's static rock (`SceneryData`, sent once per scene and kept across
// restarts) and what each level body draws, moving with its body, and the ball
// itself - while it is whole - as a sphere. The pieces move in all three
// dimensions. Without a 3D scene (the 2D view) it is the sim's own collision
// as the page hands it over: every piece of every body the ball would collide
// with, as a prism through the gameplay plane (`LEVEL_DEPTH` either side), and
// then the pieces are held to the depth they broke at, which is all a prism's
// flat ends are good for. Water slows a piece with its own drag and its current, and quartz
// sinks through it.
//
// THE PIECES FADE AWAY a short time after the break (Tris, 2026-10-16: "the
// bits should fade away after a short time"): long enough to fly, land, bounce
// and settle, then gone (`FADE_START`, `FADE_TIME`).
//
// Positions arrive in the sim's frame (x right, y DOWN) and everything here is
// in three's (y UP, z toward the camera), which is the one the pieces and the
// 3D scene use.

import type RAPIER_TYPES from "@dimforge/rapier3d-compat";
import { buildFractureSet, type FracturePiece, type FractureSet, type RingSpec } from "./glassFracture";

type Rapier = typeof RAPIER_TYPES;
type RWorld = RAPIER_TYPES.World;
type RBody = RAPIER_TYPES.RigidBody;
type RCollider = RAPIER_TYPES.Collider;

// Quartz, kg/m^3: what gives a chunk its mass and inertia from its shape.
const QUARTZ_DENSITY = 2650;
// ...but no piece lighter than this, kg. The finest fragments are a few
// hundredths of a gram, wedged among pieces of tens of grams, and at a mass
// ratio of hundreds the contact solver could not hold them: they spun in
// place at 20 rad/s for good. A fragment that small is never seen to weigh
// anything; its inertia still comes from its own shape.
const MIN_PIECE_MASS = 0.0005;
const WATER_DENSITY = 1000;
// Glass striking rock and glass: how much of the speed into the contact comes
// back, and the Coulomb friction.
const RESTITUTION = 0.4;
const FRICTION = 0.6;
// Air, per second: a little, so the finest fragments drift rather than fall
// like the large ones.
const AIR_DAMPING = 0.05;
// Turning, per second: what stands in for rolling resistance, which the engine
// does not model - without it a curved piece of link, set rolling, rolled on
// along a flat floor for good (2 s after a break, 21 of 117 still going).
const SPIN_DAMPING = 0.8;
// ...and once a piece has all but stopped moving, much more: a curved piece
// rocking on its back loses its swing to the contact in real glass, and here
// rocked on at 1-4 rad/s for seconds, keeping its whole pile awake. Below
// `ROCK_SPEED`, its spin is damped at `ROCK_DAMPING` per second.
const ROCK_SPEED = 0.05;
const ROCK_DAMPING = 8;

// The simulation's step: two to a 60 Hz sim frame. Every piece sweeps its step
// (CCD), so a fast one cannot pass through the level or another piece between
// steps; 240 Hz cost twice as much for nothing that showed.
const STEP = 1 / 120;
// At most this many steps a rendered frame: a hitch is not caught up on.
const MAX_STEPS = 12;
const GRAVITY = 9.8;

// The size of the things simulated, metres: the engine's tolerances (how far
// a contact may sink, how near it is predicted, how slow a body sleeps) are
// scaled by it, and its default is a human-sized world. At that, a 1 mm
// tolerance on pieces a few millimetres across kept the small ones jittering.
const LENGTH_UNIT = 0.1;

// Without a 3D scene, the level's collision is a set of outlines in the
// gameplay plane; as solids they reach this far either side of it, metres.
const LEVEL_DEPTH = 2;

// The break's own violence: the burst each piece is thrown out from the contact
// with, per m/s of the ball's speed into what it struck, and its floor - even a
// ball set down hard enough to break throws its pieces apart.
const KICK_PER_SPEED = 0.28;
const KICK_MIN = 0.4;
const KICK_MAX = 4;
// ...the smaller the piece the faster: the fines are thrown hardest. Kick
// scales as (reference volume / volume) ^ this.
const KICK_SIZE_EXPONENT = 1 / 6;
// A ring's pieces, which the blow never reached: they drop, with a little of
// the break's shock.
const RING_KICK: readonly [number, number] = [0.1, 0.6];

// A break's pieces come to rest together, as a pile. The engine sleeps a pile
// only when every piece in it has been still for two seconds, and one fine
// still turning in place (1.8 rad/s, five seconds after the break, the rest at
// a tenth of a millimetre a second) kept 183 pieces awake and solved. So once
// the pieces of a break average under `PILE_SPEED` with none faster than
// `PILE_MAX_SPEED`, for `PILE_TIME`, they are put to sleep together; anything
// that strikes one wakes it again.
const PILE_SPEED = 0.01;
const PILE_MAX_SPEED = 0.1;
const PILE_TIME = 0.5;

// A piece's life after its break, seconds: whole until `FADE_START`, then fading
// to nothing over `FADE_TIME`, then removed.
const FADE_START = 1.5;
const FADE_TIME = 1;

// The most chunks alive: the newest breaks take the room of the oldest.
const MAX_CHUNKS = 600;

// How long a break's pieces pass through each other (and through any other
// piece) before they collide, seconds. They start a fraction of a millimetre
// apart along every crack (`GAP`), and in the first instants of a break what
// pushes them apart is the break itself, which the kick already is: the engine
// resolving fifty pieces' worth of contacts along the cracks was half the cost
// of every step for the first frames, and the break's first step ran past a
// frame at 144 Hz, so the pieces held still and then jumped (Tris, 2026-10-16:
// "the frame stutter that occurs after the ball smashes into a surface"). By
// this age the slowest kick (`KICK_MIN`) has opened every crack by 2 cm.
const PIECE_GRACE = 0.05;
// The collision groups (Rapier's: membership in the high 16 bits, what it
// collides with in the low): a piece in its grace collides with all but pieces.
const PIECES = 0x0002;
const ALL = 0xffff;
const IN_GRACE = (PIECES << 16) | (ALL & ~PIECES);
const AFTER_GRACE = (PIECES << 16) | ALL;

const SEED = 0x9e3779b9;

// ---------------------------------------------------------------------------
// What the page and the worker say to each other
// ---------------------------------------------------------------------------

// The things that break, as the page draws them.
export interface BreakSpec {
  readonly ballRadius: number;
  // Its wall (render3d/glassWall.ts): its radius or more is a solid ball.
  readonly wall: number;
  readonly loop: RingSpec;
  // How far the loop's centre stands off the ball's surface.
  readonly loopGap: number;
}

// A piece of a level body's collision, in the BODY's frame (sim frame, y down).
export type LevelShape =
  | { readonly kind: "poly"; readonly verts: readonly number[] }
  | { readonly kind: "circle"; readonly x: number; readonly y: number; readonly radius: number };

export interface LevelBodyData {
  // Moved by the sim (followed each frame it moves), or fixed for good.
  readonly moving: boolean;
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  // What it collides as: the sim's outlines (`LevelData.flat`), or what the 3D
  // scene draws of it, in its own frame in three's axes (y up).
  readonly shapes: readonly LevelShape[];
  readonly meshes: readonly MeshData[];
}

// Triangles: three floats a vertex, three indices a triangle.
export interface MeshData {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

// The 3D scene's static solid meshes, in three's world frame, under a key that
// says which scene they are (the same scene's are not built twice).
export interface SceneryData {
  readonly key: string;
  readonly meshes: readonly MeshData[];
}

// A body of water, in the WORLD's frame (sim frame): its convex pieces, its
// current and its drag (see `WaterArea`).
export interface WaterData {
  readonly polys: readonly (readonly number[])[];
  readonly circles: readonly { readonly x: number; readonly y: number; readonly r: number }[];
  readonly flowX: number;
  readonly flowY: number;
  readonly drag: number;
}

export interface LevelData {
  readonly bodies: readonly LevelBodyData[];
  readonly waters: readonly WaterData[];
  // Collided as the sim's outlines in the plane (no 3D scene): the pieces are
  // held to the depth they break at. Otherwise as `bodies`' meshes and the
  // scenery (`SceneryData`), in 3D.
  readonly flat: boolean;
}

// A break (`ShatterEvent`), as plain numbers in the sim's frame.
export interface ShatterData {
  readonly at: readonly [number, number];
  readonly rotation: number;
  readonly point: readonly [number, number];
  readonly normal: readonly [number, number];
  readonly velocity: readonly [number, number];
  readonly spin: number;
}

// One rendered frame's worth: the time it covers, the bodies the sim moved
// since the last (index, x, y, rotation, ...), where the ball is while it is
// whole, and the breaks.
export interface FrameInput {
  readonly dt: number;
  readonly moved: readonly number[];
  readonly ball: readonly [number, number] | null;
  readonly breaks: readonly ShatterData[];
}

// What the page needs to draw the pieces this frame: per piece alive, its piece
// index, its pose after the last two steps (x y z qx qy qz qw, twice) and how
// much of it is left (1 whole, fading to 0), and how far past the last step the
// frame's time ran.
export const POSE_STRIDE = 16;
export interface FrameOutput {
  readonly alpha: number;
  readonly poses: Float32Array;
  readonly count: number;
  readonly awake: number;
}

export type ToWorker =
  | { readonly type: "init"; readonly spec: BreakSpec }
  | { readonly type: "level"; readonly level: LevelData }
  | { readonly type: "scenery"; readonly scenery: SceneryData | null }
  | { readonly type: "frame"; readonly seq: number; readonly input: FrameInput }
  | { readonly type: "reset" };

export type FromWorker =
  | { readonly type: "pieces"; readonly pieces: readonly FracturePiece[]; readonly maxChunks: number }
  | { readonly type: "frame"; readonly seq: number; readonly output: FrameOutput };

// ---------------------------------------------------------------------------

interface Live {
  readonly piece: number;
  body: RBody;
  // Which break threw it, so the oldest go first.
  readonly from: number;
  // The pose after the last two steps, for the interpolation.
  readonly prev: Float64Array;
  readonly cur: Float64Array;
  // Seconds since its break.
  age: number;
  // Its colliders, and whether its grace is over (`PIECE_GRACE`).
  readonly colliders: RAPIER_TYPES.Collider[];
  apart: boolean;
}

interface LevelBody {
  readonly rb: RBody;
  readonly moving: boolean;
}

export class ShardSim {
  // Every piece any break can throw, in one list, which the page draws from.
  pieces: readonly FracturePiece[] = [];

  private set: FractureSet | null = null;
  // Each piece's colliders, made once: a convex hull is computed when it is
  // described, which for a whole break was a 33 ms frame.
  private colliders: RAPIER_TYPES.ColliderDesc[][] = [];
  // Where each pattern's pieces start in `pieces`.
  private ballAt: number[] = [];
  private loopAt: number[] = [];
  private spec: BreakSpec | null = null;

  private world: RWorld | null = null;
  // The scene's static rock (`SceneryData`), kept across `bind`s.
  private scenery: { key: string; body: RBody } | null = null;
  // Whether the pieces are held to the plane (`LevelData.flat`).
  private flat = true;
  private warmed = false;
  private levelBodies: LevelBody[] = [];
  private ballBody: RBody | null = null;
  private ballCollider: RCollider | null = null;
  private waters: readonly WaterData[] = [];

  private readonly live: Live[] = [];
  // Per break still awake, how long its pieces have been at rest (`PILE_TIME`).
  private readonly piles = new Map<number, number>();
  private breaks = 0;
  private accumulator = 0;
  private rng = SEED;

  constructor(private readonly R: Rapier) {}

  // How many pieces can be alive at once.
  get maxChunks(): number {
    return MAX_CHUNKS;
  }

  // Step over one rendered frame (see `FrameInput`): the bodies the sim moved
  // and the ball followed, the breaks thrown, and the pieces' poses handed back.
  frame(input: FrameInput): FrameOutput {
    const world = this.world;
    if (!world) return { alpha: 0, poses: new Float32Array(0), count: 0, awake: 0 };
    this.follow(input);
    for (const e of input.breaks) this.shatter(e);
    // Gone once faded.
    this.age(Math.max(0, input.dt));
    for (let i = this.live.length - 1; i >= 0; i--) if (this.live[i]!.age >= FADE_START + FADE_TIME) this.remove(i);
    if (this.live.length === 0) {
      this.accumulator = 0;
      return { alpha: 0, poses: new Float32Array(0), count: 0, awake: 0 };
    }
    this.accumulator = Math.min(this.accumulator + Math.max(0, input.dt), STEP * MAX_STEPS);
    // Nothing to do while every piece is at rest and nothing has come to wake
    // one (a moving body, the ball): the engine is not stepped at all.
    const resting = this.live.every((c) => c.body.isSleeping()) && input.moved.length === 0 && !this.ballMoved && input.breaks.length === 0;
    if (resting) {
      this.accumulator %= STEP;
    } else {
      while (this.accumulator >= STEP) {
        this.accumulator -= STEP;
        this.water();
        for (const c of this.live) c.prev.set(c.cur);
        world.step();
        for (const c of this.live) {
          readPose(c.body, c.cur);
          rockToRest(c.body);
        }
        this.settlePiles();
      }
    }
    this.ballMoved = false;
    const poses = new Float32Array(this.live.length * POSE_STRIDE);
    let awake = 0;
    this.live.forEach((c, i) => {
      poses[i * POSE_STRIDE] = c.piece;
      poses.set(c.prev, i * POSE_STRIDE + 1);
      poses.set(c.cur, i * POSE_STRIDE + 8);
      poses[i * POSE_STRIDE + 15] = Math.min(1, Math.max(0, (FADE_START + FADE_TIME - c.age) / FADE_TIME));
      if (!c.body.isSleeping()) awake++;
    });
    return { alpha: this.accumulator / STEP, poses, count: this.live.length, awake };
  }

  // Everything gone and the generator reseeded, so a restart carries no glass
  // from the run that broke it.
  reset(): void {
    this.clearChunks();
    this.rng = SEED;
  }

  private clearChunks(): void {
    for (const c of this.live) this.world?.removeRigidBody(c.body);
    this.live.length = 0;
    this.piles.clear();
    this.accumulator = 0;
  }

  // ---------------------------------------------------------------------------

  // Cut every pattern of pieces for these things (render/glassFracture.ts).
  cut(spec: BreakSpec): void {
    this.spec = spec;
    const set = buildFractureSet(spec.ballRadius, spec.loop, undefined, spec.wall);
    const pieces: FracturePiece[] = [];
    const add = (patterns: readonly (readonly FracturePiece[])[]): number[] =>
      patterns.map((p) => {
        const at = pieces.length;
        pieces.push(...p);
        return at;
      });
    this.ballAt = add(set.ball);
    this.loopAt = add(set.loop);
    this.set = set;
    this.pieces = pieces;
    const R = this.R;
    this.colliders = pieces.map((p) => {
      const parts = p.bar
        ? barCapsules(R, p.bar)
        : p.parts
          ? p.parts.map((pts) => R.ColliderDesc.convexHull(pts))
          : [R.ColliderDesc.convexHull(p.hull)];
      if (parts.some((c) => !c)) throw new Error("GlassShards: a piece has no convex hull");
      // The piece's own mass, shared out over its parts (a bar's capsules
      // overlap at their ends, so their own volumes would count those twice).
      const mass = Math.max(MIN_PIECE_MASS, p.volume * QUARTZ_DENSITY);
      return parts.map((c) => c!.setMass(mass / parts.length).setRestitution(RESTITUTION).setFriction(FRICTION));
    });
  }

  // A physics world holding `level`'s collision, replacing any other.
  bind(level: LevelData): void {
    const R = this.R;
    const world = this.ensureWorld();
    this.clearChunks();
    for (const b of this.levelBodies) world.removeRigidBody(b.rb);
    if (this.ballBody) world.removeRigidBody(this.ballBody);
    this.flat = level.flat;
    this.levelBodies = level.bodies.map((body) => {
      const desc = body.moving ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.fixed();
      desc.setTranslation(body.x, -body.y, 0).setRotation(aboutZ(-body.rot));
      const rb = world.createRigidBody(desc);
      for (const s of level.flat ? body.shapes : []) {
        const c = levelCollider(R, s);
        if (c) world.createCollider(c.setRestitution(RESTITUTION).setFriction(FRICTION), rb);
      }
      for (const m of level.flat ? [] : body.meshes) {
        world.createCollider(R.ColliderDesc.trimesh(m.positions, m.indices).setRestitution(RESTITUTION).setFriction(FRICTION), rb);
      }
      return { rb, moving: body.moving };
    });
    this.waters = level.waters;
    // The ball, while it is whole, as a sphere the pieces of an earlier break
    // are pushed about by.
    this.ballBody = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0));
    this.ballCollider = world.createCollider(
      R.ColliderDesc.ball(this.spec?.ballRadius ?? 0.1).setRestitution(RESTITUTION).setFriction(FRICTION),
      this.ballBody,
    );
    this.ballCollider.setEnabled(false);
    if (!this.warmed) {
      this.warmed = true;
      this.warm();
    }
  }

  // The 3D scene's static rock, replacing any other; the same scene's again is
  // kept as it is (building its triangles into the engine's trees is a few
  // hundred milliseconds for the river's 700 thousand).
  setScenery(scenery: SceneryData | null): void {
    const world = this.ensureWorld();
    if ((scenery?.key ?? null) === (this.scenery?.key ?? null)) return;
    if (this.scenery) world.removeRigidBody(this.scenery.body);
    this.scenery = null;
    if (!scenery) return;
    const R = this.R;
    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    for (const m of scenery.meshes) {
      world.createCollider(R.ColliderDesc.trimesh(m.positions, m.indices).setRestitution(RESTITUTION).setFriction(FRICTION), body);
    }
    this.scenery = { key: scenery.key, body };
  }

  // The one world, made on first use and kept: the scenery in it outlives a
  // level's restart.
  private ensureWorld(): RWorld {
    if (this.world) return this.world;
    const world = new this.R.World({ x: 0, y: -GRAVITY, z: 0 });
    world.timestep = STEP;
    world.lengthUnit = LENGTH_UNIT;
    this.world = world;
    return world;
  }

  // One break thrown and stepped where nothing will see it, and taken away:
  // the engine's first break in a world cost three times any later one (its
  // first step 11-12 ms against 3), which is the engine growing into the work,
  // not the work. Done as the level is bound, in the worker, so the player's
  // first break is a later one. Leaves the world, the generator and the count
  // of breaks as they were.
  private warm(): void {
    const R = this.R;
    const world = this.world;
    const spec = this.spec;
    if (!world || !spec) return;
    const rng = this.rng;
    const breaks = this.breaks;
    // A kilometre below the level (the sim's y is down), onto a floor of its own.
    const depth = 1000;
    const floor = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -depth - spec.ballRadius - 0.1, 0));
    world.createCollider(R.ColliderDesc.cuboid(5, 0.1, 5).setRestitution(RESTITUTION).setFriction(FRICTION), floor);
    this.shatter({ at: [0, depth], rotation: 0, point: [0, depth + spec.ballRadius], normal: [0, -1], velocity: [0, 4], spin: 0 });
    for (let i = 0; i < 12; i++) {
      this.age(STEP);
      world.step();
    }
    this.clearChunks();
    world.removeRigidBody(floor);
    this.rng = rng;
    this.breaks = breaks;
  }

  // Whether the ball moved this frame (which may wake a piece).
  private ballMoved = false;

  // The level's moving bodies and the ball, where the sim has them now: a
  // body is only told where it is when it has moved, since a kinematic body
  // told where to be wakes everything touching it even where it already is
  // (170 of the river's 197 bodies were, every step, and 8 of 219 pieces ever
  // slept).
  private follow(input: FrameInput): void {
    const m = input.moved;
    for (let i = 0; i + 3 < m.length; i += 4) {
      const b = this.levelBodies[m[i]!];
      if (!b?.moving) continue;
      b.rb.setNextKinematicTranslation({ x: m[i + 1]!, y: -m[i + 2]!, z: 0 });
      b.rb.setNextKinematicRotation(aboutZ(-m[i + 3]!));
    }
    const whole = input.ball !== null;
    if (this.ballCollider!.isEnabled() !== whole) {
      this.ballCollider!.setEnabled(whole);
      this.ballMoved = true;
    }
    if (input.ball) {
      const t = this.ballBody!.translation();
      const [x, y] = input.ball;
      if (Math.abs(t.x - x) > 1e-7 || Math.abs(t.y + y) > 1e-7) {
        this.ballBody!.setNextKinematicTranslation({ x, y: -y, z: 0 });
        this.ballMoved = true;
      }
    }
  }

  // Water: its drag toward its current, and quartz's buoyancy, on every piece
  // awake in it.
  private water(): void {
    if (this.waters.length === 0) return;
    const lift = (WATER_DENSITY / QUARTZ_DENSITY) * GRAVITY;
    for (const c of this.live) {
      const b = c.body;
      if (b.isSleeping()) continue;
      const t = b.translation();
      const area = this.waters.find((w) => inWater(w, t.x, -t.y));
      if (!area) continue;
      const v = b.linvel();
      const m = b.mass();
      const k = area.drag * STEP;
      b.applyImpulse(
        { x: -m * k * (v.x - area.flowX), y: -m * k * (v.y + area.flowY) + m * lift * STEP, z: -m * k * v.z },
        true,
      );
    }
  }

  private shatter(e: ShatterData): void {
    const set = this.set;
    const spec = this.spec;
    if (!set || !spec) return;
    const from = this.breaks++;
    const at: V3 = [e.at[0], -e.at[1], 0];
    const v: V3 = [e.velocity[0], -e.velocity[1], 0];
    // The sim's spin is about its z, which points away from the camera: three's
    // is toward it.
    const w: V3 = [0, 0, -e.spin];
    const contact: V3 = [e.point[0], -e.point[1], 0];
    const n: V3 = [e.normal[0], -e.normal[1], 0];
    const into = Math.max(0, -dot(v, n));
    const kick = Math.min(KICK_MAX, KICK_MIN + KICK_PER_SPEED * into);

    // THE BALL: a pattern, its crushed pole turned onto the contact and
    // twisted about it at random.
    const p = Math.floor(this.random() * set.ball.length);
    const toContact = normalize([contact[0] - at[0], contact[1] - at[1], 0]);
    const turn = mulQ(axisAngle(toContact, this.random() * Math.PI * 2), fromTo([0, -1, 0], toContact));
    const ballPieces = set.ball[p]!;
    const meanVolume = ballPieces.reduce((a, c) => a + c.volume, 0) / ballPieces.length;
    ballPieces.forEach((piece, i) => {
      const r = rotateV(turn, piece.centre);
      const pos: V3 = [at[0] + r[0], at[1] + r[1], at[2] + r[2]];
      const out = normalize([pos[0] - contact[0], pos[1] - contact[1], pos[2] - contact[2]]);
      const speed = kick * (0.6 + 0.7 * this.random()) * (meanVolume / piece.volume) ** KICK_SIZE_EXPONENT;
      const spun = cross(w, r);
      this.spawn(from, this.ballAt[p]! + i, pos, turn, [
        v[0] + spun[0] + out[0] * speed,
        v[1] + spun[1] + out[1] * speed,
        v[2] + spun[2] + out[2] * speed,
      ], w, speed / Math.cbrt(piece.volume));
    });

    // THE LOOP, on top of the ball as it lay, in the screen's plane.
    const half = -e.rotation / 2;
    const spinTurn: Q = [0, 0, Math.sin(half), Math.cos(half)];
    const loopCentre = rotateV(spinTurn, [0, spec.ballRadius + spec.loopGap, 0]);
    this.ring(from, set.loop, this.loopAt, [at[0] + loopCentre[0], at[1] + loopCentre[1], 0], spinTurn, v);

    // The newest breaks take the room of the oldest.
    while (this.live.length > MAX_CHUNKS) this.remove(0);
  }

  // A ring's pieces, broken where it hung: a pattern, laid by `turn` about its
  // centre, dropping with `v` and a little of the break's shock.
  private ring(
    from: number,
    patterns: readonly (readonly FracturePiece[])[],
    starts: number[],
    centre: V3,
    turn: Q,
    v: V3,
  ): void {
    const p = Math.floor(this.random() * patterns.length);
    patterns[p]!.forEach((piece, i) => {
      const r = rotateV(turn, piece.centre);
      const out = normalize([r[0], r[1], r[2]]);
      const speed = RING_KICK[0] + (RING_KICK[1] - RING_KICK[0]) * this.random();
      this.spawn(
        from,
        starts[p]! + i,
        [centre[0] + r[0], centre[1] + r[1], centre[2] + r[2]],
        turn,
        [v[0] + out[0] * speed, v[1] + out[1] * speed + 0.3 * speed, v[2] + out[2] * speed],
        [0, 0, 0],
        speed / Math.cbrt(piece.volume),
      );
    });
  }

  private spawn(from: number, piece: number, pos: V3, q: Q, v: V3, w: V3, tumble: number): void {
    const R = this.R;
    const world = this.world!;
    const parts = this.colliders[piece]!;
    // A tumble about a random axis, as fast as its kick turns a piece its size.
    const axis = normalize([this.random() * 2 - 1, this.random() * 2 - 1, this.random() * 2 - 1]);
    const spin = tumble * 0.5 * this.random();
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(pos[0], pos[1], pos[2])
        .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
        // Held to the plane (`flat`), no speed through it: the lock below holds
        // a body's speed along a locked axis as well as its position, so any
        // would last for ever.
        .setLinvel(v[0], v[1], this.flat ? 0 : v[2])
        .setAngvel({ x: w[0] + axis[0] * spin, y: w[1] + axis[1] * spin, z: w[2] + axis[2] * spin })
        .setLinearDamping(AIR_DAMPING)
        .setAngularDamping(SPIN_DAMPING)
        // Without a 3D scene to land on, each piece stays at the depth it broke
        // at: the collision is then outlines extruded into a slab, so a piece
        // bounced out of the plane fell off the end of the level (2 s after a
        // 3 m drop, pieces were 3.5 m out). It tumbles in 3D all the same.
        .enabledTranslations(true, true, !this.flat)
        .setCcdEnabled(true),
    );
    const colliders = parts.map((part) => world.createCollider(part.setCollisionGroups(IN_GRACE), body));
    const cur = new Float64Array(7);
    readPose(body, cur);
    this.live.push({ piece, body, from, prev: Float64Array.from(cur), cur, age: 0, colliders, apart: false });
  }

  // Put each break's pieces to sleep together once the pile is at rest.
  private settlePiles(): void {
    const speed = new Map<number, { sum: number; max: number; n: number }>();
    for (const c of this.live) {
      if (c.body.isSleeping()) continue;
      const v = c.body.linvel();
      const s = Math.hypot(v.x, v.y, v.z);
      const e = speed.get(c.from) ?? { sum: 0, max: 0, n: 0 };
      e.sum += s;
      e.max = Math.max(e.max, s);
      e.n++;
      speed.set(c.from, e);
    }
    for (const from of [...this.piles.keys()]) if (!speed.has(from)) this.piles.delete(from);
    for (const [from, e] of speed) {
      const still = e.sum / e.n < PILE_SPEED && e.max < PILE_MAX_SPEED;
      const t = still ? (this.piles.get(from) ?? 0) + STEP : 0;
      this.piles.set(from, t);
      if (t < PILE_TIME) continue;
      for (const c of this.live) if (c.from === from) c.body.sleep();
      this.piles.delete(from);
    }
  }

  // Every piece `dt` older, colliding with the other pieces once its grace is
  // over (`PIECE_GRACE`).
  private age(dt: number): void {
    for (const c of this.live) {
      c.age += dt;
      if (!c.apart && c.age >= PIECE_GRACE) {
        c.apart = true;
        for (const k of c.colliders) k.setCollisionGroups(AFTER_GRACE);
      }
    }
  }

  private remove(i: number): void {
    const [c] = this.live.splice(i, 1);
    if (c) this.world!.removeRigidBody(c.body);
  }

  private random(): number {
    let t = (this.rng = (this.rng + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// A piece of round bar as capsules along its centreline: three of them, each
// the bar's radius about a chord of its share of the line.
function barCapsules(R: Rapier, bar: { readonly points: Float32Array; readonly radius: number }): RAPIER_TYPES.ColliderDesc[] {
  const n = bar.points.length / 3;
  const point = (i: number): V3 => [bar.points[i * 3]!, bar.points[i * 3 + 1]!, bar.points[i * 3 + 2]!];
  const out: RAPIER_TYPES.ColliderDesc[] = [];
  const CAPSULES = 3;
  for (let k = 0; k < CAPSULES; k++) {
    const a = point(Math.round((k * (n - 1)) / CAPSULES));
    const b = point(Math.round(((k + 1) * (n - 1)) / CAPSULES));
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    const q = fromTo([0, 1, 0], normalize(d));
    out.push(
      R.ColliderDesc.capsule(len / 2, bar.radius)
        .setTranslation((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
        .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }),
    );
  }
  return out;
}

// One of a level body's pieces as a collider on that body's physics body: its
// outline, in the body's frame, as a prism through the gameplay plane.
function levelCollider(R: Rapier, s: LevelShape): RAPIER_TYPES.ColliderDesc | null {
  if (s.kind === "circle") {
    // A disc through the plane: a cylinder, its axis (y) turned onto z.
    return R.ColliderDesc.cylinder(LEVEL_DEPTH, s.radius)
      .setTranslation(s.x, -s.y, 0)
      .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
  }
  const n = s.verts.length / 2;
  if (n < 3) return null;
  const pts = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const x = s.verts[i * 2]!;
    const y = -s.verts[i * 2 + 1]!;
    pts.set([x, y, -LEVEL_DEPTH, x, y, LEVEL_DEPTH], i * 6);
  }
  return R.ColliderDesc.convexHull(pts);
}

// Whether a point (sim frame) is in a body of water: inside any of its convex
// pieces, of either winding.
function inWater(w: WaterData, x: number, y: number): boolean {
  for (const c of w.circles) if ((x - c.x) ** 2 + (y - c.y) ** 2 <= c.r * c.r) return true;
  for (const p of w.polys) {
    const n = p.length / 2;
    let sign = 0;
    let inside = true;
    for (let i = 0; i < n && inside; i++) {
      const ax = p[i * 2]!;
      const ay = p[i * 2 + 1]!;
      const bx = p[((i + 1) % n) * 2]!;
      const by = p[((i + 1) % n) * 2 + 1]!;
      const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (cr === 0) continue;
      const s = Math.sign(cr);
      if (sign === 0) sign = s;
      else if (s !== sign) inside = false;
    }
    if (inside) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------

type V3 = [number, number, number];
// x, y, z, w
type Q = [number, number, number, number];

// A piece that has all but stopped moving loses its rocking (`ROCK_DAMPING`).
function rockToRest(b: RBody): void {
  if (b.isSleeping()) return;
  const v = b.linvel();
  if (v.x * v.x + v.y * v.y + v.z * v.z > ROCK_SPEED * ROCK_SPEED) return;
  const w = b.angvel();
  const k = Math.max(0, 1 - ROCK_DAMPING * STEP);
  b.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, false);
}

function readPose(b: RBody, out: Float64Array): void {
  const t = b.translation();
  const r = b.rotation();
  out[0] = t.x;
  out[1] = t.y;
  out[2] = t.z;
  out[3] = r.x;
  out[4] = r.y;
  out[5] = r.z;
  out[6] = r.w;
}

function aboutZ(angle: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) };
}

function axisAngle(axis: V3, angle: number): Q {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

// The shortest turn taking unit `a` onto unit `b`.
function fromTo(a: V3, b: V3): Q {
  const d = dot(a, b);
  if (d < -0.999999) {
    const axis = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(a, b);
  const q: Q = [c[0], c[1], c[2], 1 + d];
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function mulQ(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function rotateV(q: Q | { x: number; y: number; z: number; w: number }, v: readonly [number, number, number]): V3 {
  const [qx, qy, qz, qw] = Array.isArray(q) ? q : [q.x, q.y, q.z, q.w];
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)];
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
