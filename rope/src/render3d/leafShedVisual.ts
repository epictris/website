import * as THREE from "three";
import type { CollisionObject2D } from "../engine/body";
import { LEAF_CAPACITY, LEAF_TONES as TONES, type LeafShed } from "../render/leafShed";
import { vineLeafGeometry } from "./vineTube";
import { makeVineLeafMaterial, makeVineLeafShadowMaterial } from "./vineLeafMaterial";

// The leaves the cuff knocks loose (render/leafShed.ts), drawn as the vines
// draw theirs: the same blade, the same material and the same tones, so a leaf
// torn off a vine is visibly one of its leaves - plus the per-instance fade
// (`makeVineLeafMaterial(true)`) that lets one go without blending.
//
// The pool is fixed, so the mesh is built once and lives on the scene for the
// session; `sync` lays the live leaves each frame and sets the count.

const CAPACITY = LEAF_CAPACITY;

export class LeafShedLayer {
  private readonly geometry = vineLeafGeometry();
  private readonly material = makeVineLeafMaterial(true);
  private readonly depthMaterial = makeVineLeafShadowMaterial(false, true);
  private readonly distanceMaterial = makeVineLeafShadowMaterial(true, true);
  private readonly mesh: THREE.InstancedMesh;
  private readonly shape = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(THREE.DynamicDrawUsage);
  private readonly turn = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
  private readonly fade = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1).setUsage(THREE.DynamicDrawUsage);
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly half = new THREE.Vector3();
  // Set by `Scene3D.prewarm` around its compile: one leaf is laid so the
  // program and its shadow variants are built under the loading screen
  // rather than on the frame the first leaf comes off.
  prewarming = false;

  constructor(scene: THREE.Object3D) {
    this.geometry.setAttribute("leafShape", this.shape);
    this.geometry.setAttribute("leafFaceTurn", this.turn);
    // A loose leaf is neither pressed to a stem nor threaded by the ring.
    this.geometry.setAttribute("leafWrap", new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4));
    this.geometry.setAttribute("leafRing", new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4));
    this.geometry.setAttribute("leafFade", this.fade);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, CAPACITY);
    this.mesh.name = "shed-leaves";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.mesh.customDepthMaterial = this.depthMaterial;
    this.mesh.customDistanceMaterial = this.distanceMaterial;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // The leaves are anywhere in the level; the count is the cull.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  // Lay this frame's leaves. `depthOf` is how far in front of the gameplay
  // plane the body a leaf came off is drawn.
  sync(leaves: LeafShed | null, depthOf: (body: CollisionObject2D) => number): void {
    if (this.prewarming) {
      this.m.identity();
      this.mesh.setMatrixAt(0, this.m);
      this.fade.setX(0, 1);
      this.mesh.count = 1;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.fade.needsUpdate = true;
      return;
    }
    const n = leaves ? Math.min(leaves.live, CAPACITY) : 0;
    this.mesh.count = n;
    if (!leaves || n === 0) return;
    for (let i = 0; i < n; i++) {
      const len = leaves.length[i]!;
      this.q.set(leaves.qx[i]!, leaves.qy[i]!, leaves.qz[i]!, leaves.qw[i]!);
      // The blade's geometry starts at its stem and runs a length up +y: the
      // flight is of its middle, so the stem is laid half a length back.
      this.half.set(0, -0.5 * len, 0).applyQuaternion(this.q);
      const body = leaves.body[i];
      this.pos.set(leaves.x[i]!, leaves.y[i]!, leaves.z[i]! + (body ? depthOf(body) : 0)).add(this.half);
      this.scl.set(len, len, len);
      this.m.compose(this.pos, this.q, this.scl);
      this.mesh.setMatrixAt(i, this.m);
      this.shape.setXYZW(i, leaves.bow[i]!, leaves.curl[i]!, 0, 0);
      this.fade.setX(i, leaves.fade(i));
      const [r, g, b] = TONES[leaves.tone[i]!]!;
      this.mesh.instanceColor!.setXYZ(i, r, g, b);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.shape.needsUpdate = true;
    this.fade.needsUpdate = true;
  }

  clear(): void {
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.distanceMaterial.dispose();
  }
}
