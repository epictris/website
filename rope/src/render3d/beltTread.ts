// A conveyor in 3D: the band as its own ring of geometry, whose running surface
// carries the texture round the loop at the belt's speed, and - on a band with
// no texture to move - a ring of thin cleats riding it (docs/render3d.md,
// "Conveyor belts"; docs/conveyors.md, "Rendering").
//
// WHY ITS OWN GEOMETRY. A belt's running surface is the OUTER WALL of the band,
// and that is the face a tread texture belongs on, laid by ARC LENGTH along the
// loop so a rubber tread tiles along the belt without stretching round a wheel.
// The extruder (`extrude.ts`) cannot do that: its side-wall UVs are anchored in
// the object's own x/y so a wall's texture meets its cap's, which on a loop
// runs u along the runs and turns it into the depth axis wherever the outline
// goes vertical. So the band is built here from the loop itself (`beltRing`):
// an outer wall with u = s, an inner wall, and the two caps - the band's edge,
// `thickness` deep - at the same u, so the surface and its edge agree at the
// rim. v runs on round the band's cross-section (outer wall, front cap, inner
// wall, back cap) so it is continuous over every rim but the one at the back
// of the outer wall, which the camera never sees. A texture repeat is adjusted
// to the nearest length that goes round the loop a whole number of times
// (`beltTextureTile`), so there is no seam where `s` wraps.
//
// THE MOTION. A textured band scrolls: every frame its u is `s - speed * t`,
// with `t` the SIM time the frame stands for (`beltRenderTime`), reduced into
// one repeat - written into the ring's own UV buffer rather than the material's
// map offset, because materials are shared and cached (`assets.ts`) and an
// authored set's maps are swapped into the shared material when they arrive.
// An untextured band - the flat colour - has nothing to scroll, so it keeps the
// cleats: boxes set just inside the surface, through the whole width and a few
// millimetres out past both caps, so what shows is a pale slat end on the rim
// of the front cap and no face of theirs shares a plane with the band's. One
// `InstancedMesh` per belt, one draw call.
//
// Render-side by construction: all of it reads the loop and the clock, and
// nothing here writes anything the sim can see.

import * as THREE from "three";

import type { BeltLoop } from "../engine/shapes";
import {
  beltFrameAt,
  beltTextureTile,
  beltTreadDepth,
  beltTreadPhase,
  beltTreadPitch,
  type BeltFrame,
} from "../render/beltTread";
import { threeY } from "./space";

// How finely an arc of the band is cut: segments per whole turn. The band is
// seen at play zoom as a curve, and 64 a turn keeps a 30 cm wheel's rim within
// half a millimetre of true.
const ARC_SEGMENTS_PER_TURN = 64;

// Along the loop, how thick a cleat is (metres).
const CLEAT_THICKNESS = 0.02;
// How far a cleat's outer face sits inside the surface, and how far its ends
// stand out past the two caps (metres). Both keep a cleat face from sharing a
// plane with the band's own face, which is what z-fighting is. On a thin band
// the inset shrinks with it, so a cleat never reaches the band's inner face.
const CLEAT_INSET = 0.004;
const CLEAT_PROUD = 0.004;

// The cleats' material: worn steel slats, pale against a rubber belt as the 2D
// tread's near-white ticks are (a mid grey, which the light lifts toward
// them), so the motion reads on any belt colour a level authors short of a
// pale one. Shared by every belt in every scene - it is never mutated after it
// is made, which is the rule the material cache in `assets.ts` keeps for the
// same reason.
let cleatMaterial: THREE.MeshStandardMaterial | null = null;
function material(): THREE.MeshStandardMaterial {
  cleatMaterial ??= new THREE.MeshStandardMaterial({
    color: "#a3a9b3",
    roughness: 0.6,
    metalness: 0.3,
  });
  return cleatMaterial;
}

// Scratch, so the per-frame placement allocates nothing.
const frame: BeltFrame = { x: 0, y: 0, tx: 0, ty: 0 };
const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const p = new THREE.Vector3();
const unit = new THREE.Vector3(1, 1, 1);
const zAxis = new THREE.Vector3(0, 0, 1);

// The arc lengths the band is cut at: every arc at `ARC_SEGMENTS_PER_TURN`, a
// run as its two ends (its surface is flat and its u is linear in s), and the
// perimeter itself last, so the first and last stations are the same point with
// u a whole number of repeats apart.
export function beltRingStations(loop: BeltLoop): number[] {
  const out: number[] = [];
  loop.segments.forEach((seg, i) => {
    const s0 = loop.cum[i]!;
    if (seg.kind === "run") {
      out.push(s0);
      return;
    }
    if (!(seg.sweep > 0)) return;
    const n = Math.max(1, Math.ceil((seg.sweep * ARC_SEGMENTS_PER_TURN) / (2 * Math.PI)));
    for (let k = 0; k < n; k++) out.push(s0 + (seg.radius * seg.sweep * k) / n);
  });
  out.push(loop.total);
  return out;
}

// The four faces of the band's cross-section, in the order v runs round it.
const OUTER = 0;
const FRONT = 1;
const INNER = 2;
const BACK = 3;
// Two vertices per face per station.
const PER_STATION = 8;

// The band as a ring: `width` across the pulleys (the extrusion depth, centred
// on z = 0 as every extrusion here is), in the loop's frame, with UVs in METRES
// (`extrude.ts`'s convention, which `applyTiling` turns into repeats) - u along
// the outer surface at the rate `tile / beltTextureTile(loop, tile)`, so a
// whole number of repeats goes round, and v round the cross-section.
export class BeltRing {
  readonly geometry = new THREE.BufferGeometry();
  // How many u-metres one metre of arc length is: `tile` over the adjusted
  // repeat, so the lap is a whole number of repeats.
  private readonly uPerS: number;
  // One adjusted repeat along the loop: the scroll is reduced into it, since a
  // whole repeat's shift is invisible and a bounded number keeps the float
  // precision of the UVs.
  private readonly period: number;
  private readonly stationS: Float64Array;
  private readonly uv: THREE.BufferAttribute;
  private lastShift = NaN;

  constructor(
    private readonly loop: BeltLoop,
    width: number,
    // The surface's own repeat in metres (`tileMetres`).
    tile: number,
    private readonly speed: number,
  ) {
    this.period = beltTextureTile(loop, tile);
    this.uPerS = tile / this.period;
    const stations = beltRingStations(loop);
    this.stationS = Float64Array.from(stations);
    const count = stations.length * PER_STATION;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const t = loop.thickness;
    const zf = width / 2;
    const zb = -width / 2;
    // v at the start of each face, walking round the section from the back rim
    // of the outer wall: outer wall back -> front, front cap out -> in, inner
    // wall front -> back, back cap in -> out.
    const vOuter = zb;
    const vFront = zf;
    const vInner = zf + t;
    const vBack = zf + t + width;
    stations.forEach((s, j) => {
      beltFrameAt(loop, s, frame);
      // Outward normal: the tangent's Godot orthogonal, (ty, -tx).
      const nx = frame.ty;
      const ny = -frame.tx;
      const ox = frame.x;
      const oy = frame.y;
      const ix = ox - nx * t;
      const iy = oy - ny * t;
      const set = (face: number, k: number, x: number, y: number, z: number, n: [number, number, number], v: number) => {
        const i = j * PER_STATION + face * 2 + k;
        pos[i * 3] = x;
        pos[i * 3 + 1] = threeY(y);
        pos[i * 3 + 2] = z;
        nor[i * 3] = n[0];
        nor[i * 3 + 1] = n[1];
        nor[i * 3 + 2] = n[2];
        uv[i * 2 + 1] = v;
      };
      const out: [number, number, number] = [nx, threeY(ny), 0];
      const inn: [number, number, number] = [-nx, -threeY(ny), 0];
      set(OUTER, 0, ox, oy, zb, out, vOuter);
      set(OUTER, 1, ox, oy, zf, out, vOuter + width);
      set(FRONT, 0, ox, oy, zf, [0, 0, 1], vFront);
      set(FRONT, 1, ix, iy, zf, [0, 0, 1], vFront + t);
      set(INNER, 0, ix, iy, zf, inn, vInner);
      set(INNER, 1, ix, iy, zb, inn, vInner + width);
      set(BACK, 0, ix, iy, zb, [0, 0, -1], vBack);
      set(BACK, 1, ox, oy, zb, [0, 0, -1], vBack + t);
    });
    // Two triangles per face between consecutive stations, wound so each faces
    // along its own normal (three culls the back of a triangle): tested against
    // the normal rather than reasoned out per face, since the y negation into
    // three's frame flips every winding once already.
    const index: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const want = new THREE.Vector3();
    for (let j = 0; j + 1 < stations.length; j++) {
      for (let face = 0; face < 4; face++) {
        const i0 = j * PER_STATION + face * 2;
        const i1 = i0 + 1;
        const i2 = i0 + PER_STATION;
        const i3 = i1 + PER_STATION;
        a.fromArray(pos, i0 * 3);
        b.fromArray(pos, i2 * 3);
        c.fromArray(pos, i1 * 3);
        want.fromArray(nor, i0 * 3);
        const facing = b.sub(a).cross(c.sub(a)).dot(want);
        if (facing >= 0) index.push(i0, i2, i1, i1, i2, i3);
        else index.push(i0, i1, i2, i1, i3, i2);
      }
    }
    this.geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    this.uv = new THREE.BufferAttribute(uv, 2);
    this.geometry.setAttribute("uv", this.uv);
    this.geometry.setIndex(index);
    this.scroll(0);
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
  }

  // Carry the texture to where the belt has run it by `time` seconds of sim.
  sync(time: number): void {
    const d = (this.speed * time) % this.period;
    this.scroll(d < 0 ? d + this.period : d);
  }

  // The u of every vertex with the surface run `shift` metres on: the pattern
  // at arc length `s` is the one that stood at `s - shift`.
  private scroll(shift: number): void {
    if (shift === this.lastShift) return;
    this.lastShift = shift;
    const uv = this.uv.array as Float32Array;
    const n = this.stationS.length;
    for (let j = 0; j < n; j++) {
      const u = (this.stationS[j]! - shift) * this.uPerS;
      const base = j * PER_STATION;
      for (let k = 0; k < PER_STATION; k++) uv[(base + k) * 2] = u;
    }
    this.uv.needsUpdate = true;
  }
}

export class BeltTread {
  readonly mesh: THREE.InstancedMesh;
  readonly geometry: THREE.BoxGeometry;
  private readonly pitch: number;
  private readonly count: number;
  private readonly depth: number;
  private readonly inset: number;
  private lastPhase = NaN;

  // `loop` is in the frame of the group the mesh is added to (the geometry
  // object's own), `speed` the belt's signed surface speed in m/s, and `width`
  // the band's width through z, centred on the group's z = 0.
  constructor(
    private readonly loop: BeltLoop,
    private readonly speed: number,
    width: number,
  ) {
    this.pitch = beltTreadPitch(loop);
    this.count = Math.round(loop.total / this.pitch);
    this.depth = beltTreadDepth(loop);
    this.inset = Math.min(CLEAT_INSET, 0.2 * loop.thickness);
    // x along the loop, y along the inward normal, z through the band.
    this.geometry = new THREE.BoxGeometry(CLEAT_THICKNESS, this.depth, width + 2 * CLEAT_PROUD);
    this.mesh = new THREE.InstancedMesh(this.geometry, material(), this.count);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.place(0);
    // The cleats only ever move ALONG the loop, so the bounds the first
    // placement gives hold for every frame after it.
    this.mesh.computeBoundingSphere();
  }

  // Carry the cleats to where the belt has run them by `time` seconds of sim.
  sync(time: number): void {
    this.place(beltTreadPhase(this.loop, this.speed, time));
  }

  private place(phase: number): void {
    if (phase === this.lastPhase) return;
    this.lastPhase = phase;
    const half = this.inset + this.depth / 2;
    for (let k = 0; k < this.count; k++) {
      beltFrameAt(this.loop, phase + k * this.pitch, frame);
      // The inward normal is minus the outward one, which is the tangent's
      // Godot orthogonal (ty, -tx) - the winding every polygon here has.
      const cx = frame.x - frame.ty * half;
      const cy = frame.y + frame.tx * half;
      p.set(cx, threeY(cy), 0);
      // The box's x along the tangent, in three's y-up frame.
      q.setFromAxisAngle(zAxis, Math.atan2(threeY(frame.ty), frame.tx));
      m.compose(p, q, unit);
      this.mesh.setMatrixAt(k, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
