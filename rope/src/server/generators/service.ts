// The generator service: the dev server's side of the visuals workspace's two
// procedural pipelines. See docs/generators.md.
//
//   GET    /api/generators            which tools are here, how long the queue is
//   POST   /api/generate              { kind, key, input, params, object? } -> { key, state }
//   GET    /api/generate/<key>        a job's state
//   DELETE /api/generate/<key>        cancel it
//   GET    /generated/<kind>/<hash>/mesh.glb   the result, immutable
//
// Results are content-addressed: the mesh key names the output directory, so
// asking again for something already generated is free, and a key is never
// rewritten. Blender runs one job at a time (it saturates this machine's CPU on
// its own), so jobs wait in one FIFO queue.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";
import { boulder } from "./boulder";
import { glbTriangles } from "./glb";
import { mushrooms } from "./mushrooms";
import { findTools, toolVersions, type Tools, type ToolVersions } from "./paths";
import { Cancelled, makeJobDir, runGenerator, type Generator, type GeneratorKind } from "./run";
import { loadSchema, mergeParams, validatePairs, validateParams, type Params } from "./schema";

export const GENERATORS: Record<GeneratorKind, Generator<unknown>> = {
  boulder: boulder as Generator<unknown>,
  mushrooms: mushrooms as Generator<unknown>,
};

/** A mesh key: the generator, then a 64-bit content hash as 16 hex digits. */
export const KEY = /^(boulder|mushrooms):([0-9a-f]{16})$/;

/**
 * The key the server would give this content, or null to trust the client's.
 *
 * Null for now: the key's hash (`generatedKey` in src/render3d/generated.ts) is
 * the format phase's, and the server only checks the key's shape. The merge
 * wires `generatedKey` in here so a request whose key does not match its
 * content is refused rather than cached under a wrong name.
 */
export function expectedKey(_kind: GeneratorKind, _input: unknown, _params: Params): string | null {
  return null;
}

export type JobState = "queued" | "running" | "done" | "failed" | "superseded";

export interface Status {
  state: JobState;
  /** Seconds waiting (queued), running (running), or the run took (done, failed). */
  elapsed: number;
  message?: string;
  bytes?: number;
  triangles?: number;
}

interface Job {
  key: string;
  kind: GeneratorKind;
  hash: string;
  input: unknown;
  params: Params;
  /** The editor object this job generates for; a newer request for it supersedes this one. */
  object?: string;
  state: JobState;
  submitted: number;
  started?: number;
  finished?: number;
  message?: string;
  bytes?: number;
  triangles?: number;
  /** Past this the geometry is done and a supersede lets the job finish. */
  pastBake: boolean;
  abort?: AbortController;
}

export interface Meta {
  key: string;
  kind: GeneratorKind;
  version: number;
  params: Params;
  input: unknown;
  bytes: number;
  triangles: number;
  generatedAt: string;
  blender: string | null;
  seconds: number;
}

export const generatedDir = (root: string, kind: string, hash: string) =>
  join(root, "public", "generated", kind, hash);

// The request body cap (characters): a mushroom patch's 40 000-triangle soup,
// as the fork allowed it. A boulder's outline is bounded by its own validation.
const BODY_LIMIT = 12_000_000;

const seconds = (ms: number) => Math.round(ms / 100) / 10;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class GeneratorService {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running: Job | null = null;
  private versions: Promise<ToolVersions> | null = null;

  constructor(
    readonly root: string,
    private readonly log: (line: string) => void = () => {},
    private readonly findToolsNow: () => Tools = () => findTools(root),
  ) {}

  /** The versions, probed once; a probe that found something missing is retried next time. */
  async toolStatus(): Promise<ToolVersions & { venv: boolean; queue: number }> {
    const tools = this.findToolsNow();
    const probe = (this.versions ??= toolVersions(tools));
    const versions = await probe;
    if (!versions.python || !versions.blender || !versions.deps) this.versions = null;
    return { ...versions, venv: tools.venv, queue: this.queue.length + (this.running ? 1 : 0) };
  }

  submit(body: unknown): { key: string; state: JobState } {
    const req = body as { kind?: unknown; key?: unknown; input?: unknown; params?: unknown; object?: unknown } | null;
    if (!req || typeof req !== "object") throw new HttpError(400, "Send { kind, key, input, params }.");
    const kind = req.kind as GeneratorKind;
    const gen = GENERATORS[kind];
    if (typeof req.kind !== "string" || !gen) throw new HttpError(400, "kind must be boulder or mushrooms.");
    const match = typeof req.key === "string" ? KEY.exec(req.key) : null;
    if (!match || match[1] !== kind) throw new HttpError(400, `key must be ${kind}:<16 hex digits>.`);
    if (req.object !== undefined && typeof req.object !== "string") throw new HttpError(400, "object must be a string.");
    const key = req.key as string;
    const hash = match[2]!;

    const schema = loadSchema(this.root, gen.dir);
    let params: Params;
    let input: unknown;
    try {
      params = validateParams(schema, req.params);
      const values = mergeParams(schema, params);
      validatePairs(values);
      input = gen.validateInput(req.input, values);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const expected = expectedKey(kind, input, params);
    if (expected !== null && expected !== key) throw new HttpError(400, `key does not match its content (${expected}).`);

    if (req.object !== undefined) this.supersede(req.object, key);
    if (existsSync(join(generatedDir(this.root, kind, hash), "mesh.glb"))) return { key, state: "done" };
    const current = this.jobs.get(key);
    if (current && (current.state === "queued" || current.state === "running")) {
      current.object = req.object ?? current.object;
      return { key, state: current.state };
    }
    const missing = gen.missing(this.findToolsNow());
    if (missing) throw new HttpError(503, missing);

    const job: Job = {
      key, kind, hash, input, params, object: req.object, state: "queued", submitted: Date.now(), pastBake: false,
    };
    this.jobs.set(key, job);
    this.queue.push(job);
    this.pump();
    return { key, state: job.state };
  }

  status(key: string): Status | null {
    const job = this.jobs.get(key);
    if (job) {
      const now = Date.now();
      const elapsed =
        job.state === "queued" ? now - job.submitted
        : job.state === "running" ? now - job.started!
        : (job.finished ?? now) - (job.started ?? job.submitted);
      return {
        state: job.state,
        elapsed: seconds(elapsed),
        ...(job.message !== undefined ? { message: job.message } : {}),
        ...(job.bytes !== undefined ? { bytes: job.bytes, triangles: job.triangles } : {}),
      };
    }
    // Generated in an earlier server life: the directory answers.
    const match = KEY.exec(key);
    if (!match) return null;
    const dir = generatedDir(this.root, match[1]!, match[2]!);
    if (!existsSync(join(dir, "mesh.glb"))) return null;
    try {
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
      return { state: "done", elapsed: meta.seconds, bytes: meta.bytes, triangles: meta.triangles };
    } catch {
      return { state: "done", elapsed: 0 };
    }
  }

  /** Cancels a queued or running job outright, past the bake or not: the author asked. */
  cancel(key: string): Status | null {
    const job = this.jobs.get(key);
    if (job && (job.state === "queued" || job.state === "running")) this.stop(job, "cancelled");
    return this.status(key);
  }

  /** Every job still pending for `object` under another key stops, unless it is past the bake. */
  private supersede(object: string, key: string): void {
    for (const job of this.jobs.values()) {
      if (job.object !== object || job.key === key) continue;
      if (job.state === "queued" || (job.state === "running" && !job.pastBake)) this.stop(job, "superseded by a newer request");
    }
  }

  private stop(job: Job, message: string): void {
    job.message = message;
    if (job.state === "queued") {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.state = "superseded";
      job.finished = Date.now();
    } else {
      job.abort?.abort();
    }
  }

  private pump(): void {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    this.execute(job).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  private async execute(job: Job): Promise<void> {
    const gen = GENERATORS[job.kind];
    job.state = "running";
    job.started = Date.now();
    job.abort = new AbortController();
    const schema = loadSchema(this.root, gen.dir);
    const tools = this.findToolsNow();
    let jobDir: string | undefined;
    let keep = false;
    this.log(`generating ${job.key}`);
    try {
      jobDir = await makeJobDir(job.kind);
      const result = await runGenerator(gen, tools, this.root, job.input, job.params, schema, jobDir, {
        signal: job.abort.signal,
        onBake: () => (job.pastBake = true),
      });
      const bytes = await readFile(result.glb);
      const triangles = glbTriangles(bytes);
      const versions = await (this.versions ?? toolVersions(tools));
      const finished = Date.now();
      const meta: Meta = {
        key: job.key,
        kind: job.kind,
        version: schema.version,
        params: job.params,
        input: summariseInput(job.kind, job.input),
        bytes: bytes.byteLength,
        triangles,
        generatedAt: new Date(finished).toISOString(),
        blender: versions.blender,
        seconds: seconds(finished - job.started),
      };
      await publish(generatedDir(this.root, job.kind, job.hash), bytes, meta, job.kind === "mushrooms" ? job.input : undefined);
      Object.assign(job, { state: "done", finished, bytes: meta.bytes, triangles });
      this.log(`generated ${job.key}: ${triangles} triangles, ${meta.bytes} bytes, ${meta.seconds} s`);
    } catch (e) {
      job.finished = Date.now();
      if (e instanceof Cancelled) {
        job.state = "superseded";
      } else {
        job.state = "failed";
        job.message = (e as Error).message;
        keep = true;
        this.log(`failed ${job.key}: ${job.message.split("\n")[0]}`);
      }
    } finally {
      job.abort = undefined;
      // A soup can be megabytes and the job record lives as long as the server.
      job.input = undefined;
      // A failed run's scratch directory is kept so its validation report can
      // be read; the failure message names it.
      if (jobDir && !keep) await rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// A mushroom request's soup can run to megabytes; the level re-collects the
// surface from its host at generation time, so meta.json (read for every level
// that uses the mesh) carries a summary and the soup sits beside it.
function summariseInput(kind: GeneratorKind, input: unknown): unknown {
  if (kind !== "mushrooms") return input;
  const positions = (input as { positions: number[] }).positions;
  return { triangles: positions.length / 9, file: "input.json" };
}

// The GLB lands last and by rename, so "mesh.glb exists" always means "done".
async function publish(dir: string, glb: Uint8Array, meta: Meta, input?: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (input !== undefined) await writeFile(join(dir, "input.json"), JSON.stringify(input));
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  const partial = join(dir, `mesh.glb.${process.pid}.partial`);
  await writeFile(partial, glb);
  await rename(partial, join(dir, "mesh.glb"));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > BODY_LIMIT) throw new HttpError(413, "The request is too large; select fewer faces.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "The request is not JSON.");
  }
}

// State changes only from the editor's own page: a page on another origin could
// otherwise queue Blender runs on this machine.
function sameOrigin(req: IncomingMessage): boolean {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function generatorService(): Plugin {
  return {
    name: "generator-service",
    apply: "serve",
    configureServer(server) {
      const service = new GeneratorService(server.config.root, (line) => server.config.logger.info(`[generators] ${line}`));

      server.middlewares.use("/api/generators", (req, res) => {
        if (req.method !== "GET") return send(res, 405, { error: "Use GET." });
        service.toolStatus().then(
          (status) => send(res, 200, status),
          (e) => send(res, 500, { error: String(e) }),
        );
      });

      server.middlewares.use("/api/generate", async (req, res) => {
        try {
          const path = (req.url ?? "/").split("?")[0]!;
          if (path === "/" || path === "") {
            if (req.method !== "POST") return send(res, 405, { error: "Use POST to generate." });
            if (!sameOrigin(req)) return send(res, 403, { error: "Generate from this editor's origin." });
            return send(res, 200, service.submit(await readBody(req)));
          }
          const key = decodeURIComponent(path.slice(1));
          if (!KEY.test(key)) return send(res, 400, { error: "Not a mesh key." });
          if (req.method === "GET") {
            const status = service.status(key);
            return status ? send(res, 200, status) : send(res, 404, { error: "No such job." });
          }
          if (req.method === "DELETE") {
            if (!sameOrigin(req)) return send(res, 403, { error: "Cancel from this editor's origin." });
            const status = service.cancel(key);
            return status ? send(res, 200, status) : send(res, 404, { error: "No such job." });
          }
          return send(res, 405, { error: "Use GET or DELETE." });
        } catch (e) {
          if (e instanceof HttpError) return send(res, e.status, { error: e.message });
          return send(res, 500, { error: String(e) });
        }
      });

      // Served here rather than by vite's public handler so the answer can say
      // `immutable`: a key names exactly one mesh for ever.
      server.middlewares.use("/generated", async (req, res, next) => {
        const match = /^\/(boulder|mushrooms)\/([0-9a-f]{16})\/mesh\.glb$/.exec((req.url ?? "").split("?")[0]!);
        if (!match || (req.method !== "GET" && req.method !== "HEAD")) return next();
        const file = join(generatedDir(server.config.root, match[1]!, match[2]!), "mesh.glb");
        try {
          const info = await stat(file);
          res.setHeader("Content-Type", "model/gltf-binary");
          res.setHeader("Content-Length", info.size);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (req.method === "HEAD") res.end();
          else createReadStream(file).on("error", () => res.destroy()).pipe(res);
        } catch {
          res.statusCode = 404;
          res.end("Generated mesh not found");
        }
      });
    },
  };
}
