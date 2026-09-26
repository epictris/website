// The generator service: the dev server's side of the visuals workspace's two
// procedural pipelines. See docs/generators.md.
//
//   GET    /api/generators            which tools are here, how long the queue is
//   POST   /api/generate              { kind, key, input, params, soup?, object? } -> { key, state }
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
import {
  canonicalParams,
  loadSchema,
  mergeDefaults,
  paramSpec,
  validatePairs,
  validateParams,
  type ParamIssue,
  type ParamSchema,
  type ParamValues,
} from "../../level/generatorParams";
import {
  GENERATED_MESH_FILE,
  GENERATED_META_FILE,
  GENERATED_ROOT,
  generatedKey,
  parseGeneratedKey,
  type GeneratorInput,
} from "../../render3d/generated";
import type { GeneratedMeta } from "../../render3d/generatedMeta";
import { findTools, toolVersions, type Tools, type ToolVersions } from "./paths";
import { Cancelled, killLiveGroups, makeJobDir, runGenerator, type Generator, type GeneratorKind } from "./run";

export const GENERATORS: Record<GeneratorKind, Generator<unknown>> = {
  boulder: boulder as Generator<unknown>,
  mushrooms: mushrooms as Generator<unknown>,
};

/**
 * The key this content makes: the same `generatedKey` the editor computes for
 * its staleness badge, at the schema version this server runs. A request whose
 * key differs is refused, so nothing is ever cached under a name that does not
 * say what it is.
 */
export function expectedKey(kind: GeneratorKind, input: GeneratorInput, params: ParamValues): string {
  return generatedKey(kind, loadSchema(kind)!.version, input, params);
}

const issuesText = (issues: ParamIssue[]) => issues.map((i) => `${i.key}: ${i.message}`).join("; ");

// A null for a parameter whose default is null (the boulder's tolerance) means
// "derive it", which is what leaving it out means; it is dropped here so the
// shared validation, which stores no nulls, has nothing to refuse.
function dropBlanks(params: Record<string, unknown>, schema: ParamSchema): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([key, v]) => !(v === null && paramSpec(schema, key)?.default === null)),
  );
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
  params: ParamValues;
  /**
   * The editor objects waiting on this job. A key is content, so two objects
   * can wait on one job (a rock duplicated mid-generation is a second object
   * with the same key); a newer request from one of them takes it out of the
   * set, and the job is stopped only when nobody is left waiting on it.
   */
  objects: Set<string>;
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

// meta.json: what render3d/generatedMeta.ts reads, plus the run's length (s).
export interface Meta extends GeneratedMeta {
  seconds: number;
}

/** The directory on disk a key's files live in (generated.ts's `generatedDir` is its URL). */
export const generatedPath = (root: string, kind: string, hash: string) =>
  join(root, "public", GENERATED_ROOT.slice(1), kind, hash);

// The request body cap (bytes), sized from the schema rather than guessed: the
// largest soup the mushroom schema allows (`maxTriangles`' own max, nine
// numbers a triangle) at the widest a soup number prints - the editor rounds to
// a tenth of a millimetre within 100 m, "-99.9999," being 9 bytes, 10 allowed -
// plus a megabyte for the loop, the host and the parameters. 200 000 triangles
// is 19 MB; a boulder's outline is bounded by its own validation.
const SOUP_NUMBER_BYTES = 10;
const BODY_SLACK = 1_000_000;
export const BODY_LIMIT =
  ((paramSpec(loadSchema("mushrooms")!, "maxTriangles")!.max ?? 0) * 9 * SOUP_NUMBER_BYTES) + BODY_SLACK;

const seconds = (ms: number) => Math.round(ms / 100) / 10;

export class HttpError extends Error {
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
    const req = body as
      | { kind?: unknown; key?: unknown; input?: unknown; params?: unknown; soup?: unknown; object?: unknown }
      | null;
    if (!req || typeof req !== "object") throw new HttpError(400, "Send { kind, key, input, params }.");
    const kind = req.kind as GeneratorKind;
    const gen = GENERATORS[kind];
    if (typeof req.kind !== "string" || !gen) throw new HttpError(400, "kind must be boulder or mushrooms.");
    const parsed = typeof req.key === "string" ? parseGeneratedKey(req.key) : null;
    if (!parsed || parsed.kind !== kind) throw new HttpError(400, `key must be ${kind}:<16 hex digits>.`);
    if (req.object !== undefined && typeof req.object !== "string") throw new HttpError(400, "object must be a string.");
    const key = req.key as string;
    const hash = parsed.hash;

    const schema = loadSchema(kind)!;
    if (req.params !== undefined && (!req.params || typeof req.params !== "object" || Array.isArray(req.params)))
      throw new HttpError(400, "params must be an object of parameter values.");
    const params = dropBlanks((req.params ?? {}) as Record<string, unknown>, schema) as ParamValues;
    const issues = validateParams(params, schema);
    const values = mergeDefaults(params, schema);
    issues.push(...validatePairs(values));
    if (issues.length) throw new HttpError(400, `Invalid ${kind} parameters: ${issuesText(issues)}.`);
    let input: unknown;
    try {
      input = gen.validateInput(req.input, req.soup, values);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const expected = expectedKey(kind, gen.keyInput(input), params);
    if (expected !== key)
      throw new HttpError(400, `The key ${key} does not match its content, which makes ${expected}.`);

    if (req.object !== undefined) this.supersede(req.object, key);
    if (existsSync(join(generatedPath(this.root, kind, hash), GENERATED_MESH_FILE))) return { key, state: "done" };
    // A request naming no object is a waiter that never leaves (nothing can
    // supersede it), held as the empty name.
    const waiter = req.object ?? "";
    const current = this.jobs.get(key);
    if (current && (current.state === "queued" || current.state === "running")) {
      current.objects.add(waiter);
      return { key, state: current.state };
    }
    const missing = gen.missing(this.findToolsNow());
    if (missing) throw new HttpError(503, missing);

    const job: Job = {
      key, kind, hash, input, params, objects: new Set([waiter]), state: "queued", submitted: Date.now(), pastBake: false,
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
    const parsed = parseGeneratedKey(key);
    if (!parsed) return null;
    const dir = generatedPath(this.root, parsed.kind, parsed.hash);
    if (!existsSync(join(dir, GENERATED_MESH_FILE))) return null;
    try {
      const meta = JSON.parse(readFileSync(join(dir, GENERATED_META_FILE), "utf8")) as Meta;
      return { state: "done", elapsed: meta.seconds, bytes: meta.bytes, triangles: meta.triangles };
    } catch {
      return { state: "done", elapsed: 0 };
    }
  }

  /**
   * Stops every queued and running job, past the bake or not: the server is
   * going away and nothing will be left to publish a result or answer a poll.
   * The running job's process group is killed (see `run.ts`).
   */
  shutdown(): void {
    for (const job of [...this.queue, ...(this.running ? [this.running] : [])]) this.stop(job, "the dev server stopped");
  }

  /** Cancels a queued or running job outright, past the bake or not: the author asked. */
  cancel(key: string): Status | null {
    const job = this.jobs.get(key);
    if (job && (job.state === "queued" || job.state === "running")) this.stop(job, "cancelled");
    return this.status(key);
  }

  /**
   * `object` no longer waits on any job under another key. A job nobody is
   * left waiting on stops, unless it is past the bake; one another object still
   * waits on runs on for it, and answers that object's polls as ever.
   */
  private supersede(object: string, key: string): void {
    for (const job of this.jobs.values()) {
      if (job.key === key || !job.objects.delete(object) || job.objects.size > 0) continue;
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
    const schema = loadSchema(job.kind)!;
    const tools = this.findToolsNow();
    let jobDir: string | undefined;
    let keep = false;
    this.log(`generating ${job.key}`);
    try {
      jobDir = await makeJobDir(job.kind);
      // The generator is handed the parameters in the form the key hashed
      // (rounded to PARAM_RESOLUTION, defaults stripped): two requests within a
      // ten-thousandth of each other share a key, so they must build the same
      // mesh, and the first one's unrounded value would otherwise be baked in.
      const result = await runGenerator(gen, tools, this.root, job.input, canonicalParams(job.params, schema), schema, jobDir, {
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
        // The form the key hashed: defaults stripped, keys sorted.
        params: canonicalParams(job.params, schema),
        input: gen.keyInput(job.input),
        bytes: bytes.byteLength,
        triangles,
        generatedAt: new Date(finished).toISOString(),
        blender: versions.blender ?? "unknown",
        seconds: seconds(finished - job.started),
      };
      await publish(generatedPath(this.root, job.kind, job.hash), bytes, meta, gen.sidecars(job.input));
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

// meta.json holds the key input (read for every level that uses the mesh, so it
// stays small); what the key leaves out, a mushroom patch's megabytes of soup,
// sits beside it as a sidecar. The GLB lands last and by rename, so "mesh.glb
// exists" always means "done".
async function publish(dir: string, glb: Uint8Array, meta: Meta, sidecars: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(sidecars)) await writeFile(join(dir, name), JSON.stringify(data));
  await writeFile(join(dir, GENERATED_META_FILE), JSON.stringify(meta, null, 2) + "\n");
  const partial = join(dir, `${GENERATED_MESH_FILE}.${process.pid}.partial`);
  await writeFile(partial, glb);
  await rename(partial, join(dir, GENERATED_MESH_FILE));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// The body as JSON. Chunks are kept as bytes and decoded once at the end: a
// multi-byte character split across two chunks decodes as two replacement
// characters when each chunk is made a string on its own.
export async function readBody(req: AsyncIterable<Uint8Array | string>, limit = BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    bytes += b.byteLength;
    if (bytes > limit) throw new HttpError(413, "The request is too large; select fewer faces.");
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request is not JSON.");
  }
}

// A key named in a URL path (`/api/generate/<key>`), or a 400: a malformed
// escape (a lone `%`) is the client's mistake, not the server's.
export function keyOfPath(path: string): string {
  let key: string;
  try {
    key = decodeURIComponent(path.replace(/^\//, ""));
  } catch {
    throw new HttpError(400, "Not a mesh key (a malformed escape).");
  }
  if (!parseGeneratedKey(key)) throw new HttpError(400, "Not a mesh key.");
  return key;
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

// When the dev server's PROCESS ends - Ctrl+C, a kill, a crash - every
// generator group goes with it: they run detached (run.ts), so the terminal's
// Ctrl+C never reaches them on its own. Installed once per process, since a
// restart configures the plugin again in the same process.
//
// A signal handler replaces the default of exiting, so each one kills the
// groups, takes itself off, and re-raises the signal when no other handler is
// left to act on it (vite may well have its own, which then ends the process).
let exitHooked = false;
function endGroupsOnExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => killLiveGroups("SIGKILL"));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const onSignal = (): void => {
      killLiveGroups("SIGKILL");
      process.off(signal, onSignal);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

export function generatorService(): Plugin {
  return {
    name: "generator-service",
    apply: "serve",
    configureServer(server) {
      const service = new GeneratorService(server.config.root, (line) => server.config.logger.info(`[generators] ${line}`));
      // A restart (any edit to a config dependency, `levelFormat.ts` among
      // them) closes this server and configures a new one with a new service:
      // this one's jobs end with it, rather than leave a Blender running that
      // no poll can ever reach.
      server.httpServer?.once("close", () => service.shutdown());
      endGroupsOnExit();

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
          const key = keyOfPath(path);
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
      server.middlewares.use(GENERATED_ROOT, async (req, res, next) => {
        const match = /^\/(\w+)\/(\w+)\/(\w+\.\w+)$/.exec((req.url ?? "").split("?")[0]!);
        const parsed = match && match[3] === GENERATED_MESH_FILE ? parseGeneratedKey(`${match[1]}:${match[2]}`) : null;
        if (!parsed || (req.method !== "GET" && req.method !== "HEAD")) return next();
        const file = join(generatedPath(server.config.root, parsed.kind, parsed.hash), GENERATED_MESH_FILE);
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
