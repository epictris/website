import * as THREE from "three";
import { skinnedBoundingBox } from "./skinnedBounds";

const EDGES = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
const corners = () => Array.from({ length: 8 }, () => new THREE.Vector3());

// One shadow pass, fitted to visible receivers and extended upstream to every
// potentially overlapping caster. Bounds are conservative: they may admit an
// extra caster, but never discard one just because it is offscreen.
export class SunShadowFit {
  private readonly view = new THREE.Frustum();
  private readonly projection = new THREE.Matrix4();
  private readonly basis = new THREE.Matrix4();
  private readonly rotation = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private readonly receivers = new THREE.Box3();
  private readonly casterBoxes: THREE.Box3[] = [];
  private readonly boxPoints = corners();
  private readonly viewPoints = corners();
  private readonly boxPlanes = Array.from({ length: 6 }, () => new THREE.Plane());
  private readonly point = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private width = 30;
  private height = 30;

  fit(scene: THREE.Scene, camera: THREE.Camera, sun: THREE.DirectionalLight): void {
    // As three's renderer does: a caller that has switched the scene's auto
    // update off has updated it for the frame already (Scene3D.render).
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.direction.subVectors(sun.position, sun.target.position).normalize();
    // Use exactly the same basis as the shadow camera, including its vertical
    // light fallback, rather than maintaining a second lookAt convention.
    this.rotation.lookAt(this.direction, this.origin.set(0, 0, 0), sun.shadow.camera.up);
    this.basis.copy(this.rotation).transpose();
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.view.setFromProjectionMatrix(this.projection);
    for (let i = 0; i < 8; i++) {
      this.viewPoints[i].set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1).unproject(camera);
    }
    this.receivers.makeEmpty();
    let casterCount = 0;
    scene.traverseVisible(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.layers.test(camera.layers) || (!mesh.castShadow && !mesh.receiveShadow)) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!materials.some(material => material.visible)) return;
      // Instanced and skinned bounds belong to the object, ordinary bounds to
      // its geometry. Recompute moving instances/bones; static geometry caches
      // its local bounds and only the world transform changes each frame. A
      // skinned mesh is bounded by its bones, never by skinning its vertices
      // (skinnedBounds.ts: that walk was 3.7 ms of the frame).
      if (mesh instanceof THREE.SkinnedMesh) {
        skinnedBoundingBox(mesh, this.box);
      } else if (mesh instanceof THREE.InstancedMesh) {
        mesh.computeBoundingBox();
        this.box.copy(mesh.boundingBox!);
      } else {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        this.box.copy(mesh.geometry.boundingBox!);
      }
      this.box.applyMatrix4(mesh.matrixWorld);
      if (this.box.isEmpty()) return;
      if (mesh.castShadow) {
        const caster = this.casterBoxes[casterCount] ?? (this.casterBoxes[casterCount] = new THREE.Box3());
        caster.copy(this.box).applyMatrix4(this.basis);
        casterCount++;
      }
      if (mesh.receiveShadow && this.view.intersectsBox(this.box)) this.includeReceiver();
    });
    if (this.receivers.isEmpty()) return;

    // Leave room for PCF and the half-texel rounding below. Grow in discrete
    // steps, never shrink during a level: moving past a small prop must not
    // continually change the texel scale of every shadow in the scene.
    const guardTexels = Math.ceil(sun.shadow.radius) + 2;
    const map = sun.shadow.mapSize;
    while (this.width * (1 - 2 * guardTexels / map.x) < this.receivers.max.x - this.receivers.min.x) this.width *= 2;
    while (this.height * (1 - 2 * guardTexels / map.y) < this.receivers.max.y - this.receivers.min.y) this.height *= 2;
    const tx = this.width / map.x, ty = this.height / map.y;
    const cx = Math.round((this.receivers.min.x + this.receivers.max.x) / 2 / tx) * tx;
    const cy = Math.round((this.receivers.min.y + this.receivers.max.y) / 2 / ty) * ty;
    let upstream = this.receivers.max.z;
    for (let i = 0; i < casterCount; i++) {
      const b = this.casterBoxes[i];
      if (b.max.x < cx - this.width / 2 || b.min.x > cx + this.width / 2 ||
          b.max.y < cy - this.height / 2 || b.min.y > cy + this.height / 2 ||
          b.max.z < this.receivers.min.z) continue;
      upstream = Math.max(upstream, b.max.z);
    }
    // +z points toward the sun. Move the light past all upstream casters;
    // increasing far alone would still clip them at the near plane.
    const lightZ = Math.ceil(upstream + 2);
    sun.position.set(cx, cy, lightZ).applyMatrix4(this.rotation);
    sun.target.position.copy(sun.position).sub(this.direction);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    const shadow = sun.shadow.camera;
    shadow.left = -this.width / 2;
    shadow.right = this.width / 2;
    shadow.bottom = -this.height / 2;
    shadow.top = this.height / 2;
    shadow.near = 0.5;
    shadow.far = Math.max(1, Math.ceil(lightZ - this.receivers.min.z + 2));
    // Preserve the previous world-space depth bias as the depth range varies.
    sun.shadow.bias = -0.0008 * (75 - 0.5) / (shadow.far - shadow.near);
    shadow.updateProjectionMatrix();
  }

  private includeReceiver(): void {
    const { min, max } = this.box;
    for (let i = 0; i < 8; i++) this.boxPoints[i].set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
    this.boxPlanes[0].setComponents(1, 0, 0, -min.x);
    this.boxPlanes[1].setComponents(-1, 0, 0, max.x);
    this.boxPlanes[2].setComponents(0, 1, 0, -min.y);
    this.boxPlanes[3].setComponents(0, -1, 0, max.y);
    this.boxPlanes[4].setComponents(0, 0, 1, -min.z);
    this.boxPlanes[5].setComponents(0, 0, -1, max.z);
    // All vertices of the intersection are clipped endpoints of an edge from
    // either solid. Both directions matter when a giant mesh encloses the view.
    for (const [a, b] of EDGES) {
      this.includeSegment(this.boxPoints[a], this.boxPoints[b], this.view.planes);
      this.includeSegment(this.viewPoints[a], this.viewPoints[b], this.boxPlanes);
    }
  }

  private includeSegment(a: THREE.Vector3, b: THREE.Vector3, planes: THREE.Plane[]): void {
    let lo = 0, hi = 1;
    for (const plane of planes) {
      const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
      if (da < 0 && db < 0) return;
      if (da < 0) lo = Math.max(lo, da / (da - db));
      else if (db < 0) hi = Math.min(hi, da / (da - db));
      if (lo > hi) return;
    }
    this.receivers.expandByPoint(this.point.copy(a).lerp(b, lo).applyMatrix4(this.basis));
    this.receivers.expandByPoint(this.point.copy(a).lerp(b, hi).applyMatrix4(this.basis));
  }
}
