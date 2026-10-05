// What a pool mirrors: the scene drawn again from the camera's reflection in
// the water's surface, into a target the pool's material reads back through
// its own ripples (stillWater.ts, after Tris's cave-pool reference of
// 2026-10-05). The ball, the chain and the rocks standing in the water bend
// and break in it as the ripples pass.
//
// HOW. The camera is mirrored in the horizontal plane at the waterline and its
// projection's near plane is turned to lie ON that plane (Lengyel's oblique
// clip, as three's `Reflector` does), so everything under the water - the
// pool's bed, a submerged ball - is clipped out of the mirror rather than
// standing up out of it. The same skewed frustum also culls whatever is wholly
// under the water, so those objects cost no draw calls at all.
//
// DRAWN AS THE CANVAS IS, like the frame itself (see frameTarget.ts): flagged
// as three's XR target and stored as plain RGBA8, so every program in the pass
// is one the frame already compiled, tone mapped and sRGB encoded in the
// shader. The target therefore holds what the player would see looking up
// from the water, and the pool's material (which is not tone mapped) decodes
// it and mixes it in display terms, as the reference did.
//
// What the pass leaves out: every pool (a mirror cannot see itself), the
// editor's guides, the light shafts and the depth of field (both drawn over
// the finished frame), and the shadow pass (last frame's maps are reused, as
// the ball's probe does).
//
// The depth is kept so the pool can tell how far each mirrored thing stands
// from the water: the reference reflects near rocks strongly and the far cave
// faintly, which is what keeps the water teal rather than a dark mirror.

import * as THREE from "three";
import { POINT_VIEW_HALF_HEIGHT } from "./space";

// The target's size: half the drawing buffer's, and at most this many lines.
// The reflection is smeared by the ripples' distortion and softened by three
// taps, and since the picture is cropped to the water (see `capture`) these
// lines are spent on the water alone: over the BALL pool's third of a 4K
// frame, 270 is a texel per ~2.6 screen pixels, under the smear.
// The pass's cost is its pixels, not its draws (measured live 2026-10-05,
// 4K, RTX 4070 SUPER, interleaved: leaving the ivy, the moss or the ball out
// of it saved under 0.05 ms; 540 lines -> 270 saved 0.17 of its ~0.33 ms and
// took the frames over 7.5 ms from 17% to 7%; 135 saved only 0.04 more).
const RESOLUTION = 0.5;
const MAX_LINES = 270;

// What a pool samples, shared by every pool material: the picture, its depth,
// the matrix taking a world point to its place in the picture, and that
// matrix's inverse (for the depth back to a world point). Set every frame the
// pass runs; a pool reads them only while its own `reflect` uniform is on.
export const reflectionUniforms = {
  uReflection: { value: null as THREE.Texture | null },
  uReflectionDepth: { value: null as THREE.Texture | null },
  uReflectionMatrix: { value: new THREE.Matrix4() },
  uReflectionInverse: { value: new THREE.Matrix4() },
};

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export class PlanarReflection {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly size = new THREE.Vector2();
  private readonly perspective = new THREE.PerspectiveCamera();
  private readonly orthographic = new THREE.OrthographicCamera();
  // Scratch.
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly eye = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly crop = new THREE.Matrix4();
  private readonly inverse = new THREE.Matrix4();

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  // Draw `scene` as `camera` sees it mirrored in the horizontal plane at
  // height `y` (three's frame), with `hidden` left out of it, and publish it
  // through `reflectionUniforms`. The caller has checked the camera is above
  // the plane.
  //
  // CROPPED TO THE WATER. A point of the water at a pixel of the screen reads
  // the mirror at that same pixel (plus the ripples' push), so the mirror only
  // needs the part of the screen the water covers: `view` is that, in
  // normalised device coordinates (x0, x1, y0, y1), and the mirror camera's
  // projection is narrowed to it. Everything whose reflection lands outside it
  // is culled by the narrower frustum, and every texel of the target is spent
  // on the water. Null draws the whole view.
  capture(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    y: number,
    hidden: THREE.Object3D[],
    view: THREE.Vector4 | null,
  ): void {
    const renderer = this.renderer;
    const target = this.fit();
    const mirror = this.mirror(camera, y, view);

    const shown = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const previous = renderer.getRenderTarget();
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    // Point sprites are sized in pixels of the target they are drawn into.
    const pointHalfHeight = POINT_VIEW_HALF_HEIGHT.value;
    renderer.shadowMap.autoUpdate = false;
    POINT_VIEW_HALF_HEIGHT.value = target.height / 2;
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, mirror);    } finally {
      renderer.setRenderTarget(previous);
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      POINT_VIEW_HALF_HEIGHT.value = pointHalfHeight;
      hidden.forEach((o, i) => (o.visible = shown[i]!));
    }

    this.viewProjection.multiplyMatrices(mirror.projectionMatrix, mirror.matrixWorldInverse);
    reflectionUniforms.uReflectionMatrix.value.multiplyMatrices(BIAS, this.viewProjection);
    reflectionUniforms.uReflectionInverse.value.copy(this.viewProjection).invert();
    reflectionUniforms.uReflection.value = target.texture;
    reflectionUniforms.uReflectionDepth.value = target.depthTexture;
  }

  dispose(): void {
    this.free();
  }

  // The camera mirrored in the plane y = `y`, its view narrowed to `view`
  // and its near plane skewed onto the water.
  private mirror(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    y: number,
    view: THREE.Vector4 | null,
  ): THREE.Camera {
    camera.updateMatrixWorld();
    const mirror: THREE.PerspectiveCamera | THREE.OrthographicCamera =
      camera instanceof THREE.PerspectiveCamera ? this.perspective : this.orthographic;
    // Position, a point it looks at, and its up, each reflected (y -> 2y - y).
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.look.set(0, 0, -1).transformDirection(camera.matrixWorld).add(this.eye);
    this.up.set(0, 1, 0).transformDirection(camera.matrixWorld);
    this.eye.y = 2 * y - this.eye.y;
    this.look.y = 2 * y - this.look.y;
    this.up.y = -this.up.y;
    mirror.position.copy(this.eye);
    mirror.up.copy(this.up);
    mirror.lookAt(this.look);
    mirror.near = camera.near;
    mirror.far = camera.far;
    mirror.updateMatrixWorld();
    mirror.projectionMatrix.copy(camera.projectionMatrix);
    if (view) {
      // Clip space scaled and shifted so the window fills it.
      const sx = 2 / (view.y - view.x);
      const sy = 2 / (view.w - view.z);
      this.crop.set(sx, 0, 0, -sx * (view.x + view.y) / 2, 0, sy, 0, -sy * (view.z + view.w) / 2, 0, 0, 1, 0, 0, 0, 0, 1);
      mirror.projectionMatrix.premultiply(this.crop);
    }

    // The oblique near plane (Lengyel, terathon.com/code/oblique.html),
    // keeping the half above the water, in its general form - the far corner
    // q = P^-1 (sgn cx, sgn cy, 1, 1), the third row replaced by c' - row 4 -
    // which holds for an off-centre (cropped) projection of either kind.
    this.plane.set(new THREE.Vector3(0, 1, 0), -y).applyMatrix4(mirror.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = mirror.projectionMatrix;
    this.q.set(Math.sign(this.clip.x), Math.sign(this.clip.y), 1, 1).applyMatrix4(this.inverse.copy(p).invert());
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    const e = p.elements;
    e[2] = this.clip.x - e[3]!;
    e[6] = this.clip.y - e[7]!;
    e[10] = this.clip.z - e[11]!;
    e[14] = this.clip.w - e[15]!;
    mirror.projectionMatrixInverse.copy(p).invert();
    return mirror;
  }

  // Made on first use and remade when the canvas is resized.
  private fit(): THREE.WebGLRenderTarget {
    this.renderer.getDrawingBufferSize(this.size);
    const scale = Math.min(RESOLUTION, MAX_LINES / Math.max(1, this.size.y));
    const w = Math.max(1, Math.round(this.size.x * scale));
    const h = Math.max(1, Math.round(this.size.y * scale));
    if (this.target && this.target.width === w && this.target.height === h) return this.target;
    this.free();
    const target = new THREE.WebGLRenderTarget(w, h, {
      colorSpace: THREE.SRGBColorSpace,
      depthTexture: new THREE.DepthTexture(w, h),
      generateMipmaps: false,
    });
    // See the header and frameTarget.ts: the canvas's own programs.
    (target as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
    target.texture.internalFormat = "RGBA8";
    this.target = target;
    return target;
  }

  private free(): void {
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.target = null;
  }
}
