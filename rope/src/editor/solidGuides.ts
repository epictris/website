// Solid guides in the editor's 3D view (docs/formations.md, "Background
// guides"): each formation whose guide is a boolean tree, meshed live
// (`formation/solid.ts`) and drawn as a wireframe through whatever stands in
// front of it, in the editor only (the game never draws a guide). The node
// selected in the Formation panel is drawn in the warm accent, with handles on
// its points when it has them (a hull's, an outline's).
//
// Rebuilt only when what it draws changes: the guides, their placements, the
// selection, or a mesh leaf that has just loaded.

import * as THREE from "three";
import { meshFiles, poseMatrix, solidMesh, type SolidMesh, type StoredMesh } from "../formation/solid";
import { nodeAt, pointsOf } from "../formation/solidTree";
import { stackOf } from "../formation/solidStack";
import { meshFile } from "../formation/store";
import type { SolidNode } from "../level/levelFormat";
import type { EdItem } from "./model";
import { itemMatrix } from "./space3d";

// Which node of which formation's tree the panel has picked, and which of its
// points (null for the node itself).
// The gameplay plane in three's frame (z = 0).
const PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

export interface SolidSel {
  itemId: number;
  path: number[];
  point: number | null;
}

const GUIDE = 0x9aa6c8;
const PICKED = 0xedc282;
// The edges drawn: where faces meet at more than this many degrees.
const EDGE_DEGREES = 20;
const HANDLE_RADIUS = 0.06;

// The imported meshes the guides use, loaded once each (shared by every
// guide and the panel).
const meshes = new Map<string, StoredMesh>();
const loading = new Set<string>();
export function loadedMeshes(): ReadonlyMap<string, StoredMesh> {
  return meshes;
}
export function requestMeshes(tree: SolidNode, landed: () => void): boolean {
  let missing = false;
  for (const name of meshFiles(tree)) {
    if (meshes.has(name)) continue;
    missing = true;
    if (loading.has(name)) continue;
    loading.add(name);
    fetch(meshFile(name))
      .then((r) => (r.ok ? (r.json() as Promise<StoredMesh>) : null))
      .catch(() => null)
      .then((m) => {
        if (m) meshes.set(name, m);
        landed();
      });
  }
  return missing;
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
  const made = solidMesh(tree, meshes).mesh;
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

export class SolidGuideView {
  readonly group = new THREE.Group();
  private key = "";
  private readonly owned: { dispose(): void }[] = [];
  // Each drawn guide's holder, by item id (`boxOf`).
  private readonly holders = new Map<number, THREE.Group>();
  private readonly lineMaterial = new THREE.LineBasicMaterial({ color: GUIDE, transparent: true, opacity: 0.75, depthTest: false });
  // An unselected guide's edges sit in the scene, hidden by what stands in
  // front of them, as its volume is; the selected one's are drawn in front
  // (`lineMaterial`), with its volume.
  private readonly faintMaterial = new THREE.LineBasicMaterial({ color: GUIDE, transparent: true, opacity: 0.18 });
  private readonly pickedMaterial = new THREE.LineBasicMaterial({ color: PICKED, transparent: true, opacity: 0.95, depthTest: false });
  private readonly handleMaterial = new THREE.MeshBasicMaterial({ color: GUIDE, depthTest: false });
  private readonly handlePicked = new THREE.MeshBasicMaterial({ color: PICKED, depthTest: false });
  private readonly handleGeometry = new THREE.OctahedronGeometry(HANDLE_RADIUS);
  // The stack's cutters and intersections (see `sync`), and the invisible
  // surfaces a click on a shape lands on (`pickShape`).
  private readonly cutMaterial = new THREE.LineBasicMaterial({ color: 0xef7a6b, transparent: true, opacity: 0.85, depthTest: false });
  private readonly intersectMaterial = new THREE.LineBasicMaterial({ color: 0xe3b45c, transparent: true, opacity: 0.85, depthTest: false });
  private readonly pickMaterial = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  // A guide's volume (see `sync`): the guide colour, lit so its faces read
  // as a form, a little self-lit so it shows in a dark cave, see-through so
  // what is behind and inside it stays visible. An unselected guide is
  // depth-tested, so the scene in front of it hides it; the guide being
  // edited is drawn IN FRONT (Blender's "In Front"), stronger, with its
  // edges, its cuts and the gizmo, so it is never lost behind the
  // foreground while it is worked on.
  // Unselected: lit by the scene alone and faint, because a level holds many
  // guides one behind another and their layers add up - 25 river backdrops
  // at 22% and self-lit fogged the whole view white (2026-11-22).
  private readonly volumeMaterial = new THREE.MeshLambertMaterial({
    color: GUIDE,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    flatShading: true,
  });
  private readonly volumeActive = new THREE.MeshLambertMaterial({
    color: GUIDE,
    emissive: GUIDE,
    emissiveIntensity: 0.3,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    depthTest: false,
    flatShading: true,
  });
  private readonly pickTargets: THREE.Mesh[] = [];
  // Each guide's whole surface (`pickGuides`).
  private readonly guideTargets: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private revision = 0;

  constructor(private readonly changed: () => void) {
    this.group.name = "solid-guides";
    this.group.renderOrder = 10;
  }

  // `active`: the formation items selected or in a selected body, whose guides
  // are drawn at full strength; every other guide is a faint line, so a level
  // of many backdrops is not buried under them.
  sync(items: readonly EdItem[], sel: SolidSel | null, active: ReadonlySet<number>): void {
    const solids = items.filter((i) => i.object === "formation" && i.formation?.guide.kind === "solid");
    const key = JSON.stringify([
      this.revision,
      sel,
      [...active].filter((id) => solids.some((s) => s.id === id)),
      // Each one's whole 3D frame, which a 3D body's depth and tilt move with
      // no item changing.
      // ...and whether it is generated, which decides whether its volume shows
      // unselected.
      solids.map((i) => [i.id, itemMatrix(i).elements, i.formation!.guide, !!i.formation!.built]),
    ]);
    if (key === this.key) return;
    this.key = key;
    this.clear();
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
      const whole = solidMesh(tree, meshes);
      if (whole.mesh) {
        holder.add(this.edges(whole.mesh, active.has(item.id) ? this.lineMaterial : this.faintMaterial));
        // The guide's VOLUME: a translucent, lit, faceted shell, so the form
        // reads as a solid and not as a tangle of lines - and the surface a
        // click on it lands on, selecting its formation as a click on a mesh
        // does (`pickGuides`). A generated rock is the volume itself, so its
        // guide's shell shows only while it is selected; one not generated yet
        // is nothing but its guide, so it always does.
        const g = geometryOf(whole.mesh).toNonIndexed();
        g.computeVertexNormals();
        this.owned.push(g);
        const shown = !item.formation!.built || active.has(item.id);
        const surface = new THREE.Mesh(g, shown ? (active.has(item.id) ? this.volumeActive : this.volumeMaterial) : this.pickMaterial);
        // The selected guide's, drawn in front, after everything the scene
        // draws (water included); the others among the scene's own.
        surface.renderOrder = active.has(item.id) ? 25 : 9;
        surface.userData.solidItem = item.id;
        this.guideTargets.push(surface);
        holder.add(surface);
      }
      // The guide being edited, shape by shape (formation/solidStack.ts): each
      // cut drawn red and each intersection amber, as Blender draws its
      // boolean cutters, and every shape a surface a click picks.
      if (active.has(item.id)) {
        stackOf(tree).forEach((entry, i) => {
          const shape = solidMesh(entry.node, meshes);
          if (!shape.mesh) return;
          if (i > 0 && entry.mode !== "add") holder.add(this.edges(shape.mesh, entry.mode === "subtract" ? this.cutMaterial : this.intersectMaterial));
          // Not the base: it is the whole rock, and a click on the rock is a
          // click on the body, as a click on the object is in Blender. Its
          // row in the panel picks it.
          if (i === 0) return;
          const g = geometryOf(shape.mesh);
          this.owned.push(g);
          const target = new THREE.Mesh(g, this.pickMaterial);
          target.userData.solidPick = { itemId: item.id, path: entry.path };
          this.pickTargets.push(target);
          holder.add(target);
        });
      }
      if (sel?.itemId !== item.id) continue;
      const node = nodeAt(tree, sel.path);
      if (!node) continue;
      // The picked node on its own, in its place in the tree's frame.
      const alone = solidMesh(node, meshes);
      if (alone.mesh) holder.add(this.edges(alone.mesh, this.pickedMaterial));
      const points = pointsOf(node);
      if (points && !("op" in node)) {
        const m = new THREE.Matrix4().fromArray(poseMatrix(node));
        points.forEach((p, k) => {
          const h = new THREE.Mesh(this.handleGeometry, k === sel.point ? this.handlePicked : this.handleMaterial);
          h.position.set(p[0], p[1], p[2]).applyMatrix4(m);
          h.renderOrder = 31;
          holder.add(h);
        });
      }
    }
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

  private edges(mesh: SolidMesh, material: THREE.LineBasicMaterial): THREE.LineSegments {
    const g = geometryOf(mesh);
    const e = new THREE.EdgesGeometry(g, EDGE_DEGREES);
    g.dispose();
    this.owned.push(e);
    const lines = new THREE.LineSegments(e, material);
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

  // The formation items whose solid guide is under a screen point (normalised
  // device coordinates through `camera`), nearest first: what a click on a
  // backdrop's guide selects. `behind` says the ray meets the guide only
  // beyond the gameplay plane, where whatever the plane holds at that point is
  // in front of it and is picked first.
  pickGuides(ndc: { x: number; y: number }, camera: THREE.Camera): { id: number; distance: number; behind: boolean }[] {
    if (!this.guideTargets.length) return [];
    this.group.updateWorldMatrix(true, true);
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const toPlane = this.raycaster.ray.distanceToPlane(PLANE);
    const out: { id: number; distance: number; behind: boolean }[] = [];
    for (const hit of this.raycaster.intersectObjects(this.guideTargets, false)) {
      const id = hit.object.userData.solidItem as number | undefined;
      if (id === undefined || out.some((o) => o.id === id)) continue;
      out.push({ id, distance: hit.distance, behind: toPlane !== null && hit.distance > toPlane });
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
    return pick ? { itemId: pick.itemId, path: pick.path, point: null } : null;
  }

  dispose(): void {
    this.clear();
    this.lineMaterial.dispose();
    this.faintMaterial.dispose();
    this.pickedMaterial.dispose();
    this.handleMaterial.dispose();
    this.handlePicked.dispose();
    this.handleGeometry.dispose();
    this.volumeMaterial.dispose();
    this.volumeActive.dispose();
    this.cutMaterial.dispose();
    this.intersectMaterial.dispose();
    this.pickMaterial.dispose();
  }
}
