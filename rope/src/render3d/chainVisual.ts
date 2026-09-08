// Every chain in the scene, as one `InstancedMesh` of forged links.
//
// One mesh for all of them - the ball's chain, the level's scene chains - because
// a chain is hundreds of tiny identical objects and the only thing that differs
// per link is a transform and a tint. Per-link `Mesh` churn would allocate and
// re-add objects to the scene graph every frame at exactly the moment the frame
// is busiest (a chain coiled on the ball is ~500 links); an InstancedMesh writes
// matrices into a buffer it already owns and sets `count`.
//
// WHERE the links fall is not decided here. `walkChain`
// (render/chainMetrics.ts) is shared with the 2D renderer, so the 3D chain
// cannot drift from the 2D one on the one part of this that has ever been wrong:
// the continuous arc walk that a coil depends on (session-1467f).
//
// The path itself comes from the wrap NODES resolved against the render
// transforms (`RopeContact.renderGlobalPosition(alpha)`), exactly as the 2D
// renderer takes it, which is what keeps the chain welded to the drawn ball and
// the drawn anchor rather than to their 60 Hz sim positions.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import { BallPlayer } from "../classes/ballPlayer";
import { PX } from "../engine/units";
import { CHAIN_LINK_LEN, CHAIN_LINK_W, walkChain } from "../render/chainMetrics";
import { MANACLE_BAND, MANACLE_RADIUS, MANACLE_REACH, MANACLE_THICKNESS } from "../lib/manacle";
import { FORGED_SMALL, forgedMetal } from "./ballVisual";
import { threeY } from "./space";
import type { Scene3DLevel } from "./scene";

// A link is an oval ring: a torus stretched along the path. The tube is the bar
// stock it is forged from, and it is what a chain's weight reads as.
const LINK_TUBE = CHAIN_LINK_W * 0.42;
const LINK_HALF_LEN = CHAIN_LINK_LEN * 0.62; // overlap neighbours so links interlock

// Fixed alternation, as in 2D: a broad link lies in the gameplay plane, the next
// is the same link twisted 90 degrees about the path tangent. In 2D that twist
// could only be drawn as a thinner ellipse; here it is the actual rotation, and
// it is what makes a chain read as interlocking rather than as a row of beads.
const TWIST = Math.PI / 2;

// White: the instance colour MULTIPLIES the shared iron material, so a chain
// with no authored colour must not tint it at all.
const DEFAULT_CHAIN_COLOR = new THREE.Color(1, 1, 1);

// Starting capacity. A chain wound onto the ball re-samples every 0.25 rad, so
// the link count is bounded by path length rather than by node count; this is
// generous for the ball's 1.8 m reach plus a handful of scene chains, and the
// buffer grows if a level ever needs more.
const INITIAL_LINKS = 1024;

export class ChainLayer {
  private mesh: THREE.InstancedMesh;
  private capacity = INITIAL_LINKS;
  private count = 0;
  private readonly geometry: THREE.BufferGeometry;
  private readonly manacle: THREE.Group;
  private readonly manacleGeometry: THREE.BufferGeometry[] = [];
  // Scratch, reused every frame: a chain sync must not allocate.
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);
  private readonly axis = new THREE.Vector3();
  private readonly spin = new THREE.Quaternion();
  private readonly tint = new THREE.Color();
  private readonly path: Vec2[] = [];

  constructor(private readonly scene: THREE.Scene) {
    // Built along +x so the instance rotation is "turn +x onto the tangent",
    // which is the same statement the 2D renderer makes with `atan2`.
    const torus = new THREE.TorusGeometry(LINK_HALF_LEN, LINK_TUBE, 6, 14);
    torus.scale(1, CHAIN_LINK_W / LINK_HALF_LEN, 1);
    this.geometry = torus;
    this.mesh = this.makeMesh(this.capacity);
    scene.add(this.mesh);

    this.manacle = buildManacle(this.manacleGeometry);
    this.manacle.visible = false;
    scene.add(this.manacle);
  }

  private makeMesh(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, forgedMetal(FORGED_SMALL), capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The count is set per frame; three culls by the mesh's own bounds, which
    // for a chain that moves across the whole level is never a useful test.
    mesh.frustumCulled = false;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    return mesh;
  }

  private grow(needed: number): void {
    let capacity = this.capacity;
    while (capacity < needed) capacity *= 2;
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.capacity = capacity;
    this.mesh = this.makeMesh(capacity);
    this.scene.add(this.mesh);
  }

  // Every chain on the level, laid this frame.
  sync(level: Scene3DLevel, alpha: number): void {
    this.count = 0;
    this.manacle.visible = false;

    for (const chain of level.sceneChains) {
      const spans = chain.rope.getSpans();
      if (!spans.length) continue;
      this.path.length = 0;
      this.path.push(spans[0]!.from.contact.renderGlobalPosition(alpha));
      for (const s of spans) this.path.push(s.to.contact.renderGlobalPosition(alpha));
      this.tint.set(chain.color ?? DEFAULT_CHAIN_COLOR);
      this.lay(this.path);
    }

    const ball = level.ball;
    const chain = ball?.chain;
    if (ball && chain) {
      // The slack sim's polyline, loop→anchor — the drape while the chain has
      // slack, the straight wrap path when it is taut (see SlackChain).
      const loopToAnchor =
        ball.chainSlack?.pathLoopToAnchor(alpha) ??
        chain.path().map((n) => n.contact.renderGlobalPosition(alpha));
      if (loopToAnchor.length >= 2) {
        // Anchor first, ball last: the links then stay put in the world as the
        // chain reels and are consumed INTO the ball, rather than the whole
        // chain compressing toward the anchor (see chainMetrics.ts). The path
        // already ends on the manacle's hinge pin - the chain's own end node,
        // free or bitten; the rim the drape is pinned to around a rail - so the
        // links run to exactly where the cuff is shackled. See the 2D renderer,
        // whose placement this mirrors.
        this.path.length = 0;
        for (let i = loopToAnchor.length - 1; i >= 0; i--) {
          this.path.push(loopToAnchor[i]!);
        }
        this.path.push(ball.renderPosition(alpha));
        this.tint.set(DEFAULT_CHAIN_COLOR);
        this.lay(this.path);

        // The manacle at the far end - the flying hook, the dangling tip, or the
        // anchor - wherever the sim says it is (`BallPlayer.manaclePose`).
        // Turned about z to face `dir` with its hinge, then a quarter turn about
        // its own x, so the ring's axis lies in the gameplay plane square to
        // the chain and the ring is seen edge-on: a shackle trailing its chain,
        // a cuff driven half into the face it bit, or a ring with the bar of a
        // rail through it. "ZXY" applies z first, then x about the turned
        // frame, which is the order that reading needs.
        const pose = ball.manaclePose(alpha);
        if (pose) {
          this.manacle.position.set(pose.centre.x, threeY(pose.centre.y), 0);
          this.manacle.rotation.set(Math.PI / 2, 0, Math.atan2(threeY(pose.dir.y), pose.dir.x), "ZXY");
          this.manacle.visible = true;
        }
      }
    }

    // A chain longer than the buffer truncates for one frame and the buffer is
    // resized for the next, rather than being resized mid-walk - which would
    // throw away every matrix already written into it this frame.
    if (this.count > this.capacity) this.grow(this.count);
    this.mesh.count = Math.min(this.count, this.capacity);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private lay(points: readonly Vec2[]): void {
    walkChain(points, ({ mid, dir, broad }) => {
      const i = this.count++;
      if (i >= this.capacity) return; // grown on the next frame; see below
      // Turn the link's +x onto the tangent (in three's frame), then twist every
      // other link about that tangent.
      const angle = Math.atan2(threeY(dir.y), dir.x);
      this.axis.set(Math.cos(angle), Math.sin(angle), 0);
      // Turn about +z first, then twist about the tangent: `multiply` composes
      // right-to-left, so the argument is the rotation applied first.
      this.q.setFromAxisAngle(this.axis, broad ? 0 : TWIST);
      this.spin.setFromAxisAngle(FORWARD, angle);
      this.q.multiply(this.spin);
      this.pos.set(mid.x, threeY(mid.y), 0);
      this.m.compose(this.pos, this.q, this.scl);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.instanceColor?.setXYZ(i, this.tint.r, this.tint.g, this.tint.b);
    });
  }

  clear(): void {
    this.count = 0;
    this.mesh.count = 0;
    this.manacle.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.mesh, this.manacle);
    this.mesh.dispose();
    this.geometry.dispose();
    for (const g of this.manacleGeometry) g.dispose();
    this.manacleGeometry.length = 0;
  }
}

const FORWARD = new THREE.Vector3(0, 0, 1);

// The chain's far end as an iron manacle: a ring with the two jaws pinned
// together at the hinge, where the chain is shackled, and shut on each other
// under the lock opposite it. Built rather than authored, because it is four
// primitives and a GLTF for it would be an asset to keep in step with a shape
// nobody is going to redesign. +x points toward the hinge and the chain,
// matching the 2D renderer's `drawManacle`; the group is turned so the ring
// stands edge-on to the camera (see `sync`).
//
// Drawn shut always, for the reason `drawManacle` gives - the drawn shape has to
// BE the bar the sim collides as - and everything is fitted inside that bar for
// the same reason: the lock housing IS the bar's thickness, and the knuckle is
// set in from the ring's end by its own diameter.
function buildManacle(owned: THREE.BufferGeometry[]): THREE.Group {
  const g = new THREE.Group();
  // The same forged iron the links are, at the same scale: the manacle is the
  // end of the chain rather than a different object bolted to it.
  const iron = forgedMetal(FORGED_SMALL);
  const R = MANACLE_RADIUS;
  const BAR = MANACLE_BAND / 2; // the bar's radius, so the cuff's outer edge is the reach
  const T = MANACLE_THICKNESS;

  const cuff = new THREE.TorusGeometry(R, BAR, 8, 28);
  owned.push(cuff);
  const ring = new THREE.Mesh(cuff, iron);
  ring.castShadow = true;
  g.add(ring);

  // Lock over the mouth, holding the two jaw tips shut. Set inward off the
  // band's outer edge, as in 2D; its depth through the ring's axis is the
  // bar's thickness, which after the group's quarter turn is what the camera
  // sees across the cuff.
  const lockGeo = new THREE.BoxGeometry(2.6 * PX, 2.8 * PX, T);
  owned.push(lockGeo);
  const lock = new THREE.Mesh(lockGeo, iron);
  lock.position.set(-MANACLE_REACH + 1.3 * PX, 0, 0);
  lock.castShadow = true;
  g.add(lock);

  // Hinge knuckle: the pin's barrel, its axis along the ring's own, which the
  // chain's first link is hooked through. A cylinder stands along y; turned
  // onto z here.
  const knuckleGeo = new THREE.CylinderGeometry(T / 2, T / 2, 1.8 * PX, 12);
  owned.push(knuckleGeo);
  const knuckle = new THREE.Mesh(knuckleGeo, iron);
  knuckle.rotation.x = Math.PI / 2;
  knuckle.position.set(MANACLE_REACH - T / 2, 0, 0);
  knuckle.castShadow = true;
  g.add(knuckle);

  return g;
}

// Re-exported so a caller can size a scene against the chain's reach without
// importing the avatar for one constant.
export const CHAIN_REACH = BallPlayer.CHAIN_MAX_LENGTH;
