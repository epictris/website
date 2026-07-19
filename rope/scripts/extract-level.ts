// One-off: extract collision geometry from a Godot .tscn into a TS level module.
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(process.argv[2]!, "utf8");
const outPath = process.argv[3]!;

interface Section {
  header: string;
  props: Record<string, string>;
}

// Split into [section]\n prop=... blocks.
const sections: Section[] = [];
let cur: Section | null = null;
for (const raw of src.split("\n")) {
  const line = raw.trimEnd();
  if (line.startsWith("[")) {
    cur = { header: line, props: {} };
    sections.push(cur);
  } else if (cur && line.includes("=")) {
    const i = line.indexOf("=");
    cur.props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

function attr(header: string, key: string): string | null {
  const m = header.match(new RegExp(`${key}="([^"]*)"`));
  return m ? m[1]! : null;
}
function vec2(v: string | undefined): [number, number] {
  if (!v) return [0, 0];
  const m = v.match(/Vector2\(([-\d.e]+),\s*([-\d.e]+)\)/);
  return m ? [parseFloat(m[1]!), parseFloat(m[2]!)] : [0, 0];
}
function num(v: string | undefined, dflt = 0): number {
  return v === undefined ? dflt : parseFloat(v);
}

// sub_resource shapes
type Shape = { kind: "rect"; w: number; h: number } | { kind: "circle"; r: number };
const shapes = new Map<string, Shape>();
for (const s of sections) {
  if (!s.header.startsWith("[sub_resource")) continue;
  const type = attr(s.header, "type");
  const id = attr(s.header, "id");
  if (!id) continue;
  if (type === "RectangleShape2D") {
    const [w, h] = vec2(s.props["size"]);
    shapes.set(id, { kind: "rect", w, h });
  } else if (type === "CircleShape2D") {
    shapes.set(id, { kind: "circle", r: num(s.props["radius"], 10) });
  }
}

// nodes, keyed by full path
interface NodeInfo {
  name: string;
  type: string;
  parent: string; // "." for root child, or a path
  pos: [number, number];
  rot: number;
  shapeId: string | null;
  script: string | null;
}
const nodes = new Map<string, NodeInfo>();
function pathOf(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}
for (const s of sections) {
  if (!s.header.startsWith("[node")) continue;
  const name = attr(s.header, "name")!;
  const type = attr(s.header, "type") ?? "";
  const parent = attr(s.header, "parent") ?? ".";
  const shapeRef = s.props["shape"]?.match(/SubResource\("([^"]+)"\)/)?.[1] ?? null;
  const scriptRef = s.props["script"] ?? null;
  nodes.set(pathOf(parent, name), {
    name,
    type,
    parent,
    pos: vec2(s.props["position"]),
    rot: num(s.props["rotation"]),
    shapeId: shapeRef,
    script: scriptRef,
  });
}

// Resolve a node's world transform by walking up its parent chain.
function worldTransform(path: string): { pos: [number, number]; rot: number } {
  const node = nodes.get(path)!;
  if (node.parent === ".") return { pos: node.pos, rot: node.rot };
  const parent = worldTransform(node.parent);
  const c = Math.cos(parent.rot);
  const s = Math.sin(parent.rot);
  const [lx, ly] = node.pos;
  return {
    pos: [parent.pos[0] + (lx * c - ly * s), parent.pos[1] + (lx * s + ly * c)],
    rot: parent.rot + node.rot,
  };
}

// Find the CollisionShape2D child of a body node.
function childShape(bodyPath: string): NodeInfo | null {
  for (const [p, n] of nodes) {
    if (n.type === "CollisionShape2D" && n.parent === bodyPath && n.shapeId) return n;
  }
  return null;
}

interface OutBody {
  kind: "static" | "impermeable" | "killzone";
  x: number;
  y: number;
  rot: number;
  shape: Shape;
}
const out: OutBody[] = [];
let player: { x: number; y: number; radius: number } | null = null;

for (const [path, n] of nodes) {
  if (n.type === "CharacterBody2D") {
    const cs = childShape(path);
    const shp = cs && cs.shapeId ? shapes.get(cs.shapeId) : null;
    const w = worldTransform(path);
    player = {
      x: w.pos[0],
      y: w.pos[1],
      radius: shp && shp.kind === "circle" ? shp.r : 10,
    };
    continue;
  }
  const isStatic = n.type === "StaticBody2D";
  const isArea = n.type === "Area2D";
  if (!isStatic && !isArea) continue;

  const cs = childShape(path);
  if (!cs || !cs.shapeId) continue;
  const shape = shapes.get(cs.shapeId);
  if (!shape) continue;

  const w = worldTransform(path);
  // Bake the shape's own local offset (rotated by the body) into the body position.
  const c = Math.cos(w.rot);
  const s = Math.sin(w.rot);
  const [ox, oy] = cs.pos;
  const px = w.pos[0] + (ox * c - oy * s);
  const py = w.pos[1] + (ox * s + oy * c);

  const isKill = isArea && (n.script?.includes("twycr") || n.name.toLowerCase().includes("kill"));
  out.push({
    kind: isKill ? "killzone" : isArea ? "killzone" : "static",
    x: px,
    y: py,
    rot: w.rot,
    shape,
  });
}

const body = `// AUTO-GENERATED from scenes/levels/Level2.tscn — do not edit by hand.
export interface LevelBodyData {
  kind: "static" | "impermeable" | "killzone";
  x: number;
  y: number;
  rot: number;
  shape: { kind: "rect"; w: number; h: number } | { kind: "circle"; r: number };
}
export interface LevelData {
  player: { x: number; y: number; radius: number };
  bodies: LevelBodyData[];
}
export const LEVEL_2: LevelData = ${JSON.stringify({ player, bodies: out }, null, 2)};
`;
writeFileSync(outPath, body);
console.log(`player=${JSON.stringify(player)} bodies=${out.length}`);
