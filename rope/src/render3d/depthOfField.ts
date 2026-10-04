// DEPTH OF FIELD: the scenery behind the gameplay plane drawn out of focus, and
// the plane itself never. Off unless asked for (`?dof=low|medium|high` for
// now, while its cost is measured).
//
// THE FOCUS IS THE PLANE. Where the lens is focused is fixed at the gameplay
// plane (z = 0) plus `FOCUS_BAND` behind it, wherever a level's lens has put the
// camera, so nothing the ball can touch is ever soft. Only what lies BEHIND it
// blurs, by a thin lens's circle of confusion, `1 - s / d` for focus distance s
// and depth d: zero at the band, rising through the near scenery, levelling off
// toward the sky at the setting's size.
//
// A FRAME WITH IT ON:
//
//   1. The scene, as the canvas would draw it, into a multisampled target that
//      keeps its depth - minus the see-through things near the plane (step 5).
//      The target is flagged as three's XR target and stored as plain RGBA8, so
//      every program is the canvas's own (tone mapped, sRGB encoded) and
//      translucent layers blend in the same space: with no blur, the frame IS
//      the direct path's. Drawn into an ordinary linear float target instead,
//      the sky moved from (20,40,62) to (2,29,56) with no blur at all.
//   2. Small (see `BLUR_LINES`): each block's colour (the out-of-focus pixels
//      in it) and its largest circle of confusion.
//   3. Small: a gather blur (Gustafsson's single pass, a golden-angle spiral)
//      in which a tap counts only if its own circle reaches the pixel, so the
//      sharp plane never smears into the blur around it.
//   4. Full size, onto the canvas: an in-focus pixel is the scene's own, bit
//      for bit; an out-of-focus one is the blur, upsampled from the small
//      texels that are themselves out of focus (so no in-focus colour leaks
//      in at an edge). The scene's depth goes onto the canvas with it.
//   5. The water, the fireflies, the spray and the beams near the plane, sharp,
//      depth-tested against that. They write no depth, so step 2 would read the
//      scenery BEHIND the water and blur the water with it.
//
// Off is the direct path, untouched: nothing here is allocated or run.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

export type DepthOfFieldLevel = "off" | "low" | "medium" | "high";
export const DEPTH_OF_FIELD_LEVELS: readonly DepthOfFieldLevel[] = ["off", "low", "medium", "high"];

// The largest blur RADIUS, reached at infinity, as a fraction of the frame's
// height, so a setting is the same look at every resolution. At 1080 lines:
// about 4, 9 and 17 pixels.
export const DOF_MAX_BLUR: Readonly<Record<DepthOfFieldLevel, number>> = {
  off: 0,
  low: 0.004,
  medium: 0.008,
  high: 0.016,
};

// Metres behind the gameplay plane still drawn sharp: the scenery a level is
// played against is a solid with depth, and the back of the rock the ball
// rolls on is part of the plane.
export const FOCUS_BAND = 1.5;

// About how many lines the blur is worked at, whatever the frame is drawn at:
// the frame divided by a whole factor of at least 2 (half at 1080p, a quarter
// at 4K). A blur holds no detail finer than itself, and at half of 4K the High
// blur alone cost 0.9 ms on an RTX 4070 SUPER, which pushed a 4K frame past
// 144 Hz's 6.9 ms.
const BLUR_LINES = 540;
const MAX_FACTOR = 4;

// The most taps one small pixel's blur may take. The spiral widens its
// spacing to stay inside it, so a large blur is sparser rather than slower.
const MAX_SAMPLES = 48;

// The layer the see-through things near the plane are moved onto for a frame,
// so step 1 leaves them out and step 5 draws only them. Lights carry it too,
// or step 5 would draw the water unlit. Restored after every frame.
const OVERLAY_LAYER = 31;

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// The circle of confusion in FULL-size pixels, from a depth-buffer value.
const COC_GLSL = /* glsl */ `
  #include <packing>
  uniform sampler2D tDepth;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform bool orthographic;
  uniform float sharpTo;
  uniform float maxCoc;
  float cocAt(vec2 uv) {
    float depth = texture2D(tDepth, uv).x;
    float viewZ = orthographic
      ? orthographicDepthToViewZ(depth, cameraNear, cameraFar)
      : perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
    return maxCoc * max(0.0, 1.0 - sharpTo / -viewZ);
  }`;

const PREP_FRAGMENT = /* glsl */ `
  ${COC_GLSL}
  uniform sampler2D tColor;
  uniform vec2 fullSize;
  uniform int factor;
  void main() {
    // The factor x factor block of full-size pixels this small one covers.
    vec2 corner = floor(gl_FragCoord.xy) * float(factor);
    vec3 sum = vec3(0.0);
    vec3 all = vec3(0.0);
    float count = 0.0;
    float coc = 0.0;
    for (int y = 0; y < ${MAX_FACTOR}; y++) {
      if (y >= factor) break;
      for (int x = 0; x < ${MAX_FACTOR}; x++) {
        if (x >= factor) break;
        vec2 uv = min(corner + vec2(float(x), float(y)) + 0.5, fullSize - 0.5) / fullSize;
        vec3 c = sRGBTransferEOTF(texture2D(tColor, uv)).rgb;
        float k = cocAt(uv);
        all += c;
        if (k >= 0.5) {
          sum += c;
          count += 1.0;
        }
        coc = max(coc, k);
      }
    }
    gl_FragColor = vec4(count > 0.0 ? sum / count : all / float(factor * factor), coc);
  }`;

const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D tPrep;
  uniform vec2 texel;
  uniform float factor;
  varying vec2 vUv;
  const float GOLDEN_ANGLE = 2.39996323;
  void main() {
    vec4 centre = texture2D(tPrep, vUv);
    // Small pixels from here on.
    float coc = centre.a / factor;
    if (coc < 0.5) {
      gl_FragColor = centre;
      return;
    }
    // The spiral adds about 2 * step to radius^2 per tap, so this step reaches
    // the edge of the circle in MAX_SAMPLES taps at most.
    float step = max(0.5, coc * coc / (2.0 * float(${MAX_SAMPLES})));
    vec3 sum = centre.rgb;
    float count = 1.0;
    float radius = step;
    float angle = 0.0;
    for (int i = 0; i < ${MAX_SAMPLES}; i++) {
      if (radius >= coc) break;
      vec4 tap = texture2D(tPrep, vUv + vec2(cos(angle), sin(angle)) * texel * radius);
      // The blur only grows with depth, so a tap with a larger circle is
      // further away, and further scenery may not blur wider over this pixel
      // than the pixel itself does. An in-focus tap reaches nothing.
      float reach = min(tap.a / factor, coc);
      float take = smoothstep(radius - 0.5, radius + 0.5, reach);
      // A tap that does not reach stands in as the average so far, so the
      // weights stay even (Gustafsson).
      sum += mix(sum / count, tap.rgb, take);
      count += 1.0;
      radius += step / radius;
      angle += GOLDEN_ANGLE;
    }
    gl_FragColor = vec4(sum / count, centre.a);
  }`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  ${COC_GLSL}
  uniform sampler2D tColor;
  uniform sampler2D tBlur;
  uniform vec2 blurSize;
  uniform float factor;
  varying vec2 vUv;
  void main() {
    vec4 sharp = texture2D(tColor, vUv);
    gl_FragDepth = texture2D(tDepth, vUv).x;
    float coc = cocAt(vUv);
    if (coc < 0.5) {
      gl_FragColor = sharp;
      return;
    }
    // Bilinear by hand over the four nearest small texels, leaving out the
    // in-focus ones: at the plane's edge they hold the plane's colour. In
    // small-texel units, from this pixel's place in the blocks step 2 made.
    vec2 p = gl_FragCoord.xy / factor - 0.5;
    vec2 base = floor(p);
    vec2 f = p - base;
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 o = vec2(float(i - (i / 2) * 2), float(i / 2));
      vec4 tap = texture2D(tBlur, (clamp(base + o, vec2(0.0), blurSize - 1.0) + 0.5) / blurSize);
      vec2 w2 = mix(1.0 - f, f, o);
      float w = w2.x * w2.y * (tap.a >= 0.5 ? 1.0 : 1e-4);
      sum += tap.rgb * w;
      total += w;
    }
    vec3 blurred = sum / max(total, 1e-6);
    vec3 own = sRGBTransferEOTF(sharp).rgb;
    vec3 c = mix(own, blurred, smoothstep(0.5, 1.5, coc));
    gl_FragColor = sRGBTransferOETF(vec4(c, 1.0));
  }`;

function cocUniforms(): Record<string, THREE.IUniform> {
  return {
    tDepth: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 400 },
    orthographic: { value: false },
    sharpTo: { value: 1 },
    maxCoc: { value: 0 },
  };
}

function seeThrough(material: THREE.Material | THREE.Material[]): boolean {
  const all = Array.isArray(material) ? material : [material];
  return all.length > 0 && all.every((m) => m.transparent && !m.depthWrite);
}

export class DepthOfField {
  private maxBlur = 0;
  // Full-size pixels per small one, each way (see `BLUR_LINES`).
  private factor = 2;
  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  private prepTarget: THREE.WebGLRenderTarget | null = null;
  private blurTarget: THREE.WebGLRenderTarget | null = null;
  private readonly prepMaterial = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: PREP_FRAGMENT,
    uniforms: {
      ...cocUniforms(),
      tColor: { value: null },
      fullSize: { value: new THREE.Vector2() },
      factor: { value: 2 },
    },
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  private readonly blurMaterial = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: BLUR_FRAGMENT,
    uniforms: { tPrep: { value: null }, texel: { value: new THREE.Vector2() }, factor: { value: 2 } },
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  private readonly compositeMaterial = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: COMPOSITE_FRAGMENT,
    uniforms: {
      ...cocUniforms(),
      tColor: { value: null },
      tBlur: { value: null },
      blurSize: { value: new THREE.Vector2() },
      factor: { value: 2 },
    },
    toneMapped: false,
    // The depth is written whatever is under it: a write needs the test on.
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
  });
  private readonly prepQuad = new FullScreenQuad(this.prepMaterial);
  private readonly blurQuad = new FullScreenQuad(this.blurMaterial);
  private readonly compositeQuad = new FullScreenQuad(this.compositeMaterial);
  // The see-through objects moved onto `OVERLAY_LAYER` this frame and the
  // layer masks they had. Kept on the instance so a frame allocates nothing.
  private readonly overlays: THREE.Object3D[] = [];
  private readonly overlayMasks: number[] = [];
  private readonly size = new THREE.Vector2();
  private readonly forward = new THREE.Vector3();
  private readonly sphere = new THREE.Sphere();

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  setLevel(level: DepthOfFieldLevel): void {
    this.maxBlur = DOF_MAX_BLUR[level];
    if (this.maxBlur === 0) this.freeTargets();
  }

  get active(): boolean {
    return this.maxBlur > 0;
  }

  // Draw `scene` onto the whole canvas through the lens. False, having drawn
  // nothing, when the view does not face the gameplay plane (an orbit past
  // edge-on), where there is no plane to focus on; the caller draws directly.
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): boolean {
    camera.updateMatrixWorld();
    camera.getWorldDirection(this.forward);
    if (this.forward.z > -1e-6) return false;
    // The view depth of the gameplay plane straight ahead, which for the
    // game's head-on camera is the depth of every point on it.
    const sharpTo = -camera.position.z / this.forward.z + FOCUS_BAND;

    this.fitTargets();
    const sceneTarget = this.sceneTarget!;
    const prepTarget = this.prepTarget!;
    const blurTarget = this.blurTarget!;
    const r = this.renderer;
    this.takeOverlays(scene, camera, sharpTo);

    const target = r.getRenderTarget();
    const autoClear = r.autoClear;
    const autoReset = r.info.autoReset;
    const shadowsUpdate = r.shadowMap.autoUpdate;
    const cameraMask = camera.layers.mask;
    const background = scene.background;
    // One frame's stats across every draw below, as the direct path's one
    // `render` reports them.
    r.info.reset();
    r.info.autoReset = false;
    try {
      // 1. The scene, without the overlays.
      r.setRenderTarget(sceneTarget);
      r.render(scene, camera);

      // 2. Small: colour and circle of confusion.
      for (const m of [this.prepMaterial, this.blurMaterial, this.compositeMaterial]) {
        m.uniforms.factor!.value = this.factor;
      }
      for (const m of [this.prepMaterial, this.compositeMaterial]) {
        const u = m.uniforms;
        u.tDepth!.value = sceneTarget.depthTexture;
        u.cameraNear!.value = camera.near;
        u.cameraFar!.value = camera.far;
        u.orthographic!.value = camera instanceof THREE.OrthographicCamera;
        u.sharpTo!.value = sharpTo;
        u.maxCoc!.value = this.maxBlur * sceneTarget.height;
        u.tColor!.value = sceneTarget.texture;
      }
      (this.prepMaterial.uniforms.fullSize!.value as THREE.Vector2).set(
        sceneTarget.width,
        sceneTarget.height,
      );
      r.setRenderTarget(prepTarget);
      this.prepQuad.render(r);

      // 3. Small: the blur.
      this.blurMaterial.uniforms.tPrep!.value = prepTarget.texture;
      (this.blurMaterial.uniforms.texel!.value as THREE.Vector2).set(
        1 / blurTarget.width,
        1 / blurTarget.height,
      );
      r.setRenderTarget(blurTarget);
      this.blurQuad.render(r);

      // 4. Onto the canvas, depth and all.
      this.compositeMaterial.uniforms.tBlur!.value = blurTarget.texture;
      (this.compositeMaterial.uniforms.blurSize!.value as THREE.Vector2).set(
        blurTarget.width,
        blurTarget.height,
      );
      r.setRenderTarget(target);
      this.compositeQuad.render(r);

      // 5. The overlays, sharp. The sky was drawn in step 1, and the shadow
      //    maps are this frame's already.
      if (this.overlays.length > 0) {
        r.autoClear = false;
        camera.layers.set(OVERLAY_LAYER);
        scene.background = null;
        r.shadowMap.autoUpdate = false;
        r.render(scene, camera);
      }
    } finally {
      r.autoClear = autoClear;
      r.info.autoReset = autoReset;
      r.shadowMap.autoUpdate = shadowsUpdate;
      camera.layers.mask = cameraMask;
      scene.background = background;
      this.restoreOverlays();
    }
    return true;
  }

  dispose(): void {
    this.freeTargets();
    this.prepMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.prepQuad.dispose();
    this.blurQuad.dispose();
    this.compositeQuad.dispose();
  }

  // Every see-through object any part of which reaches the sharp band (or
  // comes in front of the plane) goes onto the overlay layer for this frame.
  // One wholly behind the band stays in the scene and blurs with it.
  private takeOverlays(scene: THREE.Scene, camera: THREE.Camera, sharpTo: number): void {
    scene.traverseVisible((o) => {
      if ((o as THREE.Light).isLight) {
        o.layers.enable(OVERLAY_LAYER);
        return;
      }
      const material = (o as THREE.Mesh).material;
      if (!material || !seeThrough(material)) return;
      if (!this.reachesFocus(o, camera, sharpTo)) return;
      this.overlays.push(o);
      this.overlayMasks.push(o.layers.mask);
      o.layers.set(OVERLAY_LAYER);
    });
  }

  private reachesFocus(o: THREE.Object3D, camera: THREE.Camera, sharpTo: number): boolean {
    const instanced = o as THREE.InstancedMesh;
    let bounds: THREE.Sphere | null = null;
    if (instanced.isInstancedMesh) {
      if (!instanced.boundingSphere) instanced.computeBoundingSphere();
      bounds = instanced.boundingSphere;
    } else {
      const geometry = (o as THREE.Mesh).geometry;
      if (!geometry) return true;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      bounds = geometry.boundingSphere;
    }
    if (!bounds) return true;
    // This object's own matrix, current: three only brings the whole scene's
    // up to date inside `render`, and an object made this frame has none yet.
    o.updateWorldMatrix(true, false);
    this.sphere.copy(bounds).applyMatrix4(o.matrixWorld);
    const depth = -this.sphere.center.applyMatrix4(camera.matrixWorldInverse).z;
    return depth - this.sphere.radius <= sharpTo;
  }

  private restoreOverlays(): void {
    for (let i = 0; i < this.overlays.length; i++) {
      this.overlays[i]!.layers.mask = this.overlayMasks[i]!;
    }
    this.overlays.length = 0;
    this.overlayMasks.length = 0;
  }

  // The targets at the drawing buffer's size, made on first use and remade
  // when the canvas is resized.
  private fitTargets(): void {
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (this.sceneTarget && this.sceneTarget.width === w && this.sceneTarget.height === h) return;
    this.freeTargets();
    // Four samples, as the canvas's own `antialias: true`.
    const scene = new THREE.WebGLRenderTarget(w, h, {
      samples: 4,
      colorSpace: THREE.SRGBColorSpace,
      depthTexture: new THREE.DepthTexture(w, h),
    });
    // Drawn exactly as the canvas is (see the header): three tone maps and
    // sRGB-encodes for an XR target, and plain RGBA8 storage keeps the
    // hardware from decoding for blending, as a canvas does not.
    (scene as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
    scene.texture.internalFormat = "RGBA8";
    this.sceneTarget = scene;
    this.factor = Math.min(MAX_FACTOR, Math.max(2, Math.round(h / BLUR_LINES)));
    const sw = Math.ceil(w / this.factor);
    const sh = Math.ceil(h / this.factor);
    // Half float: the blurred light is kept linear between the passes.
    const options = { type: THREE.HalfFloatType, depthBuffer: false } as const;
    this.prepTarget = new THREE.WebGLRenderTarget(sw, sh, options);
    this.blurTarget = new THREE.WebGLRenderTarget(sw, sh, options);
  }

  private freeTargets(): void {
    this.sceneTarget?.depthTexture?.dispose();
    this.sceneTarget?.dispose();
    this.prepTarget?.dispose();
    this.blurTarget?.dispose();
    this.sceneTarget = null;
    this.prepTarget = null;
    this.blurTarget = null;
  }
}
