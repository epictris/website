// Pictures of a scene, drawn by the real editor in headless Chromium (see
// browser.ts): PNG renders of each view, and the three-view SVG sheet.

import { deflateSync } from "node:zlib";
import { validateDocument } from "../orthographic/src/core/document";
import { encodePng } from "../orthographic/src/core/png";
import { depthPixels, idLegend, idPixels, rasterize } from "../orthographic/src/core/raster";
import type { Issue } from "../orthographic/src/core/types";
import { runInEditor } from "./browser";
import { checkGeometry, documentImages, meshOf } from "./geometry";

export const EDITOR_URL = process.env.EDITOR_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8080}/orthographic/`;
export const VIEWS = ["front", "top", "side", "perspective"] as const;
export type RenderView = (typeof VIEWS)[number];

export class BadRequest extends Error {}

export const MODES = ["shaded", "ids", "depth"] as const;
export type RenderMode = (typeof MODES)[number];

export interface RenderOptions {
  views?: string[];
  width?: number;
  height?: number;
  pixelsPerMeter?: number;
  references?: boolean;
  labels?: boolean;
  grid?: boolean;
  /** Perspective: shaded (default), ids (flat colour per object, with a legend) or depth (16-bit grey). */
  mode?: string;
  /** Perspective over a reference: every edge (default) or only each object's silhouette. */
  outlines?: string;
  /** Perspective: the reference's opacity for this picture only. */
  referenceOpacity?: number;
}

interface Normalised {
  views: RenderView[];
  width?: number;
  height?: number;
  pixelsPerMeter?: number;
  references?: boolean;
  labels?: boolean;
  grid?: boolean;
  mode: RenderMode;
  outlines?: "all" | "silhouette";
  referenceOpacity?: number;
}

export interface RenderOutcome {
  ok: boolean;
  issues: Issue[];
  /** PNG data: URLs by view. */
  images?: Record<string, string>;
  /** The orthographic views' shared scale, and where each of their pictures lies in metres. */
  pixelsPerMeter?: number;
  placements?: Record<string, Placement>;
  /** mode ids: colour (#rrggbb) to object id. */
  legend?: Record<string, string>;
  /** mode depth: the depths in metres the grey values span (white is near). */
  depthRange?: { near: number; far: number };
}

export interface Placement {
  min: Record<string, number>;
  size: Record<string, number>;
  width: number;
  height: number;
}

type PageApi = Record<string, (...a: unknown[]) => Promise<RenderOutcome & { svg?: string }>>;

/** Runs inside the editor page: load the document, render, and report every issue once. */
async function renderInEditor(job: { document: unknown; options: Normalised }): Promise<RenderOutcome> {
  const api = (window as unknown as { orthographic: PageApi }).orthographic;
  const loaded = await api.loadDocument(job.document);
  if (!loaded.ok) return loaded;
  const rendered = await api.render(job.options);
  const checked = await api.validate();
  const known = new Set(loaded.issues.map((i) => `${i.code} ${i.path}`));
  return {
    ok: rendered.ok,
    issues: [...loaded.issues, ...rendered.issues, ...checked.issues.filter((i) => !known.has(`${i.code} ${i.path}`))],
    images: rendered.images,
    pixelsPerMeter: rendered.pixelsPerMeter,
    placements: rendered.placements,
  };
}

async function sheetInEditor(document: unknown): Promise<{ ok: boolean; issues: Issue[]; svg?: string }> {
  const api = (window as unknown as { orthographic: PageApi }).orthographic;
  const loaded = await api.loadDocument(document);
  if (!loaded.ok) return loaded;
  return api.sheet();
}

export function renderOptions(req: RenderOptions): Normalised {
  const views = req.views ?? [...VIEWS];
  if (!Array.isArray(views) || !views.length || !views.every((v) => VIEWS.includes(v as RenderView)))
    throw new BadRequest(`views must be a list of ${VIEWS.join(", ")}.`);
  const clamp = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : undefined;
  const ppm = req.pixelsPerMeter;
  if (ppm !== undefined && !(typeof ppm === "number" && Number.isFinite(ppm) && ppm > 0 && ppm <= 1e6))
    throw new BadRequest("pixelsPerMeter must be a positive number (at most 1,000,000).");
  if (req.mode !== undefined && !MODES.includes(req.mode as RenderMode))
    throw new BadRequest(`mode must be one of ${MODES.join(", ")}.`);
  if (req.outlines !== undefined && req.outlines !== "all" && req.outlines !== "silhouette")
    throw new BadRequest('outlines must be "all" or "silhouette".');
  const opacity = req.referenceOpacity;
  if (opacity !== undefined && !(typeof opacity === "number" && opacity >= 0 && opacity <= 1))
    throw new BadRequest("referenceOpacity must be from 0 to 1.");
  return {
    views: [...new Set(views)] as RenderView[],
    width: clamp(req.width, 128, 4096),
    height: clamp(req.height, 128, 4096),
    pixelsPerMeter: ppm,
    references: req.references,
    labels: req.labels,
    grid: req.grid,
    mode: (req.mode as RenderMode | undefined) ?? "shaded",
    outlines: req.outlines as Normalised["outlines"],
    referenceOpacity: opacity,
  };
}

const deflate = (data: Uint8Array) => deflateSync(data);
const dataUrl = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

/**
 * The perspective view as an id or depth picture, drawn on the CPU from the
 * document: no browser, and no image pixels needed.
 */
async function rasterPicture(document: unknown, options: Normalised): Promise<RenderOutcome> {
  const read = validateDocument(document, { geometry: false });
  if (!read.state) return { ok: false, issues: read.issues };
  const s = read.state;
  const width = options.width ?? s.camera.frame[0];
  const height = Math.round((width * s.camera.frame[1]) / s.camera.frame[0]);
  const shown = s.objects.filter((e) => e.visible);
  const raster = rasterize(s.camera, shown, meshOf, width, height);
  const issues = [...read.issues, ...(await checkGeometry(s, documentImages(document)))];
  if (options.mode === "ids") {
    const png = await encodePng(width, height, { rgba: idPixels(raster) }, deflate);
    return { ok: true, issues, images: { perspective: dataUrl(png) }, legend: idLegend(raster.objects) };
  }
  const { grey16, near, far } = depthPixels(raster);
  const png = await encodePng(width, height, { grey16 }, deflate);
  return { ok: true, issues, images: { perspective: dataUrl(png) }, depthRange: { near, far } };
}

/** Run a render: ids and depth pictures on the CPU here, everything else in the editor. */
async function run(document: unknown, options: Normalised): Promise<RenderOutcome> {
  const raster = options.mode !== "shaded" && options.views.includes("perspective");
  const rest = raster ? options.views.filter((v) => v !== "perspective") : options.views;
  const [picture, editor] = await Promise.all([
    raster ? rasterPicture(document, options) : undefined,
    rest.length
      ? runInEditor(EDITOR_URL, renderInEditor, { document, options: { ...options, views: rest } })
      : undefined,
  ]);
  if (!editor) return picture!;
  if (!picture) return editor;
  const known = new Set(editor.issues.map((i) => `${i.code} ${i.path}`));
  return {
    ...editor,
    ok: editor.ok && picture.ok,
    issues: [...editor.issues, ...picture.issues.filter((i) => !known.has(`${i.code} ${i.path}`))],
    images: { ...editor.images, ...picture.images },
    legend: picture.legend,
    depthRange: picture.depthRange,
  };
}

// Renders of stored scenes, by revision: the same picture is asked for more
// than once (an agent's tool call, then a person opening its link).
const CACHE_LIMIT = 48;
const cache = new Map<string, Promise<RenderOutcome>>();

/**
 * Render a document. `key` (a scene id and revision) lets a repeated request
 * reuse the earlier result.
 */
export function render(document: unknown, req: RenderOptions, key?: string): Promise<RenderOutcome> {
  const options = renderOptions(req);
  if (!key) return run(document, options);
  const k = `${key} ${JSON.stringify(options)}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const job = run(document, options);
  cache.set(k, job);
  // Failures (a busy renderer, a timeout) are not worth remembering.
  job.catch(() => cache.delete(k));
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return job;
}

export async function projectionSheet(document: unknown): Promise<{ ok: boolean; issues: Issue[]; svg?: string }> {
  return runInEditor(EDITOR_URL, sheetInEditor, document);
}

export const pngBytes = (dataUrl: string) => Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
