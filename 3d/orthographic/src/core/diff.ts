// What changed between two states of a scene, in the document's vocabulary:
// which objects were added, removed or changed (and which of their fields),
// and which scene, camera, reference and display settings. The server logs one
// of these per revision, so an agent can see what a person did in between.

import { worldRing } from "./ring";
import type { EditorState, SceneObject } from "./types";
import { VIEW_IDS } from "./views";

export interface ChangeSummary {
  objects: { added: string[]; removed: string[]; changed: Record<string, string[]> };
  /** Changed scene fields: title, size, scale.basis, notes. */
  scene: string[];
  /** Changed camera fields, as the document names them. */
  camera: string[];
  /** Views whose reference was added, removed or changed. */
  references: string[];
  display: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The fields of an object that differ, named as in the document: outlines
 * per view in metres (parts.<k>.outlines.<view> for an object of several
 * parts, or parts when their number or names changed).
 */
function objectFields(a: SceneObject, b: SceneObject): string[] {
  const out: string[] = [];
  const names = (e: SceneObject) => e.parts.map((p) => p.id ?? "");
  if (a.parts.length !== b.parts.length || !same(names(a), names(b))) out.push("parts");
  else
    a.parts.forEach((_, k) => {
      for (const view of VIEW_IDS)
        if (!same(worldRing(a, view, k), worldRing(b, view, k)))
          out.push(a.parts.length === 1 ? `outlines.${view}` : `parts.${k}.outlines.${view}`);
    });
  for (const k of ["name", "kind", "color", "visible", "locked", "reviewed", "opacity", "notes"] as const)
    if (a[k] !== b[k]) out.push(k);
  if (!same(a.trace ?? null, b.trace ?? null)) out.push("trace");
  if (!same(a.inFrontOf ?? [], b.inFrontOf ?? [])) out.push("inFrontOf");
  return out;
}

const CAMERA_FIELDS: Record<string, string> = {
  position: "position",
  target: "target",
  fov: "verticalFovDegrees",
  roll: "rollDegrees",
  near: "near",
  far: "far",
  frame: "frame",
  locked: "locked",
  shift: "shift",
};

export function diffStates(a: EditorState, b: EditorState): ChangeSummary {
  const before = new Map(a.objects.map((e) => [e.id, e]));
  const after = new Map(b.objects.map((e) => [e.id, e]));
  const changed: Record<string, string[]> = {};
  for (const [id, e] of after) {
    const old = before.get(id);
    if (!old) continue;
    const fields = objectFields(old, e);
    if (fields.length) changed[id] = fields;
  }
  const camera = a.camera as unknown as Record<string, unknown>;
  const camera2 = b.camera as unknown as Record<string, unknown>;
  return {
    objects: {
      added: [...after.keys()].filter((id) => !before.has(id)),
      removed: [...before.keys()].filter((id) => !after.has(id)),
      changed,
    },
    scene: [
      ...(a.scene.title !== b.scene.title ? ["title"] : []),
      ...(!same(a.scene.size, b.scene.size) ? ["size"] : []),
      ...((a.scene.scaleBasis ?? "") !== (b.scene.scaleBasis ?? "") ? ["scale.basis"] : []),
      ...(a.scene.notes !== b.scene.notes ? ["notes"] : []),
    ],
    camera: Object.keys(CAMERA_FIELDS)
      .filter((k) => !same(camera[k], camera2[k]))
      .map((k) => CAMERA_FIELDS[k]),
    references: (["front", "top", "side", "perspective"] as const).filter(
      (v) => !same(a.references[v], b.references[v]),
    ),
    display: (["style", "grid", "labels", "crosshair"] as const).filter((k) => a.display[k] !== b.display[k]),
  };
}
