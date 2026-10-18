import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import { VINE_VISUAL_RADIUS } from "../level/vines";
import { forEachBraidPoint } from "../render/vineBraid";
import { forEachRopePoint } from "../render/ropeLay";
import { sampleVineCurve, vineMaterial, vineTangent } from "../render/vineCurve";
import { VineTwist } from "../render/vineTwist";
import { ROPE_FIBRE_TILE, ropeFibreMaps } from "./ropeFibres";
import type { VineLeafLag } from "./vineLeafLag";
import type { VineLeafFold } from "./vineLeafFold";

// Radial sides per strand. A rope's strands are its whole silhouette and are
// lit across their full round, where the braid's are broken up by leaves.
const BRAID_SIDES = 12, ROPE_SIDES = 16;
// A rope's ring spacing along the cord, in metres: its hard lay turns a strand
// 8.5° a ring here, where the braid's default 1.2 cm faceted the silhouette.
const ROPE_RING_STEP = .004;
const OLIVE = new THREE.Color("#637848"), BARK = new THREE.Color("#6d6243"), MOSS = new THREE.Color("#7e9155");
function softBand(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t);
}

// A braid is built ONCE, in its rest pose, and bent onto the live vine on the
// GPU - the way a skinned mesh is posed by its bones rather than rebuilt.
//
// Everything about a braid is fixed in material coordinates: the strands, their
// gauges and taper, the ridges, the paint and the ring topology all belong to a
// station along the REST length, and stretching one link must not slide them
// (render/vineCurve.ts). What a frame changes is only the centreline the
// physics moves, so a frame uploads only that: one texel pair per link point.
// Rebuilding every vertex on the CPU each frame - three strands, a ring every
// 1.2 cm, a sine-painted colour per vertex - was 6.9 ms of a 144 Hz frame for
// the six vines on BALL (Trace-20261011T201625, session-1055f).
//
// Each vertex stores its station `vineU` (link index + fraction) and its offset
// from the centreline in the centreline's own frame (along, across, depth).
// The vertex shader evaluates the same arc-weighted Hermite `sampleVineCurve`
// draws through the links, and lays the offset out on the tangent there, rolled
// by the twist rod and narrowed by the local stretch. `frameAt` is the same
// evaluation on the CPU, for the leaf roots and for the test.

// The pose: one texel per link point, two rows. Row 0 is the point and the
// curve's tangent there (x, y, tx, ty, in sim metres, y down); row 1 the roll
// the twist rod gives that point and the stretch of the links either side.
const POSE_ROWS = 2;

const STEM_VERTEX_DECLARATIONS = /* glsl */`
attribute float vineU;
uniform highp sampler2D vinePose;
uniform int vineLast;
vec3 vineCentre;
vec3 vineAlong;
vec3 vineAcross;
float vineRoll;
float vineSqueeze;
void vineFrame(float u) {
  int i = clamp(int(floor(u)), 0, vineLast - 1);
  float t = clamp(u - float(i), 0.0, 1.0);
  vec4 a = texelFetch(vinePose, ivec2(i, 0), 0);
  vec4 b = texelFetch(vinePose, ivec2(i + 1, 0), 0);
  vec4 ea = texelFetch(vinePose, ivec2(i, 1), 0);
  vec4 eb = texelFetch(vinePose, ivec2(i + 1, 1), 0);
  float len = distance(a.xy, b.xy);
  float t2 = t * t, t3 = t2 * t;
  vec2 p = (2.0 * t3 - 3.0 * t2 + 1.0) * a.xy + (t3 - 2.0 * t2 + t) * len * a.zw
    + (-2.0 * t3 + 3.0 * t2) * b.xy + (t3 - t2) * len * b.zw;
  vec2 d = (6.0 * t2 - 6.0 * t) * a.xy + (3.0 * t2 - 4.0 * t + 1.0) * len * a.zw
    + (-6.0 * t2 + 6.0 * t) * b.xy + (3.0 * t2 - 2.0 * t) * len * b.zw;
  float speed = length(d);
  vec2 tg = speed > 1e-8 ? d / speed : len > 1e-6 ? (b.xy - a.xy) / len : a.zw;
  vineCentre = vec3(p.x, -p.y, 0.0);
  vineAlong = vec3(tg.x, -tg.y, 0.0);
  vineAcross = vec3(-tg.y, -tg.x, 0.0);
  vineRoll = mix(ea.x, eb.x, t);
  vineSqueeze = inversesqrt(clamp(mix(ea.y, eb.y, t), 1.0, 1.3));
}
vec3 vineOrient(vec3 local) {
  float c = cos(vineRoll), s = sin(vineRoll);
  return vineAlong * local.x + vineAcross * (local.y * c - local.z * s) + vec3(0.0, 0.0, local.y * s + local.z * c);
}
`;

interface StemUniforms {
  vinePose: { value: THREE.DataTexture };
  vineLast: { value: number };
}

// Lit, depth and point-shadow passes all bend the same rest mesh, or the shadow
// would be cast by a straight braid hanging where the vine was built.
function patchStem(material: THREE.Material, uniforms: StemUniforms, key: string, normals: boolean): void {
  material.customProgramCacheKey = () => key;
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + STEM_VERTEX_DECLARATIONS)
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\nvineFrame(vineU);\ntransformed = vineCentre + vineSqueeze * vineOrient(transformed);");
    if (normals) shader.vertexShader = shader.vertexShader.replace("#include <beginnormal_vertex>",
      "#include <beginnormal_vertex>\nvineFrame(vineU);\nobjectNormal = vineOrient(objectNormal);");
  };
}

function makePoseTexture(width: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Float32Array(width * POSE_ROWS * 4), width, POSE_ROWS, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export class VineTube {
  growthLength = 0;
  readonly leafMotions: VineLeafLag[] = [];
  readonly leafFolds: VineLeafFold[] = [];
  readonly twist = new VineTwist();
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.BufferGeometry();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly depthMaterial: THREE.MeshDepthMaterial;
  private readonly distanceMaterial: THREE.MeshDistanceMaterial;
  private readonly uniforms: StemUniforms;
  // What the rest mesh was built for; any change rebuilds it.
  private points = 0;
  private restLength = 0;
  private seed = -1;
  private attached = false;
  private readonly tint = new THREE.Color(-1, -1, -1);
  private spacing = 0;
  private rings = 0;
  // Each ring's station in link units, and the rest mesh's local offsets
  // (the position attribute's own array), for `leafSurface`.
  private ringU = new Float64Array(0);
  private local = new Float32Array(0);
  // The CPU mirror of the shader's frame, filled by `frameAt`.
  private readonly centre = new THREE.Vector3();
  private readonly along = new THREE.Vector3();
  private readonly across = new THREE.Vector3();
  private roll = 0;
  private squeeze = 1;
  private readonly scratch = new THREE.Vector3();
  private readonly sides: number;

  // `rope` draws the braid as laid rope (`render/ropeLay.ts`): even strands at
  // a fixed lay, their fibres in a shared texture rather than painted per
  // vertex, and no leaves. Fixed for the tube's life; a vine that changes look
  // gets a new tube.
  constructor(readonly rope = false) {
    this.sides = rope ? ROPE_SIDES : BRAID_SIDES;
    const pose = makePoseTexture(16);
    this.uniforms = { vinePose: { value: pose }, vineLast: { value: 1 } };
    if (rope) {
      const fibres = ropeFibreMaps();
      this.material = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: .88, map: fibres.color, normalMap: fibres.normal,
      });
      patchStem(this.material, this.uniforms, "laid-rope-stem-v1", true);
    } else {
      this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: .91 });
      this.material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace("#include <roughnessmap_fragment>", /* glsl */`
          #include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor - .10 * smoothstep(.05, .22, vColor.g), .78, .94);
        `);
      };
      patchStem(this.material, this.uniforms, "painted-vine-stem-v2", true);
    }
    this.depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patchStem(this.depthMaterial, this.uniforms, "painted-vine-stem-depth-v2", false);
    this.distanceMaterial = new THREE.MeshDistanceMaterial();
    patchStem(this.distanceMaterial, this.uniforms, "painted-vine-stem-distance-v2", false);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = rope ? "vine-rope-tube" : "vine-braid-tube";
    this.mesh.userData.tube = this;
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.customDepthMaterial = this.depthMaterial;
    this.mesh.customDistanceMaterial = this.distanceMaterial;
    // The geometry is the rest pose; its bounds say nothing about where the
    // shader puts it.
    this.mesh.frustumCulled = false;
  }

  // Pose the braid on this frame's link points (anchor, links, second anchor),
  // building the rest mesh first if the vine is not the one it was built for.
  // `twist` must already be updated for this frame.
  sync(path: readonly Vec2[], restLength: number, seed: number, tint: THREE.Color, attachedAtBothEnds = false): void {
    this.mesh.visible = path.length >= 2 && restLength > 0;
    if (!this.mesh.visible) return;
    if (path.length !== this.points || restLength !== this.restLength || seed !== this.seed ||
      attachedAtBothEnds !== this.attached || !tint.equals(this.tint)) {
      this.build(path.length, restLength, seed, tint, attachedAtBothEnds);
    }
    this.writePose(path);
  }

  // A cord that does not state its rest length (a test's, a hand-built one) is
  // held to the length it first had, so its stations never follow the stretch.
  restLengthFor(path: readonly Vec2[]): number {
    if (!this.firstLength) for (let i = 1; i < path.length; i++) this.firstLength += path[i]!.distanceTo(path[i - 1]!);
    return this.firstLength;
  }
  private firstLength = 0;

  // The rest distance between link points, and the last point's index: a
  // station's link units times the one is metres along the rest vine.
  get linkSpacing(): number { return this.spacing; }
  get lastLink(): number { return this.points - 1; }

  // The pose texture's upload count: unchanged while the vine is still.
  get poseVersion(): number { return this.uniforms.vinePose.value.version; }

  private build(points: number, restLength: number, seed: number, tint: THREE.Color, attachedAtBothEnds: boolean): void {
    this.points = points; this.restLength = restLength; this.seed = seed;
    this.attached = attachedAtBothEnds; this.tint.copy(tint);
    this.spacing = restLength / (points - 1);
    this.growthLength = restLength;
    // The rest pose hangs straight down: the same stations, braid and paint the
    // live vine had at rest, measured in the centreline's frame.
    const rest: Vec2[] = [];
    for (let i = 0; i < points; i++) rest.push(new Vec2(0, i * this.spacing));
    const curve = sampleVineCurve(rest, [], [], restLength, this.rope ? ROPE_RING_STEP : undefined);
    const rings = curve.length;
    this.rings = rings;
    const centres = new Float32Array(3 * rings * 4);
    if (this.rope) {
      forEachRopePoint(curve, seed, (i, x, y, z, strand, radius) => {
        const k = (strand * rings + i) * 4;
        centres[k] = x; centres[k + 1] = -y; centres[k + 2] = z;
        centres[k + 3] = radius;
      });
    } else {
      forEachBraidPoint(curve, seed, (i, x, y, z, strand, girth) => {
        const k = (strand * rings + i) * 4;
        centres[k] = x; centres[k + 1] = -y; centres[k + 2] = z;
        centres[k + 3] = VINE_VISUAL_RADIUS * .52 * girth;
      }, restLength, attachedAtBothEnds);
    }
    const SIDES = this.sides, RING = SIDES + 1;
    const stride = rings * RING + 2, vertexCount = 3 * stride;
    const position = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3), stations = new Float32Array(vertexCount);
    // A rope strand's fibre map coordinates: once round the strand, and its
    // own arc length along it in fibre tiles (`ropeFibres.ts`).
    const uvs = this.rope ? new Float32Array(vertexCount * 2) : null;
    this.ringU = new Float64Array(rings);
    for (let i = 0; i < rings; i++) this.ringU[i] = vineMaterial(curve[i]!) / this.spacing;

    const tangent = new THREE.Vector3(), previousTangent = new THREE.Vector3(), transport = new THREE.Quaternion();
    const normal = new THREE.Vector3(), binormal = new THREE.Vector3(), radial = new THREE.Vector3();
    const surfaceNormal = new THREE.Vector3(), around = new THREE.Vector3(), paint = new THREE.Color();
    // A vertex built in three space at rest, written as (along, across, depth)
    // about its ring's centreline point - the frame `vineOrient` lays it out on.
    const put = (v: number, ring: number, x: number, y: number, z: number, nx: number, ny: number, nz: number): void => {
      const p = curve[ring]!, cx = p.x, cy = -p.y;
      const ax = p.tx, ay = -p.ty, bx = -p.ty, by = -p.tx;
      position[v * 3] = (x - cx) * ax + (y - cy) * ay;
      position[v * 3 + 1] = (x - cx) * bx + (y - cy) * by;
      position[v * 3 + 2] = z;
      normals[v * 3] = nx * ax + ny * ay;
      normals[v * 3 + 1] = nx * bx + ny * by;
      normals[v * 3 + 2] = nz;
      stations[v] = this.ringU[ring]!;
    };
    for (let s = 0; s < 3; s++) {
      const shade = this.rope ? 1 : s === 0 ? 1.02 : s === 1 ? .97 : .94;
      const phase = seed * .71 + s * 1.9;
      normal.set(0, 0, 1);
      let strandArc = 0;
      for (let i = 0; i < rings; i++) {
        const k = (s * rings + i) * 4;
        const before = (s * rings + Math.max(0, i - 1)) * 4;
        const after = (s * rings + Math.min(rings - 1, i + 1)) * 4;
        if (i) {
          const last = k - 4;
          strandArc += Math.hypot(centres[k]! - centres[last]!, centres[k + 1]! - centres[last + 1]!, centres[k + 2]! - centres[last + 2]!);
        }
        tangent.set(centres[after]! - centres[before]!, centres[after + 1]! - centres[before + 1]!, centres[after + 2]! - centres[before + 2]!);
        const length = tangent.length();
        if (length > 1e-8) tangent.multiplyScalar(1 / length); else tangent.set(0, -1, 0);
        if (this.rope) {
          // A rope strand's sides are measured from its crown - straight out
          // from the rope's axis - so its fibre map turns with the lay rather
          // than drifting round the strand as a transported frame would.
          normal.set(centres[k]! - curve[i]!.x, centres[k + 1]! + curve[i]!.y, centres[k + 2]!);
        } else if (i) {
          // Minimal rotation, unlike repeated projection which introduces
          // artificial roll on curved/helical strand centrelines.
          transport.setFromUnitVectors(previousTangent, tangent);
          normal.applyQuaternion(transport);
        }
        previousTangent.copy(tangent);
        normal.addScaledVector(tangent, -normal.dot(tangent));
        if (normal.lengthSq() < 1e-8) {
          normal.set(Math.abs(tangent.x) < .9 ? 1 : 0, Math.abs(tangent.x) < .9 ? 0 : 1, 0);
          normal.addScaledVector(tangent, -normal.dot(tangent));
        }
        normal.normalize();
        binormal.crossVectors(tangent, normal).normalize();
        const slope = length > 1e-8 ? (centres[after + 3]! - centres[before + 3]!) / length : 0;
        const growth = vineMaterial(curve[i]!);
        for (let j = 0; j <= SIDES; j++) {
          const angle = (j % SIDES) * Math.PI * 2 / SIDES;
          radial.copy(normal).multiplyScalar(Math.cos(angle)).addScaledVector(binormal, Math.sin(angle));
          if (this.rope) {
            // Smooth strands: the fibres are the normal map's. What the
            // vertex colour carries is the groove where two strands press
            // together, shadowed by how near this point is to the next
            // strand's surface, and the tint.
            const v = s * stride + i * RING + j, radius = centres[k + 3]!;
            const px = centres[k]! + radial.x * radius, py = centres[k + 1]! + radial.y * radius, pz = centres[k + 2]! + radial.z * radius;
            put(v, i, px, py, pz, radial.x - tangent.x * slope, radial.y - tangent.y * slope, radial.z - tangent.z * slope);
            uvs![v * 2] = j / SIDES;
            uvs![v * 2 + 1] = strandArc / ROPE_FIBRE_TILE;
            let gap = Infinity;
            for (let o = 1; o < 3; o++) {
              const q = (((s + o) % 3) * rings + i) * 4;
              gap = Math.min(gap, Math.hypot(px - centres[q]!, py - centres[q + 1]!, pz - centres[q + 2]!) - centres[q + 3]!);
            }
            const open = Math.max(0, Math.min(1, gap / (radius * .8)));
            const cavity = .18 + .82 * open * (2 - open);
            colors[v * 3] = tint.r * cavity;
            colors[v * 3 + 1] = tint.g * cavity;
            colors[v * 3 + 2] = tint.b * cavity;
            continue;
          }
          const ridge = 1 + .018 * Math.cos(angle * 3 + phase) + .012 * Math.sin(angle * 4 + growth * .8);
          const ridgeSlope = -.054 * Math.sin(angle * 3 + phase) + .048 * Math.cos(angle * 4 + growth * .8);
          const v = s * stride + i * RING + j, radius = centres[k + 3]! * ridge;
          around.copy(normal).multiplyScalar(-Math.sin(angle)).addScaledVector(binormal, Math.cos(angle));
          surfaceNormal.copy(radial).addScaledVector(tangent, -slope).addScaledVector(around, -ridgeSlope / ridge).normalize();
          put(v, i, centres[k]! + radial.x * radius, centres[k + 1]! + radial.y * radius, centres[k + 2]! + radial.z * radius,
            surfaceNormal.x, surfaceNormal.y, surfaceNormal.z);
          const patch = softBand(-.25, .25, Math.sin(growth * 4.1 + Math.sin(angle * 2 + phase) * 1.3 + phase));
          const stroke = softBand(.35, .7, Math.sin(angle * 4 + Math.sin(growth * 1.5 + phase) * .6) * Math.sin(growth * 6.2 + phase));
          paint.copy(BARK).lerp(OLIVE, patch).lerp(MOSS, stroke * .6);
          const inwardX = curve[i]!.x - centres[k]!, inwardY = -curve[i]!.y - centres[k + 1]!, inwardZ = -centres[k + 2]!;
          const contact = Math.max(0, (radial.x * inwardX + radial.y * inwardY + radial.z * inwardZ) / Math.max(1e-6, Math.hypot(inwardX, inwardY, inwardZ)));
          const cavity = 1 - .14 * contact;
          colors[v * 3] = paint.r * tint.r * shade * cavity;
          colors[v * 3 + 1] = paint.g * tint.g * shade * cavity;
          colors[v * 3 + 2] = paint.b * tint.b * shade * cavity;
        }
        if (i === 0 || i === rings - 1) {
          const v = s * stride + rings * RING + (i === 0 ? 0 : 1), sign = i === 0 ? -1 : 1;
          put(v, i, centres[k]!, centres[k + 1]!, centres[k + 2]!, tangent.x * sign, tangent.y * sign, tangent.z * sign);
          // A rope's cut end is its fibres end-on: darker than their sides.
          const end = this.rope ? .6 : 1;
          if (uvs) { uvs[v * 2] = .5; uvs[v * 2 + 1] = strandArc / ROPE_FIBRE_TILE; }
          colors[v * 3] = (this.rope ? 1 : OLIVE.r) * tint.r * shade * end;
          colors[v * 3 + 1] = (this.rope ? 1 : OLIVE.g) * tint.g * shade * end;
          colors[v * 3 + 2] = (this.rope ? 1 : OLIVE.b) * tint.b * shade * end;
        }
      }
    }
    const indices = new Uint32Array(3 * ((rings - 1) * SIDES * 6 + SIDES * 6));
    let k = 0;
    for (let s = 0; s < 3; s++) {
      const offset = s * stride, startCap = offset + rings * RING, endCap = startCap + 1;
      for (let i = 0; i < rings - 1; i++) for (let j = 0; j < SIDES; j++) {
        const a = offset + i * RING + j, b = a + RING;
        indices[k++] = a; indices[k++] = a + 1; indices[k++] = b;
        indices[k++] = b; indices[k++] = a + 1; indices[k++] = b + 1;
      }
      for (let j = 0; j < SIDES; j++) {
        indices[k++] = startCap; indices[k++] = offset + j + 1; indices[k++] = offset + j;
        indices[k++] = endCap; indices[k++] = offset + (rings - 1) * RING + j;
        indices[k++] = offset + (rings - 1) * RING + j + 1;
      }
    }
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute("vineU", new THREE.BufferAttribute(stations, 1));
    if (uvs) this.geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.mesh.geometry = this.geometry;
    this.local = position;

    if (this.uniforms.vinePose.value.image.width < points) {
      this.uniforms.vinePose.value.dispose();
      this.uniforms.vinePose.value = makePoseTexture(2 ** Math.ceil(Math.log2(points)));
    }
    this.uniforms.vineLast.value = points - 1;
    this.twist.reset();
  }

  private writePose(path: readonly Vec2[]): void {
    const texture = this.uniforms.vinePose.value;
    const data = texture.image.data as Float32Array, width = texture.image.width;
    let changed = false;
    const write = (k: number, value: number): void => {
      const f = Math.fround(value);
      if (data[k] !== f) { data[k] = f; changed = true; }
    };
    for (let i = 0; i < this.points; i++) {
      const p = path[i]!, k = i * 4, e = (width + i) * 4;
      write(k, p.x); write(k + 1, p.y);
      write(k + 2, vineTangent(path, i, "x")); write(k + 3, vineTangent(path, i, "y"));
      const before = i > 0 ? p.distanceTo(path[i - 1]!) / this.spacing : -1;
      const after = i + 1 < this.points ? p.distanceTo(path[i + 1]!) / this.spacing : -1;
      write(e, this.twist.angleAt(i * this.spacing));
      write(e + 1, before < 0 ? after : after < 0 ? before : (before + after) / 2);
    }
    if (changed) texture.needsUpdate = true;
  }

  // The shader's `vineFrame`, on the CPU and on the same float32 pose.
  private frameAt(u: number): void {
    const texture = this.uniforms.vinePose.value;
    const d = texture.image.data as Float32Array, width = texture.image.width;
    const i = Math.min(Math.max(Math.floor(u), 0), this.points - 2);
    const t = Math.min(1, Math.max(0, u - i));
    const a = i * 4, b = a + 4, ea = (width + i) * 4, eb = ea + 4;
    const ax = d[a]!, ay = d[a + 1]!, atx = d[a + 2]!, aty = d[a + 3]!;
    const bx = d[b]!, by = d[b + 1]!, btx = d[b + 2]!, bty = d[b + 3]!;
    const len = Math.hypot(bx - ax, by - ay);
    const t2 = t * t, t3 = t2 * t;
    const h0 = 2 * t3 - 3 * t2 + 1, h1 = (t3 - 2 * t2 + t) * len, h2 = -2 * t3 + 3 * t2, h3 = (t3 - t2) * len;
    const d0 = 6 * t2 - 6 * t, d1 = (3 * t2 - 4 * t + 1) * len, d2 = -6 * t2 + 6 * t, d3 = (3 * t2 - 2 * t) * len;
    const px = h0 * ax + h1 * atx + h2 * bx + h3 * btx, py = h0 * ay + h1 * aty + h2 * by + h3 * bty;
    let tx = d0 * ax + d1 * atx + d2 * bx + d3 * btx, ty = d0 * ay + d1 * aty + d2 * by + d3 * bty;
    const speed = Math.hypot(tx, ty);
    if (speed > 1e-8) { tx /= speed; ty /= speed; }
    else if (len > 1e-6) { tx = (bx - ax) / len; ty = (by - ay) / len; }
    else { tx = atx; ty = aty; }
    this.centre.set(px, -py, 0);
    this.along.set(tx, -ty, 0);
    this.across.set(-ty, -tx, 0);
    this.roll = d[ea]! * (1 - t) + d[eb]! * t;
    this.squeeze = 1 / Math.sqrt(Math.min(1.3, Math.max(1, d[ea + 1]! * (1 - t) + d[eb + 1]! * t)));
  }

  // The shader's `vineOrient`: a local (along, across, depth) on this frame.
  private orient(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.roll), s = Math.sin(this.roll);
    out.copy(this.along).multiplyScalar(x).addScaledVector(this.across, y * c - z * s);
    out.z += y * s + z * c;
    return out;
  }

  // Use the exposed support edge of the WHOLE braid at this material station.
  // A surface normal on just one strand can point its leaf into another strand.
  // Interpolation along a rendered longitudinal edge keeps the root on the
  // actual mesh, while the supporting plane leaves every strand behind it.
  leafSurface(fraction: number, centre: THREE.Vector3, outward: THREE.Vector3, point: THREE.Vector3, normal: THREE.Vector3): boolean {
    if (this.rings < 2) return false;
    const target = fraction * (this.points - 1);
    let ring = 0;
    while (ring + 1 < this.rings - 1 && this.ringU[ring + 1]! < target) ring++;
    const ua = this.ringU[ring]!, ub = this.ringU[ring + 1]!;
    const t = Math.max(0, Math.min(1, (target - ua) / (ub - ua)));
    this.frameAt(target);
    const SIDES = this.sides, RING = SIDES + 1;
    const stride = this.rings * RING + 2, local = this.local, base = centre.dot(outward);
    let exposed = -Infinity;
    for (let s = 0; s < 3; s++) for (let j = 0; j < SIDES; j++) {
      const a = (s * stride + ring * RING + j) * 3, b = a + RING * 3;
      this.orient(local[a]! + (local[b]! - local[a]!) * t, local[a + 1]! + (local[b + 1]! - local[a + 1]!) * t,
        local[a + 2]! + (local[b + 2]! - local[a + 2]!) * t, this.scratch).multiplyScalar(this.squeeze).add(this.centre);
      const support = this.scratch.dot(outward) - base;
      if (support <= exposed) continue;
      exposed = support; point.copy(this.scratch);
    }
    normal.copy(outward);
    return Number.isFinite(exposed);
  }

  // The braid as the shader draws it this frame, built on the CPU: for tests
  // that measure the rendered solid, never for drawing.
  deformedGeometry(): THREE.BufferGeometry {
    const out = new THREE.BufferGeometry();
    const stations = this.geometry.getAttribute("vineU"), rest = this.geometry.getAttribute("normal");
    const count = stations.count, position = new Float32Array(count * 3), normals = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      this.frameAt(stations.getX(v));
      this.orient(this.local[v * 3]!, this.local[v * 3 + 1]!, this.local[v * 3 + 2]!, this.scratch)
        .multiplyScalar(this.squeeze).add(this.centre).toArray(position, v * 3);
      this.orient(rest.getX(v), rest.getY(v), rest.getZ(v), this.scratch).toArray(normals, v * 3);
    }
    out.setAttribute("position", new THREE.BufferAttribute(position, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    out.setIndex(this.geometry.index!.clone());
    return out;
  }

  dispose(): void {
    this.geometry.dispose();
    this.uniforms.vinePose.value.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.distanceMaterial.dispose();
    this.mesh.removeFromParent();
  }
}

// A pointed blade with an arched midrib, cupped edges and a drooping tip.
export function vineLeafGeometry(): THREE.BufferGeometry {
  const rows = 18, columns = 10, positions: number[] = [], indices: number[] = [], uvs: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows, width = .29 * Math.pow(Math.sin(Math.PI * t), .8);
    for (let j = 0; j <= columns; j++) {
      const across = j / columns * 2 - 1;
      positions.push(width * across * (across < 0 ? .92 : 1.08) + .025 * Math.sin(Math.PI * 2 * t),
        t - .08 * t * t * t, (.045 + .026 * Math.exp(-Math.abs(across) * 9) - .018 * across * across) * Math.sin(Math.PI * t) - .08 * t * t * t);
      uvs.push(j / columns, t);
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) {
    const a = i * (columns + 1) + j, b = a + columns + 1;
    indices.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}
