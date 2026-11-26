// `cli nodes`: the node tree's proof (plans/node-tree.md "Bit-identity: the sim
// never sees the tree").
//
// The tree is the authored form, and the sim keeps reading the flat form
// `compileLevel` produces. Every level reaches the sim as
// `compileLevel(migrateToTree(normalizeFlat(L)))` whatever it was written in,
// so the one thing to prove is that this round trip hands the sim exactly
// what `normalizeFlat` alone used to:
//
//   compileLevel(migrateToTree(F)) deep-equals F, for F = normalizeFlat(L)
//
// over every level file and every bundle in the regression corpus. "Exactly"
// is `Object.is` on every number, so a -0 that became a 0 is a failure. What
// is compared exactly is everything the sim reads: the player, every body
// that builds (in build order, with every field and every object in order),
// the chains, the vines, the checkpoints and the camera's volumes and paths.
// Bodies that build nothing are not the sim's: they are rocks, lamps and
// anchors with nothing to ride, which migration lifts out of the body list
// (a lone rock becomes a top-level `Formation3D`) and compilation gathers
// back in after every body that builds. For those the case checks that the
// same things are drawn in the same place - the same formations, objects and
// decorations, each world placement within a micrometre in file units.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { collides, flatLevelOf, isMover, LEVEL_FORMAT, normalizeFlat, scaleNormalized, type AnchorObjectData, type CollisionObjectData, type LevelBodyData, type LevelData, type LevelSource, type RawLevelData } from "../level/levelFormat";
import { compileLevel, compose3D, FOG_EVERYWHERE_SIZE, formationDataOf, frameOf, isLevelTree, lookNodes, migrateToTree, scaleLevelTree, TREE_FORMAT, upgradeTree, validateTree, walkNodes, type LevelNode, type LevelTree, type PrefabLibrary } from "../level/nodes";
import { LEVELS } from "../level/registry";

export interface NodeCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Strict structural equality: `Object.is` on leaves, key sets equal with
// `undefined` values treated as absent. Returns the first difference's path.
export function firstDifference(a: unknown, b: unknown, path = "", tol = 0): string | null {
  if (Object.is(a, b)) return null;
  if (tol > 0 && typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol * Math.max(1, Math.abs(a))) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return `${path || "(root)"}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`, tol);
      if (d) return d;
    }
    return null;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    if (ra[k] === undefined && rb[k] === undefined) continue;
    if (!(k in ra) || ra[k] === undefined) return `${path}.${k}: absent != ${JSON.stringify(rb[k])?.slice(0, 80)}`;
    if (!(k in rb) || rb[k] === undefined) return `${path}.${k}: ${JSON.stringify(ra[k])?.slice(0, 80)} != absent`;
    const d = firstDifference(ra[k], rb[k], `${path}.${k}`, tol);
    if (d) return d;
  }
  return null;
}

// The look: a rock, what grows on it, a model, a lamp. Never the sim's; a flat
// level carried it in its bodies, and the compile leaves it in the tree.
const LOOK_OBJECTS: ReadonlySet<string> = new Set(["light", "model", "decoration"]);

// What the sim reads of a level, for an exact comparison: the bodies that
// build, without the look. A body's `name` is a label (and migration may
// suffix it to keep siblings apart), so it is not part of it; neither is the
// format stamp.
function simView(d: LevelData): unknown {
  const { bodies, format: _f, tree: _t, ...rest } = fogView(d);
  return {
    ...rest,
    bodies: bodies.filter(collides).map(({ name: _n, node: _node, formation: _rock, ...b }) => ({
      ...b,
      objects: b.objects.filter((o) => !LOOK_OBJECTS.has(o.type)).map((o) => {
        const { node: _o, ...rest } = o;
        return rest;
      }),
    })),
  };
}

// THE FOG AS IT IS DRAWN, not as it is written. The sim reads no fog; the
// renderer reads each region's amount and colour, falling back to the
// environment block's (`FogRegionData`). The flat form wrote one fog for
// every region in that block, or fog everywhere with no regions at all; a
// format-4 tree writes it on its regions and the "everywhere" as one region
// over everything (`upgradeTree`). So both sides are compared as the regions'
// effective fog, the environment block without its fog, and no region set
// where nothing is fogged: what the renderer would draw, exactly.
function fogView(d: LevelData): LevelData {
  const { fogAmount, fogColor, ...env } = d.environment ?? {};
  const regions =
    d.fogRegions ??
    ((fogAmount ?? 0) > 0
      ? [{ x: 0, y: 0, rot: 0, shape: { kind: "rect" as const, w: FOG_EVERYWHERE_SIZE, h: FOG_EVERYWHERE_SIZE }, falloff: 0 }]
      : []);
  const drawn = regions.map((r) => {
    const amount = r.amount ?? fogAmount;
    const color = r.color ?? fogColor;
    return { ...r, ...(amount !== undefined ? { amount } : {}), ...(color !== undefined ? { color } : {}) };
  });
  const { environment: _e, fogRegions: _f, ...rest } = d;
  return {
    ...rest,
    ...(Object.keys(env).length ? { environment: env } : {}),
    ...(drawn.some((r) => (r.amount ?? 0) > 0) ? { fogRegions: drawn } : {}),
  };
}

// JSON with every object's keys sorted, so key order is not a difference.
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x,
  );
}

type Drawn = { key: string; x: number; y: number; z: number };

// What a drawn thing is, for comparing a flat level's look with a tree's:
// every field but its placement and the references whose spelling the tree
// changes (a guide's `subset` and a lamp's `path` name nodes there, indices
// here, and are proved by the editor's own round trips).
function lookKey(type: string, fields: Record<string, unknown>): string {
  const { x: _x, y: _y, rot: _r, node: _nd, path: _p, ...rest } = fields;
  const guide = rest["guide"] as { subset?: unknown } | undefined;
  if (guide?.subset !== undefined) rest["guide"] = (({ subset: _s, ...g }) => g)(guide);
  return `${type} ${canonical(rest)}`;
}
const byKey = (p: Drawn, q: Drawn): number => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0);

// A flat level's look, from its bodies: each rock, lamp, model and decoration,
// at its world placement. The full frame, a 3D body's depth and tilt
// included, so a rock that migration lifted out of a tilted body is checked
// where it is drawn. A decoration stands on its rock and is checked by what
// it is.
function flatLook(bodies: readonly LevelBodyData[]): Drawn[] {
  const out: Drawn[] = [];
  for (const b of bodies) {
    const frame = frameOf({ x: b.x, y: b.y, rot: b.rot, ...(b.space === "3d" ? { z: b.z, tilt: b.tilt } : {}) });
    const place = (o: { x?: number; y?: number }): { x: number; y: number; z: number } => {
      const t = compose3D(frame, frameOf({ x: o.x, y: o.y })).t;
      return { x: t[0], y: t[1], z: t[2] };
    };
    if (b.formation) out.push({ key: lookKey("formation", b.formation as unknown as Record<string, unknown>), ...place(b.formation) });
    for (const o of b.objects) {
      if (!LOOK_OBJECTS.has(o.type)) continue;
      const placed = o.type === "decoration" ? { x: 0, y: 0, z: 0 } : place(o as { x?: number; y?: number });
      out.push({ key: lookKey(o.type, o as unknown as Record<string, unknown>), ...placed });
    }
  }
  return out.sort(byKey);
}

// ...and the same of a tree, from its nodes (`lookNodes`).
function treeLook(nodes: readonly LevelNode[]): Drawn[] {
  const out: Drawn[] = [];
  for (const { node: n, world, formation } of lookNodes(nodes)) {
    const at = { x: world.t[0], y: world.t[1], z: world.t[2] };
    if (n.type === "Formation3D") {
      out.push({ key: lookKey("formation", formationDataOf(n) as unknown as Record<string, unknown>), ...at });
      continue;
    }
    const { type: _t, id, name: _n, children: _c, grouped: _g, layers: _l, disabled: _d, ...fields } = n;
    if (n.type === "Decoration3D") out.push({ key: lookKey("decoration", { type: "decoration", id, formation: formation ?? "", ...fields }), x: 0, y: 0, z: 0 });
    else out.push({ key: lookKey(n.type === "Light3D" ? "light" : "model", { type: n.type === "Light3D" ? "light" : "model", ...fields }), ...at });
  }
  return out.sort(byKey);
}

export function roundTrip(raw: RawLevelData): { pass: boolean; detail: string; tree: LevelTree } {
  const flat = normalizeFlat(raw);
  const tree = migrateToTree(flat, { isMover });
  const compiled = compileLevel(tree);
  const exact = firstDifference(simView(flat), simView(compiled.data));
  if (exact) return { pass: false, detail: `sim view differs at ${exact}`, tree };
  // The look is not the sim's: it is in the tree, each thing where the flat
  // level drew it.
  const want = flatLook(flat.bodies);
  const got = treeLook(compiled.nodes);
  if (want.length !== got.length) return { pass: false, detail: `drawn: ${want.length} things became ${got.length}`, tree };
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.key !== g.key) return { pass: false, detail: `drawn: ${w.key.slice(0, 120)} became ${g.key.slice(0, 120)}`, tree };
    const off = Math.hypot(w.x - g.x, w.y - g.y, w.z - g.z);
    if (!(off <= 1e-6 * Math.max(1, Math.hypot(w.x, w.y, w.z)))) return { pass: false, detail: `drawn: ${w.key.slice(0, 80)} moved ${off}`, tree };
  }
  const built = flat.bodies.filter(collides).length;
  return { pass: true, detail: `${built} bodies build, ${flat.bodies.length - built} drawn only, ${compiled.problems.length} notes`, tree };
}

function readJson(path: string): unknown {
  const raw = readFileSync(path);
  return JSON.parse(path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
}

export function runNodeCases(filter?: string): NodeCaseResult[] {
  // A source already a tree (every level file since the conversion) is
  // flattened through its compile first: what is proved is then that the
  // flat form it compiles to migrates back losslessly, which is what the
  // editor's reading of any older bundle or file relies on.
  const sources: { name: string; raw: LevelSource }[] = [];
  for (const [id, spec] of Object.entries(LEVELS)) sources.push({ name: `level ${id}`, raw: spec.data });
  const levelsDir = join(ROOT, "levels");
  for (const f of readdirSync(levelsDir).sort()) {
    if (!f.endsWith(".json")) continue;
    sources.push({ name: `file levels/${f}`, raw: readJson(join(levelsDir, f)) as LevelSource });
  }
  for (const dir of ["playtests/regressions"]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs).sort()) {
      if (!f.endsWith(".json") && !f.endsWith(".json.gz")) continue;
      const bundle = readJson(join(abs, f)) as { data?: RawLevelData };
      if (bundle.data) sources.push({ name: `bundle ${dir}/${f}`, raw: bundle.data });
    }
  }
  const results: NodeCaseResult[] = [];
  for (const s of sources) {
    if (filter && !s.name.includes(filter)) continue;
    try {
      const r = roundTrip(flatLevelOf(s.raw));
      results.push({ name: `round trip ${s.name}`, pass: r.pass, detail: r.detail });
    } catch (e) {
      results.push({ name: `round trip ${s.name}`, pass: false, detail: `threw ${(e as Error).stack?.split("\n").slice(0, 3).join(" | ")}` });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// What a tree compiles to
// ---------------------------------------------------------------------------

const SPAWN = { type: "Spawn2D", id: "spawn", name: "Spawn", x: 0, y: 0, radius: 15 } as const;
const rect = (id: string, x = 0, y = 0, extra: Record<string, unknown> = {}): LevelNode =>
  ({ type: "CollisionShape2D", id, name: id, x, y, shape: { kind: "rect", w: 10, h: 10 }, ...extra }) as LevelNode;

function tree(nodes: LevelNode[]): LevelTree {
  return { format: TREE_FORMAT, nodes: [SPAWN as LevelNode, ...nodes] };
}

function near(a: number | undefined, b: number): boolean {
  return Math.abs((a ?? 0) - b) <= 1e-9;
}

export function runNodeTreeCases(): NodeCaseResult[] {
  const out: NodeCaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string): void => void out.push({ name, pass, detail });

  // A plain Node2D between a body and its shapes is a frame, nothing more: the
  // shape compiles into the body's frame through it.
  {
    const t = tree([
      {
        type: "StaticBody2D", id: "b", name: "B", order: 0, x: 100, y: 0, rot: Math.PI / 2,
        children: [{ type: "Node2D", id: "g", name: "G", x: 10, y: 0, rot: 0, children: [rect("s", 5, 0)] }],
      } as LevelNode,
    ]);
    const body = compileLevel(t, {}).data.bodies[0]!;
    const s = body.objects[0] as CollisionObjectData;
    check("group-frame", body.x === 100 && near(s.x, 15) && near(s.y, 0), `body at ${body.x}, shape at ${s.x}, ${s.y} in its frame (want 15, 0)`);
  }

  // THE LEVEL'S LIGHT (format 4, docs/level-format.md "The level's light").
  {
    // A format-3 tree's environment block becomes a Sun, an Environment and a
    // background, its fog the regions' own; compiled, it is the block it was
    // (but for the fog, now on the region), and upgrading twice is upgrading once.
    const env = { sunIntensity: 6.5, sunX: 0.5, skyColor: "#7ab8e0", envIntensity: 0.55, backgroundColor: "#1c3856", fogAmount: 0.52, fogColor: "#2a5075" };
    const region = { type: "FogRegion2D", id: "fog", name: "Fog", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 100, h: 100 } } as LevelNode;
    const old: LevelTree = { format: 3, environment: env, fogMasked: true, nodes: [SPAWN as LevelNode, region] };
    const up = upgradeTree(old);
    const sun = up.nodes.find((n) => n.type === "Sun") as Record<string, unknown> | undefined;
    const sky = up.nodes.find((n) => n.type === "Environment") as Record<string, unknown> | undefined;
    const fog = up.nodes.find((n) => n.type === "FogRegion2D") as Record<string, unknown> | undefined;
    check(
      "light-upgrade",
      up.format === TREE_FORMAT && up.environment === undefined && up.fogMasked === undefined && up.background === "#1c3856" &&
        sun?.["sunIntensity"] === 6.5 && sun?.["sunX"] === 0.5 && sun?.["skyColor"] === undefined &&
        sky?.["skyColor"] === "#7ab8e0" && sky?.["envIntensity"] === 0.55 && sky?.["sunIntensity"] === undefined &&
        fog?.["amount"] === 0.52 && fog?.["color"] === "#2a5075",
      JSON.stringify({ background: up.background, sun, sky, fog }),
    );
    const again = upgradeTree(up);
    check("light-upgrade-once", again === up && upgradeTree(old).nodes.map((n) => n.id).join() === up.nodes.map((n) => n.id).join(), "a format-4 tree is left as it is, and a format-3 one upgrades to the same ids every time");
    const compiled = compileLevel(old, {}).data;
    const { fogAmount: _a, fogColor: _c, ...unfogged } = env;
    const envDiff = firstDifference(compiled.environment, unfogged);
    check("light-compile", envDiff === null && compiled.fogRegions?.[0]?.amount === 0.52, envDiff ?? "the environment block as it was, the fog on its region");
    // No Sun node is no sun; no Environment node is the default sky.
    const sunless = compileLevel({ format: TREE_FORMAT, nodes: [SPAWN as LevelNode, { type: "Environment", id: "e", name: "Environment" } as LevelNode] }, {}).data;
    const lit = compileLevel({ format: TREE_FORMAT, nodes: [SPAWN as LevelNode, { type: "Sun", id: "s", name: "Sun" } as LevelNode] }, {}).data;
    check("light-no-sun", sunless.environment?.sunIntensity === 0 && lit.environment === undefined, `sunless ${JSON.stringify(sunless.environment)}, a bare Sun ${JSON.stringify(lit.environment)}`);
    // Fog everywhere (format 3 with no region and no mask) is one region over
    // everything; a level with no region has no fog.
    const everywhere = compileLevel({ format: 3, environment: { fogAmount: 0.3 }, nodes: [SPAWN as LevelNode] }, {}).data;
    const big = everywhere.fogRegions?.[0];
    check(
      "light-fog-everywhere",
      everywhere.fogRegions?.length === 1 && big?.amount === 0.3 && big.shape.kind === "rect" && big.shape.w === FOG_EVERYWHERE_SIZE && everywhere.environment?.fogAmount === undefined,
      JSON.stringify(everywhere.fogRegions),
    );
    const clear = compileLevel({ format: 3, environment: { fogAmount: 0.3 }, fogMasked: true, nodes: [SPAWN as LevelNode] }, {}).data;
    check("light-fog-none", clear.fogRegions === undefined && clear.environment === undefined, JSON.stringify({ fogRegions: clear.fogRegions, environment: clear.environment }));
    // One of each, at the top or in a folder, holding nothing; never in a prefab.
    const two = validateTree([SPAWN as LevelNode, { type: "Sun", id: "s1", name: "Sun" } as LevelNode, { type: "Sun", id: "s2", name: "Sun2" } as LevelNode], { prefabs: {} });
    const nested = validateTree([SPAWN as LevelNode, { type: "Node2D", id: "g", name: "G", children: [{ type: "Environment", id: "e", name: "Environment" } as LevelNode] } as LevelNode], { prefabs: {} });
    const foldered = validateTree([SPAWN as LevelNode, { type: "Node", id: "f", name: "F", children: [{ type: "Sun", id: "s", name: "Sun" } as LevelNode] } as LevelNode], { prefabs: {} });
    const inPrefab = validateTree([{ type: "Sun", id: "s", name: "Sun" } as LevelNode], { prefabs: {}, prefab: true });
    check(
      "light-refused",
      two.some((p) => p.error && p.message.includes("second Sun")) && nested.some((p) => p.error && p.message.includes("Environment")) &&
        !foldered.some((p) => p.error) && inPrefab.some((p) => p.error && p.message.includes("prefab")),
      [...two, ...nested, ...foldered, ...inPrefab].map((p) => p.message).join("; "),
    );
  }

  // FIREFLIES, removed 2026-11-26: a swarm's light and every firefly path go
  // at load, a stale `path` on another light is dropped, and nothing the sim
  // reads changes; a tree that holds none is left as it is.
  {
    const lamp = { type: "Light3D", id: "lamp", name: "Lamp", intensity: 3, path: "fp" } as unknown as LevelNode;
    const swarm = { type: "Light3D", id: "swarm", name: "Swarm", fireflies: 12, wake: 250 } as unknown as LevelNode;
    const path = { type: "FireflyPath2D", id: "fp", name: "FireflyPath", x: 0, y: 0, rot: 0, verts: [{ x: 0, y: 0 }, { x: 100, y: 0 }] } as unknown as LevelNode;
    const holder = { type: "Node2D", id: "h", name: "H", children: [swarm, lamp] } as LevelNode;
    const before = tree([holder, path]);
    const after = upgradeTree(before);
    const ids: string[] = [];
    walkNodes(after.nodes, (n) => void ids.push(n.id));
    const kept = after.nodes.find((n) => n.id === "h")?.children?.[0] as Record<string, unknown> | undefined;
    check(
      "fireflies-dropped",
      !ids.includes("swarm") && !ids.includes("fp") && ids.includes("lamp") && kept?.["path"] === undefined && kept?.["intensity"] === 3,
      `left ${ids.join(", ")}; the lamp ${JSON.stringify(kept)}`,
    );
    const clean = tree([{ type: "Node2D", id: "g", name: "G" } as LevelNode]);
    check("fireflies-none", upgradeTree(clean).nodes === upgradeTree(upgradeTree(clean)).nodes, "a tree with no fireflies upgrades to itself");
  }

  // Build order is the `order` key, not tree order: grouping two bodies under
  // a Node2D, or swapping siblings, changes nothing the sim sees.
  {
    const a = { type: "StaticBody2D", id: "a", name: "A", order: 0, children: [rect("sa")] } as LevelNode;
    const b = { type: "StaticBody2D", id: "b", name: "B", order: 1, x: 50, children: [rect("sb")] } as LevelNode;
    const flat = compileLevel(tree([a, b]), {}).data;
    const swapped = compileLevel(tree([{ type: "Node2D", id: "g", name: "G", children: [b, a] } as LevelNode]), {}).data;
    const diff = firstDifference(simView(flat), simView(swapped));
    check("build-order", diff === null, diff ?? "same bodies in the same order");
  }

  // A prefab placed twice: ids prefixed, overrides by id, scale on geometry,
  // build order keys leading with the instance's.
  {
    const prefabs: PrefabLibrary = {
      lamp: {
        format: TREE_FORMAT,
        root: {
          type: "StaticBody2D", id: "body", name: "Lamp", order: 0, x: 999,
          children: [rect("shade", 0, -10), { type: "Anchor2D", id: "hook", name: "Hook", y: 20 } as LevelNode],
        } as LevelNode,
      },
    };
    const level = tree([
      { type: "StaticBody2D", id: "floor", name: "Floor", order: 1, children: [rect("f")] } as LevelNode,
      { type: "Instance", id: "i1", name: "Lamp", prefab: "lamp", order: 0, x: 100, y: 0 } as LevelNode,
      { type: "Instance", id: "i2", name: "Lamp2", prefab: "lamp", order: 2, x: 200, y: 0, scale: 2, overrides: { shade: { friction: 0.5 } } } as LevelNode,
      { type: "Chain", id: "c", name: "Chain", order: 0, a: "i1/hook", b: "i2/hook" } as LevelNode,
    ]);
    const compiled = compileLevel(level, prefabs);
    const d = compiled.data;
    const order = compiled.bodyNodes.join(",");
    const second = d.bodies[2]!;
    const shade2 = second.objects[0] as CollisionObjectData;
    const hooks = d.bodies.flatMap((b) => b.objects.filter((o) => o.type === "anchor")) as AnchorObjectData[];
    const chain = d.chains?.[0];
    check("instance-order", order === "i1,floor,i2", `bodies from ${order} (want i1,floor,i2)`);
    check(
      "instance-pose-scale",
      d.bodies[0]!.x === 100 && second.x === 200 && shade2.shape.kind === "rect" && shade2.shape.w === 20 && near(shade2.y, -20),
      `instance at ${d.bodies[0]!.x} and ${second.x}; scaled shade ${JSON.stringify(shade2.shape)} at y ${shade2.y}`,
    );
    check("instance-override", (shade2 as CollisionObjectData & { friction?: number }).friction === 0.5 && (d.bodies[0]!.objects[0] as { friction?: number }).friction === undefined, "the override reaches one instance only");
    check(
      "instance-chain",
      chain !== undefined && hooks.length === 2 && chain.a === hooks[0]!.id && chain.b === hooks[1]!.id && hooks[0]!.id !== hooks[1]!.id,
      `chain ${JSON.stringify(chain)} between anchors ${hooks.map((h) => h.id).join(", ")}`,
    );
    // A tree read in metres places its prefabs in metres: the prefab files
    // are pixels, as level files are, and `lengthScale` is what says which
    // the tree is in (the editor read every prefab at 100x without it).
    const inMetres = compileLevel(scaleLevelTree(level, 1 / 100, prefabs), prefabs).data;
    const scaledAfter = scaleNormalized(d, 1 / 100);
    const metresDiff = firstDifference(simView(scaledAfter), simView(inMetres), "", 1e-12);
    check("instance-scale-commutes", metresDiff === null, metresDiff ?? "compile(scale(tree with instances)) = scale(compile(tree))");
    check("format-one-line", LEVEL_FORMAT === TREE_FORMAT, `flat ${LEVEL_FORMAT}, tree ${TREE_FORMAT}: one revision line for both forms`);
    const self: PrefabLibrary = { loop: { format: TREE_FORMAT, root: { type: "Instance", id: "x", name: "X", prefab: "loop", order: 0 } as LevelNode } };
    const refused = validateTree(tree([{ type: "Instance", id: "i", name: "I", prefab: "loop", order: 0 } as LevelNode]).nodes, { prefabs: self });
    check("prefab-self", refused.some((p) => p.error && p.message.includes("instances itself")), refused.map((p) => p.message).join("; "));
    // A prefab's rock is re-made only in the prefab: an instance overriding its
    // recipe is refused, and compiles with the prefab's recipe regardless.
    const rocky: PrefabLibrary = {
      rock: {
        format: TREE_FORMAT,
        root: { type: "Formation3D", id: "r", name: "Rock", generator: "solid", params: { seed: 1 }, guide: { kind: "solid", tree: { prim: "box", size: [100, 100, 100] } } } as LevelNode,
      },
    };
    const remade = tree([{ type: "Instance", id: "i", name: "I", prefab: "rock", order: 0, overrides: { r: { params: { seed: 2 } } } } as LevelNode]);
    const remadeProblems = validateTree(remade.nodes, { prefabs: rocky });
    const remadeRock = lookNodes(compileLevel(remade, rocky).nodes).find((p) => p.node.type === "Formation3D")?.node as { params?: unknown } | undefined;
    check(
      "prefab-rock-recipe",
      remadeProblems.some((p) => p.error && p.message.includes("prefab's alone")) && (remadeRock?.params as { seed?: number } | undefined)?.seed === 1,
      `${remadeProblems.map((p) => p.message).join("; ")}; compiled seed ${JSON.stringify(remadeRock?.params)}`,
    );
    // An override of a node the prefab has since lost is kept and warned of,
    // not refused: the author drops it in the editor.
    const orphaned = validateTree(tree([{ type: "Instance", id: "i", name: "I", prefab: "rock", order: 0, overrides: { gone: { name: "X" } } } as LevelNode]).nodes, { prefabs: rocky });
    check("prefab-orphan-warns", orphaned.length > 0 && orphaned.every((p) => !p.error), orphaned.map((p) => `${p.error ? "error" : "warning"}: ${p.message}`).join("; "));
  }

  // Every refused state is refused.
  {
    const refuses = (name: string, nodes: LevelNode[], words: string): void => {
      const problems = validateTree(tree(nodes).nodes, { prefabs: {} });
      check(`refuses ${name}`, problems.some((p) => p.error && p.message.includes(words)), problems.map((p) => p.message).join("; ") || "nothing refused");
    };
    refuses("shape-without-body", [rect("s")], "no body above it");
    refuses("2d-under-3d", [{ type: "Node3D", id: "n", name: "N", children: [{ type: "Node2D", id: "m", name: "M" }] } as LevelNode], "under a 3D node");
    refuses("body-under-rigid", [{ type: "RigidBody2D", id: "r", name: "R", order: 0, children: [rect("s"), { type: "StaticBody2D", id: "b", name: "B", order: 1, children: [rect("t")] }] } as LevelNode], "moves or can vanish");
    refuses("body-under-breakable", [{ type: "StaticBody2D", id: "r", name: "R", order: 0, breakForce: 5, children: [rect("s"), { type: "StaticBody2D", id: "b", name: "B", order: 1, children: [rect("t")] }] } as LevelNode], "moves or can vanish");
    refuses("decoration-off-rock", [{ type: "Node3D", id: "n", name: "N", children: [{ type: "Decoration3D", id: "d", name: "D", kind: "fern", anchor: { p: [0, 0, 0], n: [0, 0, 1] } }] } as LevelNode], "not a Formation3D");
    refuses("anchor-on-area", [{ type: "Area2D", id: "k", name: "K", order: 0, area: "killzone", children: [rect("s"), { type: "Anchor2D", id: "a", name: "A" }] } as LevelNode], "anchor on an area");
    refuses("camera-on-mover", [{ type: "AnimatableBody2D", id: "m", name: "M", order: 0, children: [rect("s"), { type: "CameraRegion2D", id: "c", name: "C", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 1, h: 1 } }] } as LevelNode], "sits under something that moves");
    refuses("dangling-chain", [{ type: "Chain", id: "c", name: "C", order: 0, a: "nope", b: "nada" } as LevelNode], "not in the level");
    refuses("sibling-names", [{ type: "Node2D", id: "a", name: "Same" }, { type: "Node2D", id: "b", name: "Same" }] as LevelNode[], "two siblings");
    const none = validateTree([], { prefabs: {} });
    check("refuses no-spawn", none.some((p) => p.error && p.message.includes("exactly one")), none.map((p) => p.message).join("; "));
    const allowed = validateTree(
      tree([{ type: "StaticBody2D", id: "s", name: "S", order: 0, children: [rect("p"), { type: "RigidBody2D", id: "r", name: "R", order: 1, children: [rect("q"), { type: "Light3D", id: "l", name: "L" }] }] } as LevelNode]).nodes,
      { prefabs: {} },
    );
    check("allows body-under-static", !allowed.some((p) => p.error), allowed.map((p) => p.message).join("; ") || "nothing refused");
  }

  // Every level migrates into a tree its own rules accept, and converting
  // the tree's units commutes with compiling it: what the editor and the
  // renderer read in metres is what the sim builds in metres. And back: a
  // tree through metres and back to pixels compiles to what it did.
  for (const [id, spec] of Object.entries(LEVELS)) {
    // A level file is a tree already; the hand-written sandboxes are flat.
    const t = isLevelTree(spec.data) ? spec.data : migrateToTree(normalizeFlat(spec.data as RawLevelData), { isMover });
    const errors = validateTree(t.nodes).filter((p) => p.error);
    check(`valid ${id}`, errors.length === 0, errors.slice(0, 3).map((p) => p.message).join("; ") || "no refused state");
    const metres = scaleLevelTree(t, 1 / 100);
    const viaTree = compileLevel(metres).data;
    const viaFlat = scaleNormalized(compileLevel(t).data, 1 / 100);
    const commute = firstDifference(simView(viaFlat), simView(viaTree));
    check(`scale-commutes ${id}`, commute === null, commute ?? "compile(scale(tree)) = scale(compile(tree))");
    const back = scaleLevelTree(metres, 100);
    // Through metres and back rounds, as the editor's save always has: equal
    // to a part in 1e12.
    // Both sides through the conversion's own folds (a retired field it rewrites).
    const there = firstDifference(simView(scaleNormalized(compileLevel(t).data, 1)), simView(scaleNormalized(compileLevel(back).data, 1)), "", 1e-12);
    check(`scale-returns ${id}`, there === null, there ?? "px -> m -> px compiles to the same level, to 1e-12");
  }
  return out;
}
