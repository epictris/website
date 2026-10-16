// The glass ball's shards: what it and its loop come apart into when it breaks
// (see `BallLevel.shatterIfStruck`; its chain and hook simply go), as solid
// chunks that fall, bounce, tumble and come to rest on the level, then fade -
// the PAGE'S side.
//
// Entirely render-side, on the boundary the debris and the sparks keep
// (`render/debris.ts`, docs/sparks.md): the sim contributes one fact per break
// (`ShatterEvent`) and nothing here is ever read back by the sim - a chunk can
// be pushed by the level and by a respawned ball, and never pushes either.
//
// The pieces and their physics are glassShardsSim.ts, run in a worker
// (glassShardsWorker.ts) so the page's frame never steps them. This side reads
// the level once into plain data (`LevelData`), then each frame hands over the
// breaks, the bodies the sim moved and where the ball is, and draws the poses
// that come back - a frame late, which for debris is invisible. A grab, which
// must draw the same shower every time, waits for each frame's answer
// (`flush`).
//
// The 3D scene draws the pieces (render3d/shardVisual.ts); the 2D path outlines
// them (`draw`).

import { PX } from "../engine/units";
import { Area2D, AnimatableBody2D, StaticBody2D, VineLink, WaterArea, shapesCollide } from "../engine/body";
import type { CollisionObject2D, CollisionShape2D } from "../engine/body";
import { shapeVertices, shapeWorldVertices } from "../engine/shapes";
import type { World } from "../engine/world";
import { BallHook } from "../classes/ballHook";
import { BallPlayer } from "../classes/ballPlayer";
import type { BallLevel, ShatterEvent } from "../level/ballLevel";
import type { FracturePiece } from "./glassFracture";
import { glassWall } from "../render3d/glassWall";
import type { ShardCollisionSource } from "../render3d/shardCollision";
import {
  POSE_STRIDE,
  type BreakSpec,
  type FromWorker,
  type FrameOutput,
  type LevelData,
  type LevelShape,
  type ShatterData,
  type ToWorker,
} from "./glassShardsSim";

// The things that break, as their visuals draw them (render3d/ballVisual.ts).
function breakSpec(ballRadius: number): BreakSpec {
  return {
    ballRadius,
    wall: glassWall.value,
    loop: { a: BallPlayer.LOOP_RADIUS, b: BallPlayer.LOOP_RADIUS, radius: BallPlayer.LOOP_RADIUS * 0.42 },
    loopGap: BallPlayer.LOOP_GAP,
  };
}

// A piece in flight or at rest, as the renderers read it: which piece, its
// pose this rendered frame, in three's frame (y up), and how much of it is left
// as it fades away (1 whole, 0 gone).
export interface Chunk {
  piece: number;
  fade: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

interface FollowedBody {
  readonly body: CollisionObject2D;
  readonly moving: boolean;
  // Its `transformVersion` when last handed over: only a body that has moved
  // since is (see glassShardsSim.ts `follow`).
  version: number;
}

export class GlassShards {
  // Every piece any break can throw, in one list: the 3D layer builds its
  // geometry from it once (see `piecesVersion`).
  pieces: readonly FracturePiece[] = [];
  piecesVersion = 0;
  // How many chunks can be alive at once (the 3D batch's size).
  maxChunks = 0;
  readonly chunks: Chunk[] = [];

  private worker: Worker | null = null;
  // What the pieces land on in 3D (render3d/shardCollision.ts), and the
  // version of it last handed over; without one, the sim's outlines.
  private collision: ShardCollisionSource<CollisionObject2D> | null = null;
  private collisionVersion = -1;
  private sceneryKey: string | null = null;
  private cutFor = "";
  private piecesArrived: (() => void) | null = null;
  private boundTo: World | null = null;
  private followed: FollowedBody[] = [];
  private readonly pending: ShatterData[] = [];
  // The worker's last answer, and how many chunks it held.
  private last: FrameOutput | null = null;
  private alive = 0;
  // Frames sent and answered, and the grabs waiting on them (`flush`).
  private sent = 0;
  private answered = 0;
  private readonly flushes: { seq: number; resolve: () => void }[] = [];

  // Ready this page for `level`'s breaks: the worker started, the pieces cut
  // for its ball, and its collision handed over. Called as the level loads,
  // so the first break meets none of it; `advance` also hands over a level it
  // has not seen (a restart builds a new one).
  async prepare(level: BallLevel): Promise<void> {
    const worker = this.start();
    const cutFor = `${level.ball.radius}:${glassWall.value}`;
    if (this.cutFor !== cutFor) {
      this.cutFor = cutFor;
      const arrived = new Promise<void>((resolve) => (this.piecesArrived = resolve));
      this.send(worker, { type: "init", spec: breakSpec(level.ball.radius) });
      await arrived;
    }
    this.bind(level);
  }

  // Land the pieces on what `source` draws (the 3D scene), from the next bind.
  useCollision(source: ShardCollisionSource<CollisionObject2D> | null): void {
    this.collision = source;
    this.collisionVersion = -1;
  }

  ingest(events: readonly ShatterEvent[]): void {
    for (const e of events) this.pending.push(shatterData(e));
  }

  get active(): boolean {
    return this.alive > 0;
  }

  // Hand the worker this frame (`dt` seconds of the render clock, a fixed 1/60
  // in a grab) and draw the latest poses it has sent back.
  advance(dt: number, level: BallLevel | null): void {
    const worker = this.worker;
    if (!worker || !level || this.pieces.length === 0) return;
    if (this.boundTo !== level.world || (this.collision && this.collision.collisionVersion() !== this.collisionVersion)) this.bind(level);
    const breaks = this.pending.splice(0);
    if (this.alive === 0 && breaks.length === 0) return;
    const moved: number[] = [];
    this.followed.forEach((f, i) => {
      if (!f.moving || f.body.transformVersion === f.version) return;
      f.version = f.body.transformVersion;
      const p = f.body.globalPosition;
      moved.push(i, p.x, p.y, f.body.globalRotation);
    });
    const ball = level.ball.shattered ? null : ([level.ball.globalPosition.x, level.ball.globalPosition.y] as const);
    if (breaks.length > 0) this.alive = Math.max(this.alive, 1);
    this.send(worker, { type: "frame", seq: ++this.sent, input: { dt, moved, ball, breaks } });
  }

  // Resolves once the worker has answered every frame handed to it, so a grab
  // draws the poses of the frame it is drawing.
  flush(): Promise<void> {
    if (this.answered >= this.sent) return Promise.resolve();
    return new Promise((resolve) => this.flushes.push({ seq: this.sent, resolve }));
  }

  // Everything gone and the worker's generator reseeded, so a restart carries
  // no glass from the run that broke it.
  reset(): void {
    if (this.worker) this.send(this.worker, { type: "reset" });
    this.pending.length = 0;
    this.chunks.length = 0;
    this.last = null;
    this.alive = 0;
  }

  // The 2D path's drawing: each chunk as the outline it casts on the gameplay
  // plane, a pale fill and a bright edge, which is how clear glass reads
  // against anything.
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.chunks.length === 0) return;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = PX * 0.6;
    const pts: [number, number][] = [];
    for (const c of this.chunks) {
      const hull = this.pieces[c.piece]!.hull;
      pts.length = 0;
      for (let i = 0; i < hull.length; i += 3) {
        const [x, y] = rotate(c, hull[i]!, hull[i + 1]!, hull[i + 2]!);
        pts.push([c.x + x, -(c.y + y)]);
      }
      const outline = convexHull2(pts);
      if (outline.length < 3) continue;
      ctx.beginPath();
      outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = `rgba(205, 228, 245, ${0.22 * c.fade})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(240, 248, 255, ${0.75 * c.fade})`;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./glassShardsWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<FromWorker>) => this.receive(ev.data);
    worker.onerror = (ev) => console.error(`[glass shards] the worker failed: ${ev.message}`);
    this.worker = worker;
    return worker;
  }

  private send(worker: Worker, m: ToWorker): void {
    worker.postMessage(m);
  }

  private receive(m: FromWorker): void {
    if (m.type === "pieces") {
      this.pieces = m.pieces;
      this.maxChunks = m.maxChunks;
      this.piecesVersion++;
      this.piecesArrived?.();
      this.piecesArrived = null;
      return;
    }
    this.answered = Math.max(this.answered, m.seq);
    this.last = m.output;
    this.alive = m.output.count;
    this.pose(m.output);
    for (let i = this.flushes.length - 1; i >= 0; i--) {
      if (this.flushes[i]!.seq <= this.answered) this.flushes.splice(i, 1)[0]!.resolve();
    }
  }

  // The chunks at the worker's last answer: `alpha` of the way from each one's
  // previous step to its last, positions lerped and turns nlerped.
  private pose(o: FrameOutput): void {
    const p = o.poses;
    const t = o.alpha;
    this.chunks.length = o.count;
    for (let i = 0; i < o.count; i++) {
      const at = i * POSE_STRIDE;
      const a = at + 1;
      const b = at + 8;
      const c = (this.chunks[i] ??= { piece: 0, fade: 1, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
      c.piece = p[at]!;
      c.fade = p[at + 15]!;
      c.x = p[a]! + (p[b]! - p[a]!) * t;
      c.y = p[a + 1]! + (p[b + 1]! - p[a + 1]!) * t;
      c.z = p[a + 2]! + (p[b + 2]! - p[a + 2]!) * t;
      const s = p[a + 3]! * p[b + 3]! + p[a + 4]! * p[b + 4]! + p[a + 5]! * p[b + 5]! + p[a + 6]! * p[b + 6]! < 0 ? -1 : 1;
      const qx = p[a + 3]! + (s * p[b + 3]! - p[a + 3]!) * t;
      const qy = p[a + 4]! + (s * p[b + 4]! - p[a + 4]!) * t;
      const qz = p[a + 5]! + (s * p[b + 5]! - p[a + 5]!) * t;
      const qw = p[a + 6]! + (s * p[b + 6]! - p[a + 6]!) * t;
      const n = Math.hypot(qx, qy, qz, qw) || 1;
      c.qx = qx / n;
      c.qy = qy / n;
      c.qz = qz / n;
      c.qw = qw / n;
    }
  }

  // Hand the worker `level`'s collision, replacing any other: every piece of
  // every body the ball would collide with, and the water.
  private bind(level: BallLevel): void {
    const worker = this.start();
    this.boundTo = level.world;
    this.chunks.length = 0;
    this.last = null;
    this.alive = 0;
    const ballShape = level.ball.primaryShape();
    this.followed = [];
    // In 3D, what the scene draws; otherwise (or until the scene is ready) the
    // sim's own outlines, flat.
    this.collisionVersion = this.collision?.collisionVersion() ?? -1;
    const collision = this.collision?.shardCollision() ?? null;
    const sceneryKey = collision?.scenery?.key ?? null;
    if (sceneryKey !== this.sceneryKey) {
      this.sceneryKey = sceneryKey;
      this.send(worker, { type: "scenery", scenery: collision?.scenery ?? null });
    }
    const bodies: LevelData["bodies"][number][] = [];
    for (const body of level.world.bodies) {
      // Not the ball or its hook (the ball is followed on its own), and not a
      // vine: the ball passes through vines, and a vine sways every frame, so
      // a piece touching one never came to rest.
      if (body instanceof Area2D || body instanceof BallPlayer || body instanceof BallHook || body instanceof VineLink) continue;
      const solid = body.getShapes().filter((s) => shapesCollide(ballShape, s));
      if (solid.length === 0) continue;
      const moving = !(body instanceof StaticBody2D) || body instanceof AnimatableBody2D;
      const p = body.globalPosition;
      bodies.push({
        moving,
        x: p.x,
        y: p.y,
        rot: body.globalRotation,
        shapes: collision ? [] : solid.map((s) => bodyShape(body, s)),
        meshes: collision?.bodyMeshes(body) ?? [],
      });
      this.followed.push({ body, moving, version: body.transformVersion });
    }
    const waters = level.world.areas
      .filter((a): a is WaterArea => a instanceof WaterArea)
      .map((w) => {
        const shapes = w.getShapes();
        const flow = w.flowVelocity;
        return {
          polys: shapes.filter((s) => s.shape.kind !== "circle").map((s) => shapeWorldVertices(s).flatMap((v) => [v.x, v.y])),
          circles: shapes.flatMap((s) =>
            s.shape.kind === "circle" ? [{ x: s.globalPosition.x, y: s.globalPosition.y, r: s.shape.radius }] : [],
          ),
          flowX: flow.x,
          flowY: flow.y,
          drag: w.drag,
        };
      });
    this.send(worker, { type: "level", level: { bodies, waters, flat: collision === null } });
  }
}

// A piece of `body`'s collision in the body's own frame.
function bodyShape(body: CollisionObject2D, s: CollisionShape2D): LevelShape {
  const bodyRot = body.globalRotation;
  const offset = s.globalPosition.sub(body.globalPosition).rotated(-bodyRot);
  if (s.shape.kind === "circle") return { kind: "circle", x: offset.x, y: offset.y, radius: s.shape.radius };
  const rot = s.globalRotation - bodyRot;
  return {
    kind: "poly",
    verts: shapeVertices(s.shape).flatMap((v) => {
      const p = v.rotated(rot).add(offset);
      return [p.x, p.y];
    }),
  };
}

function shatterData(e: ShatterEvent): ShatterData {
  return {
    at: [e.at.x, e.at.y],
    rotation: e.rotation,
    point: [e.point.x, e.point.y],
    normal: [e.normal.x, e.normal.y],
    velocity: [e.velocity.x, e.velocity.y],
    spin: e.spin,
  };
}

// A local vector turned by a chunk's quaternion.
function rotate(c: Chunk, x: number, y: number, z: number): [number, number, number] {
  const { qx, qy, qz, qw } = c;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

// The convex outline of points in the plane (Andrew's monotone chain).
function convexHull2(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const turn = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && turn(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && turn(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
