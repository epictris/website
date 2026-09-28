// Pictures of a scene, drawn by the real editor in headless Chromium (see
// browser.ts): PNG renders of each view, and the three-view SVG sheet.

import type { Issue } from "../orthographic/src/core/types";
import { runInEditor } from "./browser";

export const EDITOR_URL = process.env.EDITOR_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8080}/orthographic/`;
export const VIEWS = ["front", "top", "side", "perspective"] as const;
export type RenderView = (typeof VIEWS)[number];

export class BadRequest extends Error {}

export interface RenderOptions {
  views?: string[];
  width?: number;
  height?: number;
  references?: boolean;
  labels?: boolean;
  grid?: boolean;
}

interface Normalised {
  views: RenderView[];
  width?: number;
  height?: number;
  references?: boolean;
  labels?: boolean;
  grid?: boolean;
}

export interface RenderOutcome {
  ok: boolean;
  issues: Issue[];
  /** PNG data: URLs by view. */
  images?: Record<string, string>;
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
  return {
    views: [...new Set(views)] as RenderView[],
    width: clamp(req.width, 128, 4096),
    height: clamp(req.height, 128, 4096),
    references: req.references,
    labels: req.labels,
    grid: req.grid,
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
  if (!key) return runInEditor(EDITOR_URL, renderInEditor, { document, options });
  const k = `${key} ${JSON.stringify(options)}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const run = runInEditor(EDITOR_URL, renderInEditor, { document, options });
  cache.set(k, run);
  // Failures (a busy renderer, a timeout) are not worth remembering.
  run.catch(() => cache.delete(k));
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return run;
}

export async function projectionSheet(document: unknown): Promise<{ ok: boolean; issues: Issue[]; svg?: string }> {
  return runInEditor(EDITOR_URL, sheetInEditor, document);
}

export const pngBytes = (dataUrl: string) => Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
