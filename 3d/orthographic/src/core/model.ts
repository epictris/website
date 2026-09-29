// Editor state construction and queries.

import { type Box, defaultCamera, presetCamera } from "./camera";
import type { Display, EditorState, SceneObject, Vec3 } from "./types";

export const DEFAULT_SCENE_SIZE: Vec3 = [40, 30, 20];
export const DEFAULT_COLOR = "#5ee9cf";
export const MAX_OBJECTS = 300;

export function defaultDisplay(): Display {
  return { style: "solid", grid: true, labels: false, crosshair: false };
}

export function initialState(): EditorState {
  const size = [...DEFAULT_SCENE_SIZE] as Vec3;
  return {
    scene: { title: "Untitled scene", size, scaleBasis: "", notes: "" },
    objects: [],
    camera: presetCamera(defaultCamera(), "overview", { min: [0, 0, 0], max: size }),
    references: { front: null, top: null, side: null, perspective: null },
    display: defaultDisplay(),
  };
}

export const objectById = (s: EditorState, id: string) => s.objects.find((e) => e.id === id);

export function boundsOf(items: SceneObject[]): Box | null {
  if (!items.length) return null;
  return {
    min: [0, 1, 2].map((a) => Math.min(...items.map((e) => e.min[a]))) as Vec3,
    max: [0, 1, 2].map((a) => Math.max(...items.map((e) => e.min[a] + e.size[a]))) as Vec3,
  };
}

/** The scene frame, grown to include every visible object. */
export function sceneBounds(s: EditorState, includeObjects = true): Box {
  const min: Vec3 = [0, 0, 0];
  const max = [...s.scene.size] as Vec3;
  if (includeObjects)
    for (const e of s.objects)
      if (e.visible)
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], e.min[a]);
          max[a] = Math.max(max[a], e.min[a] + e.size[a]);
        }
  return { min, max };
}

/** The first free id of the form prefix-N. */
export function uniqueId(s: EditorState, prefix = "obj"): string {
  const taken = new Set(s.objects.map((e) => e.id));
  let i = 1;
  while (taken.has(`${prefix}-${i}`)) i++;
  return `${prefix}-${i}`;
}
