// The glow flora port (../glowflora.py) against the module it ports
// (glowshrooms.js, the Glowshroom Generator's own), on flat ground, where the
// port is the original. Grows the same patches both ways and compares every
// item field and every vertex attribute.
//
//   bun tools/blender/foliage/reference/parity.ts [--quick]
//
// The Python side is plain python3: glowflora.py needs no Blender.
import { generatePatch, buildItemGeometry, buildMoundGeometry } from "./glowshrooms.js";

type Case = Record<string, unknown> & { kind: string; seed: number };
const quick = process.argv.includes("--quick");
const CASES: Case[] = [
  { kind: "mushroom", seed: 42, count: 14, size: 0.55 },
  { kind: "grove", seed: 3, mushrooms: 10, lanterns: 3, ferns: 2, reeds: 2 },
  { kind: "fern", seed: 9, count: 3, fronds: 11, curl: 0.4 },
  { kind: "lantern", seed: 7 },
  { kind: "reed", seed: 5, count: 3 },
  ...(quick ? [] : [
    { kind: "mushroom", seed: 7 },
    { kind: "mushroom", seed: 102, count: 10, size: 0.7, palette: "moonlight" },
    { kind: "grove", seed: 7, palette: "toxic" },
    { kind: "grove", seed: 30, size: 0.7, palette: "ember" },
    { kind: "lantern", seed: 8, count: 4, size: 0.9 },
  ]),
];

interface Geo { p: number[]; c: number[]; g: number[]; gi: number[]; s: number[]; i: number[] }

function jsSide(c: Case) {
  const t0 = performance.now();
  const patch = generatePatch(c);
  const ms = performance.now() - t0;
  const geos = patch.items.map((it: unknown) => buildItemGeometry(it, 0));
  if (patch.mound) geos.push(buildMoundGeometry(patch.mound, 0));
  const geo: Geo = { p: [], c: [], g: [], gi: [], s: [], i: [] };
  for (const g of geos) {
    const base = geo.p.length / 3;
    geo.p.push(...g.getAttribute("position").array);
    geo.c.push(...g.getAttribute("color").array);
    geo.g.push(...g.getAttribute("aGlow").array);
    geo.gi.push(...g.getAttribute("aGill").array);
    geo.s.push(...g.getAttribute("aSway").array);
    for (const k of g.index!.array) geo.i.push(k + base);
  }
  const { collisions: _c, ...params } = patch.params;
  return { patch: { ...patch, params }, geo, ms };
}

const PY = `
import importlib.util, json, sys, time
spec = importlib.util.spec_from_file_location("glowflora", sys.argv[1])
gf = importlib.util.module_from_spec(spec); spec.loader.exec_module(gf)
out = []
for c in json.loads(sys.stdin.read()):
    t0 = time.perf_counter()
    patch = gf.generate_patch(c)
    ms = (time.perf_counter() - t0) * 1000
    b, _ranges = gf.build(patch, 0)
    flat = lambda rows: [x for r in rows for x in r]
    out.append({"patch": json.loads(gf.to_json(patch)), "solve": patch["solve"], "ms": ms,
                "geo": {"p": flat(b.p), "c": flat(b.c), "g": flat(b.g), "gi": flat(b.gi), "s": flat(b.s), "i": flat(b.i)}})
print(json.dumps(out))
`;

const py = Bun.spawnSync(["python3", "-c", PY, new URL("../glowflora.py", import.meta.url).pathname], {
  stdin: new TextEncoder().encode(JSON.stringify(CASES)),
});
if (py.exitCode !== 0) {
  console.error(new TextDecoder().decode(py.stderr));
  process.exit(1);
}
const pyOut = JSON.parse(new TextDecoder().decode(py.stdout));

let failed = 0;
function compareValue(path: string, a: unknown, b: unknown, tol: number, diffs: string[]) {
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > tol) diffs.push(`${path}: js ${a} py ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) diffs.push(`${path}: length js ${a.length} py ${b.length}`);
    else a.forEach((x, k) => compareValue(`${path}[${k}]`, x, b[k], tol, diffs));
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) compareValue(`${path}.${k}`, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol, diffs);
  } else if (a !== b) diffs.push(`${path}: js ${JSON.stringify(a)} py ${JSON.stringify(b)}`);
}

function maxDiff(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k] - b[k]));
  return m;
}

CASES.forEach((c, n) => {
  const js = jsSide(c);
  const p = pyOut[n];
  const diffs: string[] = [];
  compareValue("patch", js.patch, p.patch, 1e-9, diffs);
  const label = JSON.stringify(c);
  const geoDiffs = (["p", "c", "g", "gi", "s"] as const).map((k) => [k, maxDiff(js.geo[k], p.geo[k])] as const);
  const indexSame = js.geo.i.length === p.geo.i.length && js.geo.i.every((v, k) => v === p.geo.i[k]);
  // Positions are float32 on the three side; colours too.
  const geoOk = indexSame && geoDiffs.every(([, d]) => d < 2e-6);
  const ok = diffs.length === 0 && geoOk;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${p.patch.items.length} items, ${js.geo.p.length / 3} verts, ` +
    `js ${js.ms.toFixed(0)} ms, py ${p.ms.toFixed(0)} ms, remaining ${p.solve.remaining}, ` +
    `max diff ${geoDiffs.map(([k, d]) => `${k} ${d.toExponential(1)}`).join(" ")}${indexSame ? "" : " INDEX DIFFERS"}`);
  for (const d of diffs.slice(0, 8)) console.log(`     ${d}`);
  if (diffs.length > 8) console.log(`     ... ${diffs.length - 8} more`);
});
process.exit(failed ? 1 : 0);
