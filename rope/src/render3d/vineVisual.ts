// Every vine in the scene, as one `InstancedMesh` of short capsules.
//
// The same argument `ChainLayer` is written under, one mechanic along: a vine is
// a run of small identical pieces whose only per-piece difference is a transform
// and a tint, so it is one instanced mesh rather than a `Mesh` per segment
// rebuilt every frame. What differs from the chain is the SOURCE of the path - a
// chain's is its wrap nodes, and a vine's is its links, which are real bodies
// (see `level/vines.ts`).
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
// A capsule and not a cylinder because of the joints. The cord bends at every
// link, and two cylinders meeting at an angle leave a notch on the outside of
// the bend; the hemispherical caps fill it at any angle, which is what lets the
// segments be laid independently with no mitre to compute.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import { VINE_VISUAL_RADIUS, type VineCord } from "../level/vines";
import { VINE_COLOR } from "../render/vines";
import { forEachBraidSegment } from "../render/vineBraid";
import { threeY } from "./space";

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

export class VineLayer {
  private mesh: THREE.InstancedMesh;
  private braidMesh: THREE.InstancedMesh;
  private capacity = INITIAL_SEGMENTS;
  private count = 0;
  private braidCapacity = INITIAL_SEGMENTS;
  private braidCount = 0;
  private readonly geometry: THREE.BufferGeometry;
  private readonly braidGeometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;
  // Scratch, reused every frame: a transform sync must not allocate.
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);
  private readonly tint = new THREE.Color();
  private readonly path: Vec2[] = [];
  private readonly a3 = new THREE.Vector3();
  private readonly b3 = new THREE.Vector3();
  private readonly dir3 = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly scene: THREE.Scene) {
    // A unit-length capsule: the per-instance y scale is then the segment's own
    // length, and nothing has to rebuild geometry as a vine bends.
    this.geometry = new THREE.CapsuleGeometry(VINE_VISUAL_RADIUS, 1, 3, 8);
    this.braidGeometry = new THREE.CapsuleGeometry(VINE_VISUAL_RADIUS * 0.52, 1, 2, 6);
    this.material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(VINE_COLOR),
      roughness: 0.85,
      metalness: 0,
    });
    this.mesh = this.makeMesh(this.capacity);
    this.braidMesh = this.makeMesh(this.braidCapacity, this.braidGeometry);
    scene.add(this.mesh);
    scene.add(this.braidMesh);
  }

  private makeMesh(capacity: number, geometry = this.geometry): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The count is set per frame, and a vine swings across the level, so the
    // mesh's own bounds are never a useful cull test.
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

  // Every vine on the level, laid this frame.
  sync(vines: readonly VineCord[], alpha: number): void {
    this.count = 0;
    this.braidCount = 0;
    for (const vine of vines) {
      vine.path(alpha, this.path);
      if (this.path.length < 2) continue;
      this.tint.set(vine.color ?? DEFAULT_TINT);
      if (vine.braidSeed === null) this.lay(this.path);
      else this.layBraid(this.path, vine.braidSeed);
    }
    // A vine longer than the buffer truncates for one frame and the buffer is
    // resized for the next, rather than mid-walk - which would throw away every
    // matrix already written into it this frame. `ChainLayer`'s rule.
    if (this.count > this.capacity) this.grow(this.count);
    if (this.braidCount > this.braidCapacity) {
      while (this.braidCapacity < this.braidCount) this.braidCapacity *= 2;
      this.scene.remove(this.braidMesh);
      this.braidMesh.dispose();
      this.braidMesh = this.makeMesh(this.braidCapacity, this.braidGeometry);
      this.scene.add(this.braidMesh);
    }
    this.mesh.count = Math.min(this.count, this.capacity);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.braidMesh.count = Math.min(this.braidCount, this.braidCapacity);
    this.braidMesh.instanceMatrix.needsUpdate = true;
    if (this.braidMesh.instanceColor) this.braidMesh.instanceColor.needsUpdate = true;
  }

  private layBraid(points: readonly Vec2[], seed: number): void {
    forEachBraidSegment(points, seed, (ax, ay, az, bx, by, bz, strand) => {
      const j = this.braidCount++;
      if (j >= this.braidCapacity) return;
      this.a3.set(ax, threeY(ay), az);
      this.b3.set(bx, threeY(by), bz);
      this.dir3.subVectors(this.b3, this.a3);
      const length = this.dir3.length();
      if (length < 1e-6) return;
      this.q.setFromUnitVectors(this.up, this.dir3.multiplyScalar(1 / length));
      this.pos.addVectors(this.a3, this.b3).multiplyScalar(0.5);
      this.scl.set(1, length * 1.08, 1);
      this.m.compose(this.pos, this.q, this.scl);
      this.braidMesh.setMatrixAt(j, this.m);
      const shade = strand === 0 ? 1.1 : strand === 1 ? 0.9 : 0.72;
      this.braidMesh.instanceColor?.setXYZ(j, this.tint.r * shade, this.tint.g * shade, this.tint.b * shade);
    });
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
    this.count = 0;
    this.mesh.count = 0;
    this.braidMesh.count = 0;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.scene.remove(this.braidMesh);
    this.braidMesh.dispose();
    this.geometry.dispose();
    this.braidGeometry.dispose();
    this.material.dispose();
  }
}
