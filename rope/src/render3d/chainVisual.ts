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
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Vec2 } from "../engine/vec2";
import { BallPlayer } from "../classes/ballPlayer";
import type { CollisionObject2D } from "../engine/body";
import { PX } from "../engine/units";
import { CHAIN_LINK_BAR, CHAIN_LINK_LEN, CHAIN_LINK_W, walkChain } from "../render/chainMetrics";
import type { ChainRetract } from "../render/chainRetract";
import { MANACLE_BAND, MANACLE_HINGE, MANACLE_RADIUS, MANACLE_REACH, MANACLE_WIDTH } from "../lib/manacle";
import { FORGED_SMALL, forgedMetal } from "./ballVisual";
import { solidGlassMaterial } from "./glassMaterial";
import { setProbe } from "./reflectionProbe";
import { threeY } from "./space";
import type { Scene3DLevel } from "./scene";

// A link is an oval ring: a torus stretched along the path. The tube is the bar
// stock it is forged from, and it is what a chain's weight reads as.
const LINK_TUBE = CHAIN_LINK_BAR;
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

// The two link meshes' names: the level's own chains, and the ball's.
export const SCENE_CHAIN_MESH = "scene-chain-links";
export const AVATAR_CHAIN_MESH = "avatar-chain-links";

// One instanced mesh of links and the count laid into it this frame, grown
// when a frame lays more than it holds.
class LinkBuffer {
  mesh: THREE.InstancedMesh;
  private capacity = INITIAL_LINKS;
  count = 0;

  constructor(
    private readonly scene: THREE.Scene,
    // What the mesh is called, which is how a case finds it (`rootCases`).
    private readonly name: string,
    private readonly geometry: THREE.BufferGeometry,
    private material: THREE.Material,
    // Whether the links cast shadows: iron does, glass does not (see
    // glassMaterial.ts).
    private shadows: boolean,
  ) {
    this.mesh = this.makeMesh(this.capacity);
    scene.add(this.mesh);
  }

  private makeMesh(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.name = this.name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = true;
    // The count is set per frame; three culls by the mesh's own bounds, which
    // for a chain that moves across the whole level is never a useful test.
    mesh.frustumCulled = false;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    return mesh;
  }

  // Wear `material` from now on (the avatar's chain, iron or glass). Glass
  // casts no shadow but receives them: that is how its lens knows which
  // lights it can see (see glassMaterial.ts).
  setMaterial(material: THREE.Material, casts: boolean): void {
    this.material = material;
    this.shadows = casts;
    this.mesh.material = material;
    this.mesh.castShadow = casts;
    this.mesh.receiveShadow = true;
  }

  // Write link `i`, if it fits: a frame that lays more than the buffer holds
  // truncates for that frame and grows for the next (see `finish`), rather
  // than throwing away every matrix already written into it this frame.
  set(i: number, m: THREE.Matrix4, tint: THREE.Color): void {
    if (i >= this.capacity) return;
    this.mesh.setMatrixAt(i, m);
    this.mesh.instanceColor?.setXYZ(i, tint.r, tint.g, tint.b);
  }

  finish(): void {
    if (this.count > this.capacity) {
      let capacity = this.capacity;
      while (capacity < this.count) capacity *= 2;
      this.scene.remove(this.mesh);
      this.mesh.dispose();
      this.capacity = capacity;
      this.mesh = this.makeMesh(capacity);
      this.scene.add(this.mesh);
    }
    this.mesh.count = Math.min(this.count, this.capacity);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // Measured afresh: depth of field asks whether a see-through mesh reaches
    // the plane by its bounds (depthOfField.ts `reachesFocus`), and an
    // instanced mesh's are of wherever its links were the first time it asked.
    this.mesh.boundingSphere = null;
  }

  clear(): void {
    this.count = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
  }
}

export class ChainLayer {
  // The level's own chains, and the avatar's: two meshes, because the avatar's
  // may be glass (`BallPlayer.glass`) while the level's are always iron.
  private readonly sceneLinks: LinkBuffer;
  private readonly avatarLinks: LinkBuffer;
  // Which buffer `lay` writes into.
  private target: LinkBuffer;
  private readonly geometry: THREE.BufferGeometry;
  private readonly manacle: THREE.Group;
  private readonly manacleMesh: THREE.Mesh;
  private readonly manacleGeometry: THREE.BufferGeometry[] = [];
  private readonly ironManacle: THREE.Material;
  // The avatar's chain in glass, made the first time a glass ball is drawn and
  // kept for the page (one link material, one cuff material).
  private glassLinks: THREE.MeshPhysicalMaterial | null = null;
  private glassManacle: THREE.MeshPhysicalMaterial | null = null;
  private glass = false;
  // Scratch, reused every frame: a chain sync must not allocate.
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);
  private readonly axis = new THREE.Vector3();
  private readonly spin = new THREE.Quaternion();
  private readonly tilt = new THREE.Quaternion();
  private readonly normal = new THREE.Vector3();
  private readonly tint = new THREE.Color();
  private readonly path: Vec2[] = [];
  // How far the ball's chain is drawn behind the plane at its anchored end
  // (see `sync`), and over how much of its length it comes forward to the
  // plane. Zero for every chain end that is not bitten into a set-back body.
  private anchorDepth = 0;
  private anchorReach = 1;

  constructor(private readonly scene: THREE.Scene) {
    // Built along +x so the instance rotation is "turn +x onto the tangent",
    // which is the same statement the 2D renderer makes with `atan2`.
    const torus = new THREE.TorusGeometry(LINK_HALF_LEN, LINK_TUBE, 10, 20);
    torus.scale(1, CHAIN_LINK_W / LINK_HALF_LEN, 1);
    this.geometry = torus;
    this.sceneLinks = new LinkBuffer(scene, SCENE_CHAIN_MESH, torus, forgedMetal(FORGED_SMALL), true);
    this.avatarLinks = new LinkBuffer(scene, AVATAR_CHAIN_MESH, torus, forgedMetal(FORGED_SMALL), true);
    this.target = this.sceneLinks;

    this.manacle = buildManacle(this.manacleGeometry);
    this.manacleMesh = this.manacle.children[0] as THREE.Mesh;
    this.ironManacle = this.manacleMesh.material as THREE.Material;
    this.manacle.visible = false;
    scene.add(this.manacle);
  }

  // Draw the avatar's chain and cuff in glass (the glass ball's, see
  // `BallPlayer.glass`) or in iron. The level's own chains are iron either way.
  private setGlass(glass: boolean): void {
    if (glass === this.glass) return;
    this.glass = glass;
    if (glass) {
      // Solid glass (see `solidGlassMaterial`), whatever the ball is: each
      // link a bar of its tube's radius, the cuff a strap of half its band.
      this.glassLinks ??= solidGlassMaterial(LINK_TUBE);
      this.glassManacle ??= solidGlassMaterial(MANACLE_BAND / 2);
    }
    this.avatarLinks.setMaterial(glass ? this.glassLinks! : forgedMetal(FORGED_SMALL), !glass);
    this.manacleMesh.material = glass ? this.glassManacle! : this.ironManacle;
    this.manacleMesh.castShadow = !glass;
    // The glass cuff's lens reads its lights' shadows (see `setMaterial`).
    this.manacleMesh.receiveShadow = glass;
    // Glass is drawn over what is behind it, after the opaque scene.
    this.avatarLinks.mesh.renderOrder = glass ? 1 : 0;
    this.manacleMesh.renderOrder = glass ? 1 : 0;
  }

  // Every chain on the level, laid this frame. `retract` is the released chain
  // reeling back into the ball, if one is (see render/chainRetract.ts).
  // `depthOf` is how far in front of the gameplay plane a body is drawn (+z
  // toward the camera; `BodyVisual.depth`), which is where the ball's cuff is
  // drawn when it has bitten that body.
  sync(
    level: Scene3DLevel,
    alpha: number,
    retract: ChainRetract | null = null,
    depthOf: (body: CollisionObject2D) => number = () => 0,
  ): void {
    this.sceneLinks.count = 0;
    this.avatarLinks.count = 0;
    this.manacle.visible = false;
    this.setGlass(level.ball?.glass === true);

    this.target = this.sceneLinks;
    for (const chain of level.sceneChains) {
      const spans = chain.rope.getSpans();
      if (!spans.length) continue;
      this.path.length = 0;
      this.path.push(spans[0]!.from.contact.renderGlobalPosition(alpha));
      for (const s of spans) this.path.push(s.to.contact.renderGlobalPosition(alpha));
      this.tint.set(chain.color ?? DEFAULT_CHAIN_COLOR);
      this.lay(this.path);
    }
    // A tied chain: its knots in order, each segment straight between two
    // (see the 2D renderer).
    for (const chain of level.tieChains ?? []) {
      this.path.length = 0;
      for (const p of chain.points) this.path.push(p.renderWorld(alpha));
      this.tint.set(chain.color ?? DEFAULT_CHAIN_COLOR);
      this.lay(this.path);
    }

    this.target = this.avatarLinks;
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
        if (ball.glass) stopAtLoop(this.path, ball.radius);
        this.tint.set(DEFAULT_CHAIN_COLOR);

        // BITTEN INTO SET-BACK SCENERY - a root, a grate, anything hook-only,
        // which is drawn behind the gameplay plane (`BodyVisual.depth`) - the
        // cuff is drawn at that depth, in the root it bit rather than floating
        // in front of it, and the chain runs STRAIGHT from there to the plane:
        // over the anchor's span, so it is back on the plane at the first
        // corner it wraps (a corner of solid geometry, which is on the plane)
        // or at the ball. Render-side only: the sim's chain is in the plane.
        const anchoredTo = ball.anchoredTo;
        this.anchorDepth = anchoredTo ? depthOf(anchoredTo) : 0;
        if (this.anchorDepth !== 0) {
          const nodes = chain.path();
          const hinge = this.path[0]!;
          const wrap = nodes.length >= 3 ? nodes[nodes.length - 2]!.contact.renderGlobalPosition(alpha) : null;
          this.anchorReach = Math.max(CHAIN_LINK_LEN, hinge.distanceTo(wrap ?? ball.renderPosition(alpha)));
        }
        this.lay(this.path, this.anchorDepth !== 0);

        // The manacle at the far end - the flying hook, the dangling tip, or the
        // anchor - wherever the sim says it is (`BallPlayer.manaclePose`).
        const pose = ball.manaclePose(alpha);
        if (pose) this.placeManacle(pose.centre, pose.dir, this.anchorDepth);
      }
    }

    // A released chain reeling back into the ball, laid from its reeled end so
    // the links slide home with it, the cuff riding that end. Never beside a
    // chain that is out - a new throw deletes it - so the one manacle serves.
    const reeling = retract?.resolve(alpha);
    if (reeling) {
      this.tint.set(DEFAULT_CHAIN_COLOR);
      // Reeled home into the ball, as the chain that is out is (above).
      this.path.length = 0;
      for (const p of reeling.path) this.path.push(p);
      if (level.ball?.glass) stopAtLoop(this.path, level.ball.radius);
      this.lay(this.path);
      this.placeManacle(reeling.centre, reeling.dir);
    }

    // A chain longer than the buffer truncates for one frame and the buffer is
    // resized for the next (see `LinkBuffer.finish`).
    this.sceneLinks.finish();
    this.avatarLinks.finish();
  }

  // `toAnchor`: the ball's chain bitten into set-back scenery, laid from its
  // anchored end at `anchorDepth` straight forward to the plane over
  // `anchorReach` (see `sync`).
  private lay(points: readonly Vec2[], toAnchor = false): void {
    // The depth along the chain is a straight line from the anchor, so every
    // link on that run leans into it by the same angle.
    const slope = toAnchor ? -this.anchorDepth / this.anchorReach : 0;
    const lean = Math.atan(slope);
    walkChain(points, ({ mid, dir, broad, index }) => {
      const i = this.target.count++;
      // Turn the link's +x onto the tangent (in three's frame), then twist every
      // other link about that tangent.
      const angle = Math.atan2(threeY(dir.y), dir.x);
      const s = (index + 0.5) * CHAIN_LINK_LEN;
      const z = toAnchor && s < this.anchorReach ? this.anchorDepth + slope * s : 0;
      const leaning = toAnchor && s < this.anchorReach;
      this.axis.set(Math.cos(angle), Math.sin(angle), 0);
      if (leaning) {
        // Tilted out of the plane toward the camera by the run's lean: about
        // the in-plane normal, which turns the tangent toward +z.
        this.normal.set(-this.axis.y, this.axis.x, 0);
        this.tilt.setFromAxisAngle(this.normal, -lean);
        this.axis.set(Math.cos(angle) * Math.cos(lean), Math.sin(angle) * Math.cos(lean), Math.sin(lean));
      }
      // Turn about +z first, then (leaning) tilt out of the plane, then twist
      // about the tangent: `multiply` composes right-to-left, so the argument
      // is the rotation applied first.
      this.q.setFromAxisAngle(this.axis, broad ? 0 : TWIST);
      if (leaning) this.q.multiply(this.tilt);
      this.spin.setFromAxisAngle(FORWARD, angle);
      this.q.multiply(this.spin);
      this.pos.set(mid.x, threeY(mid.y), z);
      this.m.compose(this.pos, this.q, this.scl);
      this.target.set(i, this.m, this.tint);
    });
  }

  // The manacle at `centre`, its hinge pointing along `dir`. Turned about z to
  // face `dir` with its hinge, then a quarter turn about its own x, so the
  // ring's axis lies in the gameplay plane square to the chain and the ring is
  // seen edge-on: a shackle trailing its chain, a cuff driven half into the
  // face it bit, or a ring with the bar of a rail through it. "ZXY" applies z
  // first, then x about the turned frame, which is the order that reading
  // needs.
  //
  // `z` is the depth it is drawn at: the depth of the set-back scenery it bit
  // (a root's centre), and the plane otherwise.
  private placeManacle(centre: Vec2, dir: Vec2, z = 0): void {
    this.manacle.position.set(centre.x, threeY(centre.y), z);
    this.manacle.rotation.set(Math.PI / 2, 0, Math.atan2(threeY(dir.y), dir.x), "ZXY");
    this.manacle.visible = true;
  }

  // What the glass chain sees through itself and reflects: the ball's probe
  // (see glassMaterial.ts `solidGlassMaterial`), or the room's sky with null.
  // The iron chain does not wear the probe and ignores this.
  setReflection(texture: THREE.CubeTexture | null): void {
    if (this.glassLinks) setProbe(this.glassLinks, texture);
    if (this.glassManacle) setProbe(this.glassManacle, texture);
  }

  // Run `draw` with only the level's own chains showing - the ball's chain, a
  // reeling one and the manacle hidden - and put them back. The ball's
  // reflection probe draws through this (see reflectionProbe.ts).
  withoutAvatar(draw: () => void): void {
    const links = this.avatarLinks.mesh.visible;
    const manacle = this.manacle.visible;
    this.avatarLinks.mesh.visible = false;
    this.manacle.visible = false;
    try {
      draw();
    } finally {
      this.avatarLinks.mesh.visible = links;
      this.manacle.visible = manacle;
    }
  }

  clear(): void {
    this.sceneLinks.clear();
    this.avatarLinks.clear();
    this.manacle.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.manacle);
    this.sceneLinks.dispose();
    this.avatarLinks.dispose();
    this.geometry.dispose();
    this.glassLinks?.dispose();
    this.glassManacle?.dispose();
    for (const g of this.manacleGeometry) g.dispose();
    this.manacleGeometry.length = 0;
  }
}

// The ball's chain runs on past the loop to the ball's centre, so the links
// being reeled in are consumed INTO the ball rather than the chain compressing
// toward its anchor (see chainMetrics.ts). Hidden in iron; but through glass
// the last links of a hanging chain sat in the middle of the ball (Tris,
// 2026-10-16: "I can see a link of chain in the middle of the ball"). So a
// glass ball's run, `points` ending loop → centre, stops at the loop's inner
// edge on that last stretch: links are laid whole, so the last one drawn
// reaches no deeper than the loop it hangs from. Only that stretch is cut -
// links wound round the ball lie on its surface, nearer the centre than the
// loop is, and are the wrap the player is meant to see (a cut by distance from
// the centre took the whole coil, session-277f).
export function stopAtLoop(points: Vec2[], radius: number): void {
  if (points.length < 2) return;
  const centre = points[points.length - 1]!;
  const loop = points[points.length - 2]!;
  const edge = radius + BallPlayer.LOOP_GAP - BallPlayer.LOOP_RADIUS;
  if (loop.distanceTo(centre) > edge) points[points.length - 1] = centre.add(centre.directionTo(loop).mul(edge));
  else points.pop();
}

const FORWARD = new THREE.Vector3(0, 0, 1);

// The chain's far end as an iron manacle: a broad band of strap iron with its
// two jaws pinned together at the hinge, where the chain is shackled, and shut
// on each other under the lock plate opposite it - a leg iron rather than a
// ring of round bar. Built rather than authored, because it is a handful of
// primitives and a GLTF for it would be an asset to keep in step with a shape
// fixed by the collider. In the cuff's own frame +x points toward the hinge
// and the chain, matching the 2D renderer's `drawManacle`, and the ring's axis
// is z; the group is turned so the ring stands edge-on to the camera (see
// `sync`), which puts the band's width across the bar the camera sees.
//
// Drawn shut always, for the reason `drawManacle` gives - the drawn shape has to
// BE the bar the sim collides as - and everything is fitted inside that bar for
// the same reason: the band's width IS the bar's thickness, and the band's face
// stands a little inside the reach so the hinge knuckles, the lock plate and the
// rivets reach it and no further.
function buildManacle(owned: THREE.BufferGeometry[]): THREE.Group {
  const g = new THREE.Group();
  // The same forged iron the links are, at the same scale: the manacle is the
  // end of the chain rather than a different object bolted to it.
  const iron = forgedMetal(FORGED_SMALL);
  const W = MANACLE_WIDTH;
  const BORE = MANACLE_RADIUS - MANACLE_BAND / 2;
  const PROUD = 0.3 * PX; // how far the fittings stand off the band's face
  const FACE = MANACLE_REACH - PROUD;
  const parts: THREE.BufferGeometry[] = [];

  // The band: its cross-section - bore to face, edge to edge, the four corners
  // rounded so it reads as forged strap rather than cut tube - turned about the
  // axis. A lathe rather than an extruded annulus because its UVs run
  // continuously round the ring and across the section, which the forged
  // surface's normal map needs; an extrusion's flip between faces and showed
  // as a jagged glassy rim.
  const ROUND = 0.35 * PX;
  const section: THREE.Vector2[] = [];
  // Corner centres, walked round the section from the middle of the bore, where
  // the texture's seam across the section is out of sight; each corner is
  // rounded by a quarter arc.
  const corners: [number, number, number][] = [
    [BORE + ROUND, -W / 2 + ROUND, Math.PI],
    [FACE - ROUND, -W / 2 + ROUND, (3 * Math.PI) / 2],
    [FACE - ROUND, W / 2 - ROUND, 0],
    [BORE + ROUND, W / 2 - ROUND, Math.PI / 2],
  ];
  section.push(new THREE.Vector2(BORE, 0));
  for (const [r, h, from] of corners) {
    for (let i = 0; i <= 4; i++) {
      const a = from + (i / 4) * (Math.PI / 2);
      section.push(new THREE.Vector2(r + ROUND * Math.cos(a), h + ROUND * Math.sin(a)));
    }
  }
  section.push(new THREE.Vector2(BORE, 0));
  const band = new THREE.LatheGeometry(section, 64);
  band.rotateX(Math.PI / 2); // the lathe's axis is y; the ring's is z
  parts.push(band.toNonIndexed());
  band.dispose();

  // Hinge: three knuckles on one pin, the middle one the other jaw's, centred
  // on the pin the chain is measured to and as thick as the band, so they
  // stand proud of its face by exactly the fittings' margin and reach the end
  // of the bar. A cylinder stands along y; turned onto the axis here.
  const KNUCKLE_R = MANACLE_REACH - MANACLE_HINGE;
  const GAP = 0.15 * PX;
  const knuckleLen = (W - 2 * GAP) / 3;
  for (let i = -1; i <= 1; i++) {
    const knuckle = new THREE.CylinderGeometry(KNUCKLE_R, KNUCKLE_R, knuckleLen, 16);
    knuckle.rotateX(Math.PI / 2);
    knuckle.translate(MANACLE_HINGE, 0, i * (knuckleLen + GAP));
    parts.push(knuckle.toNonIndexed());
    knuckle.dispose();
  }

  // Lock plate over the mouth, where the jaw tips meet: a block standing off
  // the band's face to the end of the bar, a little narrower than the band.
  const PLATE = 3 * PX; // round the band
  const lock = new THREE.BoxGeometry(PROUD + 0.4 * PX, PLATE, W - 0.5 * PX);
  lock.translate(-MANACLE_REACH + (PROUD + 0.4 * PX) / 2, 0, 0);
  // A box spans the whole texture on every face, which on a 3 cm plate blows
  // the forged strokes up into rock; this puts them at the band's scale.
  (lock.getAttribute("uv") as THREE.BufferAttribute).applyMatrix3(new THREE.Matrix3().makeScale(0.3, 0.3));
  parts.push(lock.toNonIndexed());
  lock.dispose();

  // Rivets holding the hinge leaves and the lock plate's straps to the band,
  // a pair each side of both: domes on the face, their crowns at the reach.
  const RIVET = PROUD;
  for (const centre of [0, Math.PI]) {
    for (const side of [-1, 1]) {
      const a = centre + side * 0.42;
      for (const z of [-W / 4, W / 4]) {
        const rivet = new THREE.SphereGeometry(RIVET, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
        rivet.rotateZ(a - Math.PI / 2); // its crown (+y) onto the radial
        rivet.translate(FACE * Math.cos(a), FACE * Math.sin(a), z);
        parts.push(rivet.toNonIndexed());
        rivet.dispose();
      }
    }
  }

  const cuff = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!cuff) throw new Error("manacle: the cuff's parts did not merge");
  owned.push(cuff);
  const mesh = new THREE.Mesh(cuff, iron);
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

// Re-exported so a caller can size a scene against the chain's reach without
// importing the avatar for one constant.
export const CHAIN_REACH = BallPlayer.CHAIN_MAX_LENGTH;
