// THE FRAME IS DRAWN OFF THE CANVAS. Every frame goes into one multisampled
// target the size of the canvas, and the canvas only receives the finished
// picture: one single-sample copy at the end (`present`). The canvas is made
// WITHOUT antialiasing, since this target is where the antialiasing happens.
//
// Why not straight onto an antialiased canvas, as three draws by default: a
// pass that has to read the frame back (the depth of field's blur, see
// depthOfField.ts) cannot read the canvas, so it drew the scene into a target
// like this one and then wrote the whole frame again onto the canvas, every
// pixel's four samples and its depth. At 4K on an RTX 4070 SUPER that copy
// was ~0.45 ms, and it alone took a frame from 144 Hz to ~136 (2026-10-05,
// measured in the live page). Drawn here, a pass writes back into the same
// samples it read from, only where it changes something, and the frame
// crosses to the canvas once, as plain pixels.
//
// With nothing reading the frame back this costs what the antialiased canvas
// did: the browser resolved the canvas's samples itself, and here three
// resolves this target's instead; the copy to the canvas is the difference.
//
// DRAWN AS THE CANVAS IS. The target is flagged as three's XR target and
// stored as plain RGBA8, so every program is the canvas's own (tone mapped and
// sRGB encoded in the shader) and translucent layers blend in the same space a
// canvas blends them in: the picture is the direct path's, byte for byte. In
// an ordinary linear float target the sky moved from (20,40,62) to (2,29,56).
// The flag is three's internal, so a three upgrade must be checked against a
// direct render (`cli shot --3d` before and after).

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

// The same four samples `antialias: true` gave the canvas.
const SAMPLES = 4;

// Texel for pixel: no filtering. The frame is the picture alone, so where it
// lands on the canvas (the editor's letterboxed sub-rect) is an offset here.
const PRESENT_FRAGMENT = /* glsl */ `
  uniform sampler2D tFrame;
  uniform ivec2 offset;
  void main() {
    gl_FragColor = texelFetch(tFrame, ivec2(gl_FragCoord.xy) - offset, 0);
  }`;

// The sizes kept made: the whole canvas while editing and the letterboxed
// picture of a ▶ Test, so going in and out of a test makes no target.
const KEPT_SIZES = 2;

export class FrameTarget {
  // Most recently used first.
  private readonly frames: THREE.WebGLRenderTarget[] = [];
  private frame: THREE.WebGLRenderTarget | null = null;
  private readonly size = new THREE.Vector2();
  private readonly offset = new THREE.Vector2();
  private readonly presentMaterial = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: PRESENT_FRAGMENT,
    uniforms: { tFrame: { value: null }, offset: { value: this.offset } },
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  private readonly presentQuad = new FullScreenQuad(this.presentMaterial);

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  // The target for this frame: the picture alone, at the size of `rect`
  // (bottom-left origin, device pixels) or of the whole drawing buffer.
  //
  // Sized to the picture rather than to the canvas with the picture drawn
  // into a corner of it, so a pass that reads the frame back (the depth of
  // field, see depthOfField.ts) reads a whole frame wherever the picture is
  // shown: the editor's letterboxed ▶ Test is blurred as the game is.
  //
  // `withDepth` keeps the depth resolved into `depthTexture` for a pass that
  // reads it; otherwise only the colour is resolved.
  begin(
    rect: { x: number; y: number; w: number; h: number } | null,
    withDepth: boolean,
  ): THREE.WebGLRenderTarget {
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, rect ? rect.w : this.size.x);
    const h = Math.max(1, rect ? rect.h : this.size.y);
    const frame = this.fit(w, h);
    this.offset.set(rect ? rect.x : 0, rect ? rect.y : 0);
    frame.resolveDepthBuffer = withDepth;
    frame.viewport.set(0, 0, w, h);
    frame.scissorTest = false;
    return frame;
  }

  // The finished frame onto the canvas, inside the renderer's own viewport
  // (which the caller has set to the rect the frame was begun for).
  present(): void {
    const frame = this.frame;
    if (!frame) return;
    const r = this.renderer;
    this.presentMaterial.uniforms.tFrame!.value = frame.texture;
    r.setRenderTarget(null);
    // Added to the frame's stats rather than replacing them: the HUD's draw
    // calls and triangles are the scene's.
    const autoReset = r.info.autoReset;
    r.info.autoReset = false;
    try {
      this.presentQuad.render(r);
    } finally {
      r.info.autoReset = autoReset;
    }
  }

  dispose(): void {
    this.free();
    this.presentMaterial.dispose();
    this.presentQuad.dispose();
  }

  // A target of this size: one of the kept ones, or made, the least recently
  // used freed once more than `KEPT_SIZES` are held.
  private fit(w: number, h: number): THREE.WebGLRenderTarget {
    const i = this.frames.findIndex((f) => f.width === w && f.height === h);
    if (i >= 0) {
      const [found] = this.frames.splice(i, 1);
      this.frames.unshift(found!);
      return (this.frame = found!);
    }
    while (this.frames.length >= KEPT_SIZES) {
      const old = this.frames.pop()!;
      old.depthTexture?.dispose();
      old.dispose();
    }
    const frame = new THREE.WebGLRenderTarget(w, h, {
      samples: SAMPLES,
      colorSpace: THREE.SRGBColorSpace,
      depthTexture: new THREE.DepthTexture(w, h),
    });
    // See the header: three's own programs for the canvas, and blending in
    // the canvas's space.
    (frame as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
    frame.texture.internalFormat = "RGBA8";
    this.frames.unshift(frame);
    return (this.frame = frame);
  }

  private free(): void {
    for (const f of this.frames) {
      f.depthTexture?.dispose();
      f.dispose();
    }
    this.frames.length = 0;
    this.frame = null;
  }
}
