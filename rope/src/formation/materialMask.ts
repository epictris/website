// A MATERIAL LAYER's MASK (docs/formations.md "Material layers"): where its
// strokes lay the material, as a map in the rock's paint UV. Computed by the
// same code in the editor, live as the brush paints (src/editor/
// materialMasks.ts), and in the build, which writes it as the decoration's
// `mask.png` for the game (scripts/decoration-build.ts). DOM-free.
//
// Every texel of the map that the rock's paint UV covers is a point on the
// rock (rasterised from the rock's triangles: the texel's centre carried
// through its triangle onto the surface, with the triangle's normal), and the
// strokes are composited onto those points exactly as the stamp brush
// composites them onto a growth's (stampField.ts). Texels off the islands take
// the value of the nearest texel on one, so a filtered or mipmapped read at a
// seam never pulls in empty background.

import type { PaintStamp } from "../level/levelFormat";
import { compositeStamp, StampPoints } from "./stampField";

// The mask's side, texels. The material's own maps carry the detail (its
// height sharpens the mask's edge, paintLayers.ts); the mask only says where,
// and a 2.4 m rock at 1024 is a texel every 3 mm.
export const MASK_SIDE = 1024;

// A rock's triangles: positions in the formation's frame (metres), the paint
// UV of each vertex (glTF's: v = 0 is the map's first row), and the corners.
export interface PaintUvMesh {
  positions: Float32Array;
  uvs: Float32Array;
  index: Uint32Array;
}

// The texels of a map the rock's paint UV covers, as points on the rock.
export class MaskTexels {
  constructor(
    readonly side: number,
    // The covered texels' points and normals, in the order found.
    readonly points: StampPoints,
    // Each point's texel (y * side + x).
    readonly texel: Int32Array,
    // Each texel's point: its own, or the nearest covered texel's.
    readonly source: Int32Array,
  ) {}
}

export function rasterizePaintUv(meshes: readonly PaintUvMesh[], side = MASK_SIDE): MaskTexels {
  const owner = new Int32Array(side * side).fill(-1);
  const pts: number[] = [];
  const nrm: number[] = [];
  const texels: number[] = [];
  for (const mesh of meshes) {
    const { positions: P, uvs: U, index: I } = mesh;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t]!;
      const b = I[t + 1]!;
      const c = I[t + 2]!;
      // The face's normal, as the brush's samples take it.
      const e1x = P[b * 3]! - P[a * 3]!;
      const e1y = P[b * 3 + 1]! - P[a * 3 + 1]!;
      const e1z = P[b * 3 + 2]! - P[a * 3 + 2]!;
      const e2x = P[c * 3]! - P[a * 3]!;
      const e2y = P[c * 3 + 1]! - P[a * 3 + 1]!;
      const e2z = P[c * 3 + 2]! - P[a * 3 + 2]!;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz);
      if (!(nl > 0)) continue;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      // The triangle in texel space.
      const ax = U[a * 2]! * side;
      const ay = U[a * 2 + 1]! * side;
      const bx = U[b * 2]! * side;
      const by = U[b * 2 + 1]! * side;
      const cx = U[c * 2]! * side;
      const cy = U[c * 2 + 1]! * side;
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const x1 = Math.min(side - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const y1 = Math.min(side - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          // Barycentric weights of the texel's centre.
          const wa = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
          const wb = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
          const wc = 1 - wa - wb;
          const eps = -1e-6;
          if (wa < eps || wb < eps || wc < eps) continue;
          const k = y * side + x;
          if (owner[k] !== -1) continue;
          owner[k] = texels.length;
          texels.push(k);
          for (let axis = 0; axis < 3; axis++) {
            pts.push(wa * P[a * 3 + axis]! + wb * P[b * 3 + axis]! + wc * P[c * 3 + axis]!);
          }
          nrm.push(nx, ny, nz);
        }
      }
    }
  }
  // Every other texel takes its nearest covered one (a breadth-first sweep
  // out from the islands, four neighbours a step).
  const source = owner.slice();
  const queue = new Int32Array(side * side);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < source.length; k++) if (source[k] !== -1) queue[tail++] = k;
  while (head < tail) {
    const k = queue[head++]!;
    const x = k % side;
    const y = (k - x) / side;
    const s = source[k]!;
    if (x > 0 && source[k - 1] === -1) (source[k - 1] = s), (queue[tail++] = k - 1);
    if (x < side - 1 && source[k + 1] === -1) (source[k + 1] = s), (queue[tail++] = k + 1);
    if (y > 0 && source[k - side] === -1) (source[k - side] = s), (queue[tail++] = k - side);
    if (y < side - 1 && source[k + side] === -1) (source[k + side] = s), (queue[tail++] = k + side);
  }
  return new MaskTexels(side, new StampPoints(Float32Array.from(pts), Float32Array.from(nrm)), Int32Array.from(texels), source);
}

// The strokes of one material layer on its rock's texels.
export class MaterialMask {
  // The paint at each covered texel's point, 0 to 1.
  private readonly m: Float32Array;
  // How many strokes are composited, and the last of them: a stroke list
  // that does not run on from it (undone, thrown away by Esc, erased in
  // place) is composited again from nothing.
  private done = 0;
  private last: PaintStamp | null = null;

  constructor(readonly texels: MaskTexels) {
    this.m = new Float32Array(texels.points.count);
  }

  // Bring the mask to `strokes`. False when nothing changed.
  update(strokes: readonly PaintStamp[]): boolean {
    const runsOn = strokes.length >= this.done && (this.done === 0 || strokes[this.done - 1] === this.last);
    if (runsOn && strokes.length === this.done) return false;
    if (!runsOn) {
      this.m.fill(0);
      this.done = 0;
    }
    for (let i = this.done; i < strokes.length; i++) compositeStamp(this.m, this.texels.points, strokes[i]!);
    this.done = strokes.length;
    this.last = strokes.at(-1) ?? null;
    return true;
  }

  // The mask as 8-bit texels, row 0 the map's v = 0: into `out` (side x side
  // bytes, or 4 bytes a texel with `stride` 4, the value in each of RGB and
  // 255 in alpha).
  write(out: Uint8Array, stride: 1 | 4 = 1): Uint8Array {
    const { source } = this.texels;
    const m = this.m;
    for (let k = 0; k < source.length; k++) {
      const s = source[k]!;
      const v = s < 0 ? 0 : Math.round(Math.min(1, Math.max(0, m[s]!)) * 255);
      if (stride === 1) out[k] = v;
      else {
        out[k * 4] = v;
        out[k * 4 + 1] = v;
        out[k * 4 + 2] = v;
        out[k * 4 + 3] = 255;
      }
    }
    return out;
  }
}
