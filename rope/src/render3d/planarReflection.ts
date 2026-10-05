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

// The picture's size: square texels over the water's window on the screen
// (see `capture`), about TEXELS of them, and none smaller than MIN_TEXEL
// drawing-buffer pixels. TEXELS is the 480x270 the pass was measured at
// (live, 2026-10-05, 4K, RTX 4070 SUPER, interleaved: the pass's cost is its
// pixels, not its draws - leaving the ivy, the moss or the ball out of it
// saved under 0.05 ms; 540 lines -> 270 saved 0.17 of its ~0.33 ms).
//
// SQUARE, because the window is wide and short (a pool seen nearly edge-on)
// while a target of the canvas's shape spent its texels the other way: 480
// across a full-width window was a texel per 4 screen pixels at 1080p and 8
// at 4K.
const TEXELS = 480 * 270;
const MIN_TEXEL = 2;
// The texel's size is kept until the window's area asks for one more than
// this far off it (in octaves), so a window changing shape as the camera
// moves does not change the grid every frame (see `snap`).
const TEXEL_HYSTERESIS = 0.25;
// The target is only ever grown, to whole multiples of this, so a window
// changing shape draws into a part of it rather than remaking it.
const ALLOCATION_STEP = 64;

// What a pool samples, shared by every pool material: the picture, its depth,
// the matrix taking a world point to its place in the picture, and that
// matrix's inverse (for the depth back to a world point). Set every frame the
// pass runs; a pool reads them only while its own `reflect` uniform is on.
export const reflectionUniforms = {
  uReflection: { value: null as THREE.Texture | null },
  uReflectionDepth: { value: null as THREE.Texture | null },
  uReflectionMatrix: { value: new THREE.Matrix4() },
  uReflectionInverse: { value: new THREE.Matrix4() },
  // The picture is drawn into the corner of a larger target (see
  // ALLOCATION_STEP): the part of the texture it fills (x, y), and half a
  // texel of it (z, w), in the picture's own 0..1, for clamping reads inside.
  uReflectionArea: { value: new THREE.Vector4(1, 1, 0, 0) },
};

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export class PlanarReflection {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly size = new THREE.Vector2();
  // The drawing buffer's size the target was made for.
  private readonly canvas = new THREE.Vector2();
  // The picture's texel in drawing-buffer pixels, and its size in texels.
  private texel = MIN_TEXEL;
  private readonly texels = new THREE.Vector2(1, 1);
  private readonly rect = new THREE.Vector4();
  private readonly whole = new THREE.Vector4(-1, 1, -1, 1);
  private readonly anchorClip = new THREE.Vector4();
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
  //
  // HELD STILL IN THE WORLD. The picture is a few screen pixels a texel, and
  // a grid that coarse fixed to the screen aliases whatever slides across it:
  // as the camera panned slowly, a reflected rock slid along with the grid
  // and snapped back to the rock a texel at a time (Tris, 2026-10-05; a `cli
  // shot` pan at ~1.5 px a frame moved the rock 0, 1.8, 3.1, 4.9, 6.1 px and
  // its reflection 0, 0.5, 3.9, 4.0, 4.5). So the window is snapped to a grid
  // of whole texels laid through `anchor`, a point fixed in the world: as the
  // camera moves, everything at the anchor's depth is drawn into exactly the
  // same texels, only shifted by whole ones, and the pool's filtered read
  // carries it smoothly. What stands far nearer or deeper than the anchor
  // still slides against the grid, by its parallax against it.
  capture(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    y: number,
    hidden: THREE.Object3D[],
    view: THREE.Vector4 | null,
    anchor: THREE.Vector3,
  ): void {
    const renderer = this.renderer;
    const rect = this.snap(camera, view, anchor);
    const target = this.fit();
    const mirror = this.mirror(camera, y, rect);

    const shown = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const previous = renderer.getRenderTarget();
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    // Point sprites are sized in pixels of the target they are drawn into.
    const pointHalfHeight = POINT_VIEW_HALF_HEIGHT.value;
    renderer.shadowMap.autoUpdate = false;
    POINT_VIEW_HALF_HEIGHT.value = target.viewport.w / 2;
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, mirror);
    } finally {
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
    const { z: w, w: h } = target.viewport;
    reflectionUniforms.uReflectionArea.value.set(w / target.width, h / target.height, 0.5 / w, 0.5 / h);
  }

  dispose(): void {
    this.free();
  }

  // The camera mirrored in the plane y = `y`, its view narrowed to `view`
  // and its near plane skewed onto the water.
  private mirror(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    y: number,
    view: THREE.Vector4,
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
    // Clip space scaled and shifted so the window fills it. The mirror's
    // picture is the screen's turned left for right (its up is reflected, so
    // its right points the other way: a point's x in the mirror is minus the
    // screen's x of its reflection), so the window's x is turned too.
    const sx = 2 / (view.y - view.x);
    const sy = 2 / (view.w - view.z);
    this.crop.set(sx, 0, 0, sx * (view.x + view.y) / 2, 0, sy, 0, -sy * (view.z + view.w) / 2, 0, 0, 1, 0, 0, 0, 0, 1);
    mirror.projectionMatrix.premultiply(this.crop);

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

  // The window the picture covers: `view` (null for the whole screen) grown
  // out to whole texels of a grid laid through `anchor` (see `capture`), and
  // the picture's size in texels, set as the target's viewport by `fit`.
  private snap(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    view: THREE.Vector4 | null,
    anchor: THREE.Vector3,
  ): THREE.Vector4 {
    this.renderer.getDrawingBufferSize(this.size);
    const { x: width, y: height } = this.size;
    const rect = this.rect.copy(view ?? this.whole);
    const across = Math.max(1, ((rect.y - rect.x) / 2) * width);
    const down = Math.max(1, ((rect.w - rect.z) / 2) * height);
    const wanted = Math.max(MIN_TEXEL, Math.sqrt((across * down) / TEXELS));
    if (!(Math.abs(Math.log2(wanted / this.texel)) <= TEXEL_HYSTERESIS)) this.texel = wanted;

    // A texel in normalised device coordinates, and where the anchor falls.
    // Behind the camera it lays no grid: the rect stands where it is.
    const dx = (2 * this.texel) / width;
    const dy = (2 * this.texel) / height;
    camera.updateMatrixWorld();
    this.anchorClip
      .set(anchor.x, anchor.y, anchor.z, 1)
      .applyMatrix4(camera.matrixWorldInverse)
      .applyMatrix4(camera.projectionMatrix);
    const w0 = this.anchorClip.w;
    const ax = w0 > 0 ? this.anchorClip.x / w0 : rect.x;
    const ay = w0 > 0 ? this.anchorClip.y / w0 : rect.z;
    const x0 = ax + Math.floor((rect.x - ax) / dx) * dx;
    const y0 = ay + Math.floor((rect.z - ay) / dy) * dy;
    this.texels.set(Math.max(1, Math.ceil((rect.y - x0) / dx)), Math.max(1, Math.ceil((rect.w - y0) / dy)));
    return rect.set(x0, x0 + this.texels.x * dx, y0, y0 + this.texels.y * dy);
  }

  // The target, drawing into its corner at the picture's size (`snap`'s
  // texels). Made on first use, grown when a picture outgrows it, and remade
  // when the canvas is resized.
  private fit(): THREE.WebGLRenderTarget {
    const { x: width, y: height } = this.size;
    const { x: w, y: h } = this.texels;
    const resized = this.canvas.x !== width || this.canvas.y !== height;
    const old = this.target && !resized ? this.target : null;
    const grown = (have: number, need: number): number =>
      have >= need ? have : Math.ceil(need / ALLOCATION_STEP) * ALLOCATION_STEP;
    const aw = grown(old?.width ?? 0, w);
    const ah = grown(old?.height ?? 0, h);
    let target = old;
    if (!target || target.width !== aw || target.height !== ah) {
      this.free();
      target = new THREE.WebGLRenderTarget(aw, ah, {
        colorSpace: THREE.SRGBColorSpace,
        depthTexture: new THREE.DepthTexture(aw, ah),
        generateMipmaps: false,
      });
      // See the header and frameTarget.ts: the canvas's own programs.
      (target as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
      target.texture.internalFormat = "RGBA8";
      this.target = target;
      this.canvas.copy(this.size);
    }
    target.viewport.set(0, 0, w, h);
    return target;
  }

  private free(): void {
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.target = null;
  }
}
