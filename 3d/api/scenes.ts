// Scenes held by the server, so agents can build one call at a time (over MCP
// or HTTP) and a person can watch and edit the same scene in the editor.
//
// A scene is addressed by an unguessable id: knowing the id (or the editor
// link that carries it) is what grants access, so ids are never listed.
//
//   DATA_DIR/scenes/<id>.json   state, undo history, the scene's image table
//   DATA_DIR/images/<sha256>    image bytes, shared by every scene that uses them
//
// Scenes untouched for SCENE_TTL_DAYS are deleted, and image bytes no scene
// refers to go with them.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ChangeSummary, diffStates } from "../orthographic/src/core/diff";
import { fromDocument, toDocument } from "../orthographic/src/core/document";
import {
  bytesToBase64,
  IMAGE_MIMES,
  imageId,
  imageSize,
  MAX_IMAGE_BYTES,
  sniffMime,
} from "../orthographic/src/core/images";
import { initialState } from "../orthographic/src/core/model";
import { upgradeObject } from "../orthographic/src/core/parts";
import type { EditorState, ImageInfo, ImageMime, Issue, SceneDocument } from "../orthographic/src/core/types";

const DATA_DIR = process.env.DATA_DIR ?? new URL("../data", import.meta.url).pathname;
const SCENE_TTL_DAYS = Number(process.env.SCENE_TTL_DAYS ?? 90);
const IMAGE_BUDGET_BYTES = Number(process.env.IMAGE_BUDGET_MB ?? 4096) * 1024 * 1024;
const MAX_SCENES = Number(process.env.MAX_SCENES ?? 20000);
const HISTORY_LIMIT = 40;
/** Change summaries are small; keep many more of them than undo steps. */
const LOG_LIMIT = 1000;
/** Undo steps are whole states, so a large scene keeps fewer of them. */
const HISTORY_BYTES = 16 * 1024 * 1024;
const CACHE_LIMIT = 64;
/** An image nothing refers to stays in its scene this long, so it can be added and then used. */
const UNUSED_IMAGE_GRACE_MS = 24 * 3600 * 1000;

export const SCENE_ID = /^[A-Za-z0-9_-]{22}$/;

export interface SceneImage extends ImageInfo {
  /** sha256 of the bytes, hex: the blob's file name. */
  sha: string;
  added: number;
}

export interface Scene {
  id: string;
  revision: number;
  created: string;
  updated: string;
  state: EditorState;
  /** Images this scene can use, by the id its documents give them. */
  images: Record<string, SceneImage>;
  past: string[];
  future: string[];
  /** What each recent revision changed (scenes stored before the log existed have none). */
  log?: ChangeEntry[];
}

/** One revision's change: who made it and what it touched. */
export interface ChangeEntry extends ChangeSummary {
  revision: number;
  at: string;
  /** The tool that made it, "editor" for a person's edit, "undo" or "redo". */
  by: string;
}

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const scenesDir = join(DATA_DIR, "scenes");
const imagesDir = join(DATA_DIR, "images");
mkdirSync(scenesDir, { recursive: true });
mkdirSync(imagesDir, { recursive: true });

const cache = new Map<string, Scene>();
const listeners = new Map<string, Set<(revision: number) => void>>();

function writeAtomic(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function remember(scene: Scene) {
  cache.delete(scene.id);
  cache.set(scene.id, scene);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function persist(scene: Scene) {
  writeAtomic(join(scenesDir, `${scene.id}.json`), JSON.stringify(scene));
  remember(scene);
}

export function getScene(id: string): Scene | undefined {
  if (!SCENE_ID.test(id)) return undefined;
  const hit = cache.get(id);
  if (hit) {
    remember(hit);
    return hit;
  }
  const path = join(scenesDir, `${id}.json`);
  if (!existsSync(path)) return undefined;
  const scene = JSON.parse(readFileSync(path, "utf8")) as Scene;
  upgradeState(scene.state);
  remember(scene);
  return scene;
}

/** A state stored by an older server, brought to the current form (objects as parts). */
function upgradeState(s: EditorState): EditorState {
  for (const e of s.objects) upgradeObject(e);
  return s;
}

/** A state from the undo history, which may be older than the current form. */
const historyState = (snapshot: string) => upgradeState(JSON.parse(snapshot));

/** A scene id from the id itself or an editor link that carries it (?scene=...). */
export function sceneIdFrom(ref: string): string {
  const m = /[?&]scene=([A-Za-z0-9_-]{22})/.exec(ref);
  return m ? m[1] : ref.trim();
}

export function requireScene(ref: string): Scene {
  const scene = getScene(sceneIdFrom(ref));
  if (!scene)
    throw new StoreError(
      "unknown-scene",
      `There is no scene "${ref}". Scenes unused for ${SCENE_TTL_DAYS} days are deleted; create a new one.`,
    );
  return scene;
}

// ---- Change notification ----------------------------------------------------------

export function subscribe(id: string, f: (revision: number) => void): () => void {
  const set = listeners.get(id) ?? new Set();
  listeners.set(id, set);
  set.add(f);
  return () => {
    set.delete(f);
    if (!set.size) listeners.delete(id);
  };
}

function changed(scene: Scene, before: EditorState, by: string) {
  scene.revision++;
  scene.updated = new Date().toISOString();
  scene.log = [
    ...(scene.log ?? []),
    { revision: scene.revision, at: scene.updated, by, ...diffStates(before, scene.state) },
  ];
  if (scene.log.length > LOG_LIMIT) scene.log = scene.log.slice(-LOG_LIMIT);
  pruneImages(scene);
  persist(scene);
  for (const f of listeners.get(scene.id) ?? []) f(scene.revision);
}

// ---- Images --------------------------------------------------------------------------

const blobPath = (sha: string) => join(imagesDir, sha);

function imageBytesInStore(): number {
  let total = 0;
  for (const name of readdirSync(imagesDir)) total += statSync(join(imagesDir, name)).size;
  return total;
}

let storedBytes: number | undefined;

/** Keep image bytes, once per content. */
async function putBlob(bytes: Uint8Array): Promise<string> {
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const path = blobPath(sha);
  if (existsSync(path)) {
    // Fresh again, so the sweep's grace period covers the scene about to use it.
    const now = new Date();
    utimesSync(path, now, now);
    return sha;
  }
  storedBytes ??= imageBytesInStore();
  if (storedBytes + bytes.length > IMAGE_BUDGET_BYTES) {
    sweep();
    storedBytes = imageBytesInStore();
    if (storedBytes + bytes.length > IMAGE_BUDGET_BYTES)
      throw new StoreError("storage-full", "The server's image storage is full; try again later.");
  }
  writeAtomic(path, bytes);
  storedBytes += bytes.length;
  return sha;
}

/** Check image bytes and describe them: type and pixel size from the header, id from the content. */
export async function inspectImage(bytes: Uint8Array) {
  if (bytes.length > MAX_IMAGE_BYTES) throw new StoreError("image-too-large", "Use an image smaller than 25 MB.");
  const mimeType = sniffMime(bytes);
  if (!mimeType || !IMAGE_MIMES.includes(mimeType))
    throw new StoreError("invalid-image", "Use a PNG, JPEG, WebP or GIF image.");
  const size = imageSize(bytes);
  if (!size || size.width < 1 || size.height < 1)
    throw new StoreError("invalid-image", "The image's header does not give its size; it may be truncated.");
  return { mimeType: mimeType as ImageMime, ...size, id: await imageId(bytes) };
}

/**
 * Add image bytes to a scene. The id is derived from the content unless the
 * caller gives one (a document's own image ids are kept).
 */
export async function addImage(scene: Scene, bytes: Uint8Array, name: string, id?: string): Promise<SceneImage> {
  const info = await inspectImage(bytes);
  const sha = await putBlob(bytes);
  const entry: SceneImage = {
    id: id ?? info.id,
    name: name.slice(0, 180) || info.id,
    mimeType: info.mimeType,
    width: info.width,
    height: info.height,
    sha,
    added: Date.now(),
  };
  const existing = scene.images[entry.id];
  if (existing?.sha === sha) return existing;
  scene.images[entry.id] = entry;
  persist(scene);
  return entry;
}

export function imageBytes(image: SceneImage): Uint8Array {
  return readFileSync(blobPath(image.sha));
}

function referencedImages(s: EditorState): string[] {
  return Object.values(s.references).flatMap((r) => (r ? [r.image] : []));
}

/** Drop images that no state (current or in history) uses and that are past their grace period. */
function pruneImages(scene: Scene) {
  const used = new Set(referencedImages(scene.state));
  for (const snapshot of [...scene.past, ...scene.future])
    for (const id of referencedImages(JSON.parse(snapshot))) used.add(id);
  const now = Date.now();
  for (const [id, img] of Object.entries(scene.images))
    if (!used.has(id) && now - img.added > UNUSED_IMAGE_GRACE_MS) delete scene.images[id];
}

// ---- Documents ------------------------------------------------------------------------

/** The scene as a document. `images: "data"` embeds the pixels (read from the blob store). */
export function sceneDocument(
  scene: Scene,
  opts: { images?: "data" | "metadata" | "none"; derived?: boolean } = {},
): SceneDocument {
  const mode = opts.images ?? "metadata";
  const images = new Map<string, ImageInfo & { data?: string }>();
  for (const img of Object.values(scene.images)) images.set(img.id, img);
  if (mode === "data") {
    const used = new Set(referencedImages(scene.state));
    for (const id of used) {
      const img = scene.images[id];
      if (img) images.set(id, { ...img, data: bytesToBase64(imageBytes(img)) });
    }
  }
  return toDocument(scene.state, images, { images: mode, derived: opts.derived });
}

/**
 * Read a document for a scene: images it embeds are stored, images it only
 * names must already be in the scene. Returns the new state (when nothing is
 * an error) and every issue.
 */
export async function readDocument(
  doc: unknown,
  scene?: Scene,
): Promise<{ state?: EditorState; issues: Issue[]; images: Record<string, SceneImage> }> {
  const images: Record<string, SceneImage> = { ...scene?.images };
  const read = fromDocument(doc, (id) => images[id]);
  if (!read.state) return { issues: read.issues, images };
  for (const a of read.images) {
    try {
      const bytes = Uint8Array.from(Buffer.from(a.data, "base64"));
      const info = await inspectImage(bytes);
      images[a.id] = {
        id: a.id,
        name: a.name,
        mimeType: info.mimeType,
        width: info.width,
        height: info.height,
        sha: await putBlob(bytes),
        added: Date.now(),
      };
    } catch (e) {
      const message = e instanceof StoreError ? e.message : (e as Error).message;
      return {
        issues: [
          ...read.issues,
          {
            severity: "error",
            code: "image-undecodable",
            path: `/images/${a.id}`,
            message: `Image "${a.id}": ${message}`,
          },
        ],
        images,
      };
    }
  }
  return { state: read.state, issues: read.issues, images };
}

// ---- Scene lifecycle and edits -------------------------------------------------------

let sceneCount: number | undefined;

export function createScene(state: EditorState = initialState(), images: Record<string, SceneImage> = {}): Scene {
  sceneCount ??= readdirSync(scenesDir).length;
  if (sceneCount >= MAX_SCENES) {
    sweep();
    if (sceneCount >= MAX_SCENES)
      throw new StoreError("storage-full", "The server holds too many scenes; try again later.");
  }
  sceneCount++;
  const now = new Date().toISOString();
  const scene: Scene = {
    id: randomBytes(16).toString("base64url"),
    revision: 1,
    created: now,
    updated: now,
    state,
    images,
    past: [],
    future: [],
  };
  persist(scene);
  return scene;
}

/**
 * Run an edit on a copy of the scene's state and keep it as one undoable step
 * unless it reported an error. Returns the edit's result.
 */
export function editScene<R extends { issues: Issue[] }>(
  scene: Scene,
  edit: (draft: EditorState) => R,
  by = "edit",
): R {
  const before = JSON.stringify(scene.state);
  const draft = JSON.parse(before) as EditorState;
  const out = edit(draft);
  if (out.issues.some((i) => i.severity === "error")) return out;
  if (JSON.stringify(draft) === before) return out;
  scene.past.push(before);
  scene.future = [];
  let bytes = scene.past.reduce((n, p) => n + p.length, 0);
  while (scene.past.length > HISTORY_LIMIT || (bytes > HISTORY_BYTES && scene.past.length > 1))
    bytes -= scene.past.shift()!.length;
  const previous = scene.state;
  scene.state = draft;
  changed(scene, previous, by);
  return out;
}

/** Replace the scene's state and image table (a document load) as one undoable step. */
export function replaceScene(scene: Scene, state: EditorState, images: Record<string, SceneImage>, by: string) {
  scene.images = images;
  editScene(
    scene,
    (draft) => {
      Object.assign(draft, state);
      return { issues: [] };
    },
    by,
  );
}

export function undo(scene: Scene): boolean {
  const previous = scene.past.pop();
  if (previous === undefined) return false;
  scene.future.push(JSON.stringify(scene.state));
  const before = scene.state;
  scene.state = historyState(previous);
  changed(scene, before, "undo");
  return true;
}

export function redo(scene: Scene): boolean {
  const next = scene.future.pop();
  if (next === undefined) return false;
  scene.past.push(JSON.stringify(scene.state));
  const before = scene.state;
  scene.state = historyState(next);
  changed(scene, before, "redo");
  return true;
}

/**
 * The changes after revision `since`, one entry per revision. `complete` is
 * false when the log no longer reaches back that far (the oldest entries are
 * dropped first).
 */
export function changesSince(scene: Scene, since: number): { complete: boolean; changes: ChangeEntry[] } {
  const log = scene.log ?? [];
  const changes = log.filter((c) => c.revision > since);
  const complete = since >= scene.revision || (log.length > 0 && log[0].revision <= since + 1);
  return { complete, changes };
}

// ---- Expiry ----------------------------------------------------------------------------

/** Delete scenes past their time to live, then image bytes no remaining scene refers to. */
export function sweep() {
  const cutoff = Date.now() - SCENE_TTL_DAYS * 24 * 3600 * 1000;
  const keep = new Set<string>();
  let unreadable = false;
  for (const name of readdirSync(scenesDir)) {
    const path = join(scenesDir, name);
    if (!name.endsWith(".json")) {
      // A temporary file left by a crash mid-write.
      if (statSync(path).mtimeMs < Date.now() - 3600_000) rmSync(path, { force: true });
      continue;
    }
    if (statSync(path).mtimeMs < cutoff) {
      rmSync(path, { force: true });
      cache.delete(name.slice(0, -5));
      continue;
    }
    try {
      const scene = JSON.parse(readFileSync(path, "utf8")) as Scene;
      for (const img of Object.values(scene.images)) keep.add(img.sha);
    } catch {
      // Unreadable: leave it, and every image (it may refer to any), for a person to look at.
      unreadable = true;
    }
  }
  if (!unreadable)
    for (const name of readdirSync(imagesDir)) {
      const path = join(imagesDir, name);
      // Recent blobs may belong to a scene being written right now.
      if (!keep.has(name) && statSync(path).mtimeMs < Date.now() - 3600_000) rmSync(path, { force: true });
    }
  storedBytes = undefined;
  sceneCount = readdirSync(scenesDir).length;
}
