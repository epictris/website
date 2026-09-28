// The server's tools: every editor capability an agent needs, over stored
// scenes. One definition serves both the MCP server (mcp.ts) and the HTTP API
// (POST /orthographic/api/tools/<name>), so the two never drift apart.
//
// Each tool validates its arguments against its JSON Schema, runs the same
// core ops as the editor, and answers { ok, issues, ... }: an issue list rather
// than an exception, so a caller always learns what to fix.

import Ajv2020 from "ajv/dist/2020";
import { issue } from "../orthographic/src/core/commands";
import { validateDocument } from "../orthographic/src/core/document";
import { base64ToBytes, parseDataUrl } from "../orthographic/src/core/images";
import * as ops from "../orthographic/src/core/ops";
import { objectsCsv } from "../orthographic/src/core/table";
import type { EditorState, Issue, ReferenceView, ViewId } from "../orthographic/src/core/types";
import { Busy } from "./browser";
import { fetchImage } from "./fetchImage";
import { checkGeometry } from "./geometry";
import { BadRequest, render, VIEWS } from "./render";
import {
  addImage,
  createScene,
  editScene,
  readDocument,
  redo,
  replaceScene,
  requireScene,
  type Scene,
  StoreError,
  sceneDocument,
  undo,
} from "./scenes";

export interface ToolContext {
  /** Where this server is reached from the caller's side, e.g. https://3d.tris.sh. */
  origin: string;
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
    'A scene document: { format: "orthographic-scene", version: 1, scene: { size }, objects: [...], camera?, references?, images? }. See read_guide for the full format.',
};
const VIEW: Schema = { enum: ["front", "top", "side"], description: "front = x/z, top = x/y, side = y/z." };
const OBJECT_PROPS: Record<string, Schema> = {
  name: str("Display name.", { maxLength: 180 }),
  kind: str("Free-form tag such as rock, plant or wall.", { maxLength: 40 }),
  color: str("Hex colour, #rrggbb.", { pattern: "^#[0-9a-fA-F]{6}$" }),
  visible: bool(),
  locked: bool("A locked object refuses edits until unlocked."),
  reviewed: bool("Marks the object as checked against its references."),
  opacity: num("0.05 to 1; below 1 renders translucent."),
  notes: str(undefined, { maxLength: 2000 }),
};

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

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

/** The document form of some objects, with their derived bounds. */
function objectsOf(scene: Scene, idList: string[]) {
  const wanted = new Set(idList);
  return sceneDocument(scene, { images: "none" }).objects.filter((o) => wanted.has(o.id));
}

/**
 * Run an op on a scene as one undoable step. On success report the new
 * revision, the op's values, the touched objects and their geometry problems.
 */
async function edit(
  args: Record<string, unknown>,
  op: (draft: EditorState, scene: Scene) => ops.OpResult,
): Promise<ToolOutput> {
  const scene = requireScene(args.sceneId as string);
  const out = editScene(scene, (d) => op(d, scene));
  if (out.issues.some((i) => i.severity === "error")) return done(out.issues, { revision: scene.revision });
  const touched = (out.touched ?? []).filter((id) => scene.state.objects.some((e) => e.id === id));
  const geometry = touched.length ? await checkGeometry(scene.state, new Set(touched)) : [];
  const known = new Set(out.issues.map((i) => `${i.code} ${i.path} ${i.objectId}`));
  return done([...out.issues, ...geometry.filter((i) => !known.has(`${i.code} ${i.path} ${i.objectId}`))], {
    revision: scene.revision,
    ...out.value,
    ...(touched.length && { objects: objectsOf(scene, touched) }),
  });
}

async function validateScene(scene: Scene): Promise<Issue[]> {
  const read = validateDocument(sceneDocument(scene, { images: "metadata" }), {
    geometry: false,
    known: imageOf(scene),
  });
  return [...read.issues, ...(read.state ? await checkGeometry(read.state) : [])];
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
      return done([...read.issues, ...(await checkGeometry(scene.state))], {
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
      "The scene as a document in world units, with derived bounds per object and the camera's derived values (focal length, matrices). Images are listed without their pixels.",
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
      replaceScene(scene, read.state, read.images);
      return done([...read.issues, ...(await checkGeometry(scene.state))], { revision: scene.revision });
    },
  },
  {
    name: "validate",
    title: "Validate",
    description:
      "Check a scene (sceneId) or a document (document) and report every problem at once, each with a JSON Pointer path: schema errors, outlines that are not simple polygons, and geometry (outlines that share no volume or clip each other).",
    inputSchema: object({ sceneId: SCENE_ID, document: DOCUMENT }),
    readOnly: true,
    async run(args) {
      if (args.document !== undefined) {
        const known = args.sceneId ? imageOf(requireScene(args.sceneId as string)) : undefined;
        const read = validateDocument(args.document, { geometry: false, known });
        return done([...read.issues, ...(read.state ? await checkGeometry(read.state) : [])]);
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
      "Add an object from world-unit outlines (front [x, z], top [x, y], side [y, z]; each a simple polygon of 3-512 points without a repeated closing point), or from a primitive filling a box (center and size). Returns its id, its bounds and any geometry problems.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        id: str("Letters, digits, _ . -, starting with a letter or digit; unique. Generated when omitted."),
        outlines: object(
          {
            front: ring("[x, z] points."),
            top: ring("[x, y] points."),
            side: ring("[y, z] points."),
          },
          ["front", "top", "side"],
        ),
        primitive: {
          enum: ["box", "ellipsoid", "cylinder", "rock"],
          description: "Instead of outlines: a starting shape filling the box given by center and size.",
        },
        center: vec3("Box centre for a primitive (default: the scene centre)."),
        size: vec3("Box size for a primitive (default 4 x 4 x 4)."),
        ...OBJECT_PROPS,
      },
      ["sceneId"],
    ),
    run: (args) =>
      edit(args, (d) => {
        const { sceneId: _, ...spec } = args;
        return ops.addObject(d, spec as ops.AddObjectArgs);
      }),
  },
  {
    name: "update_object",
    title: "Update an object's properties",
    description: "Change an object's name, kind, color, visibility, lock, reviewed flag, opacity or notes.",
    inputSchema: object({ sceneId: SCENE_ID, id: str("The object's id."), ...OBJECT_PROPS }, ["sceneId", "id"]),
    run: (args) =>
      edit(args, (d) => {
        const { sceneId: _, id, ...patch } = args;
        return ops.updateObject(d, id as string, patch);
      }),
  },
  {
    name: "set_outline",
    title: "Set an outline",
    description:
      "Replace one view's outline of an object with world-unit points: [x, z] for front, [x, y] for top, [y, z] for side. The object's box follows the new outline and the other views stretch to keep shared axes consistent.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        id: str("The object's id."),
        view: VIEW,
        points: ring("A simple closed polygon, no repeated closing point."),
      },
      ["sceneId", "id", "view", "points"],
    ),
    run: (args) =>
      edit(args, (d) => ops.setOutline(d, args.id as string, args.view as ViewId, args.points as [number, number][])),
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
    run: (args) =>
      edit(args, (d) => ops.setBounds(d, args.ids as string[], { min: args.min as never, max: args.max as never })),
  },
  {
    name: "move_objects",
    title: "Move objects",
    description: "Translate objects by a world-unit offset.",
    inputSchema: object({ sceneId: SCENE_ID, ids: ids(), offset: vec3("World-unit offset.") }, [
      "sceneId",
      "ids",
      "offset",
    ]),
    run: (args) => edit(args, (d) => ops.moveObjects(d, args.ids as string[], args.offset as never)),
  },
  {
    name: "duplicate_objects",
    title: "Duplicate objects",
    description: "Copy objects, offset by a world-unit vector (default {x: 1, y: 1, z: 0}). Returns the new ids.",
    inputSchema: object({ sceneId: SCENE_ID, ids: ids(), offset: vec3() }, ["sceneId", "ids"]),
    run: (args) => edit(args, (d) => ops.duplicateObjects(d, args.ids as string[], args.offset as never)),
  },
  {
    name: "delete_objects",
    title: "Delete objects",
    description: "Delete objects (undo restores them).",
    inputSchema: object({ sceneId: SCENE_ID, ids: ids() }, ["sceneId", "ids"]),
    destructive: true,
    run: (args) => edit(args, (d) => ops.deleteObjects(d, args.ids as string[])),
  },
  {
    name: "set_scene",
    title: "Set scene properties",
    description:
      "Set the title, the scene frame (size: the drawing guide from (0, 0, 0) to size, not a boundary), the real-world scale metersPerUnit (null when unknown) and notes.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        title: str(undefined, { maxLength: 100 }),
        size: vec3("Frame size in scene units; at least 0.1 on every axis."),
        metersPerUnit: { type: ["number", "null"], description: "Metres per scene unit, or null." },
        notes: str(undefined, { maxLength: 4000 }),
      },
      ["sceneId"],
    ),
    run: (args) =>
      edit(args, (d) => {
        const { sceneId: _, ...patch } = args;
        return ops.setScene(d, patch as ops.SceneArgs);
      }),
  },
  {
    name: "set_camera",
    title: "Set the camera",
    description:
      "Set the perspective camera: position, target, the lens as verticalFovDegrees or focalLengthMm35Equivalent (f = 12 mm / tan(vertical FOV / 2); give one), rollDegrees, near, far, frame (output pixels, fixes the aspect ratio) and locked.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        position: vec3(),
        target: vec3(),
        verticalFovDegrees: num("5 to 140."),
        focalLengthMm35Equivalent: num("Full-frame equivalent focal length, 4.36 to 275 mm."),
        rollDegrees: num("-180 to 180."),
        near: num(),
        far: num(),
        frame: object({ width: { type: "integer" }, height: { type: "integer" } }, ["width", "height"]),
        locked: bool(),
      },
      ["sceneId"],
    ),
    run: (args) =>
      edit(args, (d) => {
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
    run: (args) =>
      edit(args, (d) => {
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
      },
      ["sceneId", "view"],
    ),
    run: (args) =>
      edit(args, (d, scene) => {
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
      "Pictures of the scene for checking it against its references: front, top and side fitted to the scene (with their reference images unless references is false), and perspective through the camera frame with its overlay. Returns PNG images, links to them, and every issue found. Takes a few seconds.",
    inputSchema: object(
      {
        sceneId: SCENE_ID,
        views: { type: "array", items: { enum: [...VIEWS] }, description: "Default: all four." },
        width: { type: "integer", description: "128 to 4096; default 1200 (perspective: the camera frame width)." },
        height: { type: "integer", description: "128 to 4096; default 900 (orthographic views only)." },
        references: bool("Draw reference images (default true)."),
        labels: bool("Label objects in orthographic views (default true)."),
        grid: bool("Draw the grid in orthographic views (default true)."),
      },
      ["sceneId"],
    ),
    readOnly: true,
    async run(args, ctx) {
      const scene = requireScene(args.sceneId as string);
      const { sceneId: _, ...options } = args;
      const out = await render(sceneDocument(scene, { images: "data" }), options, `${scene.id}@${scene.revision}`);
      const query = new URLSearchParams();
      for (const k of ["width", "height", "references", "labels", "grid"])
        if (args[k] !== undefined) query.set(k, String(args[k]));
      const urls = Object.fromEntries(
        Object.keys(out.images ?? {}).map((v) => [
          v,
          `${sceneUrl(ctx, scene, `render/${v}.png`)}?rev=${scene.revision}${query.size ? `&${query}` : ""}`,
        ]),
      );
      return { ...done(out.issues), revision: scene.revision, urls, images: out.images };
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
    return await tool.run(input, ctx);
  } catch (e) {
    if (e instanceof StoreError) return failed(e.code, e.message);
    if (e instanceof BadRequest) return failed("bad-request", e.message);
    if (e instanceof Busy) return failed("busy", `${e.message} (retry in a few seconds)`);
    console.error(`tool ${name}:`, e);
    return failed("internal-error", `${name} failed: ${(e as Error).message}`);
  }
}
