// What is BEHIND an object, read by the object itself: the patch of the frame
// around it, colour and depth, copied out of the frame the moment before it is
// drawn (`FrameCopy.grab`, as the mesh's `onBeforeRender`).
//
// For the hollow glass ball (glassMaterial.ts "HOLLOW"), which sees the scene
// behind it through its walls bent only a little - too little for the
// reflection probe, whose 128 px faces put a few texels across the whole view
// through it - and bent nonetheless, so a blend over the frame in place (which
// can only ever see the pixel straight behind) will not do either.
//
// Only a patch: the object's own square on screen grown by `REACH` each way,
// what its traced rays can land on before they fall back to the probe. A ball
// 400 px across at 4K copies a few hundred thousand pixels where the whole
// frame is eight million, and the one copy is a blit, resolving the frame's
// multisampled colour and depth on the way. Nothing is drawn again. The patch
// lands where it was, in a target the frame's size: WebGL 2 resolves samples
// only between identical rectangles (anywhere else the blit is an
// INVALID_OPERATION and copies nothing).
//
// It copies only from the scene's own frame (`frameSource`): inside any other
// render that sees the object - the pool's mirror - `on` is false and the
// object falls back to the probe.

import * as THREE from "three";

// Which target is the scene's frame this frame (frameTarget.ts), set by
// `Scene3D` before it draws into it.
export const frameSource: { target: THREE.WebGLRenderTarget | null } = { target: null };

// How far past the object's own square on screen the patch reaches, in the
// object's screen radii, each way.
const REACH = 3;

export class FrameCopy {
  // What the object's shader reads (see `frameCopyPars`).
  readonly uniforms: {
    frameCopy: THREE.IUniform<THREE.Texture | null>;
    frameCopyDepth: THREE.IUniform<THREE.Texture | null>;
    // The patch in the frame's pixels (x, y, width, height), the copy's size
    // (the frame's), the viewport, and the camera's near, far and orthographic.
    frameCopyRect: THREE.IUniform<THREE.Vector4>;
    frameCopySize: THREE.IUniform<THREE.Vector2>;
    frameViewport: THREE.IUniform<THREE.Vector4>;
    frameCamera: THREE.IUniform<THREE.Vector3>;
    frameCopyOn: THREE.IUniform<boolean>;
  } = {
    frameCopy: { value: null },
    frameCopyDepth: { value: null },
    frameCopyRect: { value: new THREE.Vector4() },
    frameCopySize: { value: new THREE.Vector2(1, 1) },
    frameViewport: { value: new THREE.Vector4() },
    frameCamera: { value: new THREE.Vector3() },
    frameCopyOn: { value: false },
  };
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly centre = new THREE.Vector3();
  private readonly ndc = new THREE.Vector3();

  // Copy the frame around `object` (a sphere of `radius` about its origin)
  // into the patch, when `renderer` is drawing the scene's frame with
  // `camera`. Called just before the object is drawn.
  grab(renderer: THREE.WebGLRenderer, camera: THREE.Camera, object: THREE.Object3D, radius: number): void {
    const u = this.uniforms;
    u.frameCopyOn.value = false;
    const source = frameSource.target;
    if (!source || renderer.getRenderTarget() !== source || !source.depthTexture) return;
    const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
    if (!perspective && (camera as THREE.OrthographicCamera).isOrthographicCamera !== true) return;
    const cam = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const viewport = renderer.getCurrentViewport(u.frameViewport.value);

    // The object's square on screen, grown by REACH, inside the viewport.
    this.centre.setFromMatrixPosition(object.matrixWorld).applyMatrix4(cam.matrixWorldInverse);
    const scale = object.matrixWorld.getMaxScaleOnAxis();
    const r = radius * scale;
    const depth = -this.centre.z;
    if (depth <= cam.near) return;
    this.ndc.copy(this.centre).applyMatrix4(cam.projectionMatrix);
    const perUnit = cam.projectionMatrix.elements[0]! * (perspective ? 1 / Math.max(depth - r, cam.near) : 1);
    const halfPx = r * perUnit * 0.5 * viewport.z * (1 + REACH);
    const cx = viewport.x + (this.ndc.x * 0.5 + 0.5) * viewport.z;
    const cy = viewport.y + (this.ndc.y * 0.5 + 0.5) * viewport.w;
    const x0 = Math.max(viewport.x, Math.floor(cx - halfPx));
    const y0 = Math.max(viewport.y, Math.floor(cy - halfPx));
    const x1 = Math.min(viewport.x + viewport.z, Math.ceil(cx + halfPx));
    const y1 = Math.min(viewport.y + viewport.w, Math.ceil(cy + halfPx));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    const copy = this.fit(renderer, source);
    const props = renderer.properties.get(source) as {
      __webglFramebuffer?: WebGLFramebuffer | WebGLFramebuffer[];
      __webglMultisampledFramebuffer?: WebGLFramebuffer;
    };
    const from = props.__webglMultisampledFramebuffer ?? props.__webglFramebuffer;
    const to = (renderer.properties.get(copy) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    if (!from || Array.isArray(from) || !to) return;

    // A blit is scissored; the frame's may be on (the editor's letterbox).
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const state = renderer.state;
    state.setScissorTest(false);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    // Back to drawing the frame, as three left it.
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, from);
    state.setScissorTest(source.scissorTest);

    u.frameCopy.value = copy.texture;
    u.frameCopyDepth.value = copy.depthTexture;
    u.frameCopyRect.value.set(x0, y0, w, h);
    u.frameCopySize.value.set(copy.width, copy.height);
    u.frameCamera.value.set(cam.near, cam.far, perspective ? 0 : 1);
    u.frameCopyOn.value = true;
  }

  dispose(): void {
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.target = null;
    this.uniforms.frameCopy.value = null;
    this.uniforms.frameCopyDepth.value = null;
    this.uniforms.frameCopyOn.value = false;
  }

  // A single-sampled target of the frame's size and its own formats: a blit
  // out of a multisampled buffer must land in the same format, so the colour
  // is the frame's plain RGBA8 (its sRGB bytes, read as they are) and the
  // depth is the frame's depth texture's type.
  private fit(renderer: THREE.WebGLRenderer, source: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget {
    const depthType = source.depthTexture!.type;
    const { width, height } = source;
    const t = this.target;
    if (t && t.width === width && t.height === height && t.depthTexture!.type === depthType && t.stencilBuffer === source.stencilBuffer) return t;
    this.dispose();
    const copy = new THREE.WebGLRenderTarget(width, height, {
      depthTexture: new THREE.DepthTexture(width, height, depthType),
      stencilBuffer: source.stencilBuffer,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    copy.texture.internalFormat = "RGBA8";
    renderer.initRenderTarget(copy);
    this.target = copy;
    return copy;
  }
}

// Declarations for a shader that reads the patch: what is at a point in view
// space, if the patch holds it.
export const FRAME_COPY_PARS = /* glsl */ `
// Three declares the projection for the vertex stage only.
uniform mat4 projectionMatrix;
uniform sampler2D frameCopy;
uniform sampler2D frameCopyDepth;
uniform vec4 frameCopyRect;
uniform vec2 frameCopySize;
uniform vec4 frameViewport;
uniform vec3 frameCamera;
uniform bool frameCopyOn;
// The frame's pixel a view-space point lands on.
vec2 framePixel( const in vec3 p ) {
	vec4 clip = projectionMatrix * vec4( p, 1.0 );
	return frameViewport.xy + ( clip.xy / clip.w * 0.5 + 0.5 ) * frameViewport.zw;
}
// How far inside the patch a pixel is, in pixels (negative outside).
float frameInside( const in vec2 px ) {
	vec2 lo = px - frameCopyRect.xy;
	vec2 hi = frameCopyRect.xy + frameCopyRect.zw - px;
	return min( min( lo.x, lo.y ), min( hi.x, hi.y ) );
}
// The view-space depth (z, negative ahead) of what the frame holds at a pixel.
float frameViewZ( const in vec2 px ) {
	ivec2 at = clamp( ivec2( px ), ivec2( frameCopyRect.xy ), ivec2( frameCopyRect.xy + frameCopyRect.zw ) - 1 );
	float d = texelFetch( frameCopyDepth, at, 0 ).r;
	float n = frameCamera.x;
	float f = frameCamera.y;
	return frameCamera.z > 0.5 ? d * ( n - f ) - n : ( n * f ) / ( ( f - n ) * d - f );
}
// The frame's colour at a pixel, as it is stored: tone mapped and encoded.
vec3 frameColour( const in vec2 px ) {
	return textureLod( frameCopy, px / frameCopySize, 0.0 ).rgb;
}
`;
