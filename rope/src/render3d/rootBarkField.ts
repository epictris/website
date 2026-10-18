// The woody bark's RELIEF, as a field over the bark tile - the one description
// both the root mesh (which displaces its rings by it, rootMesh.ts) and the
// bark bake (which paints its colour and bakes its normal and occlusion maps
// from it, scripts/bake-root-bark.ts) read, so the bumps the silhouette shows
// are the bumps the shading shades.
//
// The tile is `u` once around the root and `v` once along `BARK_TILE` metres
// of it (rootMesh.ts), wrapping in both. A root's surface is VEINS: rounded
// ridges standing proud of the wood that travel down its length, each
// wandering a little around it, widening and narrowing, swelling and
// sinking, and now and then fading out altogether - which, beside a
// neighbour it has drifted against, is one vein merging into another. The
// valleys between them are where the shade is. Over that, a fine grain.
//
// Pigment is a separate and much quieter thing: one bark colour, a few
// percent either way, since the reference's tonal variation is its lighting
// and its surface, not the colour of the wood.
//
// Pure and deterministic (its own mulberry32 stream, seeded once), no three,
// no DOM: it runs in the bake, in the browser and in `roots:bake` alike, and
// changing anything here changes what is built from the same level data, so
// bump ROOT_MESH_VERSION (rootKey.ts) and re-bake the bark with it.

// Veins around the root.
const VEINS = 12;
// How far a vein wanders around the root (tile fraction, either way), its
// half-width range (never a thin one: the least is above the mesh's side),
// and the lattice (features per tile length) of each. A vein runs in
// stretches of around a tenth of the tile (`RUN_LATTICE`), present about
// half the time, so twelve of them at these widths cover about two thirds
// of the wrap in short overlapping lengths, with valleys between.
const WANDER = 0.1;
const HALF_WIDTH: [number, number] = [0.05, 0.12];
const ALONG_LATTICE = 5;
const RUN_LATTICE = 7;
// A vein's section, the exponent of its profile (1 - x²)^CREST: above 1 a
// bell whose foot lands on the wood gently, so it shades softly instead of
// drawing a hard dark line where the flank turns from the light (0.55, a
// flat crest with steep flanks, did that); 1.4 keeps the shoulders full
// enough for the vein to stand.
const CREST = 1.4;
// The section the mesh is displaced by, see `barkAt`.
const GEOMETRY_CREST = 1.4;
// The softness of the join where two veins overlap: a smooth maximum, wide
// enough that one riding over another makes one body, not a seam.
const SOFT = 0.1;
// Fine grain over everything, height units.
const GRAIN = 0.07;

export interface BarkSample {
  // Relief, 0..1: valley floor to vein crest, 0.5 the mean surface.
  height: number;
  // Which vein this point belongs to, or -1 in a valley, for a stroke that
  // must stay on one.
  patch: number;
  // Pigment about the one bark colour: 0.5 is it, a point a few percent off.
  tone: number;
  // How far down a valley, 0..1.
  gap: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap1 = (x: number): number => ((x % 1) + 1) % 1;
const wrapDelta = (d: number): number => {
  d = wrap1(d);
  return d > 0.5 ? d - 1 : d;
};

// Wrapped value noise on an n-point lattice over one tile length, 0..1.
function noise1(n: number, seed: number): (v: number) => number {
  const r = rng(seed);
  const lat = new Float32Array(n);
  for (let i = 0; i < n; i++) lat[i] = r();
  return (v) => {
    const f = wrap1(v) * n;
    const i0 = Math.floor(f) % n;
    const t = f - Math.floor(f);
    const w = t * t * (3 - 2 * t);
    return lat[i0]! * (1 - w) + lat[(i0 + 1) % n]! * w;
  };
}
// Wrapped value noise on an nx by ny lattice over the tile, 0..1.
function noise2(nx: number, ny: number, seed: number): (u: number, v: number) => number {
  const r = rng(seed);
  const lat = new Float32Array(nx * ny);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (u, v) => {
    const fx = wrap1(u) * nx;
    const fy = wrap1(v) * ny;
    const x0 = Math.floor(fx) % nx;
    const y0 = Math.floor(fy) % ny;
    const x1 = (x0 + 1) % nx;
    const y1 = (y0 + 1) % ny;
    const tx = smooth(fx - Math.floor(fx));
    const ty = smooth(fy - Math.floor(fy));
    const a = lat[y0 * nx + x0]! * (1 - tx) + lat[y0 * nx + x1]! * tx;
    const b = lat[y1 * nx + x0]! * (1 - tx) + lat[y1 * nx + x1]! * tx;
    return a * (1 - ty) + b * ty;
  };
}

interface Vein {
  centre: number;
  path: (v: number) => number;
  width: (v: number) => number;
  // How high this vein stands, 0..1: its own, the whole way along.
  swell: number;
  presence: (v: number) => number;
}
const veins: Vein[] = (() => {
  const rand = rng(0x2009);
  const out: Vein[] = [];
  for (let i = 0; i < VEINS; i++) {
    const seed = 1000 + i * 17;
    out.push({
      centre: (i + 0.25 + rand() * 0.5) / VEINS,
      path: noise1(ALONG_LATTICE, seed + 1),
      width: noise1(ALONG_LATTICE + 1, seed + 2),
      swell: rand(),
      presence: noise1(RUN_LATTICE, seed + 4),
    });
  }
  return out;
})();
const grainN = noise2(48, 96, 2001);
const toneN = noise2(6, 4, 2002);

// `geometry` asks for the field as the mesh displaces by it: the same veins
// with a rounder section and no grain, since a steep flank sampled every
// ring and side comes out as a scalloped silhouette, and the maps carry the
// steep flank and the grain at texel scale anyway.
export function barkAt(u: number, v: number, geometry = false): BarkSample {
  // Each vein's rounded profile at this point; a smooth maximum joins the
  // ones that overlap into one broader vein.
  let acc = 0, best = 0, patch = -1;
  for (let i = 0; i < veins.length; i++) {
    const vein = veins[i]!;
    const at = vein.centre + (vein.path(v) - 0.5) * 2 * WANDER;
    // The WIDTH wanders along the vein, mostly narrow with broad stretches
    // (the square keeps the range's top rare); its height holds, so its
    // crest runs level and the silhouette is a line, not a wiggle.
    // Present in stretches, and between them it subsides into the wood -
    // gradually, over most of a run, its width and height drawing down
    // together so the end is a long low spindle, never a wall (height alone
    // left a blunt end; a thin full-height point read as a scratch) - so
    // there is no place where a vein starts. The valley, or the neighbour
    // it has drifted against, takes over. The bell section (CREST) keeps a
    // subsiding vein from pocketing the surface around it.
    const presence = smoothstep(0.15, 0.85, vein.presence(v));
    if (presence <= 0) continue;
    const half = (HALF_WIDTH[0] + (HALF_WIDTH[1] - HALF_WIDTH[0]) * vein.width(v)) * Math.sqrt(presence);
    const height = (0.8 + 0.2 * vein.swell) * presence;
    const x = Math.abs(wrapDelta(u - at)) / half;
    if (x >= 1) continue;
    const profile = Math.pow(1 - x * x, geometry ? GEOMETRY_CREST : CREST) * height;
    acc += Math.exp(profile / SOFT);
    if (profile > best) { best = profile; patch = i; }
  }
  const ridge = acc > 0 ? Math.log(acc) * SOFT : 0;
  const grain = geometry ? 0 : (grainN(u, v) - 0.5) * GRAIN;
  const height = Math.min(1, Math.max(0, 0.08 + ridge * 0.85 + grain));
  return {
    height,
    patch: best > 0.3 ? patch : -1,
    tone: 0.5 + (toneN(u, v) - 0.5) * 0.12,
    gap: 1 - smoothstep(0.05, 0.4, height),
  };
}
