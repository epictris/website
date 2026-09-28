// Draws the reconstructed solids through the perspective camera: WebGL when
// available, otherwise a depth-buffered software rasteriser of the same meshes.

import { type CameraMatrices, cameraMatrices } from "../core/camera";
import { niceStep, transform, vec } from "../core/math";
import type { Display, SceneObject, Vec3 } from "../core/types";
import type { MeshEntry } from "../meshes";

export interface RenderInput {
  camera: Parameters<typeof cameraMatrices>[0];
  display: Display;
  sceneSize: Vec3;
  objects: SceneObject[];
  meshes: ReadonlyMap<string, MeshEntry>;
  selected: (id: string) => boolean;
}

const CLAY: Vec3 = [0.48, 0.63, 0.69];
const SELECT_TINT: Vec3 = [0.81, 1, 0.94];
const hexColor = (hex: string): Vec3 => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Vec3;
const center = (e: SceneObject): Vec3 => e.min.map((v, i) => v + e.size[i] / 2) as Vec3;

/** Opaque solids first, then translucent ones back to front. */
function passes(input: RenderInput) {
  const style = input.display.style;
  const opaque: SceneObject[] = [];
  const transparent: SceneObject[] = [];
  for (const e of input.objects)
    (style === "ghost" || style === "wire" || e.opacity < 1 ? transparent : opaque).push(e);
  const eye = input.camera.position;
  transparent.sort((a, b) => vec.len(vec.sub(center(b), eye)) - vec.len(vec.sub(center(a), eye)));
  const alpha = (e: SceneObject) => (style === "wire" ? 0.22 : style === "ghost" ? 0.26 : e.opacity);
  return { opaque, transparent, alpha };
}

interface GpuMesh {
  vbo: WebGLBuffer;
  nbo: WebGLBuffer;
  ibo: WebGLBuffer;
  count: number;
  indexType: number;
  wire: WebGLBuffer | null;
  wireCount: number;
  indices: Uint16Array | Uint32Array;
}

const VERTEX = `attribute vec3 aPosition;attribute vec3 aNormal;uniform mat4 uVP;uniform vec3 uMin;uniform vec3 uSize;varying vec3 vNormal;varying vec3 vWorld;
void main(){vec3 world=uMin+aPosition*uSize;vWorld=world;vNormal=normalize(aNormal/max(uSize,vec3(0.000001)));gl_Position=uVP*vec4(world,1.0);}`;
const FRAGMENT = `precision mediump float;uniform vec3 uColor;uniform vec3 uEye;uniform float uAlpha;uniform float uLit;uniform float uSelected;varying vec3 vNormal;varying vec3 vWorld;
void main(){vec3 n=normalize(vNormal);if(!gl_FrontFacing)n=-n;vec3 eye=normalize(uEye-vWorld);float key=max(dot(n,normalize(vec3(-0.4,-0.7,0.9))),0.0);
float fill=max(dot(n,normalize(vec3(0.7,0.35,0.3))),0.0);float front=max(dot(n,eye),0.0);float rim=pow(1.0-abs(dot(n,eye)),3.0);
float shade=0.34+0.40*key+0.19*fill+0.11*front;vec3 col=mix(uColor,uColor*shade+vec3(0.07)*rim,uLit);col=mix(col,vec3(0.81,1.0,0.94),uSelected*.24);gl_FragColor=vec4(col,uAlpha);}`;

// ---- Outlines --------------------------------------------------------------------------
// The solids' outlines, drawn above the reference image at full opacity so the
// geometry stays readable however opaque the reference is. A hidden pass
// renders each pixel's object id with depth; the edge pass then draws a line
// on the nearer side wherever the object changes (silhouettes against the
// background or another object) or the depth jumps (an object hiding part of
// itself). Where two objects meet at the same depth (touching or intersecting)
// the line goes on the higher id's side, so depth noise cannot dither it.
// Creases are not drawn: the reconstructed meshes bevel sharp edges
// into bands of small facets, which read as broken, speckled lines.

const OUTLINE_GEOMETRY = `precision mediump float;uniform float uId;
void main(){gl_FragColor=vec4(0.0,0.0,floor(uId/256.0)/255.0,mod(uId,256.0)/255.0);}`;

const OUTLINE_VERTEX = `attribute vec2 aCorner;varying vec2 vUv;void main(){vUv=aCorner*0.5+0.5;gl_Position=vec4(aCorner,0.0,1.0);}`;

const OUTLINE_EDGES = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uG;uniform sampler2D uD;uniform sampler2D uPal;uniform vec2 uStep;uniform float uNear;uniform float uFar;varying vec2 vUv;
float idAt(vec2 uv){vec4 g=texture2D(uG,uv);return floor(g.b*255.0+0.5)*256.0+floor(g.a*255.0+0.5);}
float depthAt(vec2 uv){float z=texture2D(uD,uv).r*2.0-1.0;return 2.0*uNear*uFar/(uFar+uNear-z*(uFar-uNear));}
float ids(vec2 off,float id,float z){float other=idAt(vUv+off);if(other==id)return 0.0;if(other<0.5)return 1.0;
float zo=depthAt(vUv+off);return zo>z*1.004||(zo>=z*0.996&&id>other)?1.0:0.0;}
float fold(vec2 off,float id,float z){vec2 a=vUv+off;vec2 b=vUv-off;if(idAt(a)!=id||idAt(b)!=id)return 0.0;
float za=depthAt(a);float zb=depthAt(b);return abs(za+zb-2.0*z)>0.03*z&&z<max(za,zb)-0.015*z?1.0:0.0;}
void main(){float id=idAt(vUv);if(id<0.5){gl_FragColor=vec4(0.0);return;}
float z=depthAt(vUv);vec2 dx=vec2(uStep.x,0.0);vec2 dy=vec2(0.0,uStep.y);
float e=ids(dx,id,z)+ids(-dx,id,z)+ids(dy,id,z)+ids(-dy,id,z)+fold(dx,id,z)+fold(dy,id,z);
if(e<0.5){gl_FragColor=vec4(0.0);return;}
vec4 pal=texture2D(uPal,vec2((id-0.5)/512.0,0.5));gl_FragColor=vec4(mix(pal.rgb,vec3(1.0),pal.a*0.6),1.0);}`;

interface OutlineGl {
  geometry: WebGLProgram;
  edges: WebGLProgram;
  corners: WebGLBuffer;
  fbo: WebGLFramebuffer;
  color: WebGLTexture;
  depth: WebGLTexture;
  palette: WebGLTexture;
  size: [number, number];
}

/** Palette slots: object ids are 1..MAX_PALETTE (the scene limit is lower). */
const MAX_PALETTE = 511;

export class PerspectiveRenderer {
  readonly software: boolean;
  private gl: WebGLRenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private program!: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | number> = {};
  private gpu = new Map<string, GpuMesh>();
  private grid: { key: string; buffer: WebGLBuffer | null; count: number } = { key: "", buffer: null, count: 0 };
  /** Created on first use; null when the GPU lacks what outlines need. */
  private outlineGl: OutlineGl | null | undefined;
  onContextLost: (() => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      antialias: true,
      // The outline pass is copied out with a transparent background (see renderOutlinesGl).
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (gl) {
      this.gl = gl;
      this.software = false;
      this.initGl(gl);
      canvas.addEventListener("webglcontextlost", (ev) => {
        ev.preventDefault();
        this.onContextLost?.();
      });
    } else {
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Neither WebGL nor a 2D canvas is available.");
      this.ctx2d = ctx;
      this.software = true;
    }
  }

  private link(vertex: string, fragment: string): WebGLProgram {
    const gl = this.gl!;
    const compile = (type: number, code: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, code);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) || "Shader compilation failed.");
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || "Shader link failed.");
    return program;
  }

  private initGl(gl: WebGLRenderingContext) {
    gl.getExtension("OES_element_index_uint");
    const program = this.link(VERTEX, FRAGMENT);
    this.program = program;
    for (const n of ["aPosition", "aNormal"]) this.loc[n] = gl.getAttribLocation(program, n);
    for (const n of ["uVP", "uMin", "uSize", "uColor", "uEye", "uAlpha", "uLit", "uSelected"])
      this.loc[n] = gl.getUniformLocation(program, n)!;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
  }

  private buffer(target: number, data: ArrayBufferView) {
    const gl = this.gl!;
    const b = gl.createBuffer()!;
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  }

  /** Upload (or with null, drop) an object's mesh. */
  upload(id: string, mesh: MeshEntry | null) {
    const gl = this.gl;
    if (!gl) return;
    const old = this.gpu.get(id);
    for (const b of [old?.vbo, old?.nbo, old?.ibo, old?.wire]) if (b) gl.deleteBuffer(b);
    this.gpu.delete(id);
    if (!mesh?.indices.length) return;
    this.gpu.set(id, {
      vbo: this.buffer(gl.ARRAY_BUFFER, mesh.pos),
      nbo: this.buffer(gl.ARRAY_BUFFER, mesh.norm),
      ibo: this.buffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices),
      count: mesh.indices.length,
      indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      wire: null,
      wireCount: 0,
      indices: mesh.indices,
    });
  }

  /**
   * Draw at the canvas's current pixel size. With `outlines`, also draw the
   * solids' outlines into that canvas (same pixel size), on a transparent background.
   */
  render(input: RenderInput, outlines?: HTMLCanvasElement): CameraMatrices {
    const m = cameraMatrices(input.camera);
    if (outlines) {
      if (outlines.width !== this.canvas.width || outlines.height !== this.canvas.height) {
        outlines.width = this.canvas.width;
        outlines.height = this.canvas.height;
      }
      const ctx = outlines.getContext("2d")!;
      ctx.clearRect(0, 0, outlines.width, outlines.height);
      if (this.software) this.outlinesSoftware(input, m, ctx);
      else if (this.renderOutlinesGl(input, m)) ctx.drawImage(this.canvas, 0, 0);
    }
    if (this.software) this.renderSoftware(input, m);
    else this.renderGl(input, m);
    return m;
  }

  /** Line width of outlines in canvas pixels. */
  private outlineWidth() {
    return Math.max(
      1,
      Math.round((1.5 * this.canvas.width) / Math.max(1, this.canvas.clientWidth || this.canvas.width)),
    );
  }

  private initOutlines(): OutlineGl | null {
    const gl = this.gl!;
    if (!gl.getExtension("WEBGL_depth_texture")) return null;
    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [
        [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
        [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      ])
        gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    const o: OutlineGl = {
      geometry: this.link(VERTEX, OUTLINE_GEOMETRY),
      edges: this.link(OUTLINE_VERTEX, OUTLINE_EDGES),
      corners: this.buffer(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3])),
      fbo: gl.createFramebuffer()!,
      color: texture(),
      depth: texture(),
      palette: texture(),
      size: [0, 0],
    };
    gl.bindTexture(gl.TEXTURE_2D, o.palette);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MAX_PALETTE + 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return o;
  }

  /** Draw the outlines into the canvas (transparent elsewhere). False when this GPU cannot. */
  private renderOutlinesGl(input: RenderInput, m: CameraMatrices): boolean {
    const gl = this.gl!;
    if (this.outlineGl === undefined) this.outlineGl = this.initOutlines();
    const o = this.outlineGl;
    if (!o) return false;
    const [w, h] = [this.canvas.width, this.canvas.height];
    if (o.size[0] !== w || o.size[1] !== h) {
      gl.bindTexture(gl.TEXTURE_2D, o.color);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, o.depth);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, o.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, o.color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, o.depth, 0);
      o.size = [w, h];
    }
    const objects = input.objects.slice(0, MAX_PALETTE);
    // Object colours by id (1-based); alpha marks the selection.
    const palette = new Uint8Array((MAX_PALETTE + 1) * 4);
    objects.forEach((e, i) => {
      palette.set(
        hexColor(e.color).map((v) => Math.round(v * 255)),
        i * 4,
      );
      palette[i * 4 + 3] = input.selected(e.id) ? 255 : 0;
    });
    gl.bindTexture(gl.TEXTURE_2D, o.palette);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_PALETTE + 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, palette);

    // Pass 1: object id per pixel, with depth.
    gl.bindFramebuffer(gl.FRAMEBUFFER, o.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(o.geometry);
    gl.uniformMatrix4fv(gl.getUniformLocation(o.geometry, "uVP"), false, new Float32Array(m.vp));
    const aPosition = gl.getAttribLocation(o.geometry, "aPosition");
    const aNormal = gl.getAttribLocation(o.geometry, "aNormal");
    const uMin = gl.getUniformLocation(o.geometry, "uMin");
    const uSize = gl.getUniformLocation(o.geometry, "uSize");
    const uId = gl.getUniformLocation(o.geometry, "uId");
    objects.forEach((e, i) => {
      const g = this.gpu.get(e.id);
      if (!g) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 3, gl.UNSIGNED_SHORT, true, 0, 0);
      if (aNormal >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, g.nbo);
        gl.enableVertexAttribArray(aNormal);
        gl.vertexAttribPointer(aNormal, 3, gl.BYTE, true, 0, 0);
      }
      gl.uniform3fv(uMin, e.min);
      gl.uniform3fv(uSize, e.size);
      gl.uniform1f(uId, i + 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
      gl.drawElements(gl.TRIANGLES, g.count, g.indexType, 0);
    });

    // Pass 2: the edges, into the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(o.edges);
    const bind = (unit: number, t: WebGLTexture, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(gl.getUniformLocation(o.edges, name), unit);
    };
    bind(0, o.color, "uG");
    bind(1, o.depth, "uD");
    bind(2, o.palette, "uPal");
    gl.activeTexture(gl.TEXTURE0);
    const r = this.outlineWidth();
    gl.uniform2f(gl.getUniformLocation(o.edges, "uStep"), r / w, r / h);
    gl.uniform1f(gl.getUniformLocation(o.edges, "uNear"), input.camera.near);
    gl.uniform1f(gl.getUniformLocation(o.edges, "uFar"), input.camera.far);
    const aCorner = gl.getAttribLocation(o.edges, "aCorner");
    gl.bindBuffer(gl.ARRAY_BUFFER, o.corners);
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(aCorner);
    gl.enable(gl.DEPTH_TEST);
    return true;
  }

  private renderGl(input: RenderInput, m: CameraMatrices) {
    const gl = this.gl!;
    const L = this.loc;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.037, 0.071, 0.113, 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    // The canvas has an alpha channel (for the outline pass); keep the picture itself opaque.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(L.uVP as WebGLUniformLocation, false, new Float32Array(m.vp));
    gl.uniform3fv(L.uEye as WebGLUniformLocation, input.camera.position);
    const { opaque, transparent, alpha } = passes(input);
    for (const e of opaque) this.drawMesh(e, input, 1);
    if (input.display.grid) this.drawGrid(input.sceneSize);
    gl.depthMask(false);
    for (const e of transparent) this.drawMesh(e, input, alpha(e));
    gl.depthMask(true);
  }

  private drawMesh(e: SceneObject, input: RenderInput, alpha: number) {
    const gl = this.gl!;
    const L = this.loc as Record<string, WebGLUniformLocation> & Record<"aPosition" | "aNormal", number>;
    const g = this.gpu.get(e.id);
    if (!g) return;
    const style = input.display.style;
    gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
    gl.enableVertexAttribArray(L.aPosition);
    gl.vertexAttribPointer(L.aPosition, 3, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.nbo);
    gl.enableVertexAttribArray(L.aNormal);
    gl.vertexAttribPointer(L.aNormal, 3, gl.BYTE, true, 0, 0);
    gl.uniform3fv(L.uMin, e.min);
    gl.uniform3fv(L.uSize, e.size);
    gl.uniform3fv(L.uColor, style === "clay" ? CLAY : hexColor(e.color));
    gl.uniform1f(L.uAlpha, alpha);
    gl.uniform1f(L.uLit, style === "wire" ? 0 : 1);
    gl.uniform1f(L.uSelected, input.selected(e.id) ? 1 : 0);
    if (style === "wire") {
      if (!g.wire) {
        const idx = g.indices;
        const values = idx instanceof Uint32Array ? new Uint32Array(idx.length * 2) : new Uint16Array(idx.length * 2);
        for (let i = 0, j = 0; i < idx.length; i += 3) {
          const [p, q, r] = [idx[i], idx[i + 1], idx[i + 2]];
          values[j++] = p;
          values[j++] = q;
          values[j++] = q;
          values[j++] = r;
          values[j++] = r;
          values[j++] = p;
        }
        g.wire = this.buffer(gl.ELEMENT_ARRAY_BUFFER, values);
        g.wireCount = values.length;
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.wire);
      gl.drawElements(gl.LINES, g.wireCount, g.indexType, 0);
    } else {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
      gl.drawElements(gl.TRIANGLES, g.count, g.indexType, 0);
    }
  }

  private drawGrid(size: Vec3) {
    const gl = this.gl!;
    const L = this.loc as Record<string, WebGLUniformLocation> & Record<"aPosition" | "aNormal", number>;
    const key = size.join("/");
    if (this.grid.key !== key) {
      const step = niceStep(Math.max(size[0], size[1]) / 20);
      const lines: number[] = [];
      for (let x = 0; x <= size[0] + 1e-6 && lines.length < 6000; x += step) lines.push(x, 0, -0.03, x, size[1], -0.03);
      for (let y = 0; y <= size[1] + 1e-6 && lines.length < 12000; y += step)
        lines.push(0, y, -0.03, size[0], y, -0.03);
      if (this.grid.buffer) gl.deleteBuffer(this.grid.buffer);
      this.grid = { key, buffer: this.buffer(gl.ARRAY_BUFFER, new Float32Array(lines)), count: lines.length / 3 };
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grid.buffer);
    gl.enableVertexAttribArray(L.aPosition);
    gl.vertexAttribPointer(L.aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(L.aNormal);
    gl.vertexAttrib3f(L.aNormal, 0, 0, 1);
    gl.uniform3fv(L.uMin, [0, 0, 0]);
    gl.uniform3fv(L.uSize, [1, 1, 1]);
    gl.uniform3fv(L.uColor, [0.15, 0.26, 0.34]);
    gl.uniform1f(L.uAlpha, 0.8);
    gl.uniform1f(L.uLit, 0);
    gl.uniform1f(L.uSelected, 0);
    gl.drawArrays(gl.LINES, 0, this.grid.count);
  }

  // ---- Software rasteriser -----------------------------------------------------------

  /** The outline pass without a GPU: the same rules as OUTLINE_EDGES, on CPU buffers. */
  private outlinesSoftware(input: RenderInput, m: CameraMatrices, ctx: CanvasRenderingContext2D) {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const { near, far } = input.camera;
    const ids = new Uint16Array(width * height);
    const zbuf = new Float32Array(width * height).fill(Infinity);
    const objects = input.objects.slice(0, MAX_PALETTE);
    objects.forEach((e, oi) => {
      const geo = input.meshes.get(e.id);
      if (!geo) return;
      const world = (i: number): Vec3 => [
        e.min[0] + (geo.pos[i * 3] / 65535) * e.size[0],
        e.min[1] + (geo.pos[i * 3 + 1] / 65535) * e.size[1],
        e.min[2] + (geo.pos[i * 3 + 2] / 65535) * e.size[2],
      ];
      const idx = geo.indices;
      for (let t = 0; t < idx.length; t += 3) {
        const w = [world(idx[t]), world(idx[t + 1]), world(idx[t + 2])];
        const p = w.map((v) => transform(m.vp, v));
        if (p.some((q) => q[3] <= near)) continue;
        const s = p.map(
          (q): Vec3 => [((q[0] / q[3]) * 0.5 + 0.5) * width, ((-q[1] / q[3]) * 0.5 + 0.5) * height, q[2] / q[3]],
        );
        const [a, b, c] = s;
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(area) < 1e-6) continue;
        const loX = Math.max(0, Math.ceil(Math.min(a[0], b[0], c[0]) - 0.5));
        const hiX = Math.min(width - 1, Math.floor(Math.max(a[0], b[0], c[0]) - 0.5));
        const loY = Math.max(0, Math.ceil(Math.min(a[1], b[1], c[1]) - 0.5));
        const hiY = Math.min(height - 1, Math.floor(Math.max(a[1], b[1], c[1]) - 0.5));
        for (let y = loY; y <= hiY; y++)
          for (let x = loX; x <= hiX; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            const wa = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
            const wb = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
            const wc = 1 - wa - wb;
            if (wa < 0 || wb < 0 || wc < 0) continue;
            const z = wa * a[2] + wb * b[2] + wc * c[2];
            const j = y * width + x;
            if (z < -1 || z > 1 || z >= zbuf[j]) continue;
            zbuf[j] = z;
            ids[j] = oi + 1;
          }
      }
    });
    const depth = (j: number) => (2 * near * far) / (far + near - zbuf[j] * (far - near));
    const r = this.outlineWidth();
    const colors = objects.map((e) => {
      const c = hexColor(e.color);
      return (input.selected(e.id) ? c.map((v) => v + (1 - v) * 0.6) : c).map((v) => Math.round(v * 255));
    });
    const img = ctx.createImageData(width, height);
    const at = (x: number, y: number) =>
      Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x));
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const j = y * width + x;
        const id = ids[j];
        if (!id) continue;
        const z = depth(j);
        let edge = false;
        for (const [dx, dy] of [
          [r, 0],
          [-r, 0],
          [0, r],
          [0, -r],
        ]) {
          const k = at(x + dx, y + dy);
          if (ids[k] === id) continue;
          const zo = ids[k] ? depth(k) : Infinity;
          if (zo > z * 1.004 || (zo >= z * 0.996 && id > ids[k])) edge = true;
        }
        for (const [dx, dy] of [
          [r, 0],
          [0, r],
        ]) {
          const a = at(x + dx, y + dy);
          const b = at(x - dx, y - dy);
          if (ids[a] === id && ids[b] === id) {
            const [za, zb] = [depth(a), depth(b)];
            if (Math.abs(za + zb - 2 * z) > 0.03 * z && z < Math.max(za, zb) - 0.015 * z) edge = true;
          }
        }
        if (!edge) continue;
        img.data.set([...colors[id - 1], 255], j * 4);
      }
    ctx.putImageData(img, 0, 0);
  }

  private renderSoftware(input: RenderInput, m: CameraMatrices) {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const c = input.camera;
    const display = input.display;
    const vp = m.vp;
    const im = this.ctx2d!.createImageData(width, height);
    const pix = im.data;
    const zbuf = new Float32Array(width * height).fill(Infinity);
    new Uint32Array(pix.buffer).fill((255 << 24) | (29 << 16) | (18 << 8) | 9);
    const lightA = vec.norm([-0.4, -0.7, 0.9]);
    const lightB = vec.norm([0.7, 0.35, 0.3]);
    const project = (p: Vec3): Vec3 | null => {
      const q = transform(vp, p);
      if (q[3] <= 0) return null;
      return [((q[0] / q[3]) * 0.5 + 0.5) * width, ((-q[1] / q[3]) * 0.5 + 0.5) * height, q[2] / q[3]];
    };
    const line = (a: Vec3 | null, b: Vec3 | null, color: Vec3, opacity = 0.8) => {
      if (!a || !b || Math.max(a[2], b[2]) < -1 || Math.min(a[2], b[2]) > 1) return;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
      if (steps > Math.max(width, height) * 10) return;
      for (let t = 0; t <= steps; t++) {
        const f = steps ? t / steps : 0;
        const x = Math.round(a[0] + dx * f);
        const y = Math.round(a[1] + dy * f);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const z = a[2] + (b[2] - a[2]) * f;
        const j = y * width + x;
        if (z < -1 || z > 1 || z > zbuf[j] + 0.00002) continue;
        const k = j * 4;
        for (let h = 0; h < 3; h++) pix[k + h] = pix[k + h] * (1 - opacity) + color[h] * opacity;
      }
    };
    const triangle = (a: Vec3, b: Vec3, cc: Vec3, col: Vec3, alpha: number, write: boolean) => {
      const area = (b[0] - a[0]) * (cc[1] - a[1]) - (b[1] - a[1]) * (cc[0] - a[0]);
      if (Math.abs(area) < 0.06) return;
      const loX = Math.max(0, Math.ceil(Math.min(a[0], b[0], cc[0]) - 0.5));
      const hiX = Math.min(width - 1, Math.floor(Math.max(a[0], b[0], cc[0]) - 0.5));
      const loY = Math.max(0, Math.ceil(Math.min(a[1], b[1], cc[1]) - 0.5));
      const hiY = Math.min(height - 1, Math.floor(Math.max(a[1], b[1], cc[1]) - 0.5));
      if (loX > hiX || loY > hiY) return;
      const inv = 1 / area;
      const daX = (b[1] - cc[1]) * inv;
      const daY = (cc[0] - b[0]) * inv;
      const dbX = (cc[1] - a[1]) * inv;
      const dbY = (a[0] - cc[0]) * inv;
      let rowA = ((loX + 0.5) * (b[1] - cc[1]) + (loY + 0.5) * (cc[0] - b[0]) + b[0] * cc[1] - b[1] * cc[0]) * inv;
      let rowB = ((loX + 0.5) * (cc[1] - a[1]) + (loY + 0.5) * (a[0] - cc[0]) + cc[0] * a[1] - cc[1] * a[0]) * inv;
      for (let y = loY; y <= hiY; y++) {
        let wa = rowA;
        let wb = rowB;
        for (let x = loX, j = y * width + loX; x <= hiX; x++, j++, wa += daX, wb += dbX) {
          if (wa < -0.00001 || wb < -0.00001 || wa + wb > 1.00001) continue;
          const z = wa * a[2] + wb * b[2] + (1 - wa - wb) * cc[2];
          if (z < -1 || z > 1 || z >= zbuf[j]) continue;
          if (write) zbuf[j] = z;
          const k = j * 4;
          for (let h = 0; h < 3; h++) pix[k + h] = alpha === 1 ? col[h] : pix[k + h] * (1 - alpha) + col[h] * alpha;
        }
        rowA += daY;
        rowB += dbY;
      }
    };
    const drawObject = (e: SceneObject, alpha: number, write: boolean) => {
      const geo = input.meshes.get(e.id);
      if (!geo) return;
      const q = geo.pos;
      const nrm = geo.norm;
      const idx = geo.indices;
      const count = q.length / 3;
      const verts = new Float32Array(count * 4);
      const lights = new Float32Array(count);
      const color = display.style === "clay" ? CLAY : hexColor(e.color);
      const sel = input.selected(e.id);
      const eye = vec.norm(vec.sub(c.position, center(e)));
      const mv = vp.slice();
      for (let a = 0; a < 3; a++) for (let r = 0; r < 4; r++) mv[a * 4 + r] *= e.size[a];
      for (let r = 0; r < 4; r++)
        mv[12 + r] = vp[r] * e.min[0] + vp[4 + r] * e.min[1] + vp[8 + r] * e.min[2] + vp[12 + r];
      for (let i = 0; i < count; i++) {
        const j = i * 3;
        const k = i * 4;
        const x = q[j] / 65535;
        const y = q[j + 1] / 65535;
        const z = q[j + 2] / 65535;
        const w = mv[3] * x + mv[7] * y + mv[11] * z + mv[15];
        verts[k] = (((mv[0] * x + mv[4] * y + mv[8] * z + mv[12]) / w) * width) / 2 + width / 2;
        verts[k + 1] = (-((mv[1] * x + mv[5] * y + mv[9] * z + mv[13]) / w) * height) / 2 + height / 2;
        verts[k + 2] = (mv[2] * x + mv[6] * y + mv[10] * z + mv[14]) / w;
        verts[k + 3] = w;
        let nx = nrm[j] / e.size[0];
        let ny = nrm[j + 1] / e.size[1];
        let nz = nrm[j + 2] / e.size[2];
        const nn = Math.hypot(nx, ny, nz) || 1;
        nx /= nn;
        ny /= nn;
        nz /= nn;
        const dotEye = nx * eye[0] + ny * eye[1] + nz * eye[2];
        if (dotEye < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        lights[i] =
          0.34 +
          0.4 * Math.max(0, nx * lightA[0] + ny * lightA[1] + nz * lightA[2]) +
          0.19 * Math.max(0, nx * lightB[0] + ny * lightB[1] + nz * lightB[2]) +
          0.11 * Math.abs(dotEye);
      }
      for (let i = 0; i < idx.length; i += 3) {
        const [ai, bi, ci] = [idx[i], idx[i + 1], idx[i + 2]];
        const [aa, bb, dd] = [ai * 4, bi * 4, ci * 4];
        if (verts[aa + 3] <= c.near || verts[bb + 3] <= c.near || verts[dd + 3] <= c.near) continue;
        const pa: Vec3 = [verts[aa], verts[aa + 1], verts[aa + 2]];
        const pb: Vec3 = [verts[bb], verts[bb + 1], verts[bb + 2]];
        const pd: Vec3 = [verts[dd], verts[dd + 1], verts[dd + 2]];
        if (display.style === "wire") {
          const col = color.map((x) => x * 255) as Vec3;
          line(pa, pb, col, 0.38);
          line(pb, pd, col, 0.38);
          line(pd, pa, col, 0.38);
        } else {
          const light = (lights[ai] + lights[bi] + lights[ci]) / 3;
          const col = color.map((v, k) => 255 * (sel ? v * light * 0.76 + SELECT_TINT[k] * 0.24 : v * light)) as Vec3;
          triangle(pa, pb, pd, col, alpha, write);
        }
      }
    };
    const { opaque, transparent, alpha } = passes(input);
    for (const e of opaque) drawObject(e, 1, true);
    if (display.grid) {
      const size = input.sceneSize;
      const step = niceStep(Math.max(size[0], size[1]) / 20);
      for (let x = 0; x <= size[0] + 1e-6; x += step)
        line(project([x, 0, -0.03]), project([x, size[1], -0.03]), [38, 67, 87]);
      for (let y = 0; y <= size[1] + 1e-6; y += step)
        line(project([0, y, -0.03]), project([size[0], y, -0.03]), [38, 67, 87]);
    }
    for (const e of transparent) drawObject(e, alpha(e), false);
    this.ctx2d!.putImageData(im, 0, 0);
  }
}

// ---- Picking ----------------------------------------------------------------------------

function rayBox(origin: Vec3, dir: Vec3): number | null {
  let lo = 0;
  let hi = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < 1e-12) {
      if (origin[a] < 0 || origin[a] > 1) return null;
    } else {
      let x = -origin[a] / dir[a];
      let y = (1 - origin[a]) / dir[a];
      if (x > y) [x, y] = [y, x];
      lo = Math.max(lo, x);
      hi = Math.min(hi, y);
      if (lo > hi) return null;
    }
  }
  return lo;
}

function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const e1 = vec.sub(b, a);
  const e2 = vec.sub(c, a);
  const p = vec.cross(d, e2);
  const det = vec.dot(e1, p);
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const tv = vec.sub(o, a);
  const u = vec.dot(tv, p) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = vec.cross(tv, e1);
  const v = vec.dot(d, q) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = vec.dot(e2, q) * inv;
  return t > 0 ? t : Infinity;
}

/** The object under a point of the camera frame (pixels in a gate of the given size), or null. */
export function pick(input: RenderInput, px: number, py: number, gateW: number, gateH: number): string | null {
  const c = input.camera;
  const m = cameraMatrices(c);
  const t = Math.tan((c.fov * Math.PI) / 360);
  const sx = ((2 * px) / gateW - 1) * t * m.aspect;
  const sy = (1 - (2 * py) / gateH) * t;
  const dir = vec.norm(vec.add(m.forward, vec.add(vec.mul(m.right, sx), vec.mul(m.up, sy))));
  let best: string | null = null;
  let nearest = Infinity;
  for (const e of input.objects) {
    // Ray in the object's unit box, where the quantised vertices live.
    const o = c.position.map((x, i) => (x - e.min[i]) / e.size[i]) as Vec3;
    const d = dir.map((x, i) => x / e.size[i]) as Vec3;
    const tBox = rayBox(o, d);
    if (tBox === null || tBox > nearest) continue;
    const geo = input.meshes.get(e.id);
    if (!geo) continue;
    const p = geo.pos;
    const idx = geo.indices;
    const vtx = (i: number): Vec3 => [p[i * 3] / 65535, p[i * 3 + 1] / 65535, p[i * 3 + 2] / 65535];
    for (let j = 0; j < idx.length; j += 3) {
      const hit = rayTriangle(o, d, vtx(idx[j]), vtx(idx[j + 1]), vtx(idx[j + 2]));
      if (hit < nearest && hit >= c.near && hit <= c.far) {
        nearest = hit;
        best = e.id;
      }
    }
  }
  return best;
}
