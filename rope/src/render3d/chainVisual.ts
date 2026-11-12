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
import {
  BALL_LOOP_CENTRE,
  BALL_LOOP_INNER,
  BALL_LOOP_OUTER,
  CHAIN_LINK_BAR,
  CHAIN_LINK_BEND,
  CHAIN_LINK_LEN,
  CHAIN_LINK_SIDE,
  walkChain,
} from "../render/chainMetrics";
import { ballChainLayout, type ShackleLoop } from "../render/ballChainPath";
import type { ChainRetract } from "../render/chainRetract";
import type { ChainSnap } from "../render/chainSnap";
import { MANACLE_BAND, MANACLE_HINGE, MANACLE_RADIUS, MANACLE_REACH, MANACLE_WIDTH } from "../lib/manacle";
import { FORGED_SMALL, forgedMetal, GLASS_LOOP_TUBE } from "./ballVisual";
import { solidGlassMaterial } from "./glassMaterial";
import { setProbe } from "./reflectionProbe";
import { threeY } from "./space";
import type { Scene3DLevel } from "./scene";

// A link is a short link of a real chain (render/chainMetrics.ts): a round bar
// bent into a stadium, two straight sides and two semicircular ends. The tube
// is the bar stock it is forged from, and it is what a chain's weight reads as.
// The section is uniform all the way round, as a bent bar's is - a torus
// squashed into an oval thins its sides, which is what the links used to be.
const LINK_TUBE = CHAIN_LINK_BAR;
// Segments round each end bend, and round the bar's section. The straight sides
// need none of their own: a tube along a straight line is exact at any count.
const LINK_BEND_SEGMENTS = 10;
const LINK_SECTION_SEGMENTS = 10;

// The link's mesh, in the XY plane along +x (the broad link; the narrow one is
// the instance twisted about x). UVs as `TorusGeometry` lays them - u round the
// link by arc length, v round the section - so the forged surface wears it at
// the grain it wore the torus.
function linkGeometry(): THREE.BufferGeometry {
  // The centreline: CCW round the stadium, each sample with its outward normal
  // in the plane. A bend's ends share their normal with the straight beyond.
  const centre: { x: number; y: number; nx: number; ny: number }[] = [];
  for (const [cx, from] of [[CHAIN_LINK_SIDE, -Math.PI / 2], [-CHAIN_LINK_SIDE, Math.PI / 2]] as const) {
    for (let i = 0; i <= LINK_BEND_SEGMENTS; i++) {
      const a = from + (i / LINK_BEND_SEGMENTS) * Math.PI;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      centre.push({ x: cx + nx * CHAIN_LINK_BEND, y: ny * CHAIN_LINK_BEND, nx, ny });
    }
  }
  centre.push(centre[0]!); // closed, with the seam doubled for its UVs
  const along: number[] = [0];
  for (let i = 1; i < centre.length; i++) {
    along.push(along[i - 1]! + Math.hypot(centre[i]!.x - centre[i - 1]!.x, centre[i]!.y - centre[i - 1]!.y));
  }
  const total = along[along.length - 1]!;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < centre.length; i++) {
    const c = centre[i]!;
    for (let j = 0; j <= LINK_SECTION_SEGMENTS; j++) {
      const t = (j / LINK_SECTION_SEGMENTS) * 2 * Math.PI;
      const nx = Math.cos(t) * c.nx;
      const ny = Math.cos(t) * c.ny;
      const nz = Math.sin(t);
      positions.push(c.x + nx * LINK_TUBE, c.y + ny * LINK_TUBE, nz * LINK_TUBE);
      normals.push(nx, ny, nz);
      uvs.push(along[i]! / total, j / LINK_SECTION_SEGMENTS);
    }
  }
  const ring = LINK_SECTION_SEGMENTS + 1;
  const indices: number[] = [];
  for (let i = 0; i + 1 < centre.length; i++) {
    for (let j = 0; j < LINK_SECTION_SEGMENTS; j++) {
      const a = i * ring + j;
      const b = (i + 1) * ring + j;
      // Along the centreline then round the section is outward-facing CCW.
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

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
  private readonly manacleMeshes: THREE.Mesh[];
  private readonly manacleGeometry: THREE.BufferGeometry[] = [];
  // The cuffs of snapped chains' halves left on their anchors (see
  // render/chainSnap.ts), one each: clones of `manacle` sharing its geometry,
  // made as more are needed and hidden when not.
  private readonly snapManacles: THREE.Group[] = [];
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
    const link = linkGeometry();
    this.geometry = link;
    this.sceneLinks = new LinkBuffer(scene, SCENE_CHAIN_MESH, link, forgedMetal(FORGED_SMALL), true);
    this.avatarLinks = new LinkBuffer(scene, AVATAR_CHAIN_MESH, link, forgedMetal(FORGED_SMALL), true);
    this.target = this.sceneLinks;

    this.manacle = buildManacle(this.manacleGeometry);
    this.manacleMeshes = manacleMeshes(this.manacle);
    this.ironManacle = this.manacleMeshes[0]!.material as THREE.Material;
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
    for (const mesh of this.manacleMeshes) {
      mesh.material = glass ? this.glassManacle! : this.ironManacle;
      mesh.castShadow = !glass;
      // The glass cuff's lens reads its lights' shadows (see `setMaterial`).
      mesh.receiveShadow = glass;
      // Glass is drawn over what is behind it, after the opaque scene.
      mesh.renderOrder = glass ? 1 : 0;
    }
    this.avatarLinks.mesh.renderOrder = glass ? 1 : 0;
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
    // The two halves of a chain that snapped (see render/chainSnap.ts).
    snap: ChainSnap | null = null,
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
        // Shackled to the loop whenever no throw is paying out, and run on into
        // the ball while one is (`ballChainLayout`), against the loop this
        // file draws: the model's, or the glass ball's own.
        const layout = ballChainLayout(ball, loopToAnchor, alpha, this.shackleLoop(ball, alpha));
        this.path.length = 0;
        for (const p of layout.path) this.path.push(p);
        if (ball.glass && !layout.shackled) stopAtLoop(this.path, ball.radius);
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
        this.lay(this.path, this.anchorDepth !== 0, layout.pitch, layout.count);

        // The manacle at the far end - the flying hook, the dangling tip, or the
        // anchor - wherever the sim says it is (`BallPlayer.manaclePose`).
        const pose = ball.manaclePose(alpha);
        if (pose) this.placeManacle(pose.centre, pose.dir, this.anchorDepth, pose.open);
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

    // Chains that snapped (see render/chainSnap.ts): every half left on its
    // anchor, laid from the cuff's hinge with the cuff where it bit - at the
    // depth of set-back scenery it bit, as the deployed chain's is - each with
    // a cuff of its own, and the half still shackled to the ball.
    const snapped = snap?.resolve(alpha);
    let cuffs = 0;
    if (snapped) {
      this.tint.set(DEFAULT_CHAIN_COLOR);
      for (const half of snapped.anchored) {
        this.path.length = 0;
        for (const p of half.path) this.path.push(p);
        this.anchorDepth = half.body ? depthOf(half.body) : 0;
        if (this.anchorDepth !== 0) {
          this.anchorReach = Math.max(CHAIN_LINK_LEN, this.path[0]!.distanceTo(this.path[this.path.length - 1]!));
        }
        this.lay(this.path, this.anchorDepth !== 0);
        this.placeSnapManacle(cuffs++, half.centre, half.dir, this.anchorDepth);
      }
      if (snapped.onBall) {
        this.path.length = 0;
        for (const p of snapped.onBall) this.path.push(p);
        if (level.ball?.glass) stopAtLoop(this.path, level.ball.radius);
        this.lay(this.path);
      }
    }
    for (let i = cuffs; i < this.snapManacles.length; i++) this.snapManacles[i]!.visible = false;

    // A chain longer than the buffer truncates for one frame and the buffer is
    // resized for the next (see `LinkBuffer.finish`).
    this.sceneLinks.finish();
    this.avatarLinks.finish();
  }

  // The loop the ball's chain is shackled to, as this file draws it: the
  // model's forged loop (whose proportions the stand-in torus shares, see
  // `BallVisual`), or the glass ball's ring at the collision loop.
  private shackleLoop(ball: BallPlayer, alpha: number): ShackleLoop {
    if (ball.glass) {
      return {
        centre: ball.renderLoopCenter(alpha),
        inner: BallPlayer.LOOP_RADIUS - GLASS_LOOP_TUBE,
        outer: BallPlayer.LOOP_RADIUS + GLASS_LOOP_TUBE,
      };
    }
    return {
      centre: ball.renderPosition(alpha).add(ball.renderLoopDirection(alpha).mul(BALL_LOOP_CENTRE * ball.radius)),
      inner: BALL_LOOP_INNER * ball.radius,
      outer: BALL_LOOP_OUTER * ball.radius,
    };
  }

  // `toAnchor`: the ball's chain bitten into set-back scenery, laid from its
  // anchored end at `anchorDepth` straight forward to the plane over
  // `anchorReach` (see `sync`). `pitch`: how far apart the links fall, which
  // only the ball's chain sets (`ballChainLayout`); a link is drawn that long
  // inside, so neighbours always bear on each other. `count`: how many to lay.
  private lay(points: readonly Vec2[], toAnchor = false, pitch: number = CHAIN_LINK_LEN, count?: number): void {
    // The depth along the chain is a straight line from the anchor, so every
    // link on that run leans into it by the same angle.
    const slope = toAnchor ? -this.anchorDepth / this.anchorReach : 0;
    const lean = Math.atan(slope);
    this.scl.set(pitch / CHAIN_LINK_LEN, 1, 1);
    walkChain(points, ({ mid, dir, broad, at: s }) => {
      const i = this.target.count++;
      // Turn the link's +x onto the tangent (in three's frame), then twist every
      // other link about that tangent.
      const angle = Math.atan2(threeY(dir.y), dir.x);
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
    }, pitch, count);
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
  //
  // `open` swings its jaws open about the hinge pin, each by that many
  // radians: a cuff round a root thicker than its bore (`ManaclePose.open`).
  private placeManacle(centre: Vec2, dir: Vec2, z = 0, open = 0): void {
    this.manacle.position.set(centre.x, threeY(centre.y), z);
    this.manacle.rotation.set(Math.PI / 2, 0, Math.atan2(threeY(dir.y), dir.x), "ZXY");
    setManacleOpen(this.manacle, open);
    this.manacle.visible = true;
  }

  // The `i`th snapped half's cuff, placed as `placeManacle` places the ball's,
  // in the cuff material the ball's chain is drawn in (iron or glass).
  private placeSnapManacle(i: number, centre: Vec2, dir: Vec2, z: number): void {
    let cuff = this.snapManacles[i];
    if (cuff === undefined) {
      cuff = this.manacle.clone();
      this.snapManacles.push(cuff);
      this.scene.add(cuff);
    }
    const like = this.manacleMeshes[0]!;
    for (const mesh of manacleMeshes(cuff)) {
      mesh.material = like.material;
      mesh.castShadow = like.castShadow;
      mesh.receiveShadow = like.receiveShadow;
      mesh.renderOrder = like.renderOrder;
    }
    setManacleOpen(cuff, 0);
    cuff.position.set(centre.x, threeY(centre.y), z);
    cuff.rotation.set(Math.PI / 2, 0, Math.atan2(threeY(dir.y), dir.x), "ZXY");
    cuff.visible = true;
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
    const cuffs = this.snapManacles.map((c) => c.visible);
    this.avatarLinks.mesh.visible = false;
    this.manacle.visible = false;
    for (const c of this.snapManacles) c.visible = false;
    try {
      draw();
    } finally {
      this.avatarLinks.mesh.visible = links;
      this.manacle.visible = manacle;
      this.snapManacles.forEach((c, i) => (c.visible = cuffs[i]!));
    }
  }

  clear(): void {
    this.sceneLinks.clear();
    this.avatarLinks.clear();
    this.manacle.visible = false;
    for (const c of this.snapManacles) c.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.manacle);
    for (const c of this.snapManacles) this.scene.remove(c);
    this.snapManacles.length = 0;
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

  // The cuff is two JAWS on one hinge pin, so that it can open round a root
  // thicker than its bore (`RopeClamp.cuffOpening`, `setManacleOpen`): each
  // jaw half the band - the half above its long axis and the half below,
  // split at the hinge and at the mouth - with its half of the lock plate and
  // its rivets, built about the pin so that turning it is turning its group;
  // the knuckles are the pin and stay put. Shut, the two halves are the one
  // band they were cut from.
  const hingeParts: THREE.BufferGeometry[] = [];
  const jawParts: [THREE.BufferGeometry[], THREE.BufferGeometry[]] = [[], []];
  const jawOf = (y: number): THREE.BufferGeometry[] => jawParts[y >= 0 ? 0 : 1];
  // The band: its lathe's angle `phi` puts a section at y = -r·cos(phi) once
  // the lathe stands on the ring's axis, so (π/2, 3π/2) is the half above.
  for (const [jaw, start] of [[0, Math.PI / 2], [1, (3 * Math.PI) / 2]] as const) {
    const half = new THREE.LatheGeometry(section, 32, start, Math.PI);
    half.rotateX(Math.PI / 2); // the lathe's axis is y; the ring's is z
    jawParts[jaw].push(half.toNonIndexed());
    half.dispose();
    // Its cut face at the mouth, seen when the jaws are open: the band's
    // section, stood at x = -r in the plane of the cut, facing out of the jaw.
    const cap = new THREE.ShapeGeometry(new THREE.Shape(section.slice(0, -1)));
    const sign = jaw === 0 ? -1 : 1;
    cap.applyMatrix4(new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, sign, 0, 0, sign, 0, 0, 0, 0, 0, 1));
    (cap.getAttribute("uv") as THREE.BufferAttribute).applyMatrix3(new THREE.Matrix3().makeScale(0.3, 0.3));
    jawParts[jaw].push(cap.toNonIndexed());
    cap.dispose();
  }

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
    hingeParts.push(knuckle.toNonIndexed());
    knuckle.dispose();
  }

  // Lock plate over the mouth, where the jaw tips meet: a block standing off
  // the band's face to the end of the bar, a little narrower than the band,
  // in two halves, one on each jaw's tip.
  const PLATE = 3 * PX; // round the band
  for (const side of [1, -1]) {
    const lock = new THREE.BoxGeometry(PROUD + 0.4 * PX, PLATE / 2, W - 0.5 * PX);
    lock.translate(-MANACLE_REACH + (PROUD + 0.4 * PX) / 2, (side * PLATE) / 4, 0);
    // A box spans the whole texture on every face, which on a 3 cm plate blows
    // the forged strokes up into rock; this puts them at the band's scale.
    (lock.getAttribute("uv") as THREE.BufferAttribute).applyMatrix3(new THREE.Matrix3().makeScale(0.3, 0.3));
    jawOf(side).push(lock.toNonIndexed());
    lock.dispose();
  }

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
        jawOf(Math.sin(a)).push(rivet.toNonIndexed());
        rivet.dispose();
      }
    }
  }

  const merged = (parts: THREE.BufferGeometry[], name: string): THREE.Mesh => {
    const geometry = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!geometry) throw new Error(`manacle: the ${name}'s parts did not merge`);
    owned.push(geometry);
    const mesh = new THREE.Mesh(geometry, iron);
    mesh.castShadow = true;
    mesh.name = name;
    return mesh;
  };
  g.add(merged(hingeParts, "hinge"));
  // Each jaw in a group standing on the pin, its geometry moved so the pin is
  // its origin: the group's turn about z is the jaw swinging on the hinge.
  for (const [jaw, name] of [[0, MANACLE_JAW_NAMES[0]], [1, MANACLE_JAW_NAMES[1]]] as const) {
    const pivot = new THREE.Group();
    pivot.name = name;
    pivot.position.set(MANACLE_HINGE, 0, 0);
    for (const part of jawParts[jaw]) part.translate(-MANACLE_HINGE, 0, 0);
    pivot.add(merged(jawParts[jaw], `${name} mesh`));
    g.add(pivot);
  }
  return g;
}

// The jaw groups of a cuff (`buildManacle`): the one above the long axis and
// the one below.
const MANACLE_JAW_NAMES = ["jaw+", "jaw-"] as const;

// Every mesh of a cuff, hinge and jaws: what a material is set on.
function manacleMeshes(cuff: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  cuff.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

// Swing a cuff's jaws open about the hinge pin by `open` radians each, 0 shut
// (`ManaclePose.open`): the jaw above the axis turns its mouth up, the one
// below turns it down, which once the cuff stands edge-on in the plane is
// the two jaw tips parting in depth, round the root they hold.
function setManacleOpen(cuff: THREE.Object3D, open: number): void {
  const upper = cuff.getObjectByName(MANACLE_JAW_NAMES[0]);
  const lower = cuff.getObjectByName(MANACLE_JAW_NAMES[1]);
  if (upper) upper.rotation.z = -open;
  if (lower) lower.rotation.z = open;
}

// Re-exported so a caller can size a scene against the chain's reach without
// importing the avatar for one constant.
export const CHAIN_REACH = BallPlayer.CHAIN_MAX_LENGTH;
