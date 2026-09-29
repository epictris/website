// The server's tools: every editor capability an agent needs, over stored
// scenes. One definition serves both the MCP server (mcp.ts) and the HTTP API
// (POST /orthographic/api/tools/<name>), so the two never drift apart.
//
// Each tool validates its arguments against its JSON Schema, runs the same
// core ops as the editor, and answers { ok, issues, ... }: an issue list rather
// than an exception, so a caller always learns what to fix.

import { deflateSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020";
import { issue } from "../orthographic/src/core/commands";
import { compareToReference } from "../orthographic/src/core/compare";
import {
  type Calibration,
  calibrate,
  type DepthMap,
  depthOrderIssues,
  depthRangeFor,
  depthToGrey16,
} from "../orthographic/src/core/depthmap";
import { validateDocument } from "../orthographic/src/core/document";
import { base64ToBytes, parseDataUrl } from "../orthographic/src/core/images";
import * as ops from "../orthographic/src/core/ops";
import { encodePng } from "../orthographic/src/core/png";
import { objectsCsv } from "../orthographic/src/core/table";
import type { EditorState, Issue, ReferenceView, Ring, ViewId } from "../orthographic/src/core/types";
import { Busy } from "./browser";
import { fetchImage } from "./fetchImage";
import { checkGeometry, documentImages, meshOf, perspectiveImage } from "./geometry";
import { BadRequest, render, VIEWS } from "./render";
import {
  addImage,
  changesSince,
  createScene,
  editScene,
  imageBytes,
  readDocument,
  redo,
  replaceScene,
  requireScene,
  type Scene,
  type SceneImage,
  StoreError,
  sceneDocument,
  undo,
} from "./scenes";
import { decodeDepthImage, estimateDepth, VisionUnavailable } from "./vision";

export interface ToolContext {
  /** Where this server is reached from the caller's side, e.g. https://3d.tris.sh. */
  origin: string;
  /** The tool being run (set by callTool): the change log records it. */
  tool?: string;
}

export interface ToolOutput {
  ok: boolean;
  issues: Issue[];
  /** PNG data: URLs by view (render). MCP sends them as image content, HTTP inline. */
  images?: Record<string, string>;
  [key: string]: unknown;
}

type Schema = Record<string, unknown>;

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  /** Changes nothing (MCP readOnlyHint). */
  readOnly?: boolean;
  /** May remove content (MCP destructiveHint); undo restores it. */
  destructive?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

// ---- Schema pieces ----------------------------------------------------------------------

const num = (description?: string): Schema => ({ type: "number", ...(description && { description }) });
const str = (description?: string, extra: Schema = {}): Schema => ({
  type: "string",
  ...(description && { description }),
  ...extra,
});
const bool = (description?: string): Schema => ({ type: "boolean", ...(description && { description }) });
const vec3 = (description?: string): Schema => ({
  type: "object",
  required: ["x", "y", "z"],
  additionalProperties: false,
  properties: { x: num(), y: num(), z: num() },
  ...(description && { description }),
});
const partialVec3 = (description: string): Schema => ({
  type: "object",
  additionalProperties: false,
  properties: { x: num(), y: num(), z: num() },
  description,
});
const ring = (description: string): Schema => ({
  type: "array",
  minItems: 3,
  maxItems: 512,
  items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
  description,
});
const ids = (description = "Object ids."): Schema => ({
  type: "array",
  minItems: 1,
  items: { type: "string" },
  description,
});
const plane = (description: string): Schema => ({
  type: "object",
  additionalProperties: false,
  properties: { x: num(), y: num(), z: num() },
  description,
});
const SCENE_ID: Schema = str(
  "The scene's id (from create_scene), or an editor link carrying it (https://3d.tris.sh/orthographic/?scene=...).",
);
const DOCUMENT: Schema = {
  type: "object",
  description:
    'A scene document, every length in metres: { format: "orthographic-scene", version: 1, scene: { size, scale?: { basis } }, objects: [...], camera?, references?, images? }. See read_guide for the full format.',
};
const SCALE_BASIS =
  'What the scene\'s metres were taken from: things of known size in the reference, e.g. "doorway 2.1 m tall; the figure at left about 1.7 m".';
const VIEW: Schema = { enum: ["front", "top", "side"], description: "front = x/z, top = x/y, side = y/z." };
const PIXEL_SPACE: Schema = {
  enum: ["frame", "reference"],
  description:
    "Whose pixels: frame (the camera frame's, camera.frame wide; default) or reference (the perspective reference image's own, as traces use).",
};
const TRACE: Schema = object(
  {
    points: ring(
      "The silhouette in the perspective reference image's own pixels: [u, v], origin top-left, v down, as if nothing stood in front. Parts may continue off the image.",
    ),
    hidden: {
      type: "array",
      items: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 2, maxItems: 2 },
      description:
        "Runs of guessed edges where something covers the object in the image: [a, b] covers the edges from vertex a forward to vertex b (wrapping). Pixels nearer a hidden edge than a traced one are not counted as missing.",
    },
  },
  ["points"],
);
const IN_FRONT_OF: Schema = {
  type: "array",
  items: { type: "string" },
  description:
    "Ids of objects this one stands in front of where their traces overlap; compare_to_reference reports occlusion-order where the render disagrees.",
};
const OBJECT_PROPS: Record<string, Schema> = {
  name: str("Display name.", { maxLength: 180 }),
  kind: str("Free-form tag such as rock, plant or wall.", { maxLength: 40 }),
  color: str("Hex colour, #rrggbb.", { pattern: "^#[0-9a-fA-F]{6}$" }),
  visible: bool(),
  locked: bool("A locked object refuses edits until unlocked."),
  reviewed: bool("Marks the object as checked against its references."),
  opacity: num("0.05 to 1; below 1 renders translucent."),
  notes: str(undefined, { maxLength: 2000 }),
  inFrontOf: IN_FRONT_OF,
};

function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", additionalProperties: false, properties, required };
}

const OUTLINES: Schema = object(
  {
    front: ring("[x, z] points."),
    top: ring("[x, y] points."),
    side: ring("[y, z] points."),
  },
  ["front", "top", "side"],
);
const PART: Schema = {
  type: "integer",
  minimum: 0,
  description: "For an object of several parts: which one (from 0).",
};

/** Everything add_object and add_objects take to describe one object. */
const NEW_OBJECT: Record<string, Schema> = {
  id: str("Letters, digits, _ . -, starting with a letter or digit; unique. Generated when omitted."),
  outlines: OUTLINES,
  parts: {
    type: "array",
    minItems: 1,
    maxItems: 32,
    items: object({ id: str("Optional name, unique within the object."), outlines: OUTLINES }, ["outlines"]),
    description:
      "Instead of outlines: the object as a union of parts, each with its own three outlines, for a shape that varies in more than one direction at once (a wall with a ledge, stepped rocks). It is selected, coloured, traced and fitted as one.",
  },
  primitive: {
    enum: ["box", "ellipsoid", "cylinder", "rock"],
    description: "Instead of outlines: a starting shape filling the box given by center and size.",
  },
  center: vec3("Box centre for a primitive (default: the scene centre)."),
  size: vec3("Box size for a primitive in metres (default 4 x 4 x 4)."),
  trace: TRACE,
  ...OBJECT_PROPS,
};
const MAX_BATCH = 100;
/** Render options that can ride along on a render link. */
export const RENDER_QUERY = [
  "width",
  "height",
  "pixelsPerMeter",
  "references",
  "labels",
  "grid",
  "mode",
  "outlines",
  "referenceOpacity",
];

// ---- Helpers ---------------------------------------------------------------------------------

const done = (issues: Issue[], extra: Record<string, unknown> = {}): ToolOutput => ({
  ok: !issues.some((i) => i.severity === "error"),
  issues,
  ...extra,
});
const failed = (code: string, message: string) => done([issue(code, message)]);

export const editorUrl = (ctx: ToolContext, scene: Scene) => `${ctx.origin}/orthographic/?scene=${scene.id}`;
const sceneUrl = (ctx: ToolContext, scene: Scene, path: string) =>
  `${ctx.origin}/orthographic/api/scenes/${scene.id}/${path}`;

const imageOf = (scene: Scene) => (id: string) => scene.images[id];
const queryContext = (scene: Scene): ops.QueryContext => ({
  meshOf,
  referenceImage: perspectiveImage(scene.state, imageOf(scene)),
});

/** The document form of some objects, with their derived bounds. */
function objectsOf(scene: Scene, idList: string[]) {
  const wanted = new Set(idList);
  return sceneDocument(scene, { images: "none" }).objects.filter((o) => wanted.has(o.id));
}

/**
 * Run an op on a scene as one undoable step. On success report the new
 * revision, the op's values, the touched objects (`brief`: ids and bounds
 * only) and their geometry problems.
 */
async function edit(
  args: Record<string, unknown>,
  ctx: ToolContext,
  op: (draft: EditorState, scene: Scene) => ops.OpResult,
  opts: { brief?: boolean } = {},
): Promise<ToolOutput> {
  const scene = requireScene(args.sceneId as string);
  const out = editScene(scene, (d) => op(d, scene), ctx.tool);
  if (out.issues.some((i) => i.severity === "error")) return done(out.issues, { revision: scene.revision });
  const touched = (out.touched ?? []).filter((id) => scene.state.objects.some((e) => e.id === id));
  const geometry = touched.length ? await checkGeometry(scene.state, imageOf(scene), new Set(touched)) : [];
  const known = new Set(out.issues.map((i) => `${i.code} ${i.path} ${i.objectId}`));
  return done([...out.issues, ...geometry.filter((i) => !known.has(`${i.code} ${i.path} ${i.objectId}`))], {
    revision: scene.revision,
    ...out.value,
    // A batch reports bounds only: echoing every outline back would dwarf the request.
    ...(touched.length && {
      objects: opts.brief
        ? objectsOf(scene, touched).map((o) => ({ id: o.id, derived: o.derived }))
        : objectsOf(scene, touched),
    }),
  });
}

/**
 * Run a fitting op: applied as an edit, or with dryRun on a copy. Either way
 * the answer carries the object's comparison with its trace.
 */
async function fitTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
  op: (draft: EditorState, scene: Scene) => ops.OpResult,
): Promise<ToolOutput> {
  const scene = requireScene(args.sceneId as string);
  const id = args.id as string;
  const compare = (s: EditorState) =>
    compareToReference(s, meshOf, perspectiveImage(s, imageOf(scene)), { ids: [id] })?.objects[0];
  if (args.dryRun !== true) {
    const out = await edit(args, ctx, op);
    return out.ok ? { ...out, comparison: compare(scene.state) } : out;
  }
  const draft = JSON.parse(JSON.stringify(scene.state)) as EditorState;
  const r = op(draft, scene);
  if (r.issues.some((i) => i.severity === "error")) return done(r.issues, { revision: scene.revision });
  const geometry = await checkGeometry(draft, imageOf(scene), new Set([id]));
  return done([...r.issues, ...geometry], {
    revision: scene.revision,
    dryRun: true,
    ...r.value,
    comparison: compare(draft),
  });
}

async function validateScene(scene: Scene): Promise<Issue[]> {
  const read = validateDocument(sceneDocument(scene, { images: "metadata" }), {
    geometry: false,
    known: imageOf(scene),
  });
  if (!read.state) return read.issues;
  return [
    ...read.issues,
    ...(await checkGeometry(read.state, imageOf(scene))),
    ...(await depthIssues(read.state, imageOf(scene), (id) => imageBytes(scene.images[id]))),
  ];
}

// ---- Depth maps -------------------------------------------------------------------------

/** Decoded depth pictures by content, so checking a scene again costs no decode. */
const depthCache = new Map<string, DepthMap>();

async function depthPicture(key: string, bytes: () => Uint8Array): Promise<DepthMap> {
  const hit = depthCache.get(key);
  if (hit) return hit;
  const map = await decodeDepthImage(bytes());
  depthCache.set(key, map);
  while (depthCache.size > 8) depthCache.delete(depthCache.keys().next().value!);
  return map;
}

/** The perspective reference's depth map, when it has one whose picture can be read. */
async function depthMapOf(
  s: EditorState,
  images: (id: string) => { width: number; height: number; sha?: string } | undefined,
  bytes: (id: string) => Uint8Array,
): Promise<DepthMap | null> {
  const id = s.references.perspective?.depth;
  const info = id ? images(id) : undefined;
  if (!id || !info) return null;
  try {
    const data = info.sha ? undefined : bytes(id);
    return await depthPicture(info.sha ?? String(Bun.hash(data!)), () => data ?? bytes(id));
  } catch {
    return null;
  }
}

/** Where the depth map says the scene's occlusion order is wrong (nothing without a depth map). */
async function depthIssues(
  s: EditorState,
  images: (id: string) => { width: number; height: number; sha?: string } | undefined,
  bytes: (id: string) => Uint8Array,
): Promise<Issue[]> {
  const map = await depthMapOf(s, images, bytes);
  const image = perspectiveImage(s, images);
  return map && image ? depthOrderIssues(s, meshOf, map, image) : [];
}

const sceneDepthMap = (scene: Scene) => depthMapOf(scene.state, imageOf(scene), (id) => imageBytes(scene.images[id]));

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** A calibration as reported: metres to the millimetre. */
const calibrationOut = (c: Calibration) => ({
  a: round(c.a, 6),
  b: round(c.b, 6),
  r2: round(c.r2, 4),
  objects: c.objects.map((o) => ({
    id: o.id,
    sceneDepth: round(o.sceneDepth, 3),
    estimatedDepth: o.estimatedDepth === null ? null : round(o.estimatedDepth, 3),
  })),
});

/** The scene's perspective reference image, or an issue saying there is none. */
function referenceOf(scene: Scene): { image: SceneImage } | ToolOutput {
  const ref = scene.state.references.perspective;
  const image = ref && scene.images[ref.image];
  return image
    ? { image }
    : failed("no-reference", "The scene has no perspective reference image; set one with set_reference.");
}

// ---- Guide ---------------------------------------------------------------------------------

const guideText = () => Bun.file(new URL("../orthographic/llms.txt", import.meta.url)).text();
const schemaText = () => Bun.file(new URL("../orthographic/src/core/schema.json", import.meta.url)).text();

// ---- The tools -----------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "read_guide",
    title: "Read the guide",
    description:
      "The full guide to Orthographic Studio: coordinates, how outlines become solids, the document format, the workflow for turning a reference image into a scene, and every issue code. Read it before building a scene. schema: true adds the document's JSON Schema.",
    inputSchema: object({ schema: bool("Also return the JSON Schema of the scene document.") }),
    readOnly: true,
    async run(args) {
      return done([], {
        guide: await guideText(),
        ...(args.schema === true && { schema: JSON.parse(await schemaText()) }),
      });
    },
  },
  {
    name: "create_scene",
    title: "Create a scene",
    description:
      "Create a scene on the server, empty or from a document, and get its id (every other tool takes it) and an editor link a person can open to watch and edit the same scene live. Nothing is created when the document has an error.",
    inputSchema: object({ document: DOCUMENT }),
    async run(args, ctx) {
      if (args.document === undefined) {
        const scene = createScene();
        return done([], { sceneId: scene.id, revision: scene.revision, editorUrl: editorUrl(ctx, scene) });
      }
      const read = await readDocument(args.document);
      if (!read.state) return done(read.issues);
      const scene = createScene(read.state, read.images);
      return done([...read.issues, ...(await checkGeometry(scene.state, imageOf(scene)))], {
        sceneId: scene.id,
        revision: scene.revision,
        editorUrl: editorUrl(ctx, scene),
      });
    },
  },
  {
    name: "get_scene",
    title: "Get the scene document",
    description:
      "The scene as a document in metres, with derived bounds per object and the camera's derived values (focal length, matrices). Images are listed without their pixels.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        derived: bool("Include the read-only derived blocks (default true)."),
        images: { enum: ["metadata", "none"], description: "List images (default) or leave them out." },
      },
      ["sceneId"],
    ),
    readOnly: true,
    async run(args, ctx) {
      const scene = requireScene(args.sceneId as string);
      return done([], {
        revision: scene.revision,
        editorUrl: editorUrl(ctx, scene),
        document: sceneDocument(scene, {
          images: (args.images as "metadata" | "none") ?? "metadata",
          derived: args.derived !== false,
        }),
      });
    },
  },
  {
    name: "get_changes",
    title: "Get changes since a revision",
    description:
      "What changed in the scene after revision since, one entry per revision: who made it (a tool's name, editor for a person's edit, undo, redo), when, the objects added, removed and changed (with the fields that changed, outlines per view), and the scene, camera, reference and display settings that changed. complete is false when the log no longer reaches back that far. Use it after a revision-conflict, or before replacing anything a person may have been working on.",
    inputSchema: object(
      { sceneId: SCENE_ID, since: { type: "integer", minimum: 0, description: "The revision to start after." } },
      ["sceneId", "since"],
    ),
    readOnly: true,
    async run(args) {
      const scene = requireScene(args.sceneId as string);
      return done([], { revision: scene.revision, since: args.since, ...changesSince(scene, args.since as number) });
    },
  },
  {
    name: "load_document",
    title: "Replace the scene with a document",
    description:
      "Replace the whole scene with a document (one undoable step), the fastest way to write many objects at once. Images the scene already has may be named without data. Nothing changes when an issue is an error.",
    inputSchema: object({ sceneId: SCENE_ID, document: DOCUMENT }, ["sceneId", "document"]),
    destructive: true,
    async run(args) {
      const scene = requireScene(args.sceneId as string);
      const read = await readDocument(args.document, scene);
      if (!read.state) return done(read.issues, { revision: scene.revision });
      replaceScene(scene, read.state, read.images, "load_document");
      return done([...read.issues, ...(await checkGeometry(scene.state, imageOf(scene)))], {
        revision: scene.revision,
      });
    },
  },
  {
    name: "validate",
    title: "Validate",
    description:
      "Check a scene (sceneId) or a document (document) and report every problem at once, each with a JSON Pointer path: schema errors, outlines that are not simple polygons, geometry (outlines that share no volume or clip each other), traced objects against the reference, and, when the perspective reference has a depth map, object pairs whose occlusion order the map contradicts (depth-order).",
    inputSchema: object({ sceneId: SCENE_ID, document: DOCUMENT }),
    readOnly: true,
    async run(args) {
      if (args.document !== undefined) {
        const known = args.sceneId ? imageOf(requireScene(args.sceneId as string)) : undefined;
        const read = validateDocument(args.document, { geometry: false, known });
        const images = documentImages(args.document, known);
        if (!read.state) return done(read.issues);
        const scene = args.sceneId ? requireScene(args.sceneId as string) : undefined;
        const bytes = (id: string) => {
          const data = (args.document as { images?: Record<string, { data?: string }> }).images?.[id]?.data;
          return data !== undefined ? base64ToBytes(data) : imageBytes(scene!.images[id]);
        };
        return done([
          ...read.issues,
          ...(await checkGeometry(read.state, images)),
          ...(await depthIssues(read.state, (id) => images(id) ?? scene?.images[id], bytes)),
        ]);
      }
      if (!args.sceneId) return failed("missing-argument", "Give sceneId or document.");
      const scene = requireScene(args.sceneId as string);
      return done(await validateScene(scene), { revision: scene.revision });
    },
  },
  {
    name: "add_image",
    title: "Add an image",
    description:
      "Add a reference image to a scene from a public URL or base64 data (PNG, JPEG, WebP or GIF, under 25 MB). Returns its id (a hash of the bytes) and pixel size; assign it to a view with set_reference.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        url: str("An http(s) URL on the public internet."),
        data: str("Base64 file contents, or a base64 data: URL."),
        name: str("A file name to show in the editor.", { maxLength: 180 }),
      },
      ["sceneId"],
    ),
    async run(args) {
      const scene = requireScene(args.sceneId as string);
      if ((args.url === undefined) === (args.data === undefined))
        return failed("missing-argument", "Give url or data (one of them).");
      let bytes: Uint8Array;
      let name = args.name as string | undefined;
      if (args.url !== undefined) {
        const fetched = await fetchImage(args.url as string);
        bytes = fetched.bytes;
        name ??= fetched.name;
      } else {
        const raw = args.data as string;
        const payload = raw.startsWith("data:") ? parseDataUrl(raw)?.data : raw;
        if (payload === undefined) return failed("invalid-image", "data must be base64 or a base64 data: URL.");
        try {
          bytes = base64ToBytes(payload);
        } catch {
          return failed("invalid-image", "data is not valid base64.");
        }
      }
      const img = await addImage(scene, bytes, name ?? "image");
      return done([], { id: img.id, name: img.name, mimeType: img.mimeType, width: img.width, height: img.height });
    },
  },
  {
    name: "add_object",
    title: "Add an object",
    description:
      "Add an object from outlines in metres (front [x, z], top [x, y], side [y, z]; each a simple polygon of 3-512 points without a repeated closing point), from parts (a union of solids, each with its own three outlines), or from a primitive filling a box (center and size). Returns its id, its bounds and any geometry problems.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        ...NEW_OBJECT,
      },
      ["sceneId"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) => {
        const { sceneId: _, ...spec } = args;
        return ops.addObject(d, spec as ops.AddObjectArgs);
      }),
  },
  {
    name: "add_objects",
    title: "Add several objects",
    description: `Add up to ${MAX_BATCH} objects in one call and one undoable step, each specified as for add_object. All or nothing: when any object has an error, none is added, and every problem is reported with a path starting /objects/<index in this list>. Returns the new ids with their bounds (use get_scene for outlines) and any geometry problems. Build a large scene in batches of about 20, checking each with validate or render.`,
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        objects: {
          type: "array",
          minItems: 1,
          maxItems: MAX_BATCH,
          items: object(NEW_OBJECT),
          description: "The objects to add.",
        },
      },
      ["sceneId", "objects"],
    ),
    run: (args, ctx) => edit(args, ctx, (d) => ops.addObjects(d, args.objects as ops.AddObjectArgs[]), { brief: true }),
  },
  {
    name: "upsert_objects",
    title: "Add or change objects",
    description: `Add or change up to ${MAX_BATCH} objects by id in one call and one undoable step: the tool for "change these objects, keep the rest of the scene". A new id is added as by add_object; an existing object takes the properties given and keeps the others (outlines replace all three views; trace: null removes its trace; locked: false unlocks it first). All or nothing, with problems reported under /objects/<index in this list>. Returns the added and changed ids with their bounds.`,
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        objects: {
          type: "array",
          minItems: 1,
          maxItems: MAX_BATCH,
          items: object({ ...NEW_OBJECT, trace: { anyOf: [TRACE, { type: "null" }] } }),
          description: "The objects to add or change.",
        },
      },
      ["sceneId", "objects"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) => ops.upsertObjects(d, args.objects as ops.AddObjectArgs[]), { brief: true }),
  },
  {
    name: "update_object",
    title: "Update an object's properties",
    description:
      "Change an object's name, kind, color, visibility, lock, reviewed flag, opacity, notes or inFrontOf (the objects it stands in front of).",
    inputSchema: object({ sceneId: SCENE_ID, id: str("The object's id."), ...OBJECT_PROPS }, ["sceneId", "id"]),
    run: (args, ctx) =>
      edit(args, ctx, (d) => {
        const { sceneId: _, id, ...patch } = args;
        return ops.updateObject(d, id as string, patch);
      }),
  },
  {
    name: "set_outline",
    title: "Set an outline",
    description:
      "Replace one view's outline of an object (or of one of its parts) with points in metres: [x, z] for front, [x, y] for top, [y, z] for side. The box follows the new outline and the other views stretch to keep shared axes consistent; to change all three views, use set_outlines.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        id: str("The object's id."),
        view: VIEW,
        points: ring("A simple closed polygon, no repeated closing point."),
        part: PART,
      },
      ["sceneId", "id", "view", "points"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) =>
        ops.setOutline(
          d,
          args.id as string,
          args.view as ViewId,
          args.points as [number, number][],
          (args.part as number | undefined) ?? 0,
        ),
      ),
  },
  {
    name: "set_trace",
    title: "Set a trace",
    description:
      "Record the object's silhouette as traced in the perspective reference image (image pixels, origin top-left, v down), or remove it (remove: true). Traced objects are compared with the reference by validate and compare_to_reference: spill (drawn outside the trace), missing (trace not covered), IoU.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        id: str("The object's id."),
        points: (TRACE as { properties: Record<string, Schema> }).properties.points,
        hidden: (TRACE as { properties: Record<string, Schema> }).properties.hidden,
        remove: bool("Remove the trace."),
      },
      ["sceneId", "id"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) => {
        if (args.remove === true) return ops.setTrace(d, args.id as string, null);
        if (!args.points) return { issues: [issue("missing-argument", "Give points, or remove: true.")] };
        return ops.setTrace(d, args.id as string, {
          points: args.points as [number, number][],
          hidden: args.hidden as [number, number][] | undefined,
        });
      }),
  },
  {
    name: "set_outlines",
    title: "Set all three outlines",
    description:
      "Replace all three outlines of an object (or of one of its parts: part) at once, in metres (front [x, z], top [x, y], side [y, z]), as one undoable step. The box comes from the three together, so no view is stretched along the way (setting them one at a time with set_outline stretches the others each time).",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        id: str("The object's id."),
        outlines: OUTLINES,
        part: PART,
      },
      ["sceneId", "id", "outlines"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) =>
        ops.setOutlines(
          d,
          args.id as string,
          args.outlines as Record<ViewId, [number, number][]>,
          args.part as number | undefined,
        ),
      ),
  },
  {
    name: "fit_front",
    title: "Fit the front outline to the trace",
    description:
      "Solve the object's front outline from its trace and its top and side views (its own, or top and side given here in metres): the front whose solid, front ∩ top ∩ side, shows exactly inside the trace through the camera. Every depth the top and side allow is tested, and points off the image must stay inside the trace too. restOn: ids of objects the solid rests on and must not enter. trim (default true) then replaces the top and side by the solid's own shadows, so all three views agree exactly. Applies the three outlines as one undoable step (dryRun: true only reports them) and returns them with the front plane's cell size and the object's comparison with its trace (spill, missing, iou). Design the top and side first: they carry the depth the picture cannot.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        id: str("The object's id; it needs a trace (set_trace) and the scene a perspective reference."),
        top: ring("Top outline [x, y] in metres to fit with (default: the object's own)."),
        side: ring("Side outline [y, z] in metres to fit with (default: the object's own)."),
        restOn: ids("Objects the fitted solid rests on and must not enter."),
        trim: bool("Replace the top and side by the solid's own shadows (default true)."),
        maxPoints: {
          type: "integer",
          minimum: 4,
          maximum: 512,
          description: "Most points in a fitted outline (default 160).",
        },
        part: PART,
        dryRun: bool("Report the fit without changing the scene."),
      },
      ["sceneId", "id"],
    ),
    run: (args, ctx) =>
      fitTool(args, ctx, (d, scene) =>
        ops.fitFront(
          d,
          args.id as string,
          {
            top: args.top as Ring | undefined,
            side: args.side as Ring | undefined,
            restOn: args.restOn as string[] | undefined,
            trim: args.trim as boolean | undefined,
            maxPoints: args.maxPoints as number | undefined,
            part: args.part as number | undefined,
          },
          { image: imageOf(scene) },
        ),
      ),
  },
  {
    name: "suggest_views",
    title: "Suggest views from the trace",
    description:
      "A starting point for fit_front: plain box outlines for an object from its trace and the depth range it occupies (world y, metres, from depth.min to depth.max): the box between those depths that the trace's rays pass through. depth: \"estimate\" reads the range from the reference's depth map (estimate_depth) calibrated against the other placed objects (at least 3): the visible surface's 5th to 95th percentile of y, deepened to half the object's smaller extent across the picture when thinner, since a picture never shows an object's back; the answer gives the range used, the visible range and the calibration. Applies them as one undoable step (dryRun: true only reports them). Then shape the top and side, and fit_front the front.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        id: str("The object's id; it needs a trace."),
        depth: {
          anyOf: [object({ min: num(), max: num() }, ["min", "max"]), { const: "estimate" }],
          description: 'World y range in metres, { min, max }, or "estimate" to read it from the depth map.',
        },
        dryRun: bool("Report the outlines without changing the scene."),
      },
      ["sceneId", "id", "depth"],
    ),
    async run(args, ctx) {
      if (args.depth !== "estimate")
        return fitTool(args, ctx, (d, scene) =>
          ops.suggestViews(d, args.id as string, args.depth as { min: number; max: number }, {
            image: imageOf(scene),
          }),
        );
      const scene = requireScene(args.sceneId as string);
      const id = args.id as string;
      const e = scene.state.objects.find((o) => o.id === id);
      if (!e) return done([issue("unknown-object", `There is no object with id "${id}".`, { objectId: id })]);
      if (!e.trace) return failed("no-trace", `${id} has no trace; record one with set_trace first.`);
      const ref = referenceOf(scene);
      if ("ok" in ref) return ref;
      const map = await sceneDepthMap(scene);
      if (!map)
        return failed(
          "calibration-needed",
          "The perspective reference has no depth map: run estimate_depth first, or give depth as { min, max }.",
        );
      // Calibrate on everything else: the object's own current placement is what is being guessed.
      const others: EditorState = { ...scene.state, objects: scene.state.objects.filter((o) => o.id !== id) };
      const calibration = calibrate(others, meshOf, map, ref.image);
      if (!calibration || !(calibration.a > 0))
        return failed(
          "calibration-needed",
          calibration
            ? `The depth map runs backwards against the placed objects (r² ${round(calibration.r2, 3)}): check they are placed at the right depths, or give depth as { min, max }.`
            : "Calibrating the depth map needs at least 3 other placed objects, visible on the camera frame at different depths. Place some by hand first, or give depth as { min, max }.",
        );
      const range = depthRangeFor(scene.state, map, calibration, e.trace, ref.image);
      if (!range)
        return failed(
          "depth-unknown",
          `Too little of ${id}'s trace has a usable depth (too small, or beyond the depths the calibration can place); give depth as { min, max }.`,
        );
      const depth = { min: range.min, max: range.max };
      const out = await fitTool(args, ctx, (d, s) => ops.suggestViews(d, id, depth, { image: imageOf(s) }));
      return {
        ...out,
        depth: {
          min: round(range.min, 3),
          max: round(range.max, 3),
          visible: { min: round(range.visible.min, 3), max: round(range.visible.max, 3) },
          ...(range.assumedThickness !== undefined && { assumedThickness: round(range.assumedThickness, 3) }),
        },
        calibration: { a: round(calibration.a, 6), b: round(calibration.b, 6), r2: round(calibration.r2, 4) },
      };
    },
  },
  {
    name: "estimate_depth",
    title: "Estimate the reference's depth",
    description:
      "Estimate the depth of the perspective reference image with a monocular depth model (Depth Anything V2 Small, on the server; about a second, then cached): a relative map, nearer lighter, stored as a 16-bit grey image and set as references.perspective.depth (one undoable step; dryRun: true only reports). It gives order and rough depth, never geometry on its own, and it knows nothing of metres until calibrated against objects already placed: with at least 3, the answer includes the calibration (value ≈ a / depth + b by least squares, r², and each object's estimated depth beside its scene depth). From then on validate and compare_to_reference report depth-order where the map contradicts the scene's occlusion order, and suggest_views takes depth: \"estimate\".",
    inputSchema: object({ sceneId: SCENE_ID, dryRun: bool("Report without storing the map.") }, ["sceneId"]),
    async run(args, ctx) {
      const scene = requireScene(args.sceneId as string);
      const ref = referenceOf(scene);
      if ("ok" in ref) return ref;
      const map = await estimateDepth(ref.image);
      const calibration = calibrate(scene.state, meshOf, map, ref.image);
      const issues = depthOrderIssues(scene.state, meshOf, map, ref.image);
      const report = {
        width: map.width,
        height: map.height,
        calibration: calibration && calibrationOut(calibration),
        ...(!calibration && {
          note: "No calibration yet: it needs at least 3 placed objects visible on the camera frame at different depths.",
        }),
      };
      if (args.dryRun === true) return done(issues, { revision: scene.revision, dryRun: true, ...report });
      // The image may have been replaced while the model ran.
      if (scene.state.references.perspective?.image !== ref.image.id)
        return failed(
          "revision-conflict",
          "The perspective reference image changed while its depth was estimated; run it again.",
        );
      const png = await encodePng(map.width, map.height, { grey16: depthToGrey16(map) }, (d) => deflateSync(d));
      const stored = await addImage(scene, png, `depth of ${ref.image.name}`, `depth-${ref.image.id}`.slice(0, 100));
      const out = await edit(args, ctx, (d, s) =>
        ops.setReference(d, "perspective", { depth: stored.id }, { image: imageOf(s) }),
      );
      return out.ok ? { ...out, issues: [...out.issues, ...issues], image: stored.id, ...report } : out;
    },
  },
  {
    name: "set_bounds",
    title: "Set bounds",
    description:
      "Set the bounding box of one object or a group: any subset of min/max per axis. Outlines scale with the box; a group keeps its members' relative placement.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        ids: ids(),
        min: partialVec3("New minimum corner; omitted axes keep theirs."),
        max: partialVec3("New maximum corner; omitted axes keep theirs."),
      },
      ["sceneId", "ids"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) =>
        ops.setBounds(d, args.ids as string[], { min: args.min as never, max: args.max as never }),
      ),
  },
  {
    name: "move_objects",
    title: "Move objects",
    description: "Translate objects by an offset in metres.",
    inputSchema: object({ sceneId: SCENE_ID, ids: ids(), offset: vec3("Offset in metres.") }, [
      "sceneId",
      "ids",
      "offset",
    ]),
    run: (args, ctx) => edit(args, ctx, (d) => ops.moveObjects(d, args.ids as string[], args.offset as never)),
  },
  {
    name: "duplicate_objects",
    title: "Duplicate objects",
    description: "Copy objects, offset by a vector in metres (default {x: 1, y: 1, z: 0}). Returns the new ids.",
    inputSchema: object({ sceneId: SCENE_ID, ids: ids(), offset: vec3() }, ["sceneId", "ids"]),
    run: (args, ctx) => edit(args, ctx, (d) => ops.duplicateObjects(d, args.ids as string[], args.offset as never)),
  },
  {
    name: "delete_objects",
    title: "Delete objects",
    description: "Delete objects (undo restores them).",
    inputSchema: object({ sceneId: SCENE_ID, ids: ids() }, ["sceneId", "ids"]),
    destructive: true,
    run: (args, ctx) => edit(args, ctx, (d) => ops.deleteObjects(d, args.ids as string[])),
  },
  {
    name: "set_scene",
    title: "Set scene properties",
    description:
      "Set the title, the scene frame (size in metres: the drawing guide from (0, 0, 0) to size, not a boundary), the scale basis (scale.basis: the known sizes the scene's metres were taken from) and notes. Changing size moves nothing; to correct the scale of what is built, use rescale_scene.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        title: str(undefined, { maxLength: 100 }),
        size: vec3("Frame size in metres; at least 0.01 on every axis."),
        scale: object({ basis: str(SCALE_BASIS, { maxLength: 1000 }) }),
        notes: str(undefined, { maxLength: 4000 }),
      },
      ["sceneId"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) => {
        const { sceneId: _, ...patch } = args;
        return ops.setScene(d, patch as ops.SceneArgs);
      }),
  },
  {
    name: "rescale_scene",
    title: "Rescale the scene",
    description:
      "Multiply every length in the scene by factor, about the origin: the frame, every object (locked ones too), the placement of the front/top/side references and the camera, so everything keeps its place relative to everything else. For when the scale estimate changes: if an object built 10 m tall is really 4 m, factor is 0.4. Give scale.basis to record the new evidence in the same step.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        factor: { type: "number", exclusiveMinimum: 0, description: "The multiplier, e.g. 0.4." },
        scale: object({ basis: str(SCALE_BASIS, { maxLength: 1000 }) }),
      },
      ["sceneId", "factor"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) => ops.rescaleScene(d, args.factor as number, args.scale as { basis?: string } | undefined)),
  },
  {
    name: "set_camera",
    title: "Set the camera",
    description:
      "Set the perspective camera: position, target, the lens as verticalFovDegrees or focalLengthMm35Equivalent (f = 12 mm / tan(vertical FOV / 2); give one), rollDegrees, shift (lens shift as fractions of the frame: y > 0 shows more above and lowers the horizon while verticals stay vertical, as a painter's or architect's view does), near, far, frame (output pixels, fixes the aspect ratio) and locked.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        position: vec3(),
        target: vec3(),
        verticalFovDegrees: num("5 to 140."),
        focalLengthMm35Equivalent: num("Full-frame equivalent focal length, 4.36 to 275 mm."),
        rollDegrees: num("-180 to 180."),
        shift: object(
          {
            x: num("Frame widths, -1 to 1: the frame moves right."),
            y: num("Frame heights, -1 to 1: the frame moves up."),
          },
          ["x", "y"],
        ),
        near: num(),
        far: num(),
        frame: object({ width: { type: "integer" }, height: { type: "integer" } }, ["width", "height"]),
        locked: bool(),
      },
      ["sceneId"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) => {
        const { sceneId: _, ...patch } = args;
        return ops.setCamera(d, patch as ops.CameraArgs);
      }),
  },
  {
    name: "set_display",
    title: "Set the perspective display",
    description: "How the perspective view draws: style (solid, clay, wire, ghost), grid, labels, crosshair.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        style: { enum: ["solid", "clay", "wire", "ghost"] },
        grid: bool(),
        labels: bool(),
        crosshair: bool(),
      },
      ["sceneId"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d) => {
        const { sceneId: _, ...patch } = args;
        return ops.setDisplay(d, patch as ops.DisplayArgs);
      }),
  },
  {
    name: "set_reference",
    title: "Set a view's reference image",
    description:
      "Put an image (from add_image) behind a view, change its placement, or remove it (remove: true). front/top/side place it on the view plane: lower-left corner at min, stretched to size, both named by that view's axes ({x, z} front, {x, y} top, {y, z} side); a new image without them is fitted to the scene frame. perspective overlays the camera frame: offsetPercent {x, y}, scale (1 fits the frame), rotationDegrees, blend.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        view: { enum: ["front", "top", "side", "perspective"] },
        remove: bool("Remove the view's reference."),
        image: str("An image id from add_image."),
        opacity: num("0 to 1."),
        visible: bool(),
        min: plane("front/top/side: the image's lower-left corner on the view plane."),
        size: plane("front/top/side: the image's size on the view plane."),
        offsetPercent: object({ x: num(), y: num() }, ["x", "y"]),
        scale: num("perspective: 0.05 to 8."),
        rotationDegrees: num("perspective: -180 to 180."),
        blend: { enum: ["normal", "difference", "screen", "multiply"] },
        depth: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description:
            "perspective: a depth map of the reference image (an image id: grey, nearer lighter, 0 for no value, covering the whole image), or null to remove it. estimate_depth makes one.",
        },
      },
      ["sceneId", "view"],
    ),
    run: (args, ctx) =>
      edit(args, ctx, (d, scene) => {
        const { sceneId: _, view, remove, ...patch } = args;
        return ops.setReference(d, view as ReferenceView, remove === true ? null : (patch as ops.ReferenceArgs), {
          image: imageOf(scene),
        });
      }),
  },
  {
    name: "undo",
    title: "Undo",
    description: "Undo the scene's last change, whoever made it (agents and people in the editor share one history).",
    inputSchema: object({ sceneId: SCENE_ID }, ["sceneId"]),
    async run(args) {
      const scene = requireScene(args.sceneId as string);
      return done([], { undone: undo(scene), revision: scene.revision });
    },
  },
  {
    name: "redo",
    title: "Redo",
    description: "Redo the change undo last reverted.",
    inputSchema: object({ sceneId: SCENE_ID }, ["sceneId"]),
    async run(args) {
      const scene = requireScene(args.sceneId as string);
      return done([], { redone: redo(scene), revision: scene.revision });
    },
  },
  {
    name: "render",
    title: "Render views",
    description:
      "Pictures of the scene, for checking it against its references or for making reference views from. front, top and side are drawn at one shared scale (pixelsPerMeter) over the scene frame and every object plus a margin, so views sharing an axis cover the same range of it: front and top the same x, top and side the same y, front and side the same z. placements gives each picture's area on its view plane in metres ({min, size}, named by the view's axes, exactly what set_reference takes) and its pixel size: an image made from a picture, at the same pixel size, goes back in as that view's reference with that min and size. Reference images are drawn unless references is false. perspective is the camera frame with its overlay. Returns PNG images, links to them, and every issue found. Takes a few seconds.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        views: { type: "array", items: { enum: [...VIEWS] }, description: "Default: all four." },
        pixelsPerMeter: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "The orthographic views' scale. Default: the largest round scale (1, 2, 2.5, 4, 5 or 8 x 10^n) at which every orthographic view fits width x height. No picture may exceed 4096 px.",
        },
        width: {
          type: "integer",
          description:
            "128 to 4096. Orthographic: the largest picture width when pixelsPerMeter is not given (default 1200). Perspective: the frame width.",
        },
        height: {
          type: "integer",
          description:
            "128 to 4096; the largest orthographic picture height when pixelsPerMeter is not given (default 900).",
        },
        references: bool("Draw reference images (default true)."),
        labels: bool("Label objects and draw the scale bar in orthographic views (default true)."),
        grid: bool("Draw the grid in orthographic views (default true)."),
        mode: {
          enum: ["shaded", "ids", "depth"],
          description:
            'Perspective only. shaded (default): lit solids, outlined over the reference. ids: flat colours, one per object, no anti-aliasing, on black, with a legend { "#rrggbb": objectId }. depth: 16-bit grey, the nearest surface white, nothing black, with depthRange { near, far } in metres (v >= 1 is far - (v - 1) / 65534 * (far - near)). ids and depth are drawn without a browser, in a fraction of a second.',
        },
        outlines: {
          enum: ["all", "silhouette"],
          description:
            "Perspective over a reference: every edge (default: silhouettes, folds where an object hides part of itself, and creases) or only each object's outer silhouette.",
        },
        referenceOpacity: num(
          "Perspective: the reference's opacity for this picture only (0 to 1); the scene keeps its own.",
        ),
      },
      ["sceneId"],
    ),
    readOnly: true,
    async run(args, ctx) {
      const scene = requireScene(args.sceneId as string);
      const { sceneId: _, ...options } = args;
      const out = await render(sceneDocument(scene, { images: "data" }), options, `${scene.id}@${scene.revision}`);
      const query = new URLSearchParams();
      for (const k of RENDER_QUERY) if (args[k] !== undefined) query.set(k, String(args[k]));
      const urls = Object.fromEntries(
        Object.keys(out.images ?? {}).map((v) => [
          v,
          `${sceneUrl(ctx, scene, `render/${v}.png`)}?rev=${scene.revision}${query.size ? `&${query}` : ""}`,
        ]),
      );
      return {
        ...done(out.issues),
        revision: scene.revision,
        ...(out.placements && { pixelsPerMeter: out.pixelsPerMeter, placements: out.placements }),
        ...(out.legend && { legend: out.legend }),
        ...(out.depthRange && { depthRange: out.depthRange }),
        urls,
        images: out.images,
      };
    },
  },
  {
    name: "raycast",
    title: "What pixels see",
    description:
      "For each pixel, what the camera sees there: the object hit, the world point in metres, the surface normal, the distance from the camera and the depth along its view axis (null where nothing is hit). space: frame (the camera frame's pixels, the default) or reference (the perspective reference image's own pixels, as traces use). Needs no browser.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        points: {
          type: "array",
          minItems: 1,
          maxItems: 1000,
          items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          description: "[u, v] pixels, origin top-left.",
        },
        space: PIXEL_SPACE,
      },
      ["sceneId", "points"],
    ),
    readOnly: true,
    async run(args) {
      const scene = requireScene(args.sceneId as string);
      const r = ops.raycastPoints(
        scene.state,
        args.points as [number, number][],
        (args.space as never) ?? "frame",
        queryContext(scene),
      );
      return done(r.issues, { revision: scene.revision, ...r.value });
    },
  },
  {
    name: "measure",
    title: "Measure between two pixels",
    description:
      'The length in metres between two pixels. at places both ends in depth: an object id (both at the depth, along the view axis, of that object\'s surface under from: "a fern 160 px tall standing on the platform" is from its foot to its tip at the platform), a depth in metres, or "surface" (each end where its own ray meets the nearest surface). Returns the length, both world points and the depth used. Use it to size things of known size in the reference when setting the scale.',
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        from: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[u, v] pixel." },
        to: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[u, v] pixel." },
        space: PIXEL_SPACE,
        at: {
          anyOf: [{ type: "string" }, { type: "number", exclusiveMinimum: 0 }],
          description: 'An object id, a depth in metres, or "surface".',
        },
      },
      ["sceneId", "from", "to", "at"],
    ),
    readOnly: true,
    async run(args) {
      const scene = requireScene(args.sceneId as string);
      const r = ops.measure(
        scene.state,
        {
          from: args.from as [number, number],
          to: args.to as [number, number],
          space: args.space as never,
          at: args.at as string | number,
        },
        queryContext(scene),
      );
      return done(r.issues, { revision: scene.revision, ...r.value });
    },
  },
  {
    name: "compare_to_reference",
    title: "Compare with the reference",
    description:
      "Score every object that has a trace (or those in ids) against the perspective reference, on the camera frame: spill (pixels drawn outside its trace; always wrong), missing (pixels of its trace, away from hidden runs, where the background or an object whose own trace does not contain them shows instead), iou (visible region against the trace, less what nearer traced objects rightly cover) and order (pixels where an inFrontOf hint is contradicted), each count with its bounding box in frame pixels. Also returns the trace-spill, trace-missing and occlusion-order issues validate reports, and depth-order where the reference has a depth map (estimate_depth). diff: true adds a picture: correct in grey, spill in red, missing in blue, other geometry dark grey. Needs no browser; takes well under a second.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        ids: ids("Compare only these objects (default: every visible object with a trace)."),
        diff: bool("Also return the difference picture."),
      },
      ["sceneId"],
    ),
    readOnly: true,
    async run(args) {
      const scene = requireScene(args.sceneId as string);
      const s = scene.state;
      const image = perspectiveImage(s, imageOf(scene));
      if (!s.references.perspective || !image)
        return failed(
          "no-reference",
          "The scene has no perspective reference image to compare with; set one with set_reference.",
        );
      const c = compareToReference(s, meshOf, image, {
        ids: args.ids as string[] | undefined,
        diff: args.diff === true,
      });
      if (!c)
        return failed(
          "nothing-to-compare",
          "No visible object has a trace. Record each object's silhouette in the reference with set_trace first.",
        );
      const images = c.diff && {
        diff: `data:image/png;base64,${Buffer.from(await encodePng(c.width, c.height, { rgba: c.diff }, (d) => deflateSync(d))).toString("base64")}`,
      };
      const map = await sceneDepthMap(scene);
      return done([...c.issues, ...(map ? depthOrderIssues(s, meshOf, map, image) : [])], {
        revision: scene.revision,
        frame: { width: c.width, height: c.height },
        objects: c.objects,
        ...(images && { images }),
      });
    },
  },
  {
    name: "export",
    title: "Export",
    description:
      "A download link for the scene in another form: scene.json (the full project, images embedded), agent.json (the document without pixels), objects.csv (bounds per object; returned inline too), views.svg (the three views on one sheet), editor.html (the whole editor with this scene inside, one file that works offline).",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        format: { enum: ["scene.json", "agent.json", "objects.csv", "views.svg", "editor.html"] },
      },
      ["sceneId", "format"],
    ),
    readOnly: true,
    async run(args, ctx) {
      const scene = requireScene(args.sceneId as string);
      const format = args.format as string;
      const url = sceneUrl(ctx, scene, `export/${format}`);
      if (format === "objects.csv") return done([], { url, content: objectsCsv(scene.state) });
      return done([], { url, revision: scene.revision });
    },
  },
];

// ---- Dispatch ---------------------------------------------------------------------------------

// Every tool that changes a stored scene takes the revision the caller's picture of it is based on.
for (const t of TOOLS) {
  const properties = t.inputSchema.properties as Record<string, Schema> | undefined;
  if (!t.readOnly && properties?.sceneId)
    properties.baseRevision = {
      type: "integer",
      description:
        "The revision your view of the scene is based on (from the last result or get_scene). If the scene has moved on since (a person editing it, say), nothing changes and the answer is revision-conflict; get_changes says what changed.",
    };
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = new Map(TOOLS.map((t) => [t.name, ajv.compile(t.inputSchema)]));
export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);

/** Validate the arguments, run the tool, and turn every failure into issues. */
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const tool = toolByName(name);
  if (!tool)
    return failed("unknown-tool", `There is no tool "${name}". Tools: ${TOOLS.map((t) => t.name).join(", ")}.`);
  const input = (args ?? {}) as Record<string, unknown>;
  const check = validators.get(name)!;
  if (!check(input))
    return done(
      (check.errors ?? []).map((e) => {
        const key = (e.params as { additionalProperty?: string }).additionalProperty;
        const where = e.instancePath ? `Argument ${e.instancePath}` : "The arguments";
        return issue(
          `argument-${e.keyword}`,
          key
            ? `Unknown argument "${key}"${e.instancePath ? ` in ${e.instancePath}` : ""}.`
            : `${where} ${e.message ?? "is invalid"}.`,
          { path: e.instancePath },
        );
      }),
    );
  try {
    const { baseRevision, ...rest } = input;
    if (baseRevision !== undefined) {
      const scene = requireScene(rest.sceneId as string);
      if (scene.revision !== baseRevision)
        return done(
          [
            issue(
              "revision-conflict",
              `The scene changed: it is at revision ${scene.revision}, not ${baseRevision}. Nothing was changed. get_changes { since: ${baseRevision} } lists what changed; retry based on revision ${scene.revision}.`,
            ),
          ],
          { revision: scene.revision },
        );
    }
    return await tool.run(rest, { ...ctx, tool: name });
  } catch (e) {
    if (e instanceof StoreError) return failed(e.code, e.message);
    if (e instanceof BadRequest) return failed("bad-request", e.message);
    if (e instanceof Busy) return failed("busy", `${e.message} (retry in a few seconds)`);
    if (e instanceof VisionUnavailable) return failed("vision-unavailable", e.message);
    console.error(`tool ${name}:`, e);
    return failed("internal-error", `${name} failed: ${(e as Error).message}`);
  }
}
