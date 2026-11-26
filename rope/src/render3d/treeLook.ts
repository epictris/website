// THE LEVEL'S LOOK, DRAWN FROM ITS NODE TREE (plans/node-tree.md "Rendering").
//
// Every spatial node is one `THREE.Object3D`, parented as the tree is parented,
// so one rule carries everything: a node's children inherit its transform. A
// body node's object is the BODY'S AUTHORED FRAME, a child of the body's own
// visual (`BodyVisual.frame`), which the engine body moves every frame; a rock,
// a model or a lamp under a swinging crate swings with it because it is under
// it, and a rock with no body above it stands where its own pose and its
// parents' put it. That replaces the per-body carrying code, the 3D body (a
// body the sim never saw, kept only as a frame for backdrop rock) and the
// formation-on-a-body lookup with the scene graph.
//
// What is drawn here is the look: formations (rock), decorations grown on
// them, models and lights. What a body's SHAPES draw - debug geometry, belts,
// roots, water - stays with the body's visual (`bodyVisuals.ts`), since it is
// made from what the body collides as.
//
// Every drawn thing answers a pick with its node's id (`pickTagOf`).

import * as THREE from "three";
import type { ContactPulses } from "../engine/contactPulses";
import type { CollisionObject2D } from "../engine/body";
import { mushroomParameters } from "../level/mushroom";
import { objectDepth } from "../level/buildBodies";
import type { DecorationObjectData, LightObjectData } from "../level/levelFormat";
import { formationDataOf, isBodyNode, type DecorationNode, type FormationNode, type LevelNode, type ModelNode, type Pose3D } from "../level/nodes";
import { decorationFile, decorationLayerFile, isMaterialLayer, isTextureLayer } from "../formation/decoration";
import { decodedFile, loadExportFile, loadModelFile, mountExport, noShadowBehindPlane } from "./exportFiles";
import { decodedFormationFile, decorationDelta, formationFile, loadFormationFile } from "./formations";
import { isWaking } from "./glow";
import { DEFAULT_LIGHT_Z, type DrivenEmission, type LightRig, type MountedLight } from "./lights";
import { materialPaintLayer } from "./materialLayers";
import { modelFile } from "./models";
import { MushroomBounce } from "./mushroomBounce";
import { exposePaintUv, layered, paintLayerTexture, type PaintLayer } from "./paintLayers";
import { proceduralMushroom } from "./proceduralMushroom";
import { orientTo, placeBody3d, threeY } from "./space";

// The flat element a node draws as, which the loaders and the paint layers
// are written against.
function decorationData(n: DecorationNode, formation: string): DecorationObjectData {
  const { type: _t, id, name: _n, children: _c, grouped: _g, locked: _lk, layers: _l, disabled: _d, ...rest } = n;
  return { type: "decoration", id, formation, ...rest } as DecorationObjectData;
}


// A body, or the top-level frame a bodiless node is gathered under: what a
// waking light drives the glow of, and what a mushroom bounces with.
interface Carrier {
  id: string;
  solid: boolean;
  waking: boolean;
  driven: DrivenEmission[];
}

export interface TreeLookOptions {
  // The frame each body node is drawn in (`BodyVisual.frame`), by node id;
  // a body with none (it builds nothing) is drawn where it was authored.
  bodyFrame: (id: string) => THREE.Object3D | null;
  // Does this body collide (and so cast a shadow wherever its look is set back)?
  solid: (id: string) => boolean;
  rig?: LightRig;
  shown?: boolean;
}

export class TreeLook {
  // The world frame every top-level node hangs from.
  readonly root = new THREE.Group();
  // Every spatial node's object, by node id.
  readonly objects = new Map<string, THREE.Object3D>();
  private readonly owned: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly lights: MountedLight[] = [];
  // The holders the look is drawn in, hidden and shown as one (`setShown`).
  private readonly holders: THREE.Object3D[] = [];
  private readonly decorationInner = new Map<string, THREE.Group>();
  private readonly mushrooms: { bounce: MushroomBounce; carrier: string }[] = [];
  private readonly carriers = new Map<string, Carrier>();
  private shown: boolean;
  private disposed = false;
  // A file landing after the look was built: what is drawn changed, which the
  // glass shards' collision is built from.
  modelLanded: (() => void) | null = null;

  constructor(
    nodes: readonly LevelNode[],
    private readonly opts: TreeLookOptions,
  ) {
    this.root.name = "tree";
    this.shown = opts.shown ?? true;
    for (const n of nodes) this.build(n, this.root, null);
  }

  private carrierFor(n: LevelNode, up: Carrier | null): Carrier | null {
    if (!isBodyNode(n) && up) return up;
    // A body, or a top-level frame: what the latter holds is carried by
    // nothing that moves, and collides with nothing.
    const carrier = { id: n.id, solid: isBodyNode(n) && this.opts.solid(n.id), waking: hasWakingLight(n), driven: [] };
    this.carriers.set(n.id, carrier);
    return carrier;
  }

  // What a carrier's waking lights drive (`LightRig`), and taking a node into
  // its look: for a probe, and for whatever mounts a look of its own.
  drivenOf(id: string): readonly DrivenEmission[] {
    return this.carriers.get(id)?.driven ?? [];
  }

  adoptLook(id: string, node: THREE.Object3D): void {
    const carrier = this.carriers.get(id);
    if (carrier) this.adopt(node, carrier);
  }

  private build(n: LevelNode, parent: THREE.Object3D, up: Carrier | null): void {
    if (n.disabled) return;
    const carrier = this.carrierFor(n, up);
    let here: THREE.Object3D | null = null;
    switch (n.type) {
      case "StaticBody2D":
      case "AnimatableBody2D":
      case "RigidBody2D":
      case "Area2D": {
        here = this.opts.bodyFrame(n.id) ?? placed2D(new THREE.Group(), n);
        if (!here.parent) parent.add(here);
        break;
      }
      case "Node2D":
      case "CollisionShape2D":
      case "Anchor2D":
        if (!n.children?.length) return;
        here = placed2D(new THREE.Group(), n);
        parent.add(here);
        break;
      case "Node3D":
        here = placed3D(new THREE.Group(), n);
        parent.add(here);
        break;
      case "Node":
        here = new THREE.Group();
        this.root.add(here);
        break;
      case "Formation3D":
        here = this.mountFormation(n, parent, carrier!);
        break;
      case "Model3D":
        this.mountModel(n, parent, carrier!);
        return;
      case "Light3D":
        this.mountLight(n, parent, carrier!);
        return;
      case "Decoration3D":
        // Drawn by its formation, which it is always the child of.
        return;
      default:
        // The rest are volumes and marks in the plane: drawn by the 2D
        // overlay, the camera, the fog and the sky, not here.
        return;
    }
    here.name ||= `${n.type}:${n.name}`;
    this.objects.set(n.id, here);
    for (const c of n.children ?? []) this.build(c, here, carrier);
  }

  // The look's emissive materials become this carrier's own copies, driven by
  // its waking lights (`LightRig`), so one lamp's glow lights up nothing else.
  private adopt(node: THREE.Object3D, carrier: Carrier): void {
    if (!carrier.waking) return;
    const copies = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const own = (m: THREE.Material): THREE.Material => {
        const std = m as THREE.MeshStandardMaterial;
        if (!std.isMeshStandardMaterial || (std.emissive.getHex() === 0 && !std.emissiveMap)) return m;
        let copy = copies.get(m);
        if (!copy) {
          copy = std.clone();
          copy.onBeforeCompile = std.onBeforeCompile;
          copy.customProgramCacheKey = std.customProgramCacheKey;
          copies.set(m, copy);
          this.ownedMaterials.push(copy);
          carrier.driven.push({ material: copy, authored: copy.emissiveIntensity });
        }
        return copy;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
    });
  }

  private land(node: THREE.Object3D, holder: THREE.Object3D, carrier: Carrier, late: boolean): void {
    holder.add(node);
    node.updateWorldMatrix(true, true);
    // What collides casts, wherever its look has been set back to; what
    // collides with nothing is decoration and casts nothing behind the plane.
    if (!carrier.solid) noShadowBehindPlane(node);
    this.adopt(node, carrier);
    if (late) this.modelLanded?.();
  }

  // A MODEL of the library (render3d/models.ts): placed in the plane at the
  // node's x, y and turn, its depth, tilts and scale on a holder inside, so
  // the tilts are applied before the turn and a model tilted to show its side
  // keeps showing it as its body swings.
  private mountModel(n: ModelNode, parent: THREE.Object3D, carrier: Carrier): void {
    const piece = placed2D(new THREE.Group(), n);
    piece.userData["pickTag"] = n.id;
    piece.name = `model:${n.model}`;
    const holder = new THREE.Group();
    holder.position.z = objectDepth(n.z, 0);
    // Ry * Rx: about the screen's horizontal axis first, then its vertical.
    holder.rotation.set(n.rotX ?? 0, n.rotY ?? 0, 0, "YXZ");
    holder.scale.setScalar(n.scale ?? 1);
    piece.add(holder);
    piece.visible = this.shown;
    parent.add(piece);
    this.holders.push(piece);
    this.objects.set(n.id, piece);
    const params = mushroomParameters(n.model, n.mushroom);
    if (params) {
      const node = proceduralMushroom(params);
      node.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          this.owned.push(child.geometry);
          this.ownedMaterials.push(child.material as THREE.Material);
          // ...and the shadow material its meshes share (proceduralMushroom.ts).
          const shadow = child.customDistanceMaterial;
          if (shadow && !this.ownedMaterials.includes(shadow)) this.ownedMaterials.push(shadow);
        }
      });
      this.mushrooms.push({ bounce: new MushroomBounce(node, params.stemHeight), carrier: carrier.id });
      this.land(node, holder, carrier, false);
      return;
    }
    const arrive = (loaded: THREE.Object3D | null, late: boolean): void => {
      if (!loaded || this.disposed) return;
      this.land(mountExport(loaded), holder, carrier, late);
    };
    const ready = decodedFile(modelFile(n.model));
    if (ready !== undefined) arrive(ready, false);
    else void loadModelFile(n.model).then((loaded) => arrive(loaded, true));
  }

  // A FORMATION (docs/formations.md): the rock generated in its own frame,
  // which its pose puts in its parent's. It wears its TEXTURE LAYERS - the
  // decorations under it that grow no mesh - and its other decorations are
  // drawn under it, each moved from where it grew to where its anchor lands on
  // the rock now. A formation inside a scaled prefab instance is drawn at the
  // instance's scale (`placedScale`), its decorations with it.
  private mountFormation(n: FormationNode, parent: THREE.Object3D, carrier: Carrier): THREE.Object3D {
    const holder = placed3D(new THREE.Group(), n);
    holder.name = `formation:${n.id}`;
    holder.userData["pickTag"] = n.id;
    parent.add(holder);
    const scaled = new THREE.Group();
    scaled.scale.setScalar(n.placedScale ?? 1);
    holder.add(scaled);
    scaled.visible = this.shown;
    this.holders.push(scaled);
    const f = formationDataOf(n);
    const decorations = (n.children ?? []).filter((c): c is DecorationNode => c.type === "Decoration3D" && !c.disabled).map((c) => decorationData(c, n.id));
    const which = formationFile(f);
    if (which) {
      // Material layers first, then the grown texture-only mosses over them,
      // each in tree order: dirt under moss however they were painted.
      const mine = decorations.filter(isTextureLayer);
      const layers: PaintLayer[] = [
        ...mine.filter(isMaterialLayer).flatMap((o) => materialPaintLayer(o) ?? []),
        ...mine.filter((o) => !isMaterialLayer(o) && !!o.built).map((o) => ({ texture: paintLayerTexture(decorationLayerFile(o.built!.hash)), tag: o.id })),
      ];
      const arrive = (loaded: THREE.Object3D | null, late: boolean): void => {
        if (!loaded || this.disposed) return;
        const node = mountExport(loaded);
        if (layers.length) this.wearLayers(node, layers, which.baked);
        this.land(node, scaled, carrier, late);
      };
      const ready = decodedFormationFile(which);
      if (ready !== undefined) arrive(ready, false);
      else void loadFormationFile(which).then((loaded) => arrive(loaded, true));
    }
    for (const d of decorations) {
      if (!d.built || isTextureLayer(d)) continue;
      const piece = new THREE.Group();
      piece.name = `decoration:${d.id}`;
      piece.userData["pickTag"] = d.id;
      const inner = new THREE.Group();
      inner.matrixAutoUpdate = false;
      inner.matrix.copy(decorationDelta(d));
      piece.add(inner);
      scaled.add(piece);
      this.decorationInner.set(d.id, inner);
      this.objects.set(d.id, piece);
      const file = decorationFile(d.built.hash);
      const arrive = (loaded: THREE.Object3D | null, late: boolean): void => {
        if (!loaded || this.disposed) return;
        this.land(mountExport(loaded), inner, carrier, late);
      };
      const ready = decodedFile(file);
      if (ready !== undefined) arrive(ready, false);
      else void loadExportFile(file, 0, `decoration ${d.id}`).then((loaded) => arrive(loaded, true));
    }
    return holder;
  }

  // A rock's materials, each a copy with the layers over its colour, on every
  // mesh that has the paint UV (a rock generated before it shows none).
  private wearLayers(node: THREE.Object3D, layers: readonly PaintLayer[], baked: boolean): void {
    const copies = new Map<THREE.Material, THREE.Material>();
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material) || !exposePaintUv(mesh.geometry, baked)) return;
      let copy = copies.get(mesh.material);
      if (!copy) {
        copy = layered(mesh.material, layers);
        copies.set(mesh.material, copy);
        this.ownedMaterials.push(copy);
      }
      mesh.material = copy;
    });
  }

  // A LIGHT: hung on its parent's object at its own placement, so it rides
  // whatever its parent rides. The rig spends its budgets in the order lights
  // are added, which is the tree's.
  private mountLight(n: LevelNode & { type: "Light3D" }, parent: THREE.Object3D, carrier: Carrier): void {
    if (!this.opts.rig) return;
    const { type: _t, id: _id, name: _n, children: _c, grouped: _g, locked: _lk, layers: _l, disabled: _d, ...rest } = n;
    const data = { type: "light", ...rest } as LightObjectData;
    const mounted = this.opts.rig.add(
      parent,
      data,
      { x: n.x ?? 0, y: n.y ?? 0, rot: n.rot ?? 0, z: objectDepth(n.z, DEFAULT_LIGHT_Z) },
      // Only a waking light reads it; an always-on light leaves the emission
      // as authored.
      carrier.driven,
    );
    if (mounted) this.lights.push(mounted);
  }

  // Move the decorations already mounted to where `nodes` has them, without
  // rebuilding anything: what a drag of one along its rock writes every frame.
  moveDecorations(nodes: readonly LevelNode[]): void {
    const visit = (list: readonly LevelNode[], formation: string): void => {
      for (const n of list) {
        if (n.type === "Decoration3D") {
          const inner = this.decorationInner.get(n.id);
          if (inner) {
            inner.matrix.copy(decorationDelta(decorationData(n, formation)));
            inner.matrixWorldNeedsUpdate = true;
          }
        }
        if (n.children) visit(n.children, n.type === "Formation3D" ? n.id : formation);
      }
    };
    visit(nodes, "");
  }

  // Show or hide the look (`Scene3D.setSceneShown`).
  setShown(shown: boolean): void {
    this.shown = shown;
    for (const h of this.holders) h.visible = shown;
  }

  // Mushrooms bounce with the body that carries them, when it is struck.
  sync(alpha: number, pulses: ContactPulses | undefined, bodyOf: (id: string) => CollisionObject2D | null): void {
    if (!pulses) return;
    for (const m of this.mushrooms) {
      const body = bodyOf(m.carrier);
      if (body) m.bounce.sync(body, pulses, alpha);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const l of this.lights) this.opts.rig?.drop(l);
    this.lights.length = 0;
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    this.holders.length = 0;
    this.mushrooms.length = 0;
    this.objects.clear();
    this.decorationInner.clear();
    this.root.removeFromParent();
    this.root.clear();
  }
}

// Does a waking light hang on this carrier (not counting one inside a body
// below it, which is that body's)?
function hasWakingLight(n: LevelNode): boolean {
  for (const c of n.children ?? []) {
    if (c.disabled || isBodyNode(c)) continue;
    if (c.type === "Light3D" && isWaking(c as unknown as LightObjectData)) return true;
    if (hasWakingLight(c)) return true;
  }
  return false;
}

// A node's place in the plane, in three's axes.
function placed2D<T extends THREE.Object3D>(o: T, p: { x?: number; y?: number; rot?: number }): T {
  o.position.set(p.x ?? 0, threeY(p.y ?? 0), 0);
  orientTo(o, p.rot ?? 0);
  return o;
}

// ...and in the scene: depth and tilt too (`placeBody3d`'s convention).
function placed3D<T extends THREE.Object3D>(o: T, p: Pose3D): T {
  placeBody3d(o, { x: p.x ?? 0, y: p.y ?? 0, rot: p.rot ?? 0, z: p.z, tilt: p.tilt });
  return o;
}
