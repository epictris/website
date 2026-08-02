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
      const spans = chain.getSpans();
      if (spans.length) {
        // Anchor first, ball last: the links then stay put in the world as the
        // chain reels and are consumed INTO the ball, rather than the whole
        // chain compressing toward the anchor (see chainMetrics.ts).
        this.path.length = 0;
        for (let i = spans.length - 1; i >= 0; i--) {
          this.path.push(spans[i]!.to.contact.renderGlobalPosition(alpha));
        }
        this.path.push(spans[0]!.from.contact.renderGlobalPosition(alpha));
        this.path.push(ball.renderPosition(alpha));
        this.tint.set(DEFAULT_CHAIN_COLOR);
        this.lay(this.path);

        // The manacle at the far end - the flying hook, the dangling tip, or the
        // anchor - with its housing facing the span it hangs from.
        const last = spans[spans.length - 1]!;
        const tip = last.to.contact.renderGlobalPosition(alpha);
        const prev = last.from.contact.renderGlobalPosition(alpha);
        const dir =
          tip.distanceTo(prev) > 1e-5 ? tip.directionTo(prev) : ball.renderLoopDirection(alpha);
        this.manacle.position.set(tip.x, threeY(tip.y), 0);
        this.manacle.rotation.z = Math.atan2(threeY(dir.y), dir.x);
        this.manacle.visible = true;
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

// The chain's far end as an iron manacle: a cuff band, a lock housing on the
// chain side, a hinge pin opposite. Built rather than authored, because it is
// four primitives and a GLTF for it would be an asset to keep in step with a
// shape nobody is going to redesign. +x points toward the chain, matching the
// 2D renderer's `drawManacle`.
function buildManacle(owned: THREE.BufferGeometry[]): THREE.Group {
  const g = new THREE.Group();
  // The same forged iron the links are, at the same scale: the manacle is the
  // end of the chain rather than a different object bolted to it.
  const iron = forgedMetal(FORGED_SMALL);
  const R = 4.5 * PX; // the same cuff radius the 2D manacle is drawn at

  const band = new THREE.TorusGeometry(R, R * 0.18, 8, 20);
  owned.push(band);
  const cuff = new THREE.Mesh(band, iron);
  cuff.castShadow = true;
  g.add(cuff);

  const housing = new THREE.BoxGeometry(R * 0.75, R * 0.9, R * 0.6);
  owned.push(housing);
  const lock = new THREE.Mesh(housing, iron);
  lock.position.set(R, 0, 0);
  lock.castShadow = true;
  g.add(lock);

  const pinGeo = new THREE.SphereGeometry(R * 0.24, 10, 8);
  owned.push(pinGeo);
  const pin = new THREE.Mesh(pinGeo, iron);
  pin.position.set(-R, 0, 0);
  g.add(pin);

  const clevisGeo = new THREE.TorusGeometry(R * 0.32, R * 0.12, 6, 12);
  owned.push(clevisGeo);
  const clevis = new THREE.Mesh(clevisGeo, iron);
  clevis.position.set(R * 1.6, 0, 0);
  clevis.rotation.x = Math.PI / 2;
  g.add(clevis);

  return g;
}

// Re-exported so a caller can size a scene against the chain's reach without
// importing the avatar for one constant.
export const CHAIN_REACH = BallPlayer.CHAIN_MAX_LENGTH;
