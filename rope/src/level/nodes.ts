// THE NODE TREE: the authored form of a level (plans/node-tree.md).
//
// Everything a level holds is a NODE, as in Godot: a node has an id, a name and
// any number of children, and a spatial node's children inherit its transform.
// The classes are split the Godot way - a body is a `StaticBody2D`, an
// `AnimatableBody2D`, a `RigidBody2D` or an `Area2D`, not one body with a `kind`
// - and every collision piece, anchor, light, model, rock and decoration is a
// node of its own, placed in its parent's frame.
//
// THE SIM NEVER SEES THE TREE. It keeps consuming exactly what it consumed
// before, `LevelData` with its flat body list, produced by one function,
// `compileLevel`. The retired flat form is read by `migrateToTree`, so every old
// level, every recorded bundle and the Godot extractor's output reach the sim
// through the same gate: `normalizeLevelData` (levelFormat.ts) runs
// `compileLevel(migrateToTree(legacy))` on anything that is not already a tree.
// The proof that this changes nothing is a round trip over every level and
// every bundle in the corpus (`cli nodes`), plus `replay selftest` and the
// bundle corpus staying bit-identical.
//
// UNITS. A tree carries whatever units it was read in: pixels on disk, metres
// in memory (`scaleTree`). Migration and compilation never convert, so they
// work in either, exactly as `normalizeLevelData` always has.
//
// IDENTITY. Every node has an `id`, eight random base-36 characters, unique in
// its file, minted once and never changed by a rename, a move or an edit. It
// is the one way to refer to a node: a chain names its anchors by id, a guide
// names the collision pieces it was taken from by id, a prefab override names
// the node it overrides by id. A node inside a placed prefab is the ids of the
// instances down to it and then its own (`instA/instB/node`). Names are labels:
// unique only among siblings (`uniqueName`), so a path of names addresses one
// node and is printed beside engine body indices, but is never stored as a
// reference.

import { dmath } from "../engine/dmath";
import { scaleFormation, scaleNormalized, scaleObject } from "./levelFormat";
import type {
  AnchorObjectData,
  CameraPathData,
  CameraRegionData,
  ChainData,
  CheckpointData,
  CollisionGuide,
  CollisionObjectData,
  DecorationObjectData,
  EnvironmentData,
  FireflyPathData,
  FogRegionData,
  FormationData,
  GuidePiece,
  LevelBodyData,
  LevelCameraData,
  LevelData,
  LevelMetaData,
  LightObjectData,
  ModelObjectData,
  NoteData,
  RootBranchData,
  SceneObjectData,
  ShelterData,
  SolidGuide,
  SpawnData,
  VineData,
} from "./levelFormat";

// The revision of the level format that writes a tree (`LevelTree.format`).
export const TREE_FORMAT = 3;

// ---------------------------------------------------------------------------
// The classes
// ---------------------------------------------------------------------------

// What every node has. `children` absent is a leaf. `grouped` changes only
// what a click on the editor's canvas selects (plans/node-tree.md "Groups"),
// and `layers` are the editor's user data layers; the game reads neither.
// `disabled` leaves the node and everything under it out of the level: it is
// how a placed prefab drops one of the prefab's nodes (an override), since an
// instance cannot delete what its prefab holds.
export interface NodeCommon {
  id: string;
  name: string;
  children?: LevelNode[];
  grouped?: boolean;
  layers?: string[];
  disabled?: boolean;
}

// A place in the gameplay plane, in the parent's frame. Absent is zero.
export interface Pose2D {
  x?: number;
  y?: number;
  rot?: number;
}

// A place in the scene, in the parent's frame: a depth toward the camera and a
// tilt about x then y (radians), applied before the turn in the plane - the
// convention every 3D body used (`render3d/space.ts` `placeBody3d`). Absent is
// zero. There is no scale: only a `Model3D` and a prefab instance have one.
export interface Pose3D extends Pose2D {
  z?: number;
  tilt?: [number, number];
}

export interface PlainNode extends NodeCommon {
  type: "Node";
}

export interface Node2DNode extends NodeCommon, Pose2D {
  type: "Node2D";
}

// Everything a body has exactly one of (the retired `LevelBodyData` minus its
// kind, frame and contents). Held on the body node once, so a compound body's
// pieces never carry copies to keep in step.
export type BodyProps = Omit<
  LevelBodyData,
  "kind" | "name" | "x" | "y" | "rot" | "space" | "z" | "tilt" | "formation" | "objects"
>;

// A body's BUILD ORDER key (plans/node-tree.md "Build order"). The solver
// visits contacts in body order, so body order changes how a level plays; the
// key keeps it stable through every reparent and sibling reorder. Migration
// assigns the old index; a new body takes one past the highest.
interface BodyCommon extends NodeCommon, Pose2D, BodyProps {
  order: number;
}

export interface StaticBodyNode extends BodyCommon {
  type: "StaticBody2D";
}

// A body moved by script: a pendulum, a rotor or a route.
export interface AnimatableBodyNode extends BodyCommon {
  type: "AnimatableBody2D";
}

export interface RigidBodyNode extends BodyCommon {
  type: "RigidBody2D";
}

export type AreaKind = "killzone" | "force" | "water" | "finish";
export const AREA_KINDS: readonly AreaKind[] = ["killzone", "force", "water", "finish"];

export interface AreaNode extends BodyCommon {
  type: "Area2D";
  area: AreaKind;
}

export type BodyNode = StaticBodyNode | AnimatableBodyNode | RigidBodyNode | AreaNode;

// A root branch names the branch it grows out of by node id.
export type NodeRootBranch = Omit<RootBranchData, "parent"> & { parent?: string };

export interface ShapeNode extends NodeCommon, Omit<CollisionObjectData, "type" | "root"> {
  type: "CollisionShape2D";
  root?: NodeRootBranch;
}

// A chain or vine end: its id is what the chain names.
export interface AnchorNode extends NodeCommon, Pose2D {
  type: "Anchor2D";
}

export interface SpawnNode extends NodeCommon, SpawnData {
  type: "Spawn2D";
}

// `checkpoint` is what `?checkpoint=` names; the node's own name is a label.
export interface CheckpointNode extends NodeCommon {
  type: "Checkpoint2D";
  checkpoint: string;
  x: number;
  y: number;
}

export interface CameraRegionNode extends NodeCommon, CameraRegionData {
  type: "CameraRegion2D";
}

export interface CameraPathNode extends NodeCommon, CameraPathData {
  type: "CameraPath2D";
}

// A light's swarm names its path by the path's node id.
export interface FireflyPathNode extends NodeCommon, Omit<FireflyPathData, "id"> {
  type: "FireflyPath2D";
}

export interface ShelterNode extends NodeCommon, ShelterData {
  type: "Shelter2D";
}

export interface FogRegionNode extends NodeCommon, FogRegionData {
  type: "FogRegion2D";
}

export interface NoteNode extends NodeCommon, NoteData {
  type: "Note2D";
}

export interface Node3DNode extends NodeCommon, Pose3D {
  type: "Node3D";
}

// A collision guide names the pieces it was taken from by node id.
export type NodeCollisionGuide = Omit<CollisionGuide, "subset"> & { subset?: string[] };
export type NodeFormationGuide = NodeCollisionGuide | SolidGuide;

// Rock: a recipe and a guide, built into the store. One class whatever its
// guide (plans/node-tree.md "Formations"); its id is the formation id the
// sculpt store, the job runner and the paint sidecar file things under.
export interface FormationNode extends NodeCommon, Pose3D, Omit<FormationData, "id" | "x" | "y" | "rot" | "guide"> {
  type: "Formation3D";
  guide: NodeFormationGuide;
  // Set by compilation alone, on a rock inside a scaled prefab instance: the
  // scale it is drawn at. Never authored.
  placedScale?: number;
}

// Moss, ivy, a fern...: grown on its parent, which is always a `Formation3D`.
// Its anchors are in that formation's frame, so it has no placement of its
// own; its id is what its paint is filed under.
export interface DecorationNode extends NodeCommon, Omit<DecorationObjectData, "type" | "id" | "formation"> {
  type: "Decoration3D";
}

export interface ModelNode extends NodeCommon, Omit<ModelObjectData, "type"> {
  type: "Model3D";
}

export interface LightNode extends NodeCommon, Omit<LightObjectData, "type" | "path"> {
  type: "Light3D";
  path?: string;
}

// Chains and vines are not spatial: their points are anchors. Like bodies they
// carry a build order key, since the sim builds them in list order.
export interface ChainNode extends NodeCommon, Omit<ChainData, "a" | "b" | "via" | "through"> {
  type: "Chain";
  order: number;
  a: string;
  b: string;
  via?: string[];
  through?: string[];
}

export interface VineNode extends NodeCommon, Omit<VineData, "anchor" | "anchor2"> {
  type: "Vine";
  order: number;
  anchor: string;
  anchor2?: string;
}

// A PREFAB placed in a level (or in another prefab). It takes the class of
// the prefab's root, its own pose and uniform scale replace the root's, its
// `overrides` set any property of any node inside by that node's id, and its
// `children` are extra nodes under the root. Its `order` leads the build order
// key of every body inside it.
export interface InstanceNode extends NodeCommon, Pose3D {
  type: "Instance";
  prefab: string;
  order: number;
  scale?: number;
  overrides?: Record<string, Record<string, unknown>>;
}

export type LevelNode =
  | PlainNode
  | Node2DNode
  | StaticBodyNode
  | AnimatableBodyNode
  | RigidBodyNode
  | AreaNode
  | ShapeNode
  | AnchorNode
  | SpawnNode
  | CheckpointNode
  | CameraRegionNode
  | CameraPathNode
  | FireflyPathNode
  | ShelterNode
  | FogRegionNode
  | NoteNode
  | Node3DNode
  | FormationNode
  | DecorationNode
  | ModelNode
  | LightNode
  | ChainNode
  | VineNode
  | InstanceNode;

export type NodeType = LevelNode["type"];

export const NODE_TYPES: readonly NodeType[] = [
  "Node",
  "Node2D",
  "StaticBody2D",
  "AnimatableBody2D",
  "RigidBody2D",
  "Area2D",
  "CollisionShape2D",
  "Anchor2D",
  "Spawn2D",
  "Checkpoint2D",
  "CameraRegion2D",
  "CameraPath2D",
  "FireflyPath2D",
  "Shelter2D",
  "FogRegion2D",
  "Note2D",
  "Node3D",
  "Formation3D",
  "Decoration3D",
  "Model3D",
  "Light3D",
  "Chain",
  "Vine",
  "Instance",
];

// A level file in the tree form. The level-wide settings that are not things
// in the level stay level properties.
export interface LevelTree {
  format: number;
  meta?: LevelMetaData;
  environment?: EnvironmentData;
  camera?: LevelCameraData;
  // Fog only inside the level's `FogRegion2D` nodes, so a level with none of
  // them has fog nowhere. Absent is fog everywhere, which is what a level that
  // never authored a fog region has always had (`LevelData.fogRegions`
  // absent versus empty).
  fogMasked?: boolean;
  // The editor's DATA LAYERS by name (a node's `layers` name them). Editor
  // only, like groups: the game ignores them.
  layers?: string[];
  // The LENGTH SCALE of this tree against its file: a tree read in metres
  // (`scaleLevelTree(tree, PX)`, the editor's and the sim's) says so here,
  // so its instances expand against the prefab library at the same scale -
  // a prefab file is in pixels, as a level file is. Absent is 1, the file's
  // own units; never written to disk (a tree is written at 1).
  lengthScale?: number;
  nodes: LevelNode[];
}

// A prefab file (`prefabs/<name>.json`): one node tree, edited like a level.
export interface PrefabData {
  format: number;
  root: LevelNode;
}

export type PrefabLibrary = Readonly<Record<string, PrefabData>>;

export function isLevelTree(raw: unknown): raw is LevelTree {
  return typeof raw === "object" && raw !== null && Array.isArray((raw as { nodes?: unknown }).nodes);
}

// ---------------------------------------------------------------------------
// Class predicates
// ---------------------------------------------------------------------------

export const BODY_TYPES: ReadonlySet<NodeType> = new Set(["StaticBody2D", "AnimatableBody2D", "RigidBody2D", "Area2D"]);

const NODE_2D_TYPES: ReadonlySet<NodeType> = new Set([
  "Node2D",
  "StaticBody2D",
  "AnimatableBody2D",
  "RigidBody2D",
  "Area2D",
  "CollisionShape2D",
  "Anchor2D",
  "Spawn2D",
  "Checkpoint2D",
  "CameraRegion2D",
  "CameraPath2D",
  "FireflyPath2D",
  "Shelter2D",
  "FogRegion2D",
  "Note2D",
]);

const NODE_3D_TYPES: ReadonlySet<NodeType> = new Set(["Node3D", "Formation3D", "Decoration3D", "Model3D", "Light3D"]);

// The nodes the camera, the fog and the sky read as volumes fixed in the world.
export const WORLD_FIXED_TYPES: ReadonlySet<NodeType> = new Set([
  "Spawn2D",
  "Checkpoint2D",
  "CameraRegion2D",
  "CameraPath2D",
  "FireflyPath2D",
  "Shelter2D",
  "FogRegion2D",
]);

export function isBodyNode(n: LevelNode): n is BodyNode {
  return BODY_TYPES.has(n.type);
}

// The class an instance takes is its prefab's root's.
export function classOf(n: LevelNode, prefabs: PrefabLibrary = prefabLibrary()): NodeType {
  if (n.type !== "Instance") return n.type;
  const seen = new Set<string>();
  let cur: LevelNode | undefined = n;
  while (cur && cur.type === "Instance") {
    if (seen.has(cur.prefab)) return "Instance";
    seen.add(cur.prefab);
    cur = prefabs[cur.prefab]?.root;
  }
  return cur?.type ?? "Instance";
}

export function is2D(type: NodeType): boolean {
  return NODE_2D_TYPES.has(type);
}

export function is3D(type: NodeType): boolean {
  return NODE_3D_TYPES.has(type);
}

// Does a body of this class move or vanish, so nothing simulated may ride it?
export function bodyMovesOrVanishes(n: BodyNode): boolean {
  return n.type !== "StaticBody2D" || (n.breakForce ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// The prefab library
// ---------------------------------------------------------------------------
//
// Prefabs are files beside the levels (`prefabs/<name>.json`). The browser
// gets them from Vite's glob import; bun reads the directory. Both are eager,
// so `compileLevel` stays synchronous for every caller. The editor replaces an
// entry after saving one (`setPrefab`), so a level placed in the same session
// compiles against what was just written.

let library: Record<string, PrefabData> | null = null;

function loadLibrary(): Record<string, PrefabData> {
  const out: Record<string, PrefabData> = {};
  try {
    const globbed = import.meta.glob("../../prefabs/*.json", { eager: true, import: "default" }) as Record<string, PrefabData>;
    for (const [path, data] of Object.entries(globbed)) out[prefabNameOf(path)] = data;
    return out;
  } catch {
    // Not under Vite: `import.meta.glob` does not exist.
  }
  const proc = (globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.("fs") as typeof import("node:fs") | undefined;
  const url = proc?.getBuiltinModule?.("url") as typeof import("node:url") | undefined;
  if (!fs || !url) return out;
  const dir = url.fileURLToPath(new URL("../../prefabs/", import.meta.url));
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    out[prefabNameOf(file)] = JSON.parse(fs.readFileSync(dir + file, "utf8")) as PrefabData;
  }
  return out;
}

function prefabNameOf(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.json$/, "");
}

export function prefabLibrary(): PrefabLibrary {
  library ??= loadLibrary();
  return library;
}

export function setPrefab(name: string, data: PrefabData | null): void {
  library ??= loadLibrary();
  if (data) library[name] = data;
  else delete library[name];
  scaledLibraries.clear();
}

// The library at a tree's length scale (`LevelTree.lengthScale`): every
// prefab's root put through the same scaling a level's nodes are. The
// shared library's are kept, per scale, until a prefab is replaced.
const scaledLibraries = new Map<number, PrefabLibrary>();
export function prefabsAt(factor: number, prefabs: PrefabLibrary = prefabLibrary()): PrefabLibrary {
  if (factor === 1) return prefabs;
  const shared = prefabs === library;
  const cached = shared ? scaledLibraries.get(factor) : undefined;
  if (cached) return cached;
  const out: Record<string, PrefabData> = {};
  for (const [name, p] of Object.entries(prefabs)) out[name] = { ...p, root: scaleTree([p.root], factor, prefabs)[0]! };
  if (shared) scaledLibraries.set(factor, out);
  return out;
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

export function walkNodes(
  nodes: readonly LevelNode[],
  visit: (node: LevelNode, parent: LevelNode | null, depth: number) => void | "skip",
  parent: LevelNode | null = null,
  depth = 0,
): void {
  for (const n of nodes) {
    if (visit(n, parent, depth) === "skip") continue;
    if (n.children) walkNodes(n.children, visit, n, depth + 1);
  }
}

export function findNode(nodes: readonly LevelNode[], id: string): LevelNode | null {
  let found: LevelNode | null = null;
  walkNodes(nodes, (n) => {
    if (found) return "skip";
    if (n.id === id) found = n;
  });
  return found;
}

// The names from the root down to the node, joined by `/`: what the editor's
// breadcrumb and the replay tools print. Never stored as a reference.
export function nodePath(nodes: readonly LevelNode[], id: string): string | null {
  const trail: string[] = [];
  const search = (list: readonly LevelNode[]): boolean => {
    for (const n of list) {
      trail.push(n.name);
      if (n.id === id || (n.children && search(n.children))) return true;
      trail.pop();
    }
    return false;
  };
  return search(nodes) ? trail.join("/") : null;
}

// ---------------------------------------------------------------------------
// Names and ids
// ---------------------------------------------------------------------------

// A name no sibling has: Godot's rule, the name itself if free, else with the
// next free number appended (`Rock`, `Rock2`, `Rock3`).
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  const base = name.trim() || "Node";
  if (!taken.has(base)) return base;
  const stem = base.replace(/\d+$/, "");
  for (let k = 2; ; k++) {
    const candidate = `${stem}${k}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Renames, in place, every child whose name a sibling before it already has.
export function uniqueChildNames(children: LevelNode[]): void {
  const taken = new Set<string>();
  for (const c of children) {
    c.name = uniqueName(c.name, taken);
    taken.add(c.name);
  }
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

// A fresh id for a node created in the editor.
export function newNodeId(taken?: ReadonlySet<string>): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < 8; i++) id += ID_ALPHABET[Math.floor(Math.random() * 36)];
    if (!taken?.has(id)) return id;
  }
}

// Ids minted by MIGRATION are deterministic: the same flat level migrates to
// the same tree every time it is loaded, so a level that has not been written
// in the tree form yet still names its nodes the same way on every load.
function idMinter(taken: Set<string>): () => string {
  let state = 0x9e3779b9;
  for (const id of [...taken].sort()) for (let i = 0; i < id.length; i++) state = Math.imul(state ^ id.charCodeAt(i), 0x01000193) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % 36;
  };
  return () => {
    for (;;) {
      let id = "";
      for (let i = 0; i < 8; i++) id += ID_ALPHABET[next()];
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Pose arithmetic
// ---------------------------------------------------------------------------

export interface Frame2D {
  x: number;
  y: number;
  rot: number;
}

export const IDENTITY_2D: Frame2D = Object.freeze({ x: 0, y: 0, rot: 0 });

function isIdentity(f: Frame2D): boolean {
  return f.x === 0 && f.y === 0 && f.rot === 0;
}

export function poseOf(p: Pose2D): Frame2D {
  return { x: p.x ?? 0, y: p.y ?? 0, rot: p.rot ?? 0 };
}

// `child` in `parent`'s frame, in the parent's parent's. The same arithmetic
// `worldPlacement` (buildBodies.ts) composes an object through its body with,
// and exact when the parent is the identity, which every migrated level is.
export function compose2D(parent: Frame2D, child: Frame2D): Frame2D {
  if (isIdentity(parent)) return { x: child.x, y: child.y, rot: child.rot };
  const cos = dmath.cos(parent.rot);
  const sin = dmath.sin(parent.rot);
  return {
    x: parent.x + child.x * cos - child.y * sin,
    y: parent.y + child.x * sin + child.y * cos,
    rot: parent.rot + child.rot,
  };
}

// The inverse: a world frame into `parent`'s.
export function relative2D(parent: Frame2D, world: Frame2D): Frame2D {
  if (isIdentity(parent)) return { x: world.x, y: world.y, rot: world.rot };
  const cos = dmath.cos(-parent.rot);
  const sin = dmath.sin(-parent.rot);
  const dx = world.x - parent.x;
  const dy = world.y - parent.y;
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos, rot: world.rot - parent.rot };
}

// A 3D frame, in the level's own axes (x right, y down, z toward the camera):
// a rotation matrix (row-major) and a translation.
export interface Frame3D {
  m: [number, number, number, number, number, number, number, number, number];
  t: [number, number, number];
}

export const IDENTITY_3D: Frame3D = Object.freeze({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }) as Frame3D;

function mul3(a: Frame3D["m"], b: Frame3D["m"]): Frame3D["m"] {
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Frame3D["m"];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return r;
}

// A pose as a frame. In three's axes the pose is Rz(-rot) Ry(tilt y) Rx(tilt
// x) at (x, -y, z) (`placeBody3d`); the level's axes flip y, which conjugates
// the rotation by diag(1, -1, 1).
export function frameOf(p: Pose3D): Frame3D {
  const a = p.tilt?.[0] ?? 0;
  const b = p.tilt?.[1] ?? 0;
  const c = -(p.rot ?? 0);
  const ca = dmath.cos(a), sa = dmath.sin(a), cb = dmath.cos(b), sb = dmath.sin(b), cc = dmath.cos(c), sc = dmath.sin(c);
  const rx: Frame3D["m"] = [1, 0, 0, 0, ca, -sa, 0, sa, ca];
  const ry: Frame3D["m"] = [cb, 0, sb, 0, 1, 0, -sb, 0, cb];
  const rz: Frame3D["m"] = [cc, -sc, 0, sc, cc, 0, 0, 0, 1];
  const three = mul3(rz, mul3(ry, rx));
  const f = [1, -1, 1];
  const m = three.map((v, k) => v * f[Math.floor(k / 3)]! * f[k % 3]!) as Frame3D["m"];
  return { m, t: [p.x ?? 0, p.y ?? 0, p.z ?? 0] };
}

export function compose3D(parent: Frame3D, child: Frame3D): Frame3D {
  const [px, py, pz] = parent.t;
  const m = parent.m;
  const [cx, cy, cz] = child.t;
  return {
    m: mul3(m, child.m),
    t: [px + m[0] * cx + m[1] * cy + m[2] * cz, py + m[3] * cx + m[4] * cy + m[5] * cz, pz + m[6] * cx + m[7] * cy + m[8] * cz],
  };
}

// The inverse of a frame: a rotation's transpose, and its translation undone.
export function invert3D(f: Frame3D): Frame3D {
  const m = f.m;
  const r: Frame3D["m"] = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  const [x, y, z] = f.t;
  return { m: r, t: [-(r[0] * x + r[1] * y + r[2] * z), -(r[3] * x + r[4] * y + r[5] * z), -(r[6] * x + r[7] * y + r[8] * z)] };
}

// A frame back to a pose, the inverse of `frameOf` (three's ZYX Euler).
export function poseOfFrame(f: Frame3D): Required<Pose3D> {
  const fl = [1, -1, 1];
  const t = f.m.map((v, k) => v * fl[Math.floor(k / 3)]! * fl[k % 3]!);
  const m31 = t[6]!;
  const b = dmath.asin(Math.max(-1, Math.min(1, -m31)));
  let a: number;
  let c: number;
  if (Math.abs(m31) < 0.9999999) {
    a = dmath.atan2(t[7]!, t[8]!);
    c = dmath.atan2(t[3]!, t[0]!);
  } else {
    a = 0;
    c = dmath.atan2(-t[1]!, t[4]!);
  }
  return { x: f.t[0], y: f.t[1], z: f.t[2], rot: -c, tilt: [a, b] };
}

// Does a pose leave the plane (a depth or a tilt)?
export function isOffPlane(p: Pose3D): boolean {
  return (p.z ?? 0) !== 0 || (p.tilt !== undefined && (p.tilt[0] !== 0 || p.tilt[1] !== 0));
}

// ---------------------------------------------------------------------------
// Migration: the flat form into a tree
// ---------------------------------------------------------------------------

const SHAPE_NAMES: Record<string, string> = {
  rect: "Rect",
  circle: "Circle",
  poly: "Poly",
  curve: "Curve",
  belt: "Belt",
  path: "Path",
};

function capitalised(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function bodyClassOf(b: LevelBodyData, isMover: (b: LevelBodyData) => boolean): BodyNode["type"] {
  if (b.kind === "rigid") return "RigidBody2D";
  if (b.kind === "static") return isMover(b) ? "AnimatableBody2D" : "StaticBody2D";
  return "Area2D";
}

// Strips undefined-valued keys so a node written to disk holds what is set.
function defined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

export interface MigrateOptions {
  isMover: (b: LevelBodyData) => boolean;
}

// THE LEGACY READER. A normalized flat level (`normalizeLevelData`'s output)
// as a tree with exactly its nesting: a body becomes a body node holding its
// objects as children in their order, its formation last with the decorations
// that grow on it under it. A body that builds nothing (no collision) is not a
// body: its rock becomes a top-level `Formation3D`, or a `Node3D` holding the
// rock and its lights and models when it has any, and a body of lights or
// anchors alone becomes a `Node2D` (a `Node3D` for a 3D body).
//
// Every id that exists is kept - formation and decoration ids as they are,
// anchor and firefly path numbers written as strings - so the paint sidecars,
// the sculpt store and the formation store need no change; everything else is
// minted, deterministically.
export function migrateToTree(data: LevelData, opts: MigrateOptions): LevelTree {
  const taken = new Set<string>();
  for (const b of data.bodies) {
    if (b.formation) taken.add(b.formation.id);
    for (const o of b.objects) {
      if (o.type === "decoration") taken.add(o.id);
      if (o.type === "anchor") taken.add(String(o.id));
    }
  }
  for (const p of data.fireflyPaths ?? []) taken.add(String(p.id));
  const mint = idMinter(taken);

  const nodes: LevelNode[] = [];
  nodes.push({ type: "Spawn2D", id: mint(), name: "Spawn", ...data.player });

  data.bodies.forEach((b, index) => {
    const { kind, name, x, y, rot, space, z, tilt, formation, objects, node: _node, ...props } = b;
    const collides = objects.some((o) => o.type === "collision");
    const objectNodes = new Map<number, LevelNode>();
    const childOf = (o: SceneObjectData, i: number): LevelNode | null => {
      const node = objectNode(o, mint);
      if (node) objectNodes.set(i, node);
      return node;
    };
    const decorations = objects.filter((o): o is DecorationObjectData => o.type === "decoration");
    const others: LevelNode[] = [];
    objects.forEach((o, i) => {
      if (o.type === "decoration") return;
      const n = childOf(o, i);
      if (n) others.push(n);
    });
    // Root branches name their parent branch by node id, not by index.
    objects.forEach((o, i) => {
      if (o.type !== "collision" || o.root?.parent === undefined) return;
      const node = objectNodes.get(i) as ShapeNode | undefined;
      const parent = objectNodes.get(o.root.parent);
      if (node?.root) node.root.parent = parent?.id ?? `#${o.root.parent}`;
    });
    const formationNode = formation ? formationNodeOf(formation, objects, objectNodes, mint) : null;
    const orphans: LevelNode[] = [];
    for (const d of decorations) {
      const dn = decorationNode(d);
      if (formationNode && d.formation === formation!.id) (formationNode.children ??= []).push(dn);
      else orphans.push(dn);
    }
    if (formationNode?.children) uniqueChildNames(formationNode.children);

    if (collides) {
      const type = bodyClassOf(b, opts.isMover);
      const body = {
        type,
        id: mint(),
        name: name ?? defaultBodyName(type),
        // `Object.is`, so a -0 is written and compiles back as the -0 it was.
        ...(!Object.is(x, 0) ? { x } : {}),
        ...(!Object.is(y, 0) ? { y } : {}),
        ...(!Object.is(rot, 0) ? { rot } : {}),
        order: index,
        ...(type === "Area2D" ? { area: kind as AreaKind } : {}),
        ...props,
        // Every body is grouped, so a click on the canvas takes the body first
        // and a second goes into it, as it always has (plans/node-tree.md
        // "Groups").
        grouped: true,
      } as BodyNode;
      const children = [...others, ...(formationNode ? [formationNode] : []), ...orphans];
      if (children.length) {
        uniqueChildNames(children);
        body.children = children;
      }
      nodes.push(defined(body));
      return;
    }

    // A body that builds nothing. Its frame (and a 3D body's depth and tilt)
    // carries over to whatever holds its contents.
    const frame: Pose3D = {
      ...(x !== 0 ? { x } : {}),
      ...(y !== 0 ? { y } : {}),
      ...(rot !== 0 ? { rot } : {}),
      ...(space === "3d" && z ? { z } : {}),
      ...(space === "3d" && tilt ? { tilt: [tilt[0], tilt[1]] as [number, number] } : {}),
    };
    const contents = [...others, ...orphans];
    if (formationNode && contents.length === 0) {
      // A lone rock: the formation takes its body's frame composed with its own
      // placement, so it stands where it stood.
      // In the plane the two compose as every placement does; a 3D body's
      // depth and tilt go through the full rotation.
      const own = { x: formation!.x ?? 0, y: formation!.y ?? 0, rot: formation!.rot ?? 0 };
      const placed: Required<Pose3D> =
        space === "3d" && tilt && (tilt[0] !== 0 || tilt[1] !== 0)
          ? poseOfFrame(compose3D(frameOf(frame), frameOf(own)))
          : { ...compose2D({ x, y, rot }, own), z: space === "3d" ? (z ?? 0) : 0, tilt: [0, 0] };
      const { x: _x, y: _y, rot: _r, z: _z, tilt: _t, ...rest } = formationNode;
      const node: FormationNode = { ...rest, ...writtenPose(placed) };
      if (name) node.name = name;
      nodes.push(node);
      return;
    }
    // Grouped: it was one body, and is still picked as one thing.
    const holder: Node2DNode | Node3DNode =
      space === "3d" || formationNode
        ? { type: "Node3D", id: mint(), name: name ?? "Node3D", ...frame, grouped: true }
        : { type: "Node2D", id: mint(), name: name ?? "Node2D", ...frame, grouped: true };
    const children = [...others, ...(formationNode ? [formationNode] : []), ...orphans];
    uniqueChildNames(children);
    holder.children = children;
    nodes.push(holder);
  });

  for (const r of data.cameraRegions ?? []) nodes.push({ type: "CameraRegion2D", id: mint(), name: "CameraRegion", ...r });
  for (const p of data.cameraPaths ?? []) nodes.push({ type: "CameraPath2D", id: mint(), name: "CameraPath", ...p });
  for (const p of data.fireflyPaths ?? []) {
    const { id, ...rest } = p;
    nodes.push({ type: "FireflyPath2D", id: String(id), name: "FireflyPath", ...rest });
  }
  for (const s of data.shelters ?? []) nodes.push({ type: "Shelter2D", id: mint(), name: "Shelter", ...s });
  for (const f of data.fogRegions ?? []) nodes.push({ type: "FogRegion2D", id: mint(), name: "FogRegion", ...f });
  for (const n of data.notes ?? []) nodes.push({ type: "Note2D", id: mint(), name: "Note", ...n });
  for (const c of data.checkpoints ?? []) {
    const { name, ...rest } = c;
    nodes.push({ type: "Checkpoint2D", id: mint(), name: name.trim() || "Checkpoint", checkpoint: name, ...rest });
  }
  (data.chains ?? []).forEach((c, order) => {
    const { a, b, via, through, ...rest } = c;
    nodes.push(
      defined({
        type: "Chain",
        id: mint(),
        name: "Chain",
        order,
        a: String(a),
        b: String(b),
        ...(via ? { via: via.map(String) } : {}),
        ...(through ? { through: through.map(String) } : {}),
        ...rest,
      }) as ChainNode,
    );
  });
  (data.vines ?? []).forEach((v, order) => {
    const { anchor, anchor2, ...rest } = v;
    nodes.push(
      defined({
        type: "Vine",
        id: mint(),
        name: "Vine",
        order,
        anchor: String(anchor),
        ...(anchor2 !== undefined ? { anchor2: String(anchor2) } : {}),
        ...rest,
      }) as VineNode,
    );
  });
  uniqueChildNames(nodes);
  // An id the flat form repeated (two anchors numbered alike, which a
  // hand-edited file can hold) names its FIRST holder, as the chain builder
  // always resolved it (`buildSceneChains`); every later one is given an id of
  // its own, so a node id names one node.
  const used = new Set<string>();
  walkNodes(nodes, (n) => {
    if (used.has(n.id)) n.id = mint();
    used.add(n.id);
  });

  return {
    format: TREE_FORMAT,
    ...(data.meta ? { meta: data.meta } : {}),
    ...(data.environment ? { environment: data.environment } : {}),
    ...(data.camera ? { camera: data.camera } : {}),
    ...(data.fogRegions !== undefined ? { fogMasked: true } : {}),
    nodes,
  };
}

function defaultBodyName(type: BodyNode["type"]): string {
  return type;
}

function writtenPose(p: Required<Pose3D>): Pose3D {
  return {
    ...(p.x !== 0 ? { x: p.x } : {}),
    ...(p.y !== 0 ? { y: p.y } : {}),
    ...(p.z !== 0 ? { z: p.z } : {}),
    ...(p.rot !== 0 ? { rot: p.rot } : {}),
    ...(p.tilt[0] !== 0 || p.tilt[1] !== 0 ? { tilt: [p.tilt[0], p.tilt[1]] as [number, number] } : {}),
  };
}

function objectNode(o: SceneObjectData, mint: () => string): LevelNode | null {
  switch (o.type) {
    case "collision": {
      const { type: _t, root, node: _n, ...rest } = o;
      const name = root ? "Root" : (SHAPE_NAMES[o.shape.kind] ?? "CollisionShape2D");
      const node: ShapeNode = { type: "CollisionShape2D", id: mint(), name, ...rest };
      if (root) {
        const { parent: _p, ...branch } = root;
        node.root = branch;
      }
      return node;
    }
    case "anchor": {
      const { type: _t, id, node: _n, ...rest } = o;
      return { type: "Anchor2D", id: String(id), name: "Anchor", ...rest };
    }
    case "light": {
      const { type: _t, path, node: _n, ...rest } = o;
      return defined({ type: "Light3D", id: mint(), name: "Light", ...rest, ...(path !== undefined ? { path: String(path) } : {}) }) as LightNode;
    }
    case "model": {
      const { type: _t, node: _n, ...rest } = o;
      return { type: "Model3D", id: mint(), name: o.model ? capitalised(o.model) : "Model", ...rest };
    }
    case "decoration":
      return decorationNode(o);
  }
}

function decorationNode(o: DecorationObjectData): DecorationNode {
  const { type: _t, id, formation: _f, node: _n, ...rest } = o;
  return { type: "Decoration3D", id, name: capitalised(o.kind), ...rest };
}

function formationNodeOf(
  f: FormationData,
  objects: readonly SceneObjectData[],
  objectNodes: ReadonlyMap<number, LevelNode>,
  mint: () => string,
): FormationNode {
  const { id, x, y, rot, guide, node: _n, ...rest } = f;
  let nodeGuide: NodeFormationGuide = guide as SolidGuide;
  if (guide.kind === "collision") {
    const { subset, ...g } = guide;
    nodeGuide = g;
    if (subset) {
      // Indices into the body's ENCLOSING collision pieces (`guideFromCollision`).
      const pieces: number[] = [];
      objects.forEach((o, i) => {
        if (o.type === "collision" && enclosesShape(o)) pieces.push(i);
      });
      nodeGuide.subset = subset.map((k) => objectNodes.get(pieces[k] ?? -1)?.id ?? `#${k}`);
    }
  }
  void mint;
  return {
    type: "Formation3D",
    id,
    name: "Formation",
    ...(x !== undefined && x !== 0 ? { x } : {}),
    ...(y !== undefined && y !== 0 ? { y } : {}),
    ...(rot !== undefined && rot !== 0 ? { rot } : {}),
    ...rest,
    guide: nodeGuide,
  };
}

// A collision piece a guide can be taken from: one that encloses an area.
export function enclosesShape(o: Pick<CollisionObjectData, "shape">): boolean {
  return o.shape.kind === "rect" || o.shape.kind === "circle" || o.shape.kind === "poly";
}

// ---------------------------------------------------------------------------
// Prefab instances
// ---------------------------------------------------------------------------

// Build order keys of nodes that came out of an instance: the instance's key,
// then the prefab body's own (plans/node-tree.md "Compile").
const orderKeys = new WeakMap<LevelNode, number[]>();

function orderKeyOf(n: LevelNode & { order?: number }): number[] {
  return orderKeys.get(n) ?? [n.order ?? 0];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

// Every instance replaced by a copy of its prefab's tree: overrides applied,
// ids prefixed with the instance's, the root taking the instance's id, name,
// pose and scale, and the instance's own children appended under the root.
// Nested instances expand from the inside out. A prefab that reaches itself
// is refused.
export function expandInstances(nodes: readonly LevelNode[], prefabs: PrefabLibrary, problems: string[] = []): LevelNode[] {
  return nodes.map((n) => expandOne(n, prefabs, [], [], problems));
}

function expandOne(n: LevelNode, prefabs: PrefabLibrary, stack: string[], key: number[], problems: string[]): LevelNode {
  if (n.type !== "Instance") {
    const copy = { ...n } as LevelNode;
    if ("order" in copy && key.length) orderKeys.set(copy, [...key, (copy as { order: number }).order]);
    if (n.children) copy.children = n.children.map((c) => expandOne(c, prefabs, stack, key, problems));
    return copy;
  }
  const prefab = prefabs[n.prefab];
  // What an instance that cannot be placed stands as: a frame holding what
  // was added under it, where it was, so nothing authored around a missing
  // prefab moves or is lost (the instance itself is kept by whoever wrote it).
  const holder = {
    type: n.z !== undefined || n.tilt !== undefined ? "Node3D" : "Node2D",
    id: n.id,
    name: n.name,
    ...pose3DOf(n),
    ...(n.grouped !== undefined ? { grouped: n.grouped } : {}),
    ...(n.disabled !== undefined ? { disabled: n.disabled } : {}),
    ...(n.layers ? { layers: [...n.layers] } : {}),
    ...(n.children?.length ? { children: n.children.map((c) => expandOne(c, prefabs, stack, key, problems)) } : {}),
  } as LevelNode;
  if (!prefab) {
    problems.push(`instance ${n.id} places prefab "${n.prefab}", which does not exist`);
    return holder;
  }
  if (stack.includes(n.prefab)) {
    problems.push(`prefab "${n.prefab}" instances itself (${[...stack, n.prefab].join(" > ")})`);
    return holder;
  }
  const innerKey = [...key, n.order];
  const root = clone(prefab.root);
  if (n.overrides) applyOverrides(root, n.overrides, problems, n.id);
  // Expand the prefab's own instances first, against this one's key.
  const expanded = expandOne(root, prefabs, [...stack, n.prefab], innerKey, problems);
  const scale = n.scale ?? 1;
  if (scale !== 1) scaleGeometry(expanded, scale, true);
  // Prefix every id inside with the instance's.
  const prefix = (node: LevelNode): void => {
    node.id = `${n.id}/${node.id}`;
    if (node.type === "Chain") {
      node.a = `${n.id}/${node.a}`;
      node.b = `${n.id}/${node.b}`;
      if (node.via) node.via = node.via.map((v) => `${n.id}/${v}`);
      if (node.through) node.through = node.through.map((v) => `${n.id}/${v}`);
    }
    if (node.type === "Vine") {
      node.anchor = `${n.id}/${node.anchor}`;
      if (node.anchor2) node.anchor2 = `${n.id}/${node.anchor2}`;
    }
    if (node.type === "CollisionShape2D" && node.root?.parent) node.root = { ...node.root, parent: `${n.id}/${node.root.parent}` };
    if (node.type === "Formation3D" && node.guide.kind === "collision" && node.guide.subset) {
      node.guide = { ...node.guide, subset: node.guide.subset.map((s) => `${n.id}/${s}`) };
    }
    if (node.type === "Light3D" && node.path) node.path = `${n.id}/${node.path}`;
    for (const c of node.children ?? []) prefix(c);
  };
  for (const c of expanded.children ?? []) prefix(c);
  // The root IS the instance: its id, name, flags and pose.
  const out = expanded as LevelNode & Pose3D;
  out.id = n.id;
  out.name = n.name;
  if (n.grouped !== undefined) out.grouped = n.grouped;
  if (n.disabled !== undefined) out.disabled = n.disabled;
  if (n.layers) out.layers = [...n.layers];
  delete out.x;
  delete out.y;
  delete out.rot;
  delete out.z;
  delete out.tilt;
  if (n.x !== undefined) out.x = n.x;
  if (n.y !== undefined) out.y = n.y;
  if (n.rot !== undefined) out.rot = n.rot;
  if (n.z !== undefined) out.z = n.z;
  if (n.tilt !== undefined) out.tilt = n.tilt;
  if ("order" in out) orderKeys.set(out, innerKey);
  if (n.children?.length) out.children = [...(out.children ?? []), ...n.children.map((c) => expandOne(c, prefabs, stack, key, problems))];
  return out;
}

// What makes a prefab's rock the rock it is (plans/node-tree.md "Formations in
// prefabs"): one recipe, one build, shared by every instance. An instance may
// move, hide or re-decorate it, never re-make it, so these are refused as
// overrides (`validateTree`) and ignored if a file holds one anyway.
export const PREFAB_ROCK_RECIPE: ReadonlySet<string> = new Set(["guide", "params", "generator", "variant"]);

// How an override of a node the prefab no longer has is reported.
const ORPHANED_OVERRIDE = "which its prefab no longer has";

function applyOverrides(root: LevelNode, overrides: Record<string, Record<string, unknown>>, problems: string[], instance: string): void {
  const byId = new Map<string, LevelNode>();
  walkNodes([root], (node) => {
    byId.set(node.id, node);
  });
  for (const [id, props] of Object.entries(overrides)) {
    const target = byId.get(id);
    if (!target) {
      // Kept on the instance and shown as orphaned by the editor; nothing to apply.
      problems.push(`instance ${instance} overrides node ${id}, ${ORPHANED_OVERRIDE}`);
      continue;
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "id" || k === "type" || k === "children") continue;
      if (target.type === "Formation3D" && PREFAB_ROCK_RECIPE.has(k)) {
        problems.push(`instance ${instance} overrides the ${k} of the prefab's rock ${id}, which is the prefab's alone; ignored`);
        continue;
      }
      if (v === null) delete (target as unknown as Record<string, unknown>)[k];
      else (target as unknown as Record<string, unknown>)[k] = clone(v);
    }
  }
}

// GEOMETRIC scale about the subtree's root origin: positions, sizes and
// vertices, not rates or speeds (a scaled pendulum swings at the same period).
// The root's own pose is replaced by the instance's, so it is not scaled.
export function scaleGeometry(node: LevelNode, s: number, isRoot: boolean): void {
  const n = node as unknown as Record<string, unknown> & Pose3D;
  if (!isRoot) {
    if (typeof n.x === "number") n.x *= s;
    if (typeof n.y === "number") n.y *= s;
    if (typeof n.z === "number") n.z *= s;
  }
  switch (node.type) {
    case "CollisionShape2D":
      node.shape = scaleShapeGeometry(node.shape, s);
      if (node.thickness !== undefined) node.thickness *= s;
      break;
    case "StaticBody2D":
    case "AnimatableBody2D":
    case "RigidBody2D":
    case "Area2D":
      if (node.pivotX !== undefined) node.pivotX *= s;
      if (node.pivotY !== undefined) node.pivotY *= s;
      if (node.moveNodes) node.moveNodes = node.moveNodes.map((m) => ({ ...m, x: m.x * s, y: m.y * s, ...(m.inX !== undefined ? { inX: m.inX * s } : {}), ...(m.inY !== undefined ? { inY: m.inY * s } : {}), ...(m.outX !== undefined ? { outX: m.outX * s } : {}), ...(m.outY !== undefined ? { outY: m.outY * s } : {}) }));
      break;
    case "Formation3D":
      // Its guide stays as authored (the build is the prefab's); it is DRAWN
      // scaled, decorations and all.
      node.placedScale = (node.placedScale ?? 1) * s;
      break;
    case "Model3D":
      node.scale = (node.scale ?? 1) * s;
      break;
    case "Light3D":
      if (node.range !== undefined) node.range *= s;
      break;
    case "Chain":
      if (node.length !== undefined) node.length *= s;
      if (node.lengths) node.lengths = node.lengths.map((l) => l * s);
      break;
    case "Vine":
      node.length *= s;
      break;
    default:
      break;
  }
  for (const c of node.children ?? []) scaleGeometry(c, s, false);
}

function scaleShapeGeometry(shape: ShapeNode["shape"], s: number): ShapeNode["shape"] {
  const scaled = JSON.parse(JSON.stringify(shape), (k, v) => {
    if (typeof v !== "number") return v;
    // Every number in a shape is a length except a count or a belt's speed.
    if (k === "speed" || k === "sense" || k === "segments") return v;
    return v * s;
  }) as ShapeNode["shape"];
  return scaled;
}

// ---------------------------------------------------------------------------
// Compile: the tree into the flat form the sim reads
// ---------------------------------------------------------------------------

export interface CompiledLevel {
  data: LevelData;
  // The full node id of the body node each `data.bodies` entry came from, by
  // index; a body that only holds bodiless content (a rock, a lamp) has the
  // id of the node it was gathered under.
  bodyNodes: string[];
  // The expanded tree the data was compiled from (instances replaced).
  nodes: LevelNode[];
  problems: string[];
  // Every element of `data` - body, object, rock, volume, path, note,
  // checkpoint, chain, vine, the spawn - back to the node it came from, for the
  // editor, which reads the compiled level and edits the tree.
  nodeOf: Map<object, string>;
}

interface Ctx {
  // World frame of this node's parent, in the plane.
  world: Frame2D;
  // ...and in 3D, for content under a `Node3D`.
  world3: Frame3D;
  offPlane: boolean;
  body: { node: BodyNode; data: LevelBodyData; key: number[]; shapes: Map<string, number> } | null;
  // This node's parent's frame within the body.
  local: Frame2D;
  parent: LevelNode | null;
  // The parent's path of names, "" at the root.
  path: string;
}

// THE ONE FUNCTION THE SIM'S INPUT COMES FROM. Bodies come out in build order
// (`order` keys, then pre-order for ties), each with its pieces composed into
// its frame in pre-order; a body's rock is its first `Formation3D` (the flat
// form has one slot), and the rest of what has no body to ride - rocks, lamps,
// anchors - is gathered into bodies that build nothing, appended after every
// body that builds, as the renderer and the editor have always drawn them.
export function compileLevel(tree: LevelTree, prefabs: PrefabLibrary = prefabLibrary()): CompiledLevel {
  const problems: string[] = [];
  const nodes = expandInstances(tree.nodes, prefabsAt(tree.lengthScale ?? 1, prefabs), problems);
  const nodeOf = new Map<object, string>();
  const tag = <T extends object>(o: T, id: string): T => {
    nodeOf.set(o, id);
    return o;
  };

  const bodies: { data: LevelBodyData; key: number[]; seq: number; node: string }[] = [];
  const gathered: { data: LevelBodyData; node: string }[] = [];
  const gatherFor = new Map<string, LevelBodyData>();
  let seq = 0;

  let player: SpawnData | null = null;
  const cameraRegions: CameraRegionData[] = [];
  const cameraPaths: CameraPathData[] = [];
  const fireflyPaths: (FireflyPathData & { key: string })[] = [];
  const shelters: ShelterData[] = [];
  const fogRegions: FogRegionData[] = [];
  const notes: NoteData[] = [];
  const checkpoints: CheckpointData[] = [];
  const chains: { node: ChainNode; key: number[]; seq: number }[] = [];
  const vines: { node: VineNode; key: number[]; seq: number }[] = [];
  const anchors: string[] = [];
  const lights: { o: LightObjectData; path: string }[] = [];
  const formationBodies = new Map<string, LevelBodyData>();
  const decorations: { o: DecorationObjectData; formation: string; parent: LevelNode | null; ctx: Ctx }[] = [];
  const pendingRoots: { node: ShapeNode; o: CollisionObjectData; body: NonNullable<Ctx["body"]> }[] = [];
  const pendingSubsets: { node: FormationNode; f: FormationData; body: NonNullable<Ctx["body"]> }[] = [];

  // Everything with no body to ride is gathered under the node it sits in: one
  // body that builds nothing per such frame, in that frame's world pose.
  const gatherBody = (ctx: Ctx): LevelBodyData => {
    const key = ctx.parent?.id ?? "";
    let b = gatherFor.get(key);
    if (b) return b;
    b = frameBody(ctx);
    b.node = { id: key, path: ctx.path };
    gatherFor.set(key, b);
    gathered.push({ data: b, node: key });
    return b;
  };

  const visit = (n: LevelNode, ctx: Ctx): void => {
    if (n.disabled) return;
    const pose = poseOf(n as Pose2D);
    const here2 = compose2D(ctx.world, pose);
    const path = ctx.path ? `${ctx.path}/${n.name}` : n.name;
    const childCtx = (over: Partial<Ctx>): Ctx => ({ ...ctx, parent: n, path, ...over });

    switch (n.type) {
      case "Node":
        for (const c of n.children ?? []) visit(c, childCtx({ world: IDENTITY_2D, world3: IDENTITY_3D, offPlane: false, local: IDENTITY_2D, body: null }));
        return;
      case "Node2D": {
        const local = ctx.body ? compose2D(ctx.local, pose) : IDENTITY_2D;
        for (const c of n.children ?? []) visit(c, childCtx({ world: here2, world3: compose3D(ctx.world3, frameOf(pose)), local }));
        return;
      }
      case "StaticBody2D":
      case "AnimatableBody2D":
      case "RigidBody2D":
      case "Area2D": {
        const data = bodyData(n, here2);
        data.node = { id: n.id, path };
        const key = orderKeyOf(n);
        bodies.push({ data, key, seq: seq++, node: n.id });
        const body = { node: n, data, key, shapes: new Map<string, number>() };
        for (const c of n.children ?? []) visit(c, childCtx({ world: here2, world3: compose3D(ctx.world3, frameOf(pose)), local: IDENTITY_2D, body }));
        return;
      }
      case "CollisionShape2D": {
        if (!ctx.body) {
          problems.push(`collision shape ${n.id} has no body above it; it builds nothing`);
          return;
        }
        const placed = compose2D(ctx.local, pose);
        const { type: _t, id: _id, name: _n, children: _c, grouped: _g, layers: _l, disabled: _d, root, x: _x, y: _y, rot: _r, ...rest } = n;
        const o: CollisionObjectData = {
          type: "collision",
          ...placeIn(ctx.local, n),
          ...rest,
          ...(root ? { root: { ...rootWithoutParent(root) } } : {}),
          node: n.id,
        } as CollisionObjectData;
        ctx.body.shapes.set(n.id, ctx.body.data.objects.length);
        ctx.body.data.objects.push(tag(o, n.id));
        if (root?.parent !== undefined) pendingRoots.push({ node: n, o, body: ctx.body });
        for (const c of n.children ?? []) visit(c, childCtx({ world: here2, local: placed }));
        return;
      }
      case "Anchor2D": {
        anchors.push(n.id);
        const o: AnchorObjectData = { type: "anchor", id: 0, ...placeIn(ctx.body ? ctx.local : IDENTITY_2D, n), node: n.id };
        anchorObjects.set(n.id, o);
        (ctx.body ? ctx.body.data : gatherBody(ctx)).objects.push(tag(o, n.id));
        return;
      }
      case "Light3D": {
        const { type: _t, id: _id, name: _n, children: _c, grouped: _g, layers: _l, disabled: _d, path, x: _x, y: _y, rot: _r, ...rest } = n;
        const o = { type: "light", ...placeIn(ctx.body ? ctx.local : IDENTITY_2D, n), ...rest, node: n.id } as LightObjectData;
        if (path !== undefined) lights.push({ o, path });
        (ctx.body ? ctx.body.data : gatherBody(ctx)).objects.push(tag(o, n.id));
        return;
      }
      case "Model3D": {
        const { type: _t, id: _id, name: _n, children: _c, grouped: _g, layers: _l, disabled: _d, x: _x, y: _y, rot: _r, ...rest } = n;
        const o = { type: "model", ...placeIn(ctx.body ? ctx.local : IDENTITY_2D, n), ...rest, node: n.id } as ModelObjectData;
        (ctx.body ? ctx.body.data : gatherBody(ctx)).objects.push(tag(o, n.id));
        return;
      }
      case "Formation3D": {
        const { type: _t, id, name: _n, children, grouped: _g, layers: _l, disabled: _d, x: _x, y: _y, rot: _r, z: _z, tilt: _tl, guide, placedScale: _ps, ...rest } = n;
        const plainGuide = guide.kind === "collision" ? (({ subset: _s, ...g }) => g)(guide) : guide;
        let host: LevelBodyData;
        let f: FormationData;
        if (ctx.body && !ctx.body.data.formation && !ctx.offPlane) {
          host = ctx.body.data;
          f = { id, ...placeIn(ctx.local, n), ...rest, guide: plainGuide } as FormationData;
          if (guide.kind === "collision" && guide.subset) pendingSubsets.push({ node: n, f, body: ctx.body });
        } else {
          // A rock with no body to ride (or a second rock on one): a body of
          // its own that builds nothing, in the rock's world pose.
          host = frameBody({ ...ctx, parent: n }, n);
          host.node = { id: n.id, path };
          gathered.push({ data: host, node: n.id });
          f = { id, ...rest, guide: plainGuide } as FormationData;
        }
        host.formation = tag(f, id);
        formationBodies.set(id, host);
        for (const c of children ?? []) visit(c, childCtx({}));
        return;
      }
      case "Decoration3D": {
        const { type: _t, id, name: _n, children: _c, grouped: _g, layers: _l, disabled: _d, ...rest } = n;
        const formation = ctx.parent?.type === "Formation3D" ? ctx.parent.id : "";
        decorations.push({ o: { type: "decoration", id, formation, ...rest } as DecorationObjectData, formation, parent: ctx.parent, ctx });
        return;
      }
      case "Node3D": {
        const world3 = compose3D(ctx.world3, frameOf(n));
        const local = ctx.body ? compose2D(ctx.local, pose) : IDENTITY_2D;
        for (const c of n.children ?? []) visit(c, childCtx({ world: here2, world3, offPlane: ctx.offPlane || isOffPlane(n), local }));
        return;
      }
      case "Spawn2D": {
        const { type: _t, id: _id, name: _n, children: _c, grouped: _g, layers: _l, disabled: _d, ...rest } = n;
        if (player) problems.push(`a second Spawn2D (${n.id}) is ignored`);
        else player = tag({ ...rest, x: here2.x, y: here2.y }, n.id);
        return;
      }
      case "Checkpoint2D":
        checkpoints.push(tag({ name: n.checkpoint, x: here2.x, y: here2.y }, n.id));
        return;
      case "CameraRegion2D":
        cameraRegions.push(tag({ ...strip(n), ...here2 } as CameraRegionData, n.id));
        return;
      case "CameraPath2D":
        cameraPaths.push(tag({ ...strip(n), ...here2 } as CameraPathData, n.id));
        return;
      case "FireflyPath2D":
        fireflyPaths.push({ ...strip(n), ...here2, id: 0, key: n.id } as FireflyPathData & { key: string });
        return;
      case "Shelter2D":
        shelters.push(tag({ ...strip(n), ...here2 } as ShelterData, n.id));
        return;
      case "FogRegion2D":
        fogRegions.push(tag({ ...strip(n), ...here2 } as FogRegionData, n.id));
        return;
      case "Note2D":
        notes.push(tag({ ...strip(n), ...here2 } as NoteData, n.id));
        return;
      case "Chain":
        chains.push({ node: n, key: orderKeyOf(n), seq: seq++ });
        return;
      case "Vine":
        vines.push({ node: n, key: orderKeyOf(n), seq: seq++ });
        return;
      case "Instance":
        // Expanded above; one left here is a prefab that could not be.
        return;
    }
  };

  const anchorObjects = new Map<string, AnchorObjectData>();
  const root: Ctx = { world: IDENTITY_2D, world3: IDENTITY_3D, offPlane: false, body: null, local: IDENTITY_2D, parent: null, path: "" };
  for (const n of nodes) visit(n, root);

  // Decorations go into whatever body their rock was compiled into.
  for (const d of decorations) {
    const host = formationBodies.get(d.formation) ?? (d.ctx.body ? d.ctx.body.data : gatherBody(d.ctx));
    host.objects.push(tag(d.o, d.o.id));
  }

  // Root branches and guide subsets: node ids back to the indices the flat form reads.
  for (const r of pendingRoots) {
    const parentId = r.node.root!.parent!;
    const index = r.body.shapes.get(parentId) ?? (parentId.startsWith("#") ? Number(parentId.slice(1)) : undefined);
    if (index !== undefined) r.o.root = { ...r.o.root!, parent: index };
    else problems.push(`root ${r.node.id} grows out of ${parentId}, which is not a shape in its body`);
  }
  for (const p of pendingSubsets) {
    const pieces: string[] = [];
    for (const [id, i] of p.body.shapes) {
      const o = p.body.data.objects[i] as CollisionObjectData;
      if (enclosesShape(o)) pieces.push(id);
    }
    const subset = (p.node.guide as NodeCollisionGuide).subset!.map((id) => (id.startsWith("#") ? Number(id.slice(1)) : pieces.indexOf(id)));
    (p.f.guide as CollisionGuide).subset = subset;
  }

  // Anchor ids: a numeric id keeps its number; any other is given the next
  // free one, in pre-order.
  const numbers = numberIds(anchors);
  for (const [id, o] of anchorObjects) o.id = numbers.get(id)!;
  const anchorNumber = (id: string): number => numbers.get(id) ?? (/^\d+$/.test(id) ? Number(id) : -1);

  const pathNumbers = numberIds(fireflyPaths.map((p) => p.key));
  for (const p of fireflyPaths) p.id = pathNumbers.get(p.key)!;
  for (const l of lights) l.o.path = pathNumbers.get(l.path) ?? (/^\d+$/.test(l.path) ? Number(l.path) : -1);

  const ordered = [...bodies].sort((a, b) => compareKeys(a.key, b.key) || a.seq - b.seq);
  const byOrder = <T extends { key: number[]; seq: number }>(list: T[]): T[] => [...list].sort((a, b) => compareKeys(a.key, b.key) || a.seq - b.seq);

  const data: LevelData = {
    player: player ?? { x: 0, y: 0, radius: 15 },
    bodies: [...ordered.map((b) => b.data), ...gathered.map((g) => g.data)],
    ...(tree.meta ? { meta: tree.meta } : {}),
    ...(cameraRegions.length ? { cameraRegions } : {}),
    ...(cameraPaths.length ? { cameraPaths } : {}),
    ...(fireflyPaths.length ? { fireflyPaths: fireflyPaths.map(({ key, ...p }) => tag(p, key)) } : {}),
    ...(shelters.length ? { shelters } : {}),
    ...(fogRegions.length || tree.fogMasked ? { fogRegions } : {}),
    ...(notes.length ? { notes } : {}),
    ...(checkpoints.length ? { checkpoints } : {}),
    ...(chains.length
      ? {
          chains: byOrder(chains).map(({ node }) => {
            const { type: _t, id: _id, name: _n, children: _c, grouped: _g, layers: _l, disabled: _d, order: _o, a, b, via, through, ...rest } = node;
            return tag(
              {
                a: anchorNumber(a),
                b: anchorNumber(b),
                ...rest,
                ...(via ? { via: via.map(anchorNumber) } : {}),
                ...(through ? { through: through.map(anchorNumber) } : {}),
              } as ChainData,
              node.id,
            );
          }),
        }
      : {}),
    ...(vines.length
      ? {
          vines: byOrder(vines).map(({ node }) => {
            const { type: _t, id: _id, name: _n, children: _c, grouped: _g, layers: _l, disabled: _d, order: _o, anchor, anchor2, ...rest } = node;
            return tag({ anchor: anchorNumber(anchor), ...(anchor2 !== undefined ? { anchor2: anchorNumber(anchor2) } : {}), ...rest } as VineData, node.id);
          }),
        }
      : {}),
    ...(tree.environment ? { environment: tree.environment } : {}),
    ...(tree.camera ? { camera: tree.camera } : {}),
  };
  if (!player) problems.push("the level has no Spawn2D");
  for (const b of [...ordered, ...gathered]) nodeOf.set(b.data, b.node);
  return { data, bodyNodes: [...ordered.map((b) => b.node), ...gathered.map((g) => g.node)], nodes, problems, nodeOf };
}

function numberIds(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  let next = 1;
  for (const id of ids) {
    if (/^\d+$/.test(id) && !out.has(id)) {
      out.set(id, Number(id));
      next = Math.max(next, Number(id) + 1);
    }
  }
  for (const id of ids) if (!out.has(id)) out.set(id, next++);
  return out;
}

// A node's placement in its body's frame, written as the flat form writes it.
// Straight under the body the node's own fields are copied as they stand -
// present or absent - so a migrated level compiles back to exactly the object
// it came from; under a plain `Node2D` the two compose and a zero is left out.
function placeIn(local: Frame2D, n: Pose2D): Pose2D {
  if (isIdentity(local)) {
    return {
      ...(n.x !== undefined ? { x: n.x } : {}),
      ...(n.y !== undefined ? { y: n.y } : {}),
      ...(n.rot !== undefined ? { rot: n.rot } : {}),
    };
  }
  const f = compose2D(local, poseOf(n));
  return {
    ...(f.x !== 0 ? { x: f.x } : {}),
    ...(f.y !== 0 ? { y: f.y } : {}),
    ...(f.rot !== 0 ? { rot: f.rot } : {}),
  };
}

function rootWithoutParent(r: NodeRootBranch): RootBranchData {
  const { parent: _p, ...rest } = r;
  return rest;
}

// A node's own data, without what every node has and without its placement.
function strip(n: LevelNode): Record<string, unknown> {
  const { type: _t, id: _id, name: _n, children: _c, grouped: _g, layers: _l, disabled: _d, ...rest } = n as LevelNode & Record<string, unknown>;
  return rest;
}

function bodyData(n: BodyNode, world: Frame2D): LevelBodyData {
  const { type, id: _id, name, children: _c, grouped: _g, layers: _l, disabled: _d, order: _o, x: _x, y: _y, rot: _r, ...props } = n as BodyNode & { area?: AreaKind };
  const { area, ...rest } = props as typeof props & { area?: AreaKind };
  const kind = type === "RigidBody2D" ? "rigid" : type === "Area2D" ? (area ?? "killzone") : "static";
  return { kind, name, x: world.x, y: world.y, rot: world.rot, ...rest, objects: [] };
}

// A body that builds nothing, standing in a frame: the parent's world pose for
// gathered content, or a rock's own (`self`).
function frameBody(ctx: Ctx, self?: FormationNode): LevelBodyData {
  if (!ctx.offPlane && !(self && isOffPlane(self))) {
    const base = ctx.body ? compose2D(ctx.body.data, ctx.local) : ctx.world;
    const f = self ? compose2D(base, poseOf(self)) : base;
    return { kind: "static", x: f.x, y: f.y, rot: f.rot, objects: [] };
  }
  const base = ctx.body ? compose3D(ctx.world3, IDENTITY_3D) : ctx.world3;
  const p = poseOfFrame(self ? compose3D(base, frameOf(self)) : base);
  return {
    kind: "static",
    x: p.x,
    y: p.y,
    rot: p.rot,
    space: "3d",
    ...(p.z !== 0 ? { z: p.z } : {}),
    ...(p.tilt[0] !== 0 || p.tilt[1] !== 0 ? { tilt: p.tilt } : {}),
    objects: [],
  };
}

// ---------------------------------------------------------------------------
// Validity
// ---------------------------------------------------------------------------
//
// The states the editor refuses and `cli levels` rejects (plans/node-tree.md
// "States the editor refuses"). Each exists because the editor and the game
// would disagree about it: a body under a moving body rides its parent in the
// editor and simulates on its own in play; a camera region on a swinging crate
// is carried by the editor and read as fixed by the camera.

export interface TreeProblem {
  id: string;
  message: string;
  // Refused outright, or only worth saying.
  error: boolean;
}

export interface ValidateOptions {
  prefabs?: PrefabLibrary;
  // A prefab holds no Spawn2D or Checkpoint2D and needs no spawn of its own.
  prefab?: boolean;
}

export function validateTree(nodes: readonly LevelNode[], opts: ValidateOptions = {}): TreeProblem[] {
  const prefabs = opts.prefabs ?? prefabLibrary();
  const out: TreeProblem[] = [];
  const error = (id: string, message: string): void => void out.push({ id, message, error: true });
  const warn = (id: string, message: string): void => void out.push({ id, message, error: false });

  // Ids unique in the file, names unique among siblings.
  const ids = new Set<string>();
  const checkSiblings = (list: readonly LevelNode[]): void => {
    const names = new Set<string>();
    for (const n of list) {
      if (ids.has(n.id)) error(n.id, `id ${n.id} is used twice`);
      ids.add(n.id);
      if (!n.name) error(n.id, `node ${n.id} has no name`);
      else if (names.has(n.name)) error(n.id, `two siblings are called "${n.name}"`);
      names.add(n.name);
      if (n.children) checkSiblings(n.children);
    }
  };
  checkSiblings(nodes);

  // The rules about where a node may sit read the CLASS, which an instance
  // takes from its prefab's root; they are checked on the expanded tree so a
  // prefab's insides are held to them too.
  const problems: string[] = [];
  const expanded = expandInstances(nodes, prefabs, problems);
  // An override naming a node the prefab has since lost is kept for the
  // author to see and drop (the editor marks it orphaned): a warning. The
  // rest - a missing prefab, a cycle, a re-made rock - are refused.
  for (const p of problems) (p.includes(ORPHANED_OVERRIDE) ? warn : error)("", p);

  let spawns = 0;
  const anchors = new Set<string>();
  const links: { id: string; ends: string[] }[] = [];

  interface Up {
    body: BodyNode | null;
    in3D: boolean;
    moving: boolean;
  }
  const visit = (n: LevelNode, up: Up, parent: LevelNode | null): void => {
    const type = n.type;
    if (is2D(type) && up.in3D) error(n.id, `${n.name} (${type}) sits under a 3D node; a 2D node is in the gameplay plane`);
    if (isBodyNode(n) && up.body && bodyMovesOrVanishes(up.body)) {
      error(n.id, `${n.name} is a body under ${up.body.name} (${up.body.type}${up.body.type === "StaticBody2D" ? ", breakable" : ""}), which moves or can vanish`);
    }
    if (type === "CollisionShape2D" && !up.body) error(n.id, `${n.name} is a collision shape with no body above it`);
    if (type === "Decoration3D" && parent?.type !== "Formation3D") error(n.id, `${n.name} is a decoration whose parent is not a Formation3D`);
    if (type === "Anchor2D") {
      anchors.add(n.id);
      if (up.body?.type === "Area2D") error(n.id, `${n.name} is an anchor on an area (${up.body.name})`);
    }
    if (WORLD_FIXED_TYPES.has(type) && up.moving) error(n.id, `${n.name} (${type}) is read as fixed in the world but sits under something that moves`);
    if (type === "Spawn2D") {
      spawns++;
      if (opts.prefab) error(n.id, `a prefab may not hold a Spawn2D`);
    }
    if (type === "Checkpoint2D" && opts.prefab) error(n.id, `a prefab may not hold a Checkpoint2D`);
    if (type === "Area2D" && !AREA_KINDS.includes(n.area)) error(n.id, `${n.name} is an area of unknown kind "${String(n.area)}"`);
    if (isBodyNode(n) && !(n.children ?? []).some(function hasShape(c: LevelNode): boolean {
      return !c.disabled && (c.type === "CollisionShape2D" || (!isBodyNode(c) && (c.children ?? []).some(hasShape)));
    })) {
      warn(n.id, `${n.name} is a body with no shapes; it builds nothing and should be a Node2D`);
    }
    if (type === "Chain") links.push({ id: n.id, ends: [n.a, n.b, ...(n.via ?? []), ...(n.through ?? [])] });
    if (type === "Vine") links.push({ id: n.id, ends: [n.anchor, ...(n.anchor2 !== undefined ? [n.anchor2] : [])] });

    const next: Up = {
      body: isBodyNode(n) ? n : up.body,
      in3D: up.in3D || is3D(type),
      moving: up.moving || (isBodyNode(n) && bodyMovesOrVanishes(n) && n.type !== "Area2D"),
    };
    if (type === "Node") {
      next.body = null;
      next.in3D = false;
      next.moving = false;
    }
    for (const c of n.children ?? []) visit(c, next, n);
  };
  for (const n of expanded) visit(n, { body: null, in3D: false, moving: false }, null);

  if (!opts.prefab && spawns !== 1) error("", `the level has ${spawns} Spawn2D nodes; it needs exactly one`);
  for (const l of links) {
    for (const end of l.ends) if (!anchors.has(end)) error(l.id, `chain or vine ${l.id} names anchor ${end}, which is not in the level`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------
//
// A tree between pixels (disk) and metres (memory). Which fields are lengths
// is known in one place, `scaleNormalized` (levelFormat.ts), so each node is
// handed to it as the flat element it compiles to and read back: a field
// added to an element is scaled for the tree the day it is scaled for the
// flat form, with no second list to forget. A pose's x, y and z are lengths;
// its turn and tilt are angles.

const SPAWN_STUB: SpawnData = { x: 0, y: 0, radius: 1 };

function scaleVia(data: Partial<LevelData>, factor: number): LevelData {
  return scaleNormalized({ player: SPAWN_STUB, bodies: [], ...data } as LevelData, factor);
}

function scalePose<T extends Pose3D>(n: T, factor: number): T {
  const out = { ...n };
  if (n.x !== undefined) out.x = n.x * factor;
  if (n.y !== undefined) out.y = n.y * factor;
  if (n.z !== undefined) out.z = n.z * factor;
  return out;
}

const COMMON_KEYS = ["type", "id", "name", "children", "grouped", "layers", "disabled"] as const;

function common(n: LevelNode): NodeCommon & { type: NodeType } {
  const out: Record<string, unknown> = {};
  for (const k of COMMON_KEYS) if ((n as unknown as Record<string, unknown>)[k] !== undefined) out[k] = (n as unknown as Record<string, unknown>)[k];
  return out as unknown as NodeCommon & { type: NodeType };
}

// One node's own fields, scaled; its children are left to the caller.
export function scaleNode(n: LevelNode, factor: number, prefabs: PrefabLibrary = prefabLibrary()): LevelNode {
  const c = common(n);
  const s = strip(n) as Record<string, unknown>;
  switch (n.type) {
    case "Node":
      return n;
    case "Node2D":
    case "Anchor2D":
    case "Node3D":
      return scalePose(n, factor);
    case "StaticBody2D":
    case "AnimatableBody2D":
    case "RigidBody2D":
    case "Area2D": {
      const { order, area, x: _x, y: _y, rot: _r, ...props } = s as Record<string, unknown> & { order: number; area?: AreaKind };
      const body = scaleVia({ bodies: [{ kind: "static", x: 0, y: 0, rot: 0, ...props, objects: [] } as LevelBodyData] }, factor).bodies[0]!;
      const { kind: _k, x: _bx, y: _by, rot: _br, objects: _o, ...scaled } = body;
      return scalePose({ ...c, ...scaled, order, ...(area !== undefined ? { area } : {}), ...pose2DOf(n) } as LevelNode & Pose3D, factor);
    }
    case "CollisionShape2D": {
      const o = scaleObject({ type: "collision", ...s } as CollisionObjectData, factor);
      const { type: _t, ...rest } = o;
      return { ...c, ...rest } as LevelNode;
    }
    case "Light3D": {
      const { path, ...rest } = s as Record<string, unknown> & { path?: string };
      const o = scaleObject({ type: "light", ...rest } as LightObjectData, factor);
      const { type: _t, ...scaled } = o;
      return { ...c, ...scaled, ...(path !== undefined ? { path } : {}) } as LevelNode;
    }
    case "Model3D": {
      const { type: _t, ...scaled } = scaleObject({ type: "model", ...s } as ModelObjectData, factor);
      return { ...c, ...scaled } as LevelNode;
    }
    case "Decoration3D": {
      const { type: _t, id: _id, formation: _f, ...scaled } = scaleObject({ type: "decoration", id: n.id, formation: "", ...s } as DecorationObjectData, factor) as DecorationObjectData;
      return { ...c, ...scaled } as LevelNode;
    }
    case "Formation3D": {
      const { x: _x, y: _y, rot: _r, z: _z, tilt: _t, placedScale, ...rest } = s as Record<string, unknown> & { placedScale?: number };
      const { id: _id, ...scaled } = scaleFormation({ id: n.id, ...rest } as unknown as FormationData, factor);
      // A drawing scale is a ratio, not a length.
      return scalePose({ ...c, ...scaled, ...pose3DOf(n), ...(placedScale !== undefined ? { placedScale } : {}) } as LevelNode & Pose3D, factor);
    }
    case "Spawn2D":
      return { ...c, ...scaleVia({ player: s as unknown as SpawnData }, factor).player } as LevelNode;
    case "Checkpoint2D": {
      const p = scaleVia({ checkpoints: [{ name: n.checkpoint, x: n.x, y: n.y }] }, factor).checkpoints![0]!;
      return { ...c, checkpoint: n.checkpoint, x: p.x, y: p.y } as LevelNode;
    }
    case "CameraRegion2D":
      return { ...c, ...(scaleVia({ cameraRegions: [s as unknown as CameraRegionData] }, factor).cameraRegions?.[0] ?? scalePose(s, factor)) } as LevelNode;
    case "CameraPath2D":
      return { ...c, ...(scaleVia({ cameraPaths: [s as unknown as CameraPathData] }, factor).cameraPaths?.[0] ?? scalePose(s, factor)) } as LevelNode;
    case "FireflyPath2D": {
      const p = scaleVia({ fireflyPaths: [{ id: 0, ...s } as unknown as FireflyPathData] }, factor).fireflyPaths?.[0];
      if (!p) return { ...c, ...scalePose(s, factor) } as LevelNode;
      const { id: _id, ...rest } = p;
      return { ...c, ...rest } as LevelNode;
    }
    case "Shelter2D":
      return { ...c, ...(scaleVia({ shelters: [s as unknown as ShelterData] }, factor).shelters?.[0] ?? scalePose(s, factor)) } as LevelNode;
    case "FogRegion2D":
      return { ...c, ...scaleVia({ fogRegions: [s as unknown as FogRegionData] }, factor).fogRegions![0]! } as LevelNode;
    case "Note2D":
      return { ...c, ...scaleVia({ notes: [s as unknown as NoteData] }, factor).notes![0]! } as LevelNode;
    case "Chain": {
      const { order, a, b, via, through, ...rest } = s as Record<string, unknown> & { order: number; a: string; b: string; via?: string[]; through?: string[] };
      const { a: _a, b: _b, via: _v, through: _th, ...scaled } = scaleVia({ chains: [{ a: 0, b: 0, ...rest } as ChainData] }, factor).chains![0]!;
      return defined({ ...c, order, a, b, ...(via ? { via: [...via] } : {}), ...(through ? { through: [...through] } : {}), ...scaled }) as LevelNode;
    }
    case "Vine": {
      const { order, anchor, anchor2, ...rest } = s as Record<string, unknown> & { order: number; anchor: string; anchor2?: string };
      const { anchor: _a, anchor2: _b, ...scaled } = scaleVia({ vines: [{ anchor: 0, ...rest } as VineData] }, factor).vines![0]!;
      return { ...c, order, anchor, ...(anchor2 !== undefined ? { anchor2 } : {}), ...scaled } as LevelNode;
    }
    case "Instance": {
      const out = scalePose({ ...n }, factor);
      if (n.overrides) out.overrides = scaleOverrides(n, factor, prefabs);
      return out;
    }
  }
}

// An override is a partial node: scaled as the node it overrides would be,
// and only the keys it sets kept.
function scaleOverrides(n: InstanceNode, factor: number, prefabs: PrefabLibrary): InstanceNode["overrides"] {
  const root = prefabs[n.prefab]?.root;
  const byId = new Map<string, LevelNode>();
  if (root) walkNodes([root], (node) => void byId.set(node.id, node));
  const out: NonNullable<InstanceNode["overrides"]> = {};
  for (const [id, props] of Object.entries(n.overrides ?? {})) {
    const target = byId.get(id);
    if (!target) {
      out[id] = { ...props };
      continue;
    }
    // A `null` (a field the override removes) has nothing to scale, and the
    // prefab's own value stands in for it while the rest are scaled.
    const set = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== null && v !== undefined));
    const merged = { ...target, ...set, children: undefined } as LevelNode;
    const scaled = scaleNode(merged, factor, prefabs) as unknown as Record<string, unknown>;
    out[id] = Object.fromEntries(Object.keys(props).map((k) => [k, props[k] === null ? null : scaled[k]]));
  }
  return out;
}

function pose2DOf(n: Pose2D): Pose2D {
  return { ...(n.x !== undefined ? { x: n.x } : {}), ...(n.y !== undefined ? { y: n.y } : {}), ...(n.rot !== undefined ? { rot: n.rot } : {}) };
}

function pose3DOf(n: Pose3D): Pose3D {
  return { ...pose2DOf(n), ...(n.z !== undefined ? { z: n.z } : {}), ...(n.tilt !== undefined ? { tilt: [n.tilt[0], n.tilt[1]] as [number, number] } : {}) };
}

// The whole tree, children included, as fresh objects.
export function scaleTree(nodes: readonly LevelNode[], factor: number, prefabs: PrefabLibrary = prefabLibrary()): LevelNode[] {
  return nodes.map((n) => {
    const out = scaleNode(n, factor, prefabs);
    const copy = out === n ? { ...n } : out;
    if (n.children) copy.children = scaleTree(n.children, factor, prefabs);
    return copy;
  });
}

export function scaleLevelTree(tree: LevelTree, factor: number, prefabs: PrefabLibrary = prefabLibrary()): LevelTree {
  const carried = scaleVia({ ...(tree.camera ? { camera: tree.camera } : {}) }, factor);
  const { lengthScale: was, ...rest } = tree;
  // Back at the file's own units within rounding (1/100 * 100) is exactly 1.
  const lengthScale = (was ?? 1) * factor;
  return {
    ...rest,
    ...(Math.abs(lengthScale - 1) > 1e-12 ? { lengthScale } : {}),
    ...(tree.meta ? { meta: { ...tree.meta } } : {}),
    ...(tree.environment ? { environment: { ...tree.environment } } : {}),
    ...(carried.camera ? { camera: carried.camera } : {}),
    nodes: scaleTree(tree.nodes, factor, prefabs),
  };
}
