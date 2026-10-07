import * as THREE from "three";
import { BUILTIN_ATLAS_SIZE, HANGING_LEAF_PROFILES, type HangingLeafProfile } from "./vine/hangingLeafProfiles";

/**
 * The leaf library: the built-in painted leaves and silhouettes plus leaves the user imports.
 * Everything lives in one atlas canvas (built-in sheet on top, imported leaves in
 * extra rows below), so every vine still draws all its leaves in one call.
 */
export type CustomLeaf = {
  id: string; name: string;
  /** the leaf, tip up, cropped; RGB is white/grey when tinted, the painted colours when kept */
  image: HTMLCanvasElement;
  aspect: number; baseUv: [number, number]; scale: number; keepColour: boolean;
  /** average painted colour, for tinting a kept-colour leaf toward a green */
  avgColour?: string;
  thumb: string;
};
export type SavedLeaf = Omit<CustomLeaf, "image" | "thumb"> & { png: string };

const ATLAS_W = BUILTIN_ATLAS_SIZE[0], COLS = 6, CELL = Math.floor(ATLAS_W / COLS), BUILTIN_H = BUILTIN_ATLAS_SIZE[1];
export const MAX_CUSTOM = 36;

export class LeafLibrary {
  custom: CustomLeaf[] = [];
  texture: THREE.CanvasTexture | null = null;
  profiles: HangingLeafProfile[] = HANGING_LEAF_PROFILES;
  private builtIn: HTMLImageElement | null = null;

  constructor(private builtInUrl: string) {}

  async init(): Promise<void> {
    this.builtIn = await loadImage(this.builtInUrl);
    this.compose();
  }

  /** Rebuild the atlas texture and the profile list after the custom leaves change. */
  compose(): void {
    const rows = Math.ceil(this.custom.length / COLS);
    const H = BUILTIN_H + rows * CELL;
    const canvas = document.createElement("canvas"); canvas.width = ATLAS_W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(this.builtIn!, 0, 0, ATLAS_W, BUILTIN_H);
    // Built-in rects were measured in the built-in atlas (v up); re-express them in this taller one.
    const builtIn = HANGING_LEAF_PROFILES.map(p => {
      const [u, v, w, h] = p.atlasRect, top = (1 - v - h) * BUILTIN_H, hp = h * BUILTIN_H;
      return { ...p, atlasRect: [u, 1 - (top + hp) / H, w, hp / H] as [number, number, number, number] };
    });
    const custom = this.custom.map((leaf, i) => {
      const col = i % COLS, row = Math.floor(i / COLS);
      const sc = Math.min((CELL - 6) / leaf.image.width, (CELL - 6) / leaf.image.height);
      const w = Math.max(1, Math.round(leaf.image.width * sc)), h = Math.max(1, Math.round(leaf.image.height * sc));
      const x = col * CELL + Math.floor((CELL - w) / 2), y = BUILTIN_H + row * CELL + Math.floor((CELL - h) / 2);
      ctx.drawImage(leaf.image, x, y, w, h);
      return { id: leaf.id, geometryAspect: leaf.aspect, baseUv: leaf.baseUv, scale: leaf.scale, keepColour: leaf.keepColour, avgColour: leaf.avgColour,
        atlasRect: [x / ATLAS_W, 1 - (y + h) / H, w / ATLAS_W, h / H] as [number, number, number, number] };
    });
    this.texture?.dispose();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; texture.userData.shared = true;
    this.texture = texture;
    this.profiles = [...builtIn, ...custom];
  }

  remove(id: string): void { this.custom = this.custom.filter(l => l.id !== id); this.compose(); }

  /** Cut every leaf out of an image: one leaf, or a sheet of several. */
  async importImage(file: Blob, name: string, keepColour: boolean): Promise<CustomLeaf[]> {
    const objectUrl = URL.createObjectURL(file);
    let img: HTMLImageElement;
    try { img = await loadImage(objectUrl); }
    finally { URL.revokeObjectURL(objectUrl); }
    const leaves = cutLeaves(img, name, keepColour);
    if (!leaves.length) throw new Error(`No leaves were found in ${name}. Use a PNG with a transparent background, or leaves on a plain background.`);
    const room = MAX_CUSTOM - this.custom.length;
    if (room <= 0) throw new Error(`There is room for ${MAX_CUSTOM} added leaves. Remove some first.`);
    const added = leaves.slice(0, room);
    this.custom.push(...added); this.compose();
    return added;
  }

  save(): SavedLeaf[] {
    return this.custom.map(({ image, thumb: _t, ...rest }) => ({ ...rest, png: image.toDataURL("image/png") }));
  }

  async load(saved: SavedLeaf[]): Promise<void> {
    const leaves: CustomLeaf[] = [];
    for (const s of saved.slice(0, MAX_CUSTOM)) {
      if (!/^data:image\/png;base64,/.test(s.png) || !/^my-[a-z0-9]{1,16}$/.test(s.id)) continue;
      const img = await loadImage(s.png);
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; c.getContext("2d")!.drawImage(img, 0, 0);
      leaves.push({ id: s.id, name: String(s.name).slice(0, 80), image: c, aspect: Number(s.aspect) || 1,
        baseUv: [Number(s.baseUv?.[0]) || 0.5, Number(s.baseUv?.[1]) || 0.05], scale: Math.min(1.35, Math.max(0.55, Number(s.scale) || 1)),
        keepColour: !!s.keepColour, avgColour: /^#[0-9a-f]{6}$/i.test(String(s.avgColour)) ? s.avgColour : undefined,
        thumb: makeThumb(c, !!s.keepColour) });
    }
    this.custom = leaves; this.compose();
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That image could not be read."));
    img.src = src;
  });
}

let counter = 0;
const newId = () => `my-${Date.now().toString(36).slice(-6)}${(counter++).toString(36)}`;

/**
 * Find leaves in an image and return each one cleaned, rotated so its stalk end is at
 * the bottom and its tip at the top, and cropped. Mirrors tools/cut2.py.
 */
function cutLeaves(img: HTMLImageElement, name: string, keepColour: boolean): CustomLeaf[] {
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const W = Math.max(1, Math.round(img.width * scale)), H = Math.max(1, Math.round(img.height * scale));
  const src = document.createElement("canvas"); src.width = W; src.height = H;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0, W, H);
  const px = sctx.getImageData(0, 0, W, H).data, N = W * H;

  // Alpha: real transparency if the image has it, otherwise key out a plain background.
  let transparent = 0;
  for (let i = 0; i < N; i++) if (px[i * 4 + 3] < 250) transparent++;
  const alpha = new Float32Array(N);
  if (transparent > N * 0.02) {
    for (let i = 0; i < N; i++) alpha[i] = px[i * 4 + 3] / 255;
  } else {
    const border: number[][] = [];
    for (let x = 0; x < W; x += 4) border.push(rgbAt(px, x, 0, W), rgbAt(px, x, H - 1, W));
    for (let y = 0; y < H; y += 4) border.push(rgbAt(px, 0, y, W), rgbAt(px, W - 1, y, W));
    const bg = [0, 1, 2].map(c => median(border.map(b => b[c])));
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]);
      alpha[i] = Math.min(1, Math.max(0, (d - 25) / 45));
    }
  }
  // Clean mask: light blur, threshold, fill holes. Inside of each leaf becomes solid.
  const soft = boxBlur(alpha, W, H, 2);
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = soft[i] > 0.35 ? 1 : 0;
  fillHoles(mask, W, H);

  // Connected leaves.
  const label = new Int32Array(N), comps: { area: number; idx: number[] }[] = [];
  const stack = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i] || label[i]) continue;
    const idx: number[] = []; let top = 0; stack[top++] = i; label[i] = comps.length + 1;
    while (top) {
      const j = stack[--top]; idx.push(j);
      const x = j % W, y = (j / W) | 0;
      const nb = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
      for (const k of nb) if (k >= 0 && mask[k] && !label[k]) { label[k] = comps.length + 1; stack[top++] = k; }
    }
    comps.push({ area: idx.length, idx });
  }
  const biggest = Math.max(0, ...comps.map(c => c.area));
  const keep = comps.map((c, n) => ({ ...c, n: n + 1 })).filter(c => c.area >= Math.max(250, biggest * 0.03));
  const med = median(keep.map(c => c.area)) || 1;

  return keep.map((comp, k) => {
    // Bounding box, centroid, tip (lowest point) and base (where the tip->centre line leaves the leaf).
    let x0 = W, y0 = H, x1 = 0, y1 = 0, cx = 0, cy = 0;
    for (const j of comp.idx) { const x = j % W, y = (j / W) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); cx += x; cy += y; }
    cx /= comp.area; cy /= comp.area;
    let tipX = 0, tipN = 0;
    for (const j of comp.idx) { const y = (j / W) | 0; if (y >= y1 - 2) { tipX += j % W; tipN++; } }
    const tip = [tipX / tipN, y1];
    const reach = Math.hypot(cx - tip[0], cy - tip[1]) || 1;
    const d = [(cx - tip[0]) / reach, (cy - tip[1]) / reach];
    let base = [cx, y0];
    for (let t = 0.5, inside = false; t < W + H; t += 0.5) {
      const qx = tip[0] + d[0] * t, qy = tip[1] + d[1] * t, X = Math.round(qx), Y = Math.round(qy);
      if (X < 0 || Y < 0 || X >= W || Y >= H) { base = [qx, qy]; break; }
      if (label[Y * W + X] === comp.n) inside = true;
      else if (inside && t > reach) { base = [qx - d[0] * 2, qy - d[1] * 2]; break; }
    }
    // The leaf alone, with solid inside and a 1 px soft rim, in a padded box.
    const pad = 4, bw = x1 - x0 + 1 + pad * 2, bh = y1 - y0 + 1 + pad * 2;
    const box = document.createElement("canvas"); box.width = bw; box.height = bh;
    const bctx = box.getContext("2d")!; const out = bctx.createImageData(bw, bh);
    let lumMax = 0; const lums: number[] = [];
    for (const j of comp.idx) { const l = lum(px, j); lums.push(l); }
    lumMax = percentile(lums, 0.95) || 1;
    let ar = 0, ag = 0, ab = 0;
    for (const j of comp.idx) { ar += px[j * 4]; ag += px[j * 4 + 1]; ab += px[j * 4 + 2]; }
    ar /= comp.area; ag /= comp.area; ab /= comp.area;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const sx = x + x0 - pad, sy = y + y0 - pad, o = (y * bw + x) * 4;
      let a = 0, j = -1;
      if (sx >= 0 && sy >= 0 && sx < W && sy < H) {
        j = sy * W + sx;
        if (label[j] === comp.n) a = 1;
        else if (neighbourOf(label, comp.n, sx, sy, W, H)) a = Math.min(1, soft[j] * 1.4);
      }
      if (keepColour) {
        const ok = j >= 0 && a > 0;
        out.data[o] = ok ? px[j * 4] : ar; out.data[o + 1] = ok ? px[j * 4 + 1] : ag; out.data[o + 2] = ok ? px[j * 4 + 2] : ab;
      } else {
        // Tinted later by a shade of green: keep only the painted light and dark as grey.
        const g = j >= 0 && a > 0 ? Math.round(255 * Math.min(1, 0.55 + 0.45 * lum(px, j) / lumMax)) : 255;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = g;
      }
      out.data[o + 3] = Math.round(a * 255);
    }
    bctx.putImageData(out, 0, 0);
    // Rotate so base -> tip is vertical with the tip up.
    const vx = tip[0] - base[0], vy = tip[1] - base[1];
    const theta = Math.atan2(vx, vy) + Math.PI;
    const diag = Math.ceil(Math.hypot(bw, bh)) + 4;
    const rot = document.createElement("canvas"); rot.width = diag; rot.height = diag;
    const rctx = rot.getContext("2d", { willReadFrequently: true })!;
    rctx.translate(diag / 2, diag / 2); rctx.rotate(theta); rctx.drawImage(box, -bw / 2, -bh / 2);
    const bxLocal = base[0] - x0 + pad - bw / 2, byLocal = base[1] - y0 + pad - bh / 2;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const baseRot = [bxLocal * cos - byLocal * sin + diag / 2, bxLocal * sin + byLocal * cos + diag / 2];
    // Crop to the visible leaf.
    const rd = rctx.getImageData(0, 0, diag, diag).data;
    let cx0 = diag, cy0 = diag, cx1 = 0, cy1 = 0;
    for (let y = 0; y < diag; y++) for (let x = 0; x < diag; x++) if (rd[(y * diag + x) * 4 + 3] > 8) {
      cx0 = Math.min(cx0, x); cx1 = Math.max(cx1, x); cy0 = Math.min(cy0, y); cy1 = Math.max(cy1, y);
    }
    const cw = cx1 - cx0 + 3, ch = cy1 - cy0 + 3;
    const leaf = document.createElement("canvas"); leaf.width = cw; leaf.height = ch;
    leaf.getContext("2d")!.drawImage(rot, cx0 - 1, cy0 - 1, cw, ch, 0, 0, cw, ch);
    const bu = (baseRot[0] - (cx0 - 1)) / cw, bv = 1 - (baseRot[1] - (cy0 - 1)) / ch;
    return {
      id: newId(), name: keep.length > 1 ? `${name} ${k + 1}` : name, image: leaf,
      aspect: cw / ch, baseUv: [clamp01(bu), clamp01(bv)] as [number, number],
      scale: Math.min(1.35, Math.max(0.55, Math.sqrt(comp.area / med))), keepColour,
      avgColour: keepColour ? `#${[ar, ag, ab].map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}` : undefined,
      thumb: makeThumb(leaf, keepColour),
    };
  });
}

/** Picker thumbnail: drawn tip-down like the art, tinted with the sheet green unless colours are kept. */
export function makeThumb(leaf: HTMLCanvasElement, keepColour: boolean): string {
  const S = 112, c = document.createElement("canvas"); c.width = c.height = S;
  const ctx = c.getContext("2d")!;
  const sc = Math.min((S - 8) / leaf.width, (S - 8) / leaf.height), w = leaf.width * sc, h = leaf.height * sc;
  ctx.translate(S / 2, S / 2); ctx.rotate(Math.PI); ctx.drawImage(leaf, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!keepColour) {
    ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = "#7aa744"; ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = "destination-in";
    ctx.translate(S / 2, S / 2); ctx.rotate(Math.PI); ctx.drawImage(leaf, -w / 2, -h / 2, w, h);
  }
  return c.toDataURL("image/png");
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const rgbAt = (px: Uint8ClampedArray, x: number, y: number, W: number) => { const o = (y * W + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
const lum = (px: Uint8ClampedArray, j: number) => 0.2126 * px[j * 4] + 0.7152 * px[j * 4 + 1] + 0.0722 * px[j * 4 + 2];
function median(a: number[]): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
function percentile(a: number[], p: number): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
function neighbourOf(label: Int32Array, n: number, x: number, y: number, W: number, H: number): boolean {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const X = x + dx, Y = y + dy;
    if (X >= 0 && Y >= 0 && X < W && Y < H && label[Y * W + X] === n) return true;
  }
  return false;
}
function boxBlur(a: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length), n = 2 * r + 1;
  for (let y = 0; y < H; y++) { let s = 0; for (let x = -r; x <= r; x++) s += a[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) { tmp[y * W + x] = s / n; s += a[y * W + Math.min(W - 1, x + r + 1)] - a[y * W + Math.max(0, x - r)]; } }
  for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) { out[y * W + x] = s / n; s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]; } }
  return out;
}
function fillHoles(mask: Uint8Array, W: number, H: number): void {
  // Flood the background from the border; anything not reached and not leaf is a hole.
  const seen = new Uint8Array(mask.length), stack: number[] = [];
  const push = (i: number) => { if (!mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) {
    const j = stack.pop()!, x = j % W, y = (j / W) | 0;
    if (x > 0) push(j - 1); if (x < W - 1) push(j + 1); if (y > 0) push(j - W); if (y < H - 1) push(j + W);
  }
  for (let i = 0; i < mask.length; i++) if (!mask[i] && !seen[i]) mask[i] = 1;
}
