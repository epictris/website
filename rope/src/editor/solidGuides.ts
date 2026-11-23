// Solid guides in the editor's 3D view (docs/formations.md, "Background
// guides"): each formation whose guide is a boolean tree, meshed live
// (`formation/solid.ts`) and drawn as a wireframe through whatever stands in
// front of it, in the editor only (the game never draws a guide). The node
// selected in the Formation panel is drawn in the warm accent.
//
// Rebuilt only when what it draws changes: the guides, their placements, the
// selection, or a mesh leaf that has just loaded.

import * as THREE from "three";
import { showToast } from "../render/toast";
import { encodeMeshBin, readStoredMesh } from "../formation/meshBin";
import { sha256Bytes } from "../formation/sha256";
import { meshFiles, poseMatrix, solidMesh, type SolidMesh, type SolidResult } from "../formation/solid";
import { nodeAt } from "../formation/solidTree";
import { stackOf } from "../formation/solidStack";
import { meshFile, MESHES_API } from "../formation/store";
import type { SolidNode } from "../level/levelFormat";
import type { EdItem } from "./model";
import { itemMatrix } from "./space3d";

// Which node of which formation's tree the panel has picked.
export interface SolidSel {
  itemId: number;
  path: number[];
}

const GUIDE = 0x9aa6c8;
const PICKED = 0xedc282;
// The edges drawn: where faces meet at more than this many degrees.
const EDGE_DEGREES = 20;

// The stored meshes the guides use, loaded once each (shared by every guide,
// the panel and sculpting), in either of the store's forms
// (formation/meshBin.ts).
const meshes = new Map<string, SolidMesh>();
const loading = new Set<string>();
export function loadedMeshes(): ReadonlyMap<string, SolidMesh> {
  return meshes;
}
// A mesh into the store in its binary form (Apply, a sculpt's commit, a
// cut). Its name is the sha256 of its bytes, known here at once, so the
// guide can name it in the same edit and this tab draws it from memory; the
// upload finishes behind (`saved`), and a store that refuses it is said in a
// toast, since the level then names a mesh the store does not hold.
export function storeMesh(mesh: SolidMesh): { name: string; saved: Promise<void> } {
  const bytes = encodeMeshBin(mesh);
  const name = `${sha256Bytes(bytes)}.bin`;
  meshes.set(name, mesh);
  const saved = fetch(MESHES_API, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes as BodyInit })
    .then(async (res) => {
      const body = (await res.json()) as { name?: string; error?: string };
      if (body.name !== name) throw new Error(body.error ?? `the store named it ${body.name ?? `nothing (${res.status})`}`);
    })
    .catch((e: Error) => {
      showToast(`The guide's mesh was not stored: ${e.message}. Undo, or sculpt again to retry.`, "warn");
      throw e;
    })
    .finally(() => uploads.delete(saved));
  uploads.add(saved);
  return { name, saved };
}
// The uploads still on their way: a job asked now waits for them
// (`meshesStored`), since it reads the guide's meshes from the store.
const uploads = new Set<Promise<void>>();
export async function meshesStored(): Promise<void> {
  await Promise.allSettled([...uploads]);
}
export function requestMeshes(tree: SolidNode, landed: () => void): boolean {
  let missing = false;
  for (const name of meshFiles(tree)) {
    if (meshes.has(name)) continue;
    missing = true;
    if (loading.has(name)) continue;
    loading.add(name);
    fetch(meshFile(name))
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((bytes) => (bytes ? readStoredMesh(name, bytes) : null))
      .catch((e: Error) => {
        console.warn(`solid guide mesh ${name}: ${e.message}`);
        return null;
      })
      .then((m) => {
        if (m) meshes.set(name, m);
        landed();
      });
  }
  return missing;
}

// A node's mesh from the loaded meshes, kept per node object once every mesh
// it names has loaded (an edit replaces a tree, so the same object is the
// same solid): a sculpted guide is a few hundred milliseconds of manifold-3d
// to mesh, and the view, the panel and the bounds all ask.
const meshOfNode = new WeakMap<SolidNode, SolidResult>();
export function guideMesh(node: SolidNode): SolidResult {
  const known = meshOfNode.get(node);
  if (known) return known;
  const made = solidMesh(node, meshes);
  if (!made.missing.length) meshOfNode.set(node, made);
  return made;
}

// The box round what a solid guide makes, in the guide's own frame (its
// formation item's, `itemMatrix`). Null until every mesh it imports has
// loaded, and for a guide that makes nothing: a box measured off half the
// meshes is a box in the wrong place, and an answer the caller would keep.
//
// Kept per tree: an edit to a guide replaces its tree rather than changing it
// in place, so a tree seen before is the same solid, and its CSG is not run
// again on every frame something asks where it is.
const boundsOfTree = new WeakMap<SolidNode, THREE.Box3 | null>();
export function guideBounds(tree: SolidNode): THREE.Box3 | null {
  const known = boundsOfTree.get(tree);
  if (known !== undefined) return known;
  if (meshFiles(tree).some((name) => !meshes.has(name))) return null;
  const made = guideMesh(tree).mesh;
  const box = made?.positions.length ? new THREE.Box3().setFromArray(made.positions) : null;
  boundsOfTree.set(tree, box);
  return box;
}

function geometryOf(mesh: SolidMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return g;
}

// A guide's tree carried by a rigid transform `m` (a body frame into
// another's: `inverse(itemMatrix(a)) * itemMatrix(b)`), leaf by leaf, since
// only a primitive has a pose. Exact for any rigid `m`: a leaf's pose is
// translate, turn, scale, so `m` times it is a new translate and turn over
// the same scale, which decomposes back into `pos`, `rot` (Euler XYZ, as
// `poseMatrix` reads it) and the leaf's own `scale`. What the leaf holds in
// its own frame - an outline, a hull's points, a mesh - is untouched.
export function carryTree(tree: SolidNode, m: THREE.Matrix4): SolidNode {
  if ("op" in tree) return { ...tree, of: tree.of.map((c) => carryTree(c, m)) };
  const placed = m.clone().multiply(new THREE.Matrix4().fromArray(poseMatrix(tree)));
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  placed.decompose(pos, quat, scale);
  const rot = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  const { pos: _p, rot: _r, ...rest } = tree;
  return {
    ...rest,
    pos: [pos.x, pos.y, pos.z],
    ...(rot.x || rot.y || rot.z ? { rot: [rot.x, rot.y, rot.z] as [number, number, number] } : {}),
  };
}

// The transform that carries guide `from`'s tree into guide `into`'s frame.
export function frameBetween(from: EdItem, into: EdItem): THREE.Matrix4 {
  return itemMatrix(into).invert().multiply(itemMatrix(from));
}

interface GuideMaterials {
  line: THREE.LineBasicMaterial;
  faint: THREE.LineBasicMaterial;
  volume: THREE.MeshLambertMaterial;
  active: THREE.MeshLambertMaterial;
}

export class SolidGuideView {
  readonly group = new THREE.Group();
  private key = "";
  private readonly owned: { dispose(): void }[] = [];
  // Each drawn guide's holder, by item id (`boxOf`).
  private readonly holders = new Map<number, THREE.Group>();
  // Each guide's own colour (`colorOf` in `sync`; editor/guideColors.ts), and
  // the four materials drawn in it, made once per colour.
  private readonly palette = new Map<number, GuideMaterials>();
  private readonly pickedMaterial = new THREE.LineBasicMaterial({ color: PICKED, transparent: true, opacity: 0.95, depthTest: false });
  // The stack's cutters and intersections (see `sync`), and the invisible
  // surfaces a click on a shape lands on (`pickShape`).
  private readonly cutMaterial = new THREE.LineBasicMaterial({ color: 0xef7a6b, transparent: true, opacity: 0.85, depthTest: false });
  private readonly intersectMaterial = new THREE.LineBasicMaterial({ color: 0xe3b45c, transparent: true, opacity: 0.85, depthTest: false });
  private readonly pickMaterial = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  private readonly pickTargets: THREE.Mesh[] = [];
  // Each guide's whole surface (`pickGuides`).
  private readonly guideTargets: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private revision = 0;
  // Each node's built geometry (`shapeOf`), and which sync last used it.
  private readonly built = new Map<SolidNode, { surface: THREE.BufferGeometry; edges: THREE.EdgesGeometry; used: number }>();
  private pass = 0;

  constructor(private readonly changed: () => void) {
    this.group.name = "solid-guides";
    this.group.renderOrder = 10;
  }

  // The materials a guide of this colour is drawn in.
  private materials(color: number): GuideMaterials {
    let m = this.palette.get(color);
    if (m) return m;
    m = {
      // The selected guide's edges, drawn in front with its volume.
      line: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }),
      // An unselected guide's edges sit in the scene, hidden by what stands
      // in front of them, as its volume is.
      faint: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 }),
      // A guide's volume: its colour, lit so its faces read as a form,
      // see-through so what is behind and inside it stays visible. An
      // unselected guide is depth-tested, so the scene in front of it hides
      // it, lit by the scene alone and faint, because a level holds many
      // guides one behind another and their layers add up - 25 river
      // backdrops at 22% and self-lit fogged the whole view white
      // (2026-11-22).
      volume: new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.1, depthWrite: false, flatShading: true }),
      // The guide being edited is drawn IN FRONT (Blender's "In Front"),
      // stronger and a little self-lit, with its edges, its cuts and the
      // gizmo, so it is never lost behind the foreground while it is worked
      // on.
      active: new THREE.MeshLambertMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        depthTest: false,
        flatShading: true,
      }),
    };
    this.palette.set(color, m);
    return m;
  }

  // `items`: the formations whose guides are to be drawn (the editor's
  // "show guides" and per-formation view decide which). `active`: the
  // formation items selected or in a selected body, whose guides are drawn
  // at full strength and in front. `colorOf`: each guide's colour.
  sync(items: readonly EdItem[], sel: SolidSel | null, active: ReadonlySet<number>, colorOf: (item: EdItem) => number = () => GUIDE): void {
    const solids = items.filter((i) => i.object === "formation" && i.formation?.guide.kind === "solid");
    const key = JSON.stringify([
      this.revision,
      sel,
      [...active].filter((id) => solids.some((s) => s.id === id)),
      // Each one's whole 3D frame, which a 3D body's depth and tilt move with
      // no item changing, and its colour.
      solids.map((i) => [i.id, itemMatrix(i).elements, i.formation!.guide, colorOf(i)]),
    ]);
    if (key === this.key) return;
    this.key = key;
    this.clear();
    this.pass++;
    for (const item of solids) {
      const tree = (item.formation!.guide as { tree: SolidNode }).tree;
      // Drawn with what has loaded; redrawn when the rest lands.
      requestMeshes(tree, () => this.landed());
      const holder = new THREE.Group();
      // In the item's 3D frame: its body's, when the body is 3D.
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(itemMatrix(item));
      this.group.add(holder);
      this.holders.set(item.id, holder);
      const whole = this.shapeOf(tree);
      const look = this.materials(colorOf(item));
      if (whole) {
        holder.add(this.lines(whole.edges, active.has(item.id) ? look.line : look.faint));
        // The guide's VOLUME: a translucent, lit, faceted shell (flat shaded
        // by its material), so the form reads as a solid and not as a tangle
        // of lines - and the surface a click on it lands on, selecting its
        // formation as a click on a mesh does (`pickGuides`). Every guide
        // handed in is shown: whether a generated rock's guide is drawn over
        // it is the editor's "show guides" (until 2026-11-23 it showed only
        // while selected).
        const surface = new THREE.Mesh(whole.surface, active.has(item.id) ? look.active : look.volume);
        // The selected guide's, drawn in front, after everything the scene
        // draws (water included); the others among the scene's own.
        surface.renderOrder = active.has(item.id) ? 25 : 9;
        surface.userData.solidItem = item.id;
        this.guideTargets.push(surface);
        holder.add(surface);
      }
      // The guide being edited, shape by shape (formation/solidStack.ts): each
      // cut drawn red and each intersection amber, as Blender draws its
      // boolean cutters, and every shape a surface a click picks. Not the
      // base: it is the whole rock, and a click on the rock is a click on the
      // body, as a click on the object is in Blender. Its row in the panel
      // picks it.
      if (active.has(item.id)) {
        stackOf(tree).forEach((entry, i) => {
          if (i === 0) return;
          const shape = this.shapeOf(entry.node);
          if (!shape) return;
          if (entry.mode !== "add") holder.add(this.lines(shape.edges, entry.mode === "subtract" ? this.cutMaterial : this.intersectMaterial));
          const target = new THREE.Mesh(shape.surface, this.pickMaterial);
          target.userData.solidPick = { itemId: item.id, path: entry.path };
          this.pickTargets.push(target);
          holder.add(target);
        });
      }
      if (sel?.itemId !== item.id) continue;
      const node = nodeAt(tree, sel.path);
      if (!node) continue;
      // The picked node on its own, in its place in the tree's frame.
      const alone = this.shapeOf(node);
      if (alone) holder.add(this.lines(alone.edges, this.pickedMaterial));
    }
    // What no guide drew this time goes (a guide edited, removed, hidden).
    for (const [node, built] of this.built) {
      if (built.used === this.pass) continue;
      built.surface.dispose();
      built.edges.dispose();
      this.built.delete(node);
    }
  }

  // A node's surface and edges, built once per node object (an edit replaces
  // a tree rather than changing it, so the same object is the same solid): a
  // selection change redraws a 200k-triangle sculpt without meshing it again
  // (measured 2026-11-23: 0.9 s a click before this). One with a mesh still
  // loading is built for now and not kept.
  private shapeOf(node: SolidNode): { surface: THREE.BufferGeometry; edges: THREE.EdgesGeometry } | null {
    const have = this.built.get(node);
    if (have) {
      have.used = this.pass;
      return have;
    }
    const made = guideMesh(node);
    if (!made.mesh) return null;
    const surface = geometryOf(made.mesh);
    const edges = new THREE.EdgesGeometry(surface, EDGE_DEGREES);
    if (made.missing.length) {
      this.owned.push(surface, edges);
      return { surface, edges };
    }
    const built = { surface, edges, used: this.pass };
    this.built.set(node, built);
    return built;
  }

  private landed(): void {
    this.revision++;
    this.changed();
  }

  // The box a solid guide occupies (three's frame), as drawn: what **F**
  // frames for a backdrop, which stands well off the gameplay plane. Null for
  // an item with no solid guide drawn (or none loaded yet).
  boxOf(itemId: number): THREE.Box3 | null {
    const holder = this.holders.get(itemId);
    if (!holder || !holder.children.length) return null;
    holder.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(holder);
    return box.isEmpty() ? null : box;
  }

  private lines(edges: THREE.EdgesGeometry, material: THREE.LineBasicMaterial): THREE.LineSegments {
    const lines = new THREE.LineSegments(edges, material);
    // Over the volumes, the selected one's included.
    lines.renderOrder = 30;
    // A guide is never what a click lands on: the rock is, or the panel.
    lines.raycast = () => {};
    return lines;
  }

  private clear(): void {
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
    this.group.clear();
    this.holders.clear();
    this.pickTargets.length = 0;
    this.guideTargets.length = 0;
  }

  // The formation items whose drawn solid guide is under a screen point (normalised
  // device coordinates through `camera`), nearest first: what a click on a
  // backdrop's guide selects. Which side of the gameplay plane that is, is the
  // caller's to judge, against every surface it was given for the item (the
  // editor's `raycastItems`).
  pickGuides(ndc: { x: number; y: number }, camera: THREE.Camera): { id: number; distance: number }[] {
    if (!this.guideTargets.length) return [];
    this.group.updateWorldMatrix(true, true);
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const out: { id: number; distance: number }[] = [];
    for (const hit of this.raycaster.intersectObjects(this.guideTargets, false)) {
      // Only a guide that is DRAWN: a generated rock's guide is an invisible
      // shell (unless it is selected), and the rock is what is on screen and
      // what a click on it means - the shell can stand proud of the rock, in
      // front of another one, and must not take a click aimed at that.
      if ((hit.object as THREE.Mesh).material === this.pickMaterial) continue;
      const id = hit.object.userData.solidItem as number | undefined;
      if (id === undefined || out.some((o) => o.id === id)) continue;
      out.push({ id, distance: hit.distance });
    }
    return out;
  }

  // The shape of an edited guide under a screen point (normalised device
  // coordinates through `camera`), nearest first: what a click on a shape in
  // the view picks. Null over none.
  pickShape(ndc: { x: number; y: number }, camera: THREE.Camera): SolidSel | null {
    if (!this.pickTargets.length) return null;
    this.group.updateWorldMatrix(true, true);
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const hit = this.raycaster.intersectObjects(this.pickTargets, false)[0];
    const pick = hit?.object.userData.solidPick as { itemId: number; path: number[] } | undefined;
    return pick ? { itemId: pick.itemId, path: pick.path } : null;
  }

  dispose(): void {
    this.clear();
    for (const built of this.built.values()) {
      built.surface.dispose();
      built.edges.dispose();
    }
    this.built.clear();
    for (const m of this.palette.values()) for (const material of Object.values(m)) material.dispose();
    this.palette.clear();
    this.pickedMaterial.dispose();
    this.cutMaterial.dispose();
    this.intersectMaterial.dispose();
    this.pickMaterial.dispose();
  }
}
