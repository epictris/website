// Plain cords use instanced capsules; braids and ropes use continuous dynamic
// tubes; berry vines are drawn by their own layer (`StarberryLayer`).
// Each braid has one reusable mesh containing its three strands. Unlike a
// scene chain's wrap nodes, a vine's path comes from its real physics links.
//
// It is drawn HERE rather than left to the 2D overlay, and that is the whole
// reason this file exists. A cord painted flat over the scene disappears the
// moment the overlay does - which is every 3D-only view the editor has, and
// every orbited one, since the overlay is a projection of the gameplay plane and
// is dropped as soon as the camera leaves it. A vine is not chrome, it is the
// level; and drawn in the scene it also gets what the flat cord could never
// have: it goes behind the geometry in front of it, and the level's own lights
// fall on it.
//
// Plain cords use a capsule rather than a cylinder because of the joints. The cord bends at every
// link, and two cylinders meeting at an angle leave a notch on the outside of
// the bend; the hemispherical caps fill it at any angle, which is what lets the
// segments be laid independently with no mitre to compute.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import { VINE_VISUAL_RADIUS, type VineCord } from "../level/vines";
import { VINE_COLOR } from "../render/vines";
import { sampleVineCurve, vineMaterial, type VineCurvePoint } from "../render/vineCurve";
import { VineTube, vineLeafGeometry } from "./vineTube";
import { makeVineLeafMaterial, makeVineLeafShadowMaterial } from "./vineLeafMaterial";
import { VineLeafLag } from "./vineLeafLag";
import { LEAF_CHORD, RING_HALF_WIDTH, VineLeafFold, wrapRadius } from "./vineLeafFold";
import { vineRandom } from "../render/vineGrowth";
import { forEachVineLeaf } from "../render/vineLeaves";
import { braidLeafAttachment } from "../render/vineBraid";
import { ROPE_COLOR } from "../render/ropeLay";
import { threeY } from "./space";
import { StarberryLayer } from "./starberryVisual";

// White: the instance colour MULTIPLIES the shared material, so the default has
// to be the material's own colour rather than a tint over it. The material is
// therefore built in the vine green and an authored colour replaces it.
const DEFAULT_TINT = new THREE.Color(1, 1, 1);

// How much longer than its gap each capsule is drawn. The caps already fill the
// outside of a bend; this covers the INSIDE, where the two segments' ends pull
// apart as the cord turns.
const OVERLAP = 1.08;

// Starting capacity: a 3 m vine at the default spacing is 20 segments, so this
// is a dozen vines before the buffer has to grow.
const INITIAL_SEGMENTS = 256;

// A capsule is built along +y, and every path here is laid along a tangent, so
// the instance rotation is "turn +y onto the tangent" - one quaternion from the
// angle, exactly as the chain turns its +x.
const FORWARD = new THREE.Vector3(0, 0, 1);

// How far ahead of a leaf's base the ball's ring starts squaring the blade up
// to the plane it folds in (see `layLeaves`): a few band widths.
const RING_SQUARING = .03; // metres

// The ball's ring threaded on a vine, as the renderer reads it: which vine (by
// identity - a `Vine` is the `VineCord` the layer is handed) and where along
// its link polyline, in link units (`RopeVineClamp`'s segment and fraction).
export interface VineRing {
  readonly vine: object;
  readonly u: number;
}

export class VineLayer {
  private readonly starberries: StarberryLayer;
  private mesh: THREE.InstancedMesh;
  private readonly braids = new Map<VineCord, VineTube>();
  private leafMesh: THREE.InstancedMesh;
  private capacity = INITIAL_SEGMENTS;
  private count = 0;
  private leafCapacity = INITIAL_SEGMENTS;
  private leafCount = 0;
  private readonly geometry: THREE.BufferGeometry;
  private readonly curve: VineCurvePoint[] = [];
  private readonly curveStorage: VineCurvePoint[] = [];
  private readonly leafGeometry: THREE.BufferGeometry;
  private readonly leafAttachment = { across: 0, depth: 0 };
  private readonly material: THREE.Material;
  private readonly leafMaterial: THREE.Material;
  private readonly leafDepthMaterial: THREE.Material;
  private readonly leafDistanceMaterial: THREE.Material;
  // Scratch, reused every frame: a transform sync must not allocate.
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly leafFrame = new THREE.Matrix4();
  private readonly leafOutward = new THREE.Vector3();
  private readonly leafSurfaceNormal = new THREE.Vector3();
  private readonly leafWidth = new THREE.Vector3();
  private readonly leafNormal = new THREE.Vector3();
  private readonly inverseLeaf = new THREE.Quaternion();
  private readonly leafLag = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);
  private readonly tint = new THREE.Color();
  private readonly path: Vec2[] = [];
  private readonly a3 = new THREE.Vector3();
  private readonly dir3 = new THREE.Vector3();
  private readonly stemAlong = new THREE.Vector3();
  private readonly stemOut = new THREE.Vector3();
  private readonly hinge = new THREE.Vector3();
  private readonly foldOffset = new THREE.Vector3();
  private readonly foldRest = new THREE.Quaternion();
  private readonly foldAt = new THREE.Quaternion();
  private readonly foldTwist = new THREE.Quaternion();
  private readonly foldIdentity = new THREE.Quaternion();
  private readonly foldDir = new THREE.Vector3();
  private readonly foldNormal = new THREE.Vector3();
  private readonly foldBasis = new THREE.Matrix4();
  private readonly curving = new THREE.Vector3();

  // `scene` is what the vines are drawn under: the level's own group
  // (`LevelScene.root`), so they are put up and taken down with it.
  constructor(private readonly scene: THREE.Object3D) {
    this.starberries = new StarberryLayer(scene);
    // A unit-length capsule: the per-instance y scale is then the segment's own
    // length, and nothing has to rebuild geometry as a vine bends.
    this.geometry = new THREE.CapsuleGeometry(VINE_VISUAL_RADIUS, 1, 3, 8);
    this.leafGeometry = vineLeafGeometry();
    this.material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(VINE_COLOR),
      roughness: 0.85,
      metalness: 0,
    });
    this.leafMaterial = makeVineLeafMaterial();
    this.leafDepthMaterial = makeVineLeafShadowMaterial(false);
    this.leafDistanceMaterial = makeVineLeafShadowMaterial(true);
    this.mesh = this.makeMesh(this.capacity);
    this.leafMesh = this.makeMesh(this.leafCapacity, this.leafGeometry, this.leafMaterial);
    scene.add(this.mesh);
    this.leafMesh.name = "vine-leaves";
    scene.add(this.leafMesh);
  }

  private makeMesh(capacity: number, geometry = this.geometry, material = this.material): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The count is set per frame, and a vine swings across the level, so the
    // mesh's own bounds are never a useful cull test.
    mesh.frustumCulled = false;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    if (geometry === this.leafGeometry) {
      // Release the previous GPU attribute before replacing a grown instance
      // buffer. The blade's CPU geometry is retained and reuploaded once.
      if (geometry.getAttribute("leafShape")) geometry.dispose();
      geometry.setAttribute("leafShape", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute("leafFaceTurn", new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute("leafWrap", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute("leafRing", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
      mesh.customDepthMaterial = this.leafDepthMaterial;
      mesh.customDistanceMaterial = this.leafDistanceMaterial;
    }
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

  // Every vine on the level, laid this frame. `ring` is the ball's ring when it
  // is threaded on one of them, which folds the leaves it passes over.
  sync(vines: readonly VineCord[], alpha: number, time = 0, ring: VineRing | null = null): void {
    this.starberries.sync(vines, alpha, time);
    this.count = 0;
    this.leafCount = 0;
    for (const [vine, tube] of this.braids) {
      // A tube is a braid or a rope for its whole life, so a vine that has
      // changed look is given a new one.
      if (!vines.includes(vine) || vine.braidSeed === null || vine.starberry || tube.rope !== (vine.rope ?? false)) {
        tube.dispose(); this.braids.delete(vine);
      } else tube.mesh.visible = false;
    }
    for (const vine of vines) {
      // A berry vine is the berry layer's alone (`StarberryLayer`).
      if (vine.starberry) continue;
      vine.path(alpha, this.path);
      if (this.path.length < 2) continue;
      // A rope's fibres carry its tone and the tint is its colour; a vine's
      // tint multiplies its own painted green.
      this.tint.set(vine.color ?? (vine.rope ? ROPE_COLOR : DEFAULT_TINT));
      if (vine.braidSeed === null) this.lay(this.path);
      else {
        let tube = this.braids.get(vine);
        if (!tube) { tube = new VineTube(vine.rope ?? false); this.braids.set(vine, tube); this.scene.add(tube.mesh); }
        const restLength = vine.restLength ?? tube.restLengthFor(this.path);
        sampleVineCurve(this.path, this.curve, this.curveStorage, restLength);
        if (this.curve.length < 2) continue;
        tube.twist.update(this.curve, time, vine.attachedAtBothEnds ?? false);
        tube.sync(this.path, restLength, vine.braidSeed, this.tint, vine.attachedAtBothEnds);
        if (!tube.rope) this.layLeaves(this.path, vine.braidSeed, tube, time, ring !== null && ring.vine === vine ? ring.u : null);
      }
    }
    // Grow only after the walk, then fill the fresh buffers before displaying
    // them. Otherwise their untouched matrices draw capsules at the origin.
    let resized = false;
    if (this.count > this.capacity) { this.grow(this.count); resized = true; }
    if (this.leafCount > this.leafCapacity) {
      resized = true;
      while (this.leafCapacity < this.leafCount) this.leafCapacity *= 2;
      this.scene.remove(this.leafMesh);
      this.leafMesh.dispose();
      this.leafMesh = this.makeMesh(this.leafCapacity, this.leafGeometry, this.leafMaterial);
      this.leafMesh.name = "vine-leaves";
      this.scene.add(this.leafMesh);
    }
    if (resized) { this.sync(vines, alpha, time, ring); return; }
    this.mesh.count = Math.min(this.count, this.capacity);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.leafMesh.count = Math.min(this.leafCount, this.leafCapacity);
    this.leafMesh.instanceMatrix.needsUpdate = true;
    if (this.leafMesh.instanceColor) this.leafMesh.instanceColor.needsUpdate = true;
    this.leafGeometry.getAttribute("leafShape").needsUpdate = true;
    this.leafGeometry.getAttribute("leafFaceTurn").needsUpdate = true;
    this.leafGeometry.getAttribute("leafWrap").needsUpdate = true;
    this.leafGeometry.getAttribute("leafRing").needsUpdate = true;
  }

  // A blade's frame for a fold angle in the plane of `stemAlong` and `stemOut`:
  // its growth direction at that angle, its width along the hinge.
  private foldFrame(angle: number, out: THREE.Quaternion): void {
    this.foldDir.copy(this.stemAlong).multiplyScalar(Math.cos(angle)).addScaledVector(this.stemOut, Math.sin(angle));
    this.foldNormal.crossVectors(this.hinge, this.foldDir);
    this.foldBasis.makeBasis(this.hinge, this.foldDir, this.foldNormal);
    out.setFromRotationMatrix(this.foldBasis);
  }

  private layLeaves(points: readonly Vec2[], seed: number, tube: VineTube, time: number, ringU: number | null): void {
    let localLeaf = 0;
    forEachVineLeaf(points, seed, (x, y, side, length, tone, tx, ty, turn, fraction) => {
      const leaf = localLeaf++;
      const j = this.leafCount++;
      if (j >= this.leafCapacity) return;
      const nx = -ty, ny = tx;
      braidLeafAttachment(seed, fraction, tube.growthLength, side, this.leafAttachment);
      this.pos.set(x + nx * this.leafAttachment.across, threeY(y + ny * this.leafAttachment.across), this.leafAttachment.depth);
      this.a3.set(x, threeY(y), 0);
      const target = fraction * vineMaterial(this.curve.at(-1)!);
      let ring = 0;
      while (ring + 1 < this.curve.length - 1 && vineMaterial(this.curve[ring + 1]!) < target) ring++;
      const a = this.curve[ring]!, b = this.curve[ring + 1]!;
      const t = (target - vineMaterial(a)) / Math.max(1e-8, vineMaterial(b) - vineMaterial(a));
      const roll = (a.twist ?? 0) * (1 - t) + (b.twist ?? 0) * t;
      const across = side * .8 * Math.cos(roll) - .6 * Math.sin(roll);
      const depth = side * .8 * Math.sin(roll) + .6 * Math.cos(roll);
      this.leafOutward.set(nx * across, threeY(ny * across), depth);
      this.leafSurfaceNormal.copy(this.leafOutward);
      tube.leafSurface(fraction, this.a3, this.leafOutward, this.pos, this.leafSurfaceNormal);
      // Keep the blade's width tangent to the stem surface. Free roll around
      // its growth axis used to turn an edge back into the braid.
      this.dir3.set(tx * (.72 + turn * .12), threeY(ty * (.72 + turn * .12)) - .28, turn * .18);
      this.dir3.addScaledVector(this.leafSurfaceNormal, -this.dir3.dot(this.leafSurfaceNormal)).normalize();
      this.dir3.multiplyScalar(.78).addScaledVector(this.leafSurfaceNormal, .62).normalize();
      this.leafWidth.crossVectors(this.dir3, this.leafSurfaceNormal).normalize();
      this.leafNormal.crossVectors(this.leafWidth, this.dir3).normalize();
      this.leafFrame.makeBasis(this.leafWidth, this.dir3, this.leafNormal);
      this.q.setFromRotationMatrix(this.leafFrame);
      // The fold at the base, if the ball's ring is over this leaf or was a
      // moment ago (`VineLeafFold`). Measured in the plane of the stem's
      // downstream tangent and the line from its axis out through the base -
      // not the leaf's outward direction, since the base is wherever the braid
      // stands furthest out, usually on a strand to one side - about the hinge
      // across them, so a blade folded flat lies square over the axis.
      this.stemAlong.set(tx, threeY(ty), 0).normalize();
      this.foldOffset.subVectors(this.pos, this.a3);
      this.foldOffset.addScaledVector(this.stemAlong, -this.foldOffset.dot(this.stemAlong));
      const hingeRadius = this.foldOffset.length();
      this.stemOut.copy(this.foldOffset).multiplyScalar(1 / hingeRadius);
      const rest = Math.atan2(this.dir3.dot(this.stemOut), this.dir3.dot(this.stemAlong));
      const fold = tube.leafFolds[leaf] ?? (tube.leafFolds[leaf] = new VineLeafFold());
      const ringX = ringU === null ? null : (ringU - fraction * tube.lastLink) * tube.linkSpacing;
      const angle = fold.update(rest, ringX, hingeRadius, length * LEAF_CHORD, time);
      // How unfolded the blade is: 1 at its own angle, 0 flat against the stem
      // either way. A folded blade is its rest frame carried rigidly about the
      // hinge, with its own tilt and twist off the fold plane, its curl, droop,
      // sway and face turn let go as it flattens - by the square, so a blade
      // pressed nearly flat keeps none of them to stand out of the ring with,
      // while one just touched keeps most. And a ring arriving at any part of
      // the blade squares it up to the fold plane before it meets it: its face
      // meets the blade's whole width at once, so whatever twist the blade had
      // off that plane - which tips one edge down toward the stem, into the
      // path of a ring passing under it - is gone by the time they touch, and
      // the blade's chord is all the fold has to keep clear.
      const free = angle === rest ? 1
        : Math.max(0, Math.min(1, angle < rest ? angle / rest : (Math.PI - angle) / (Math.PI - rest)));
      let square = 1;
      if (fold.threadedAt >= 0) square = 0;
      else if (ringX !== null) {
        const reach = length * LEAF_CHORD * Math.cos(angle);
        const apart = Math.max(Math.min(reach, 0) - (ringX + RING_HALF_WIDTH), (ringX - RING_HALF_WIDTH) - Math.max(reach, 0), 0);
        square = Math.min(1, apart / RING_SQUARING);
      }
      const loose = free * free * square;
      if (loose < 1) {
        this.hinge.crossVectors(this.stemAlong, this.stemOut);
        this.foldFrame(rest, this.foldRest);
        this.foldFrame(angle, this.foldAt);
        this.foldTwist.copy(this.foldRest).invert().multiply(this.q);
        this.q.copy(this.foldAt).multiply(this.foldIdentity.slerp(this.foldTwist, loose));
        this.foldIdentity.identity();
      }
      // Pressed, the blade lies ON the stem rather than on a plane touching it:
      // its width wraps a cylinder about the stem's axis (behind the blade, or
      // in front of one turned over its hinge, whose face now meets the stem),
      // and its length follows the stem's own curve under it - a long blade
      // laid straight along a sagging span would stand off it into the ring.
      // How nearly it lies along the stem, 0 at its own angle or further out
      // (a blade being lifted over the ring stands off the stem, and is not
      // wrapped round it) and 1 flat along it, down the vine or up it.
      const wrap = this.leafGeometry.getAttribute("leafWrap");
      const pressed = Math.max(0, Math.min(1, 1 - Math.abs(Math.sin(angle)) / Math.max(1e-6, Math.abs(Math.sin(rest)))));
      // The band in blade lengths along the blade, which runs at `angle` to
      // the cord: an axial span `a` is `a / |cos|` of blade.
      const slant = Math.max(.3, Math.abs(Math.cos(angle))) * length;
      const threading = this.leafGeometry.getAttribute("leafRing");
      threading.setXYZW(j,
        fold.threadedAt < 0 ? 0 : fold.threadedAt / slant, fold.threadedAt < 0 ? 0 : RING_HALF_WIDTH / slant,
        Math.abs(Math.sin(angle)), 0);
      if (pressed > 0 || fold.threadedAt >= 0) {
        // Down the vine the stem is behind the blade's face; turned over its
        // hinge, up the vine, the face is toward it.
        const facing = angle < Math.PI / 2 ? 1 : -1;
        // The wrap's cylinder passes through the base, so the base is moved to
        // the wrap's radius and the cylinder's axis is the stem's.
        const wrapped = wrapRadius(hingeRadius);
        this.pos.addScaledVector(this.stemOut, (wrapped - hingeRadius) * (fold.threadedAt >= 0 ? 1 : pressed));
        // The stem's curvature under the blade, in the blade's own frame: a
        // span sags in the gameplay plane, which is as often across the blade
        // as toward its face, and a stem curving out from under a long blade
        // either way leaves it standing in the ring.
        const before = this.curve[Math.max(0, ring - 3)]!, after = this.curve[Math.min(this.curve.length - 1, ring + 4)]!;
        const arc = after.distance - before.distance;
        this.curving.set(after.tx - before.tx, threeY(after.ty - before.ty), 0).multiplyScalar(arc > 1e-6 ? 1 / arc : 0);
        const width = 1 + turn * .18;
        const toFace = this.curving.dot(this.foldDir.set(0, 0, 1).applyQuaternion(this.q));
        const across = this.curving.dot(this.foldDir.set(1, 0, 0).applyQuaternion(this.q));
        wrap.setXYZW(j, pressed, facing * wrapped / length, width, toFace * length / 2 * pressed);
        threading.setW(j, across * length / (2 * width) * pressed);
      } else {
        wrap.setXYZW(j, 0, 1, 1, 0);
      }
      // Keep the attached base tangent to the stem, then gently turn the broad
      // blade toward the gameplay plane after it has cleared the braid.
      this.leafGeometry.getAttribute("leafFaceTurn").setX(j,
        Math.max(-1.05, Math.min(1.05, Math.atan2(this.leafWidth.z, this.leafNormal.z))) * (.7 + .3 * vineRandom(seed, leaf, 22)) * loose);
      const motion = tube.leafMotions[leaf] ?? (tube.leafMotions[leaf] = new VineLeafLag());
      this.inverseLeaf.copy(this.q).invert();
      this.leafLag.copy(motion.update(this.pos, time, length)).applyQuaternion(this.inverseLeaf).multiplyScalar(loose / length);
      // Pressed flat, the blade's curl and the droop built into its geometry
      // (-0.08·t³ along its normal, `vineLeafGeometry`) are pressed out too.
      const shape = this.leafGeometry.getAttribute("leafShape");
      shape.setXYZW(j, (vineRandom(seed, leaf, 20) - .5) * .09 * loose,
        (vineRandom(seed, leaf, 21) > .8 ? -.09 : .015) * loose + .08 * (1 - loose), this.leafLag.x, this.leafLag.z);
      this.scl.set(length * (1 + turn * .18), length, length);
      this.m.compose(this.pos, this.q, this.scl);
      this.leafMesh.setMatrixAt(j, this.m);
      const green = tone === 0 ? [0.08, 0.18, 0.05] :
        tone === 1 ? [0.13, 0.26, 0.065] : [0.23, 0.34, 0.1];
      this.leafMesh.instanceColor?.setXYZ(j, green[0]!, green[1]!, green[2]!);
    }, this.curve, tube.growthLength);
    this.scl.set(1, 1, 1);
  }

  private lay(points: readonly Vec2[]): void {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const d = b.sub(a);
      const len = d.length();
      if (len < 1e-6) continue;
      const j = this.count++;
      if (j >= this.capacity) continue; // grown on the next frame; see above
      // The capsule's +y turned onto the segment, in three's frame.
      this.q.setFromAxisAngle(FORWARD, Math.atan2(threeY(d.y), d.x) - Math.PI / 2);
      this.pos.set((a.x + b.x) / 2, threeY((a.y + b.y) / 2), 0);
      this.scl.set(1, len * OVERLAP, 1);
      this.m.compose(this.pos, this.q, this.scl);
      this.mesh.setMatrixAt(j, this.m);
      this.mesh.instanceColor?.setXYZ(j, this.tint.r, this.tint.g, this.tint.b);
    }
    // The scale is per instance and `scl` is scratch, so it has to be handed
    // back to the identity the next caller assumes.
    this.scl.set(1, 1, 1);
  }

  clear(): void {
    this.starberries.hide();
    this.count = 0;
    this.mesh.count = 0;
    for (const tube of this.braids.values()) { tube.mesh.visible = false; tube.leafMotions.length = 0; tube.leafFolds.length = 0; tube.twist.reset(); }
    this.leafMesh.count = 0;
  }

  dispose(): void {
    this.starberries.dispose();
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    for (const tube of this.braids.values()) tube.dispose();
    this.braids.clear();
    this.scene.remove(this.leafMesh);
    this.leafMesh.dispose();
    this.geometry.dispose();
    this.leafGeometry.dispose();
    this.material.dispose();
    this.leafMaterial.dispose();
    this.leafDepthMaterial.dispose();
    this.leafDistanceMaterial.dispose();
  }
}
