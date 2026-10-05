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

// Texel for pixel: no filtering, and correct inside any viewport, so the
// editor's letterboxed sub-rect copies the same way the whole frame does.
const PRESENT_FRAGMENT = /* glsl */ `
  uniform sampler2D tFrame;
  void main() {
    gl_FragColor = texelFetch(tFrame, ivec2(gl_FragCoord.xy), 0);
  }`;

export class FrameTarget {
  private frame: THREE.WebGLRenderTarget | null = null;
  private readonly size = new THREE.Vector2();
  private readonly presentMaterial = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: PRESENT_FRAGMENT,
    uniforms: { tFrame: { value: null } },
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  private readonly presentQuad = new FullScreenQuad(this.presentMaterial);

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  // The target for this frame, at the drawing buffer's size and drawing into
  // `rect` (bottom-left origin, device pixels) or the whole of it.
  // `withDepth` keeps the depth resolved into `depthTexture` for a pass that
  // reads it; otherwise only the colour is resolved.
  begin(
    rect: { x: number; y: number; w: number; h: number } | null,
    withDepth: boolean,
  ): THREE.WebGLRenderTarget {
    const frame = this.fit();
    frame.resolveDepthBuffer = withDepth;
    if (rect) {
      frame.viewport.set(rect.x, rect.y, rect.w, rect.h);
      frame.scissor.set(rect.x, rect.y, rect.w, rect.h);
      frame.scissorTest = true;
    } else {
      frame.viewport.set(0, 0, frame.width, frame.height);
      frame.scissorTest = false;
    }
    return frame;
  }

  // The finished frame onto the canvas, inside the renderer's own viewport
  // (which the caller has set to the same rect).
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

  // Made on first use and remade when the canvas is resized.
  private fit(): THREE.WebGLRenderTarget {
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (this.frame && this.frame.width === w && this.frame.height === h) return this.frame;
    this.free();
    const frame = new THREE.WebGLRenderTarget(w, h, {
      samples: SAMPLES,
      colorSpace: THREE.SRGBColorSpace,
      depthTexture: new THREE.DepthTexture(w, h),
    });
    // See the header: three's own programs for the canvas, and blending in
    // the canvas's space.
    (frame as { isXRRenderTarget?: boolean }).isXRRenderTarget = true;
    frame.texture.internalFormat = "RGBA8";
    this.frame = frame;
    return frame;
  }

  private free(): void {
    this.frame?.depthTexture?.dispose();
    this.frame?.dispose();
    this.frame = null;
  }
}
