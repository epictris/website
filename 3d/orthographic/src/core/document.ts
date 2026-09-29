// The scene document: converting editor state to the published format and
// back, and validating a document with every problem reported at once.

import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import { cameraMatrices, cameraProblem, focalToFov, fovToFocal, horizontalFov, presetCamera } from "./camera";
import { inFrontOfIssues, issue, objectFromWorld, setReference } from "./commands";
import { referenceIssues } from "./compare";
import { clone } from "./math";
import { buildMesh, COVERAGE_WARNING, type MeshMeta, solidMeta } from "./mesher";
import { defaultDisplay, initialState } from "./model";
import { worldRing } from "./ring";
import schema from "./schema.json";
import type {
  DocObject,
  DocVec3,
  EditorState,
  ImageAsset,
  ImageInfo,
  Issue,
  Point,
  SceneDocument,
  SceneObject,
  Vec3,
  ViewId,
} from "./types";
import { axisNames, VIEW_IDS } from "./views";

export const FORMAT = "orthographic-scene";
export const VERSION = 1;
export const SCHEMA_URL = "https://3d.tris.sh/orthographic/schema.json";

/** World values rounded to 1e-9 m: float noise (12.219999999999999) says nothing and costs a reader tokens. */
const tidy = (v: number) => Math.round(v * 1e9) / 1e9;
const toVec = (v: Vec3): DocVec3 => ({ x: tidy(v[0]), y: tidy(v[1]), z: tidy(v[2]) });
const worldPoints = (e: SceneObject, view: ViewId, part: number) =>
  worldRing(e, view, part).map(([a, b]) => [tidy(a), tidy(b)] as Point);
const worldOutlines = (e: SceneObject, part: number) =>
  Object.fromEntries(VIEW_IDS.map((v) => [v, worldPoints(e, v, part)])) as Record<ViewId, Point[]>;

/** Whether an object is written as plain outlines: one part, unnamed. */
const isPlain = (e: SceneObject) => e.parts.length === 1 && e.parts[0].id === undefined;

/** Where an object's (or a part's) outlines are in its document form. */
const outlinesPath = (e: SceneObject, index: number, part: number) =>
  isPlain(e) ? `/objects/${index}/outlines` : `/objects/${index}/parts/${part}/outlines`;
const fromVec = (v: DocVec3): Vec3 => [v.x, v.y, v.z];
const pair = (view: ViewId, p: Point) => {
  const [a, b] = axisNames(view);
  return { [a]: p[0], [b]: p[1] };
};
const unpair = (view: ViewId, o: Record<string, number>): Point => {
  const [a, b] = axisNames(view);
  return [o[a], o[b]];
};

// ---- Export ------------------------------------------------------------------

export interface ExportOptions {
  /** "data" embeds the pixels, "metadata" lists the images without them, "none" leaves images out. */
  images?: "data" | "metadata" | "none";
  /** Include read-only derived values (bounds, camera matrices). Default true. */
  derived?: boolean;
  editor?: Record<string, unknown>;
}

export function toDocument(
  s: EditorState,
  images: ReadonlyMap<string, ImageInfo & { data?: string }>,
  opts: ExportOptions = {},
): SceneDocument {
  const derived = opts.derived !== false;
  const m = cameraMatrices(s.camera);
  const doc: SceneDocument = {
    $schema: SCHEMA_URL,
    format: FORMAT,
    version: VERSION,
    scene: {
      title: s.scene.title,
      size: toVec(s.scene.size),
      // Scenes stored before the scale existed have no scaleBasis.
      scale: { basis: s.scene.scaleBasis ?? "" },
      notes: s.scene.notes,
    },
    objects: s.objects.map((e) => {
      const o: DocObject = {
        id: e.id,
        name: e.name,
        kind: e.kind,
        color: e.color,
        ...(isPlain(e)
          ? { outlines: worldOutlines(e, 0) }
          : {
              parts: e.parts.map((p, k) => ({
                ...(p.id !== undefined && { id: p.id }),
                outlines: worldOutlines(e, k),
              })),
            }),
        ...(e.trace && {
          trace: { points: clone(e.trace.points), ...(e.trace.hidden.length && { hidden: clone(e.trace.hidden) }) },
        }),
        ...(e.inFrontOf?.length && { inFrontOf: [...e.inFrontOf] }),
        visible: e.visible,
        locked: e.locked,
        reviewed: e.reviewed,
        opacity: e.opacity,
        notes: e.notes,
      };
      if (derived) {
        const max = e.min.map((v, i) => v + e.size[i]) as Vec3;
        o.derived = {
          min: toVec(e.min),
          max: toVec(max),
          center: toVec(e.min.map((v, i) => v + e.size[i] / 2) as Vec3),
          size: toVec(e.size),
        };
      }
      return o;
    }),
    camera: {
      position: toVec(s.camera.position),
      target: toVec(s.camera.target),
      verticalFovDegrees: s.camera.fov,
      rollDegrees: s.camera.roll,
      shift: { x: s.camera.shift?.[0] ?? 0, y: s.camera.shift?.[1] ?? 0 },
      near: s.camera.near,
      far: s.camera.far,
      frame: { width: s.camera.frame[0], height: s.camera.frame[1] },
      locked: s.camera.locked,
      ...(derived && {
        derived: {
          focalLengthMm35Equivalent: fovToFocal(s.camera.fov),
          horizontalFovDegrees: horizontalFov(s.camera),
          aspectRatio: m.aspect,
          up: toVec(m.up),
          forward: toVec(m.forward),
          viewMatrixColumnMajor: m.view,
          projectionMatrixColumnMajor: m.projection,
        },
      }),
    },
    references: {},
    display: clone(s.display),
  };
  const used = new Set<string>();
  for (const view of VIEW_IDS) {
    const r = s.references[view];
    if (!r) continue;
    used.add(r.image);
    doc.references![view] = {
      image: r.image,
      opacity: r.opacity,
      visible: r.visible,
      min: pair(view, r.min),
      size: pair(view, r.size),
    };
  }
  const p = s.references.perspective;
  if (p) {
    used.add(p.image);
    doc.references!.perspective = {
      image: p.image,
      opacity: p.opacity,
      visible: p.visible,
      offsetPercent: { x: p.offsetPercent[0], y: p.offsetPercent[1] },
      scale: p.scale,
      rotationDegrees: p.rotationDegrees,
      blend: p.blend,
      ...(p.depth && { depth: p.depth }),
    };
    if (p.depth) used.add(p.depth);
  }
  if (opts.images !== "none" && used.size) {
    doc.images = {};
    for (const id of [...used].sort()) {
      const a = images.get(id);
      if (!a) continue;
      doc.images[id] = {
        name: a.name,
        mimeType: a.mimeType,
        width: a.width,
        height: a.height,
        ...(opts.images === "data" && { data: a.data }),
      };
    }
  }
  if (opts.editor) doc.editor = opts.editor;
  return doc;
}

// ---- Import and validation ---------------------------------------------------------

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

function schemaIssue(e: ErrorObject): Issue {
  const where = e.instancePath || "the document";
  let message = `${where} ${e.message ?? "is invalid"}`;
  if (e.keyword === "additionalProperties" || e.keyword === "unevaluatedProperties") {
    const key =
      (e.params as { additionalProperty?: string; unevaluatedProperty?: string }).additionalProperty ??
      (e.params as { unevaluatedProperty?: string }).unevaluatedProperty;
    message = `${where} has an unknown property "${key}".`;
  } else if (e.keyword === "enum")
    message = `${where} must be one of ${JSON.stringify((e.params as { allowedValues: unknown[] }).allowedValues)}.`;
  else if (e.keyword === "const")
    message = `${where} must be ${JSON.stringify((e.params as { allowedValue: unknown }).allowedValue)}.`;
  else if (!message.endsWith(".")) message += ".";
  return { severity: "error", code: `schema-${e.keyword}`, path: e.instancePath, message };
}

export interface ReadResult {
  state?: EditorState;
  /** Images embedded in the document (new to the editor or not). */
  images: ImageAsset[];
  issues: Issue[];
  editor?: Record<string, unknown>;
}

/**
 * Read a document into editor state. `known` resolves images the editor
 * already holds, so a document may reference an image without embedding it.
 * Returns every problem found; `state` is set only when none is an error.
 */
export function fromDocument(doc: unknown, known: (id: string) => ImageInfo | undefined = () => undefined): ReadResult {
  const images: ImageAsset[] = [];
  const issues: Issue[] = [];
  if (!validateSchema(doc)) {
    const seen = new Set<string>();
    for (const i of (validateSchema.errors ?? []).map(schemaIssue))
      if (!seen.has(i.path + i.code)) {
        seen.add(i.path + i.code);
        issues.push(i);
      }
    // Unknown properties (often typos) leave the rest readable, so keep checking to report every problem;
    // any other schema error means the content cannot be trusted.
    const unknownOnly = issues.every(
      (i) => i.code === "schema-additionalProperties" || i.code === "schema-unevaluatedProperties",
    );
    if (!unknownOnly) return { images, issues };
  }
  const d = doc as unknown as SceneDocument;
  const s = initialState();
  s.scene = {
    title: d.scene.title ?? "Untitled scene",
    size: fromVec(d.scene.size),
    scaleBasis: d.scene.scale?.basis ?? "",
    notes: d.scene.notes ?? "",
  };
  if (!s.scene.scaleBasis.trim() && d.objects.length)
    issues.push({
      severity: "warning",
      code: "scale-not-set",
      path: "/scene/scale",
      message:
        "The scene's scale is not set: every length is in metres, but scene.scale.basis does not say what they were measured from. Size the scene from things of known size in the reference (a door is about 2 m tall, a person about 1.7 m) and record that evidence in scene.scale.basis.",
    });

  const ids = new Map<string, number>();
  d.objects.forEach((o, i) => {
    const path = `/objects/${i}`;
    if (ids.has(o.id)) {
      issues.push(
        issue("duplicate-id", `Object id "${o.id}" is used by objects ${ids.get(o.id)} and ${i}.`, {
          path: `${path}/id`,
          objectId: o.id,
        }),
      );
      return;
    }
    ids.set(o.id, i);
    const shape = o.parts ? { parts: o.parts } : { outlines: o.outlines! };
    const { object, issues: found } = objectFromWorld(o.id, shape, o, path);
    issues.push(...found);
    if (object) s.objects.push(object);
  });

  issues.push(...inFrontOfIssues(s, undefined, "warning"));

  for (const [id, img] of Object.entries(d.images ?? {})) {
    const path = `/images/${id}`;
    if (img.data === undefined) {
      if (!known(id))
        issues.push(
          issue(
            "image-without-data",
            `Image "${id}" has no data and the scene does not have it yet; embed it as base64 in data.`,
            { path },
          ),
        );
      continue;
    }
    images.push({
      id,
      name: img.name ?? id,
      mimeType: img.mimeType,
      width: img.width,
      height: img.height,
      data: img.data.replace(/\s+/g, ""),
    });
  }
  const imageSize = (id: string) => images.find((a) => a.id === id) ?? known(id);

  if (d.camera) {
    const c = d.camera;
    let fov = c.verticalFovDegrees;
    if (c.focalLengthMm35Equivalent !== undefined) {
      const fromFocal = focalToFov(c.focalLengthMm35Equivalent);
      if (fov !== undefined && Math.abs(fov - fromFocal) > 0.01)
        issues.push(
          issue(
            "camera-lens-mismatch",
            `verticalFovDegrees ${fov} and focalLengthMm35Equivalent ${c.focalLengthMm35Equivalent} (= ${fromFocal.toFixed(3)}°) disagree; give one of them.`,
            {
              path: "/camera",
            },
          ),
        );
      fov ??= fromFocal;
    }
    const camera = {
      position: fromVec(c.position),
      target: fromVec(c.target),
      fov: fov ?? 36,
      roll: c.rollDegrees ?? 0,
      shift: (c.shift ? [c.shift.x, c.shift.y] : [0, 0]) as [number, number],
      near: c.near ?? 0.05,
      far: c.far ?? 2000,
      frame: (c.frame ? [c.frame.width, c.frame.height] : [1600, 900]) as [number, number],
      locked: c.locked ?? false,
    };
    const problem = cameraProblem(camera);
    if (problem) issues.push(issue("invalid-camera", problem, { path: "/camera" }));
    else s.camera = camera;
  } else s.camera = presetCamera(s.camera, "overview", { min: [0, 0, 0], max: s.scene.size });

  for (const view of [...VIEW_IDS, "perspective"] as const) {
    const r = d.references?.[view];
    if (!r) continue;
    const path = `/references/${view}`;
    if (!imageSize(r.image)) {
      issues.push(
        issue(
          "unknown-image",
          `The ${view} reference uses image "${r.image}", which is neither in images nor already in the scene.`,
          { path: `${path}/image` },
        ),
      );
      continue;
    }
    const patch =
      view === "perspective"
        ? {
            ...r,
            offsetPercent:
              "offsetPercent" in r && r.offsetPercent ? ([r.offsetPercent.x, r.offsetPercent.y] as Point) : undefined,
          }
        : {
            ...r,
            min: unpair(view, (r as { min: Record<string, number> }).min),
            size: unpair(view, (r as { size: Record<string, number> }).size),
          };
    const found = setReference(s, view, patch as never, imageSize);
    issues.push(...found.map((i) => ({ ...i, path: i.path || path })));
  }

  if (d.display) Object.assign(s.display, { ...defaultDisplay(), ...d.display });

  const ok = !issues.some((i) => i.severity === "error");
  return { state: ok ? s : undefined, images, issues, editor: d.editor };
}

// ---- Geometry checks ---------------------------------------------------------------

/**
 * Problems that only show once the solids are reconstructed: silhouettes that
 * share no volume, or clip each other so a view is not filled. `meta` gives a
 * mesh's metadata when the caller already has it; otherwise it is rebuilt here.
 * `only` limits the checks to those objects.
 */
export function geometryIssues(
  s: EditorState,
  meta?: (id: string) => MeshMeta | undefined,
  only?: ReadonlySet<string>,
): Issue[] {
  const out: Issue[] = [];
  s.objects.forEach((e, i) => {
    if (only && !only.has(e.id)) return;
    const m = meta?.(e.id) ?? solidMeta(e.parts);
    m.parts.forEach((p, k) => {
      const path = outlinesPath(e, i, k);
      const name = isPlain(e) ? e.id : `${e.id} part ${e.parts[k]?.id ?? k}`;
      if (p.empty) {
        out.push(
          issue(
            "no-common-volume",
            `The three outlines of ${name} share no volume, so it has no 3D solid. Make the silhouettes overlap along their shared axes.`,
            { objectId: e.id, path },
          ),
        );
        return;
      }
      for (const view of VIEW_IDS)
        if (p.coverage[view] < COVERAGE_WARNING)
          out.push({
            severity: "warning",
            code: "low-coverage",
            objectId: e.id,
            view,
            path: `${path}/${view}`,
            message: `The solid of ${name} fills only ${Math.round(p.coverage[view] * 100)}% of its ${view} outline: the other two views cut away the rest. Make the views agree on where the object is thick and thin.`,
          });
    });
  });
  const [sx, sy, sz] = s.scene.size;
  s.objects.forEach((e, i) => {
    if (only && !only.has(e.id)) return;
    const max = e.min.map((v, a) => v + e.size[a]);
    const outside = e.min.some((v) => v < -1e-9) || max[0] > sx + 1e-9 || max[1] > sy + 1e-9 || max[2] > sz + 1e-9;
    if (outside)
      out.push({
        severity: "warning",
        code: "outside-frame",
        objectId: e.id,
        path: `/objects/${i}`,
        message: `${e.id} extends beyond the scene frame (0,0,0)–(${sx},${sy},${sz}). That is allowed, but check it is intended.`,
      });
  });
  return out;
}

/**
 * Validate a document: schema, semantics and (optionally) geometry: the
 * solids, and traced objects against the perspective reference.
 */
export function validateDocument(
  doc: unknown,
  opts: { geometry?: boolean; known?: (id: string) => ImageInfo | undefined } = {},
) {
  const read = fromDocument(doc, opts.known);
  const issues = [...read.issues];
  const s = read.state;
  if (s && opts.geometry !== false) {
    issues.push(...geometryIssues(s));
    const ref = s.references.perspective;
    if (ref && s.objects.some((e) => e.trace)) {
      const image = (doc as SceneDocument).images?.[ref.image] ?? opts.known?.(ref.image);
      issues.push(...referenceIssues(s, (e) => buildMesh(e.parts, e.size), image));
    }
  }
  return { ok: !issues.some((i) => i.severity === "error"), issues, state: s };
}
