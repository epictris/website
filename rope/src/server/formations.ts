// The formation store and the job runner, in dev (docs/formations.md, "The
// job runner").
//
//   GET    /generated/<hash>/<file>       the store, `no-store` (a bake adds
//                                         tiers and rewrites meta.json under
//                                         one hash)
//   POST   /api/jobs                      {kind, formation, label?} -> {id};
//                                         the formation a `Formation3D` node
//                                         or a compiled `FormationData`
//   GET    /api/jobs?client=<id>          server-sent events: a snapshot of
//                                         every job, then each change
//   DELETE /api/jobs/<id>                 cancel
//   POST   /api/jobs/hold                 {client, held}: an editor in ▶ Test
//                                         holds the bakes back (the game is on
//                                         the same card); released when its
//                                         event stream closes
//   GET    /api/formations/fingerprint    the generators' code fingerprint now
//   GET    /api/materials                 the material library: {materials:
//                                         [{name, library}]} (a library file's
//                                         sha256, which a material layer's
//                                         request names)
//
// A job is the build script (`scripts/formation-build.ts`) run as a child,
// keyed by the hash it will produce: asking for one that is queued or running
// joins it, and one whose result the store holds is answered done at once.
// Geometry jobs run GEOMETRY_SLOTS at a time; a bake runs alone, on the GPU,
// and none starts while a ▶ Test holds them. The progress is the build's own
// `<tag> step i/n: label (note)` lines; a failure carries the last lines of
// the output and the path of the whole of it.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { canonical, formationHash } from "../formation/recipe";
import { decorationHash, type DecorationRequest } from "../formation/decoration";
import { MATERIAL_LAYER_FILES, MATERIAL_LIBRARY_DIR, MATERIAL_NAME, MATERIALS_API, materialLayerHash, materialLibraryFile, type MaterialLayerRequest, type MaterialLibraryEntry } from "../formation/materialLayer";
import { sha256Hex } from "../formation/sha256";
import { decodeMeshBin, type StoredMesh } from "../formation/meshBin";
import { FORMATION_HASH, FORMATION_STORE, GEOMETRY_FILE, MESHES, MESHES_API, META_FILE, PAINT_API, ROCK_FILE, tierFileName, type FormationMeta } from "../formation/store";
import type { FormationData, FormationTier } from "../level/levelFormat";
import type { NodeFormationGuide } from "../level/nodes";

// "decoration" grows one decoration on a formation's rock
// (scripts/decoration-build.ts): its key is the request's hash.
// "material" bakes one library material onto one rock
// (scripts/material-layer-build.ts), what the editor lays a material layer's
// live mask over while it is painted: its key is `materialLayerHash`.
export type JobKind = "geometry" | "bake" | "decoration" | "material";
export type JobStateName = "queued" | "running" | "done" | "failed" | "cancelled";

// What a finished job hands the editor: a level's `formation.built`.
export interface JobResult {
  hash: string;
  front: number;
  generatorHash: string;
  recipeVersion: number;
  tiers: FormationTier[];
  // What the build noticed (`FormationMeta.warnings`), for the panel.
  warnings: string[];
  // A material layer's: its baked material (`built.maps`).
  maps?: string;
}

export interface JobState {
  id: string;
  kind: JobKind;
  hash: string;
  label: string;
  // What the jobs list calls it, where its kind does not say (a material
  // layer's decoration job is a bake, not a growth).
  verb?: string;
  state: JobStateName;
  // 0..1 where the build says how far it is.
  progress?: number;
  step?: string;
  error?: string;
  // The whole output, relative to rope/.
  log: string;
  result?: JobResult;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
}

export type JobEvent = { type: "snapshot"; jobs: JobState[] } | { type: "job"; job: JobState };

// How many geometry builds run at once: each is a Python process and a
// headless Blender, a few seconds of a few cores.
const GEOMETRY_SLOTS = 3;
// Finished jobs kept for the panel.
const KEEP_FINISHED = 40;

// A material layer's mask, and its material's maps
// (scripts/material-layer-build.ts), are the last four.
const STORE_FILES = /^(geometry\.glb|meta\.json|tier-\d+\.glb|decoration\.glb|layer\.png|mask\.png|color\.png|surface\.png|normal\.png)$/;

export function formationService(): Plugin {
  return {
    name: "formation-service",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      const store = join(root, "public", FORMATION_STORE.slice(1));
      const runner = new JobRunner(root, store);

      server.middlewares.use(FORMATION_STORE, (req, res, next) => {
        const [hash, file, ...rest] = (req.url ?? "").split("?")[0]!.replace(/^\//, "").split("/");
        const mesh = hash === MESHES && !!file && /^[0-9a-f]{64}\.(json|bin)$/.test(file);
        if (!hash || !file || rest.length || (!mesh && (!FORMATION_HASH.test(hash) || !STORE_FILES.test(file)))) return next();
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const path = join(store, hash, file);
        stat(path).then(
          (info) => {
            const type = file.endsWith(".json") ? "application/json" : file.endsWith(".bin") ? "application/octet-stream" : file.endsWith(".png") ? "image/png" : "model/gltf-binary";
            res.setHeader("Content-Type", type);
            res.setHeader("Content-Length", info.size);
            res.setHeader("Cache-Control", "no-store");
            if (req.method === "HEAD") res.end();
            else createReadStream(path).on("error", () => res.destroy()).pipe(res);
          },
          () => {
            res.statusCode = 404;
            res.end(`formation ${hash.slice(0, 12)} has no ${file} here; generate it in the editor`);
          },
        );
      });

      // A level's paint (docs/formations.md, "Decorations"): its painted
      // decorations' strokes by decoration id, beside the level and not in it,
      // in `levels/paint/<level>.json` (a folder of its own: a second `.json`
      // beside each level would be offered as a level). A prefab's is
      // `prefabs/paint/<prefab>.json`, asked for as `prefabs/<prefab>`.
      server.middlewares.use(PAINT_API, (req, res, next) => {
        const asked = decodeURIComponent((req.url ?? "/").split("?")[0]!.replace(/^\//, ""));
        const prefab = asked.startsWith("prefabs/");
        const name = prefab ? asked.slice("prefabs/".length) : asked;
        if (!/^[A-Za-z0-9_-]+$/.test(name)) return next();
        const paintDir = prefab ? join(root, "prefabs", "paint") : join(root, "levels", "paint");
        const path = join(paintDir, `${name}.json`);
        if (req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          return res.end(existsSync(path) ? readFileSync(path) : "{}");
        }
        if (req.method === "PUT") {
          return readJson(req).then(
            (body) => {
              const strokes = body as Record<string, unknown>;
              const empty = !Object.keys(strokes).length;
              if (empty && !existsSync(path)) return json(res, 200, { ok: true });
              mkdirSync(paintDir, { recursive: true });
              // One stroke a line: text a diff can read.
              const text = `{\n${Object.keys(strokes).sort().map((id) => `  ${JSON.stringify(id)}: [\n${(strokes[id] as unknown[]).map((s) => `    ${JSON.stringify(s)}`).join(",\n")}\n  ]`).join(",\n")}\n}\n`;
              writeFileSync(path, text);
              json(res, 200, { ok: true });
            },
            (e: Error) => json(res, 400, { error: e.message }),
          );
        }
        next();
      });

      // A solid guide's mesh: kept once, by its content. An applied or
      // sculpted one comes as the binary form (formation/meshBin.ts), named
      // by its bytes' sha256 plus `.bin`; an imported one as JSON.
      server.middlewares.use(MESHES_API, (req, res, next) => {
        if (req.method !== "POST") return next();
        if (req.headers["content-type"] === "application/octet-stream") {
          return readBytes(req).then(
            (bytes) => {
              try {
                decodeMeshBin(bytes);
              } catch (e) {
                return json(res, 400, { error: (e as Error).message });
              }
              const name = `${createHash("sha256").update(bytes).digest("hex")}.bin`;
              const dir = join(store, MESHES);
              mkdirSync(dir, { recursive: true });
              const path = join(dir, name);
              if (!existsSync(path)) writeFileSync(path, bytes);
              json(res, 200, { name });
            },
            (e: Error) => json(res, 400, { error: e.message }),
          );
        }
        readJson(req).then(
          (body) => {
            const m = body as Partial<StoredMesh>;
            const bad = !Array.isArray(m.verts) || !Array.isArray(m.faces) || !m.faces.length ||
              m.verts.some((v) => !Array.isArray(v) || v.length !== 3 || v.some((c) => !Number.isFinite(c))) ||
              m.faces.some((f) => !Array.isArray(f) || f.length < 3 || f.some((i) => !Number.isInteger(i) || i < 0 || i >= m.verts!.length));
            if (bad) return json(res, 400, { error: "a mesh is {verts: [[x, y, z], ...], faces: [[i, j, k, ...], ...]}" });
            const text = JSON.stringify(canonical({ verts: m.verts, faces: m.faces }));
            const name = sha256Hex(text);
            const dir = join(store, MESHES);
            mkdirSync(dir, { recursive: true });
            const path = join(dir, `${name}.json`);
            if (!existsSync(path)) writeFileSync(path, text);
            json(res, 200, { name });
          },
          (e: Error) => json(res, 400, { error: e.message }),
        );
      });

      // The material library (docs/formations.md "Material layers"): each
      // file's name and the sha256 of its bytes, read afresh every time, so
      // a material saved in Blender is a new library at the next ask.
      server.middlewares.use(MATERIALS_API, (req, res, next) => {
        if (req.method !== "GET") return next();
        json(res, 200, { materials: materialLibrary(root) });
      });

      server.middlewares.use("/api/formations/fingerprint", (req, res, next) => {
        if (req.method !== "GET") return next();
        runner.fingerprint().then(
          (fingerprint) => json(res, 200, { fingerprint }),
          (e: Error) => json(res, 500, { error: e.message }),
        );
      });

      server.middlewares.use("/api/jobs", (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        const path = url.pathname.replace(/\/+$/, "");
        if (req.method === "GET" && path === "") return runner.subscribe(req, res, url.searchParams.get("client") ?? "");
        if (req.method === "POST" && path === "") {
          return readJson(req).then(
            (body) => {
              const b = body as { kind?: JobKind; formation?: JobFormation; label?: string; request?: DecorationRequest; material?: MaterialLayerRequest };
              if (b.kind === "material") {
                const m = b.material;
                if (!m?.host || !FORMATION_HASH.test(m.host) || !MATERIAL_NAME.test(m.material ?? "") || !m.library) {
                  return json(res, 400, { error: "a material job is {kind: material, material: {host, material, library}}" });
                }
                return json(res, 200, { id: runner.askMaterial(m, b.label ?? m.material).id });
              }
              if (b.kind === "decoration") {
                if (!b.request?.host || !b.request.kind) return json(res, 400, { error: "a decoration job is {kind: decoration, request: {host, kind, ...}}" });
                return json(res, 200, { id: runner.askDecoration(b.request, b.label ?? b.request.kind).id });
              }
              if ((b.kind !== "geometry" && b.kind !== "bake") || !b.formation?.guide || !b.formation.generator) {
                return json(res, 400, { error: "a job is {kind: geometry|bake, formation: {generator, params, guide}}" });
              }
              json(res, 200, { id: runner.ask(b.kind, recipeOf(b.formation), b.label ?? b.formation.id ?? "formation").id });
            },
            (e: Error) => json(res, 400, { error: e.message }),
          );
        }
        if (req.method === "POST" && path === "/hold") {
          return readJson(req).then(
            (body) => {
              const b = body as { client?: string; held?: boolean };
              runner.hold(b.client ?? "", b.held === true);
              json(res, 200, { ok: true });
            },
            (e: Error) => json(res, 400, { error: e.message }),
          );
        }
        if (req.method === "DELETE" && /^\/[\w-]+$/.test(path)) {
          return json(res, runner.cancel(path.slice(1)) ? 200 : 404, {});
        }
        const log = /^\/([\w-]+)\/log$/.exec(path);
        if (req.method === "GET" && log) {
          const text = runner.logOf(log[1]!);
          res.statusCode = text === null ? 404 : 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          return res.end(text ?? "no such job, or it has not started");
        }
        next();
      });
    },
  };
}

// A formation as a job is asked for it: a `Formation3D` node (its id the
// formation's, its guide's `subset` naming `CollisionShape2D` nodes) or the
// compiled `FormationData` (`subset` as indices). Either carries the recipe.
type JobFormation = Pick<FormationData, "generator" | "variant" | "params"> & { id?: string; guide: FormationData["guide"] | NodeFormationGuide };

type JobRecipe = Pick<FormationData, "generator" | "variant" | "params" | "guide"> & { id?: string };

// What a job builds: the recipe alone. The guide's `subset` says where its
// pieces came from, not what they are, and the hash leaves it out
// (`formationRecipe`), so it is dropped here rather than carried into the
// build's recipe file in whichever of its two forms it came.
function recipeOf(f: JobFormation): JobRecipe {
  const guide = f.guide.kind === "collision" ? (({ subset: _s, ...g }) => g)(f.guide) : f.guide;
  return { ...(f.id !== undefined ? { id: f.id } : {}), generator: f.generator, ...(f.variant !== undefined ? { variant: f.variant } : {}), params: f.params ?? {}, guide };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBytes(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => done(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", fail);
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((done, fail) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      try {
        done(JSON.parse(body || "{}"));
      } catch (e) {
        fail(e as Error);
      }
    });
    req.on("error", fail);
  });
}

interface Job {
  state: JobState;
  // Null for a decoration's job, which is its `request`, and a material's.
  formation: JobRecipe | null;
  request?: DecorationRequest;
  // A material bake's.
  material?: MaterialLayerRequest;
  child?: ChildProcess;
  output: string;
}

function fileSha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// The library's materials, by name, with each file's sha256.
function materialLibrary(root: string): MaterialLibraryEntry[] {
  const dir = join(root, MATERIAL_LIBRARY_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".blend") && MATERIAL_NAME.test(f.slice(0, -6)))
    .sort()
    .map((f) => ({ name: f.slice(0, -6), library: fileSha(join(dir, f)) }));
}

// The `<tag> step i/n: label (note)` lines of the build and the exporter, as
// a share of the whole job: a geometry build is its three steps; a bake is
// the exporter's seven steps, its encode's "k of n maps", and the tiers last.
function progressOf(kind: JobKind, line: string): { progress: number; step: string } | null {
  const m = /^\[(formation|formation-bake|model|decoration|decoration-export)\] step (\d+)\/(\d+): (.*)$/.exec(line);
  if (m) {
    const [, tag, i, n, label] = m;
    const share = (Number(i) - 1) / Number(n);
    const maps = /\((\d+) of (\d+) maps\)$/.exec(label!);
    const inner = maps ? Number(maps[1]) / Math.max(1, Number(maps[2])) / Number(n) : 0;
    // A decoration: its preparation, then the exporter's growth and export.
    if (kind === "decoration") return tag === "decoration" ? { progress: 0.05 * share, step: label! } : { progress: 0.05 + 0.95 * (share + inner), step: label! };
    if (kind === "geometry") return { progress: tag === "formation" ? share : 0, step: label! };
    // A bake whose geometry was missing builds it first: the first tenth.
    return tag === "formation" ? { progress: 0.1 * share, step: label! } : { progress: 0.1 + 0.85 * (share + inner), step: label! };
  }
  if (kind === "bake" && line.startsWith("[formation] deriving lower tiers")) return { progress: 0.95, step: "derive lower tiers" };
  return null;
}

class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly clients = new Map<ServerResponse, string>();
  private readonly holds = new Set<string>();
  private next = 1;

  // The generators' fingerprint now (`fingerprint`), refreshed with every
  // build asked for: a store entry built by another is not an answer.
  private current: string | null = null;

  constructor(
    private readonly root: string,
    private readonly store: string,
  ) {
    this.refreshFingerprint();
  }

  private refreshFingerprint(): void {
    this.fingerprint().then(
      (fp) => (this.current = fp),
      () => {},
    );
  }

  // A store entry for `hash` built by an older generator than the code now:
  // asked for, it is built again (`--force`), as the panel's "Built by an
  // older generator: Regenerate builds it with the current code" promises.
  // Until 2026-11-25 the store's entry answered and nothing was rebuilt.
  private olderBuild(hash: string): boolean {
    if (!this.current) return false;
    try {
      const meta = JSON.parse(readFileSync(join(this.store, hash, META_FILE), "utf8")) as FormationMeta;
      return meta.generatorHash !== this.current;
    } catch {
      return false;
    }
  }

  // Grow a decoration, or join the job already growing it, or answer at once
  // from the store.
  askDecoration(request: DecorationRequest, label: string): JobState {
    const hash = decorationHash(request);
    for (const j of this.jobs.values()) {
      if (j.state.hash === hash && (j.state.state === "queued" || j.state.state === "running")) return j.state;
    }
    const id = `j${Date.now().toString(36)}${(this.next++).toString(36)}`;
    const state: JobState = { id, kind: "decoration", hash, label, ...(request.kind === "material" ? { verb: "Bake" } : {}), state: "queued", log: "", queuedAt: Date.now() };
    const job: Job = { state, formation: null, request, output: "" };
    this.jobs.set(id, job);
    const done = this.result(hash, "decoration");
    if (done) {
      state.state = "done";
      state.progress = 1;
      state.step = "in the store";
      state.result = done;
      state.endedAt = Date.now();
    }
    this.publish(job);
    this.pump();
    return state;
  }

  // Bake a library material onto a rock, or join the bake on its way, or
  // answer at once from the store. A library file that has changed since the
  // editor last listed it fails at once: the editor lists it again.
  askMaterial(m: MaterialLayerRequest, label: string): JobState {
    const request: MaterialLayerRequest = { host: m.host, material: m.material.toLowerCase(), library: m.library };
    const hash = materialLayerHash(request);
    for (const j of this.jobs.values()) {
      if (j.state.hash === hash && (j.state.state === "queued" || j.state.state === "running")) return j.state;
    }
    const id = `j${Date.now().toString(36)}${(this.next++).toString(36)}`;
    const state: JobState = { id, kind: "material", hash, label, state: "queued", log: "", queuedAt: Date.now() };
    const job: Job = { state, formation: null, material: request, output: "" };
    this.jobs.set(id, job);
    const done = this.result(hash, "material");
    const file = join(this.root, materialLibraryFile(request.material));
    if (done) {
      state.state = "done";
      state.progress = 1;
      state.step = "in the store";
      state.result = done;
      state.endedAt = Date.now();
    } else if (!existsSync(file) || fileSha(file) !== request.library) {
      state.state = "failed";
      state.error = existsSync(file) ? `${materialLibraryFile(request.material)} has changed since it was listed` : `no library material ${materialLibraryFile(request.material)}`;
      state.endedAt = Date.now();
    }
    this.publish(job);
    this.pump();
    return state;
  }

  private result(hash: string, kind: JobKind): JobResult | null {
    const none = { hash, front: 0, generatorHash: "", recipeVersion: 0, tiers: [], warnings: [] };
    if (kind === "material") return MATERIAL_LAYER_FILES.every((f) => existsSync(join(this.store, hash, f))) ? { ...none, maps: hash } : null;
    if (kind === "decoration") {
      // A material layer's mask, which names the material it lays
      // (decoration-build.ts).
      if (existsSync(join(this.store, hash, "mask.png"))) {
        try {
          const meta = JSON.parse(readFileSync(join(this.store, hash, META_FILE), "utf8")) as { maps?: string };
          return meta.maps ? { ...none, maps: meta.maps } : null;
        } catch {
          return null;
        }
      }
      // A grown mesh, or a texture layer's map (decoration-build.ts).
      return existsSync(join(this.store, hash, "decoration.glb")) || existsSync(join(this.store, hash, "layer.png")) ? none : null;
    }
    const dir = join(this.store, hash);
    const have = [GEOMETRY_FILE, META_FILE, ROCK_FILE].every((f) => existsSync(join(dir, f)));
    if (!have || this.olderBuild(hash)) return null;
    try {
      const meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf8")) as FormationMeta;
      if (kind === "bake" && (!meta.tiers.length || !existsSync(join(dir, tierFileName(0))))) return null;
      return {
        hash,
        front: meta.bounds.max[2],
        generatorHash: meta.generatorHash,
        recipeVersion: meta.recipeVersion,
        tiers: meta.tiers,
        warnings: meta.warnings ?? [],
      };
    } catch {
      return null;
    }
  }

  ask(kind: "geometry" | "bake", formation: JobRecipe, label: string): JobState {
    this.refreshFingerprint();
    const hash = formationHash(formation);
    for (const j of this.jobs.values()) {
      if (j.state.hash === hash && j.state.kind === kind && (j.state.state === "queued" || j.state.state === "running")) return j.state;
    }
    const id = `j${Date.now().toString(36)}${(this.next++).toString(36)}`;
    const state: JobState = { id, kind, hash, label, state: "queued", log: "", queuedAt: Date.now() };
    const job: Job = { state, formation, output: "" };
    this.jobs.set(id, job);
    const done = this.result(hash, kind);
    if (done) {
      state.state = "done";
      state.progress = 1;
      state.step = "in the store";
      state.result = done;
      state.endedAt = Date.now();
    }
    this.publish(job);
    this.pump();
    return state;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state.state === "queued") {
      this.finish(job, "cancelled");
    } else if (job.state.state === "running" && job.child?.pid) {
      job.state.step = "cancelling";
      try {
        process.kill(-job.child.pid, "SIGTERM");
      } catch {
        job.child.kill("SIGTERM");
      }
      (job as Job & { cancelled?: boolean }).cancelled = true;
    }
    return true;
  }

  // A job's whole output: as far as it has got while it runs, the log after.
  logOf(id: string): string | null {
    const job = this.jobs.get(id);
    if (!job || !job.state.log) return null;
    if (job.child || !existsSync(join(this.root, job.state.log))) return job.output;
    return readFileSync(join(this.root, job.state.log), "utf8");
  }

  hold(client: string, held: boolean): void {
    if (held) this.holds.add(client);
    else this.holds.delete(client);
    this.pump();
  }

  fingerprint(): Promise<string> {
    return new Promise((done, fail) => {
      const child = spawn(join(this.root, ".venv", "bin", "python"), ["-c", "import worker; print(worker.fingerprint())"], {
        cwd: join(this.root, "tools", "blender", "formations"),
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.on("error", fail);
      child.on("close", (status) => (status === 0 ? done(out.trim()) : fail(new Error(`fingerprint exited ${status}`))));
    });
  }

  subscribe(req: IncomingMessage, res: ServerResponse, client: string): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    this.clients.set(res, client);
    const send = (e: JobEvent): boolean => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "snapshot", jobs: [...this.jobs.values()].map((j) => j.state) });
    const beat = setInterval(() => res.write(": beat\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      this.clients.delete(res);
      // A tab that closed mid-▶ Test lets the bakes go.
      if (client && this.holds.delete(client)) this.pump();
    });
  }

  private publish(job: Job): void {
    const msg = `data: ${JSON.stringify({ type: "job", job: job.state } satisfies JobEvent)}\n\n`;
    for (const res of this.clients.keys()) res.write(msg);
  }

  private running(kind: JobKind): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.state.kind === kind && j.state.state === "running") n++;
    return n;
  }

  private pump(): void {
    const queued = [...this.jobs.values()].filter((j) => j.state.state === "queued").sort((a, b) => a.state.queuedAt - b.state.queuedAt);
    for (const job of queued) {
      // Geometry and decorations are Python and a headless Blender on the
      // CPU: GEOMETRY_SLOTS of them at once.
      const cpu = job.state.kind === "geometry" || job.state.kind === "decoration";
      if (cpu && this.running("geometry") + this.running("decoration") < GEOMETRY_SLOTS) this.start(job);
      else if (cpu) continue;
      // A bake holds the GPU: one at a time.
      else if (job.state.kind !== "geometry" && this.running("bake") === 0) {
        if (this.holds.size) {
          if (job.state.step !== "held while ▶ Test runs") {
            job.state.step = "held while ▶ Test runs";
            this.publish(job);
          }
          continue;
        }
        this.start(job);
      }
    }
  }

  private start(job: Job): void {
    const s = job.state;
    // A geometry job queued behind its own twin's bake, or the like: the
    // store may have it by now.
    const done = this.result(s.hash, s.kind);
    if (done) {
      s.result = done;
      this.finish(job, "done");
      return;
    }
    const dir = join(this.root, ".cache", "formation-jobs");
    mkdirSync(dir, { recursive: true });
    let argv: string[];
    if (s.kind === "decoration") {
      const request = join(dir, `${s.id}.json`);
      writeFileSync(request, JSON.stringify(job.request));
      argv = [join(this.root, "scripts", "decoration-build.ts"), request];
    } else if (s.kind === "material") {
      argv = [join(this.root, "scripts", "material-layer-build.ts"), job.material!.host, job.material!.material];
    } else {
      const recipe = join(dir, `${s.id}.json`);
      const { generator, variant, params, guide } = job.formation!;
      writeFileSync(recipe, JSON.stringify({ generator, ...(variant ? { variant } : {}), params, guide }));
      argv = [
        join(this.root, "scripts", "formation-build.ts"),
        recipe,
        ...(s.kind === "bake" ? ["--bake"] : []),
        ...(this.olderBuild(s.hash) ? ["--force"] : []),
      ];
    }
    s.log = `.cache/formation-jobs/${s.id}.log`;
    s.state = "running";
    s.startedAt = Date.now();
    s.progress = 0;
    s.step = "starting";
    this.publish(job);
    const child = spawn("bun", ["run", ...argv], {
      cwd: this.root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    job.child = child;
    let partial = "";
    const take = (chunk: Buffer): void => {
      const text = chunk.toString();
      job.output += text;
      const lines = (partial + text).split("\n");
      partial = lines.pop()!;
      for (const line of lines) {
        const p = progressOf(s.kind, line);
        if (p) {
          s.progress = Math.max(s.progress ?? 0, p.progress);
          s.step = p.step;
          this.publish(job);
        }
      }
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", (c: Buffer) => (job.output += c.toString()));
    child.on("close", (status, signal) => {
      writeFileSync(join(this.root, s.log), job.output);
      if ((job as Job & { cancelled?: boolean }).cancelled) return this.finish(job, "cancelled");
      const result = this.result(s.hash, s.kind);
      if (status === 0 && result) {
        s.result = result;
        return this.finish(job, "done");
      }
      // The step list's own rows say nothing the step line has not.
      const lines = job.output.split("\n").filter((l) => l.trim() && !/^\s*([✓✗·▸-] |total )/.test(l) && !/ step \d+\/\d+: /.test(l));
      s.error = `${signal ?? `exit ${status}`}: ${lines.slice(-8).join("\n")}`;
      this.finish(job, "failed");
    });
  }

  private finish(job: Job, state: JobStateName): void {
    job.state.state = state;
    job.state.endedAt = Date.now();
    if (state === "done") {
      job.state.progress = 1;
      job.state.step = job.state.step === "in the store" ? job.state.step : "done";
    }
    job.child = undefined;
    this.publish(job);
    const finished = [...this.jobs.values()].filter((j) => j.state.endedAt !== undefined).sort((a, b) => a.state.endedAt! - b.state.endedAt!);
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.jobs.delete(old.state.id);
    this.pump();
  }
}
