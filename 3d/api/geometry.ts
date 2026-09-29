// Geometry for the server: the same checks as the editor (core/document.ts
// geometryIssues, core/compare.ts), with each object's solid and mesh
// remembered by shape, so checking a scene again costs only its changes.
// Exact meshing takes milliseconds per object, so it runs in-process.

import { referenceIssues } from "../orthographic/src/core/compare";
import { geometryIssues } from "../orthographic/src/core/document";
import { buildMesh, type Mesh, type MeshMeta, solidMeta } from "../orthographic/src/core/mesher";
import type { ImageSize } from "../orthographic/src/core/overlay";
import type { EditorState, Issue, SceneObject } from "../orthographic/src/core/types";

const META_LIMIT = 4000;
const MESH_LIMIT = 600;
const metas = new Map<string, MeshMeta>();
const meshes = new Map<string, Mesh>();

function remember<T>(cache: Map<string, T>, limit: number, key: string, make: () => T): T {
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = make();
    cache.set(key, hit);
    while (cache.size > limit) cache.delete(cache.keys().next().value!);
  } else {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

const metaOf = (e: SceneObject) => remember(metas, META_LIMIT, JSON.stringify(e.parts), () => solidMeta(e.parts));

/** An object's drawn surface (the size decides its creases). */
export const meshOf = (e: SceneObject): Mesh =>
  remember(meshes, MESH_LIMIT, `${e.size.join(",")}|${JSON.stringify(e.parts)}`, () => buildMesh(e.parts, e.size));

/** Image pixel sizes by id. */
export type ImageLookup = (id: string) => ImageSize | undefined;

/** The images a document lists (with or without their data), then those `known` elsewhere. */
export const documentImages =
  (doc: unknown, known?: ImageLookup): ImageLookup =>
  (id) =>
    (doc as { images?: Record<string, ImageSize> } | null)?.images?.[id] ?? known?.(id);

/** The perspective reference image's pixel size, when the scene has one. */
export const perspectiveImage = (s: EditorState, images: ImageLookup) =>
  s.references.perspective ? images(s.references.perspective.image) : undefined;

/**
 * Problems with the solids of every object (or just `only`), and, for objects
 * with traces, with how they match the perspective reference.
 */
export async function checkGeometry(s: EditorState, images: ImageLookup, only?: ReadonlySet<string>): Promise<Issue[]> {
  const solids = geometryIssues(
    s,
    (id) => {
      const e = s.objects.find((o) => o.id === id);
      return e && metaOf(e);
    },
    only,
  );
  const traced = s.objects.some((e) => e.trace && (!only || only.has(e.id)));
  return traced ? [...solids, ...referenceIssues(s, meshOf, perspectiveImage(s, images), only)] : solids;
}
