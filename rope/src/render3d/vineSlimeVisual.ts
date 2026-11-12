import * as THREE from "three";
import { SLIME_CAPACITY, type VineSlime } from "../render/vineSlime";

// The globs of slime off a vine (render/vineSlime.ts): small wet drops, glossy
// enough that the scene's lights catch them, which is most of what makes a
// centimetre of slime readable at the game's framing. Opaque, and shrunk away
// rather than faded, so nothing has to be sorted.
//
// The pool is fixed, so the mesh is built once and lives on the scene for the
// session; `sync` lays the live globs each frame and sets the count.

// The slime's colour, linear RGB: the vine's own green (render/vines.ts
// VINE_COLOR), paler and yellower, as a film of it is.
const SLIME_COLOR = new THREE.Color().setRGB(0.2, 0.26, 0.07);

export class VineSlimeLayer {
  private readonly geometry = new THREE.IcosahedronGeometry(1, 2);
  private readonly material = new THREE.MeshPhysicalMaterial({
    color: SLIME_COLOR,
    roughness: 0.18,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
  });
  private readonly mesh: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  // Set by `Scene3D.prewarm` around its compile (see `LeafShedLayer`).
  prewarming = false;

  constructor(scene: THREE.Object3D) {
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, SLIME_CAPACITY);
    this.mesh.name = "vine-slime";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  sync(slime: VineSlime | null): void {
    if (this.prewarming) {
      this.m.identity();
      this.mesh.setMatrixAt(0, this.m);
      this.mesh.count = 1;
      this.mesh.instanceMatrix.needsUpdate = true;
      return;
    }
    const n = slime ? Math.min(slime.live, SLIME_CAPACITY) : 0;
    this.mesh.count = n;
    if (!slime || n === 0) return;
    for (let i = 0; i < n; i++) {
      const r = slime.radius[i]! * slime.fade(i);
      this.pos.set(slime.x[i]!, slime.y[i]!, slime.z[i]!);
      this.scl.set(r * slime.sx[i]!, r * slime.sy[i]!, r * slime.sz[i]!);
      this.m.compose(this.pos, this.q, this.scl);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
