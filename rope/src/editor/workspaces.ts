// THE EDITOR'S WORKSPACES (docs/editor.md, "Workspaces"): one editor, four
// arrangements of it, one per workflow, as Blender's Layout / Modeling /
// Texture Paint tabs are. Each decides
//
// - how the view moves: 2D is locked head on to the gameplay plane (middle
//   drag pans, the wheel zooms about the plane), the other two orbit freely;
// - what is offered in the left dock: 2D the drawing tools and the layers,
//   Formations the guides and the generators, Decorations the decoration
//   palette and the brush, Texturing the material library and the brush;
// - what is in the workspace at all: what the overlay draws and what a click
//   or a band can pick (`inWorkspace`), what the outliner lists, and which
//   inspector sections are shown (`sectionShown`) and open first.
//
// Nothing here touches the level: a workspace is how the author is working,
// remembered by this browser (`readWorkspace`) and in the address bar.

import type { NodeType } from "../level/nodes";
import type { EdItem, EdLayer } from "./model";

export type Workspace = "2d" | "formations" | "decorations" | "texturing";

export const WORKSPACES: readonly Workspace[] = ["2d", "formations", "decorations", "texturing"];

export const WORKSPACE_LABELS: Record<Workspace, string> = {
  "2d": "2D",
  formations: "Formations",
  decorations: "Decorations",
  texturing: "Texturing",
};

export const WORKSPACE_TITLES: Record<Workspace, string> = {
  "2d":
    "The gameplay plane head on: collision outlines, chains, vines, roots, mushrooms, lights, camera regions and notes (1)",
  formations: "Free 3D view: solid and collision guides, and generating rock from them (2)",
  decorations: "Free 3D view: placing, painting and growing moss, ivy, ferns, vines and mushrooms on the rocks (3)",
  texturing: "Free 3D view: painting the rocks with materials from the library, Blender materials baked onto each rock (4)",
};

// The view never leaves the plane head on.
export const HEAD_ON_ONLY: Record<Workspace, boolean> = {
  "2d": true,
  formations: false,
  decorations: false,
  texturing: false,
};

// The layers each workspace edits. The 3D workspaces work on the scene alone:
// camera regions, fog, notes and the rest are plane furniture, and drawn over
// a rock seen from the side they are noise in the way of the click.
export function workspaceLayers(ws: Workspace): readonly EdLayer[] | null {
  return ws === "2d" ? null : ["scene"];
}

// Whether an item is part of the workspace: drawn by the overlay, picked by a
// click or a band, listed in the scene tree. `is3d` says whether it stands in
// a 3D frame (`Node3D`, `Formation3D`: no collision, free to stand at a depth).
//
// - 2D: everything on the plane. A 3D body (a backdrop) is not, nor is a
//   decoration: both are worked on in their own workspaces, and the scene
//   still draws them.
// - Formations: the bodies a rock is made from - the formations themselves and
//   the collision a guide is taken from.
// - Decorations: the rocks and what grows on them.
// - Texturing: the rocks and the materials painted on them (material layers,
//   decorations of kind `material`, which Decorations leaves out).
export function inWorkspace(ws: Workspace, item: EdItem, is3d: boolean): boolean {
  const material = item.decoration?.kind === "material";
  switch (ws) {
    case "2d":
      return !is3d && item.object !== "decoration";
    case "formations":
      return item.layer === "scene" && (item.object === "formation" || item.object === "collision");
    case "decorations":
      return item.layer === "scene" && (item.object === "formation" || (item.object === "decoration" && !material));
    case "texturing":
      return item.layer === "scene" && (item.object === "formation" || (item.object === "decoration" && material));
  }
}

// The workspaces whose brush paints decorations on the rocks.
export function paintsRocks(ws: Workspace): boolean {
  return ws === "decorations" || ws === "texturing";
}

// THE INSPECTOR, per workspace. 2D hides only what belongs to the other two;
// the 3D workspaces show the few sections their work needs, so a rock's panel
// is its recipe and not its bounce, friction and mover first.
const HIDDEN_IN_2D = ["body/Formation", "formation/Formation", "body/Decorations", "formation/Decorations", "body/Materials", "formation/Materials", "decoration/"];
const SHOWN: Record<Exclude<Workspace, "2d">, readonly string[]> = {
  formations: [
    "node/",
    // The level's own nodes, picked in the scene tree: the spawn and the
    // light (the Sun, the Environment) read the same in every workspace.
    "level/Player spawn",
    "light/",
    "body/Transform",
    "body/Formation",
    "formation/Transform",
    "formation/Formation",
    "object/Transform",
    "object/Debug",
  ],
  decorations: [
    "node/",
    // The level's own nodes, picked in the scene tree: the spawn and the
    // light (the Sun, the Environment) read the same in every workspace.
    "level/Player spawn",
    "light/",
    "body/Decorations",
    "formation/Decorations",
    "decoration/",
  ],
  texturing: [
    "node/",
    // The level's own nodes, picked in the scene tree: the spawn and the
    // light (the Sun, the Environment) read the same in every workspace.
    "level/Player spawn",
    "light/",
    "body/Materials",
    "formation/Materials",
    "decoration/",
  ],
};

// WHAT A CLICK ON THE CANVAS STOPS AT, per workspace (plans/node-tree.md
// "Workspaces"): a group root whose class is clickable here selects first; the
// others pass the click through to what is under them. So in Decorations a
// click on a fern selects the fern, though the body above it is grouped.
const CLICKABLE: Record<Workspace, ReadonlySet<NodeType>> = {
  "2d": new Set<NodeType>([
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
    "Shelter2D",
    "FogRegion2D",
    "Note2D",
    "Chain",
    "Vine",
    "Instance",
  ]),
  formations: new Set<NodeType>(["Node3D", "Formation3D", "Model3D", "Light3D", "Instance"]),
  decorations: new Set<NodeType>(["Decoration3D"]),
  texturing: new Set<NodeType>([]),
};

export function clickableIn(ws: Workspace, type: NodeType): boolean {
  return CLICKABLE[ws].has(type);
}

// A key matches an entry equal to it, or under it when the entry ends in "/".
const matches = (key: string, entry: string): boolean => (entry.endsWith("/") ? key.startsWith(entry) : key === entry);

export function sectionShown(ws: Workspace, key: string): boolean {
  if (ws === "2d") return !HIDDEN_IN_2D.some((e) => matches(key, e));
  return SHOWN[ws].some((e) => matches(key, e));
}

// The sections a workspace opens until the author closes them: the one its
// work is done in.
export const PRIMARY_SECTIONS: readonly string[] = [
  "body/Formation",
  "formation/Formation",
  "body/Decorations",
  "formation/Decorations",
  "body/Materials",
  "formation/Materials",
  "decoration/Decoration",
  // A placed prefab's: which prefab, what this instance changes in it.
  "node/Prefab",
  // The level's own nodes and volumes: what they ARE is the whole of their
  // panel, so it is open when one is picked.
  "level/Player spawn",
  "light/Sun",
  "light/Environment",
  "fog/Fog",
  "shelter/Wall",
];

// What the inspector says with nothing selected, in the 3D workspaces (2D says
// what the active layer is for).
export const EMPTY_HINTS: Record<Exclude<Workspace, "2d">, string> = {
  formations:
    "Formations: click a rock or a guide to edit its recipe and Generate it. A body with collision and no rock offers a recipe to generate one from its outline. Primitives (or Shift+A) add a new guide where the view is looking; with a guide selected, Shift+A (or Add to selected guide) adds a shape to its stack. G, R and S grab, rotate and scale the selection (X / Y / Z hold an axis); the gizmo's centre box drags it in the view plane. Middle drag orbits, F frames the selection.",
  decorations:
    "Decorations: pick a kind on the left and click a generated rock to place it (moss and ivy then paint: drag on the rock, it grows when you let go). Click a rock to list what grows on it, or a decoration to edit, move or repaint it. Middle drag orbits, F frames the selection.",
  texturing:
    "Texturing: pick a material on the left and drag on a generated rock to paint it, right-drag to erase; Enter bakes what you painted for the game, Esc throws the strokes away. The materials are Blender files in assets-src/materials: save one in Blender and the rocks show it again. Click a painted patch to select it. Middle drag orbits, F frames the selection.",
};

// --- remembered per browser --------------------------------------------------

const WORKSPACE_KEY = "rope.editor.workspace";

export function parseWorkspace(raw: string | null | undefined): Workspace | null {
  return WORKSPACES.includes(raw as Workspace) ? (raw as Workspace) : null;
}

export function readWorkspace(): Workspace {
  try {
    return parseWorkspace(localStorage.getItem(WORKSPACE_KEY)) ?? "2d";
  } catch {
    return "2d";
  }
}

export function writeWorkspace(ws: Workspace): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, ws);
  } catch {
    // Unwritable storage: remembered for this page only.
  }
}
