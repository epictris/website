// The editor's side of the generator service (docs/generators.md): it submits a
// generated object's request, follows the job to its end, and when the mesh is
// there puts its key on the object - once, as one undo step, and only if the
// object still wants exactly that mesh.
//
// The service is content-addressed, so the client carries almost no state: a
// job is named by its mesh key, the latest job per editor object is the one
// that object is waiting for, and a job left behind by a newer submit is simply
// no longer followed (the server supersedes it, or lets it finish into the
// cache past its bake). Nothing here decides WHAT to generate; the editor
// builds the request (`generatorInput`, `generatedKey`) and hands it over.
//
// The model is never written from a poll's callback directly. A result that
// lands while a drag is in progress would push an undo step into the middle of
// the gesture and have the drag's own snapshot swallow it, so a swap waits for
// `canWrite` and is retried from the frame loop (`flush`).

import type { GeneratorKind, ParamValues } from "./paramSchema";

// What the service answers for a job (`GET /api/generate/<key>`).
export type JobState = "queued" | "running" | "done" | "failed" | "superseded";

export interface JobStatus {
  state: JobState;
  // Seconds waiting (queued), running (running), or the run took (the rest).
  elapsed: number;
  message?: string;
  bytes?: number;
  triangles?: number;
}

// What the editor asks for: the service's POST body without the `object`,
// which the client adds.
export interface GenerateRequest {
  kind: GeneratorKind;
  key: string;
  input: unknown;
  // Only the values that differ from the defaults.
  params: ParamValues;
  // A mushroom patch's surface: flat triangle soup, patch frame, metres.
  soup?: number[];
}

// One object's latest job as the panel shows it. `state` is the service's, or
// `failed` for a request the service refused (a 400 names the bad parameters,
// a 503 the missing tool) or never answered.
export interface Job {
  readonly itemId: number;
  readonly key: string;
  readonly kind: GeneratorKind;
  state: JobState;
  elapsed: number;
  message?: string;
  bytes?: number;
  triangles?: number;
}

// The tools the service found (`GET /api/generators`).
export interface ToolHealth {
  python: string | null;
  blender: string | null;
  deps: boolean;
  venv: boolean;
  queue: number;
}

// What is missing for which generator, in words, or "" when nothing is. The
// boulder needs Python with its packages and Blender; the patch Blender alone.
export function missingTools(h: ToolHealth | null): string {
  if (!h) return "";
  const out: string[] = [];
  if (!h.blender) out.push("Blender not found (rocks, mushrooms)");
  if (!h.python) out.push("Python not found (rocks)");
  else if (!h.deps) out.push("rock packages missing: bun run generators:setup");
  return out.join(" · ");
}

// The slice of `fetch` the client uses, so the cases can hand it a fake.
export type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface JobsHost {
  fetch: Fetcher;
  // A timer; `setTimeout` in the page, a queue the cases drain in bun.
  later(fn: () => void, ms: number): void;
  // Whether the model may be written now (false while a drag is in progress).
  canWrite(): boolean;
  // The key the object would be generated under NOW, at the schema version the
  // server runs: null when it cannot be generated, undefined when the object is
  // gone. A result is put on the object only when this still names it.
  wantedKey(itemId: number): string | null | undefined;
  // Put `key` on the object as ONE undo step (`beginAction`, write, `markDirty`),
  // with the current schema version. Called only when `wantedKey` named it.
  swap(itemId: number, key: string): void;
  // Something a panel or a badge shows changed.
  changed(): void;
}

// Poll backoff: the first look after this long (ms), doubling up to the cap
// (ms). A boulder takes seconds and a queue can take minutes, so the cap is the
// resolution of the "generating N s" readout rather than anything faster.
export const POLL_FIRST_MS = 250;
export const POLL_MAX_MS = 1000;

const TERMINAL: ReadonlySet<JobState> = new Set(["done", "failed", "superseded"]);

async function errorOf(res: { status: number; json(): Promise<unknown> }): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string") return body.error;
  } catch {
    // Not JSON: the status says what there is to say.
  }
  return `the service answered ${res.status}`;
}

export class GeneratorJobs {
  private readonly jobs = new Map<number, Job>();
  // A finished mesh's facts by key, from the status endpoint, for the panel's
  // "N triangles · M KB" (null while being asked, so it is asked once).
  private readonly known = new Map<string, { bytes: number; triangles: number } | null>();
  // Results waiting for the drag to end.
  private readonly pending: Job[] = [];
  private toolHealth: ToolHealth | null = null;
  private healthAsked = false;
  // Names this page's objects to the service, so a newer request for an object
  // supersedes an older one for it and never one from another editor tab that
  // happens to hold an item with the same id.
  private readonly page = Math.random().toString(36).slice(2, 10);

  constructor(private readonly host: JobsHost) {}

  // The object's latest job, if it has had one this session.
  job(itemId: number): Job | undefined {
    return this.jobs.get(itemId);
  }

  // Whether any job is queued or running: what the outliner asks per frame.
  get busy(): boolean {
    for (const j of this.jobs.values()) if (j.state === "queued" || j.state === "running") return true;
    return false;
  }

  get health(): ToolHealth | null {
    return this.toolHealth;
  }

  // Submit a generation for an object. A job already under way for it under
  // another key stops being followed (the service supersedes it); the same key
  // again is the same job and is simply followed on.
  async submit(itemId: number, req: GenerateRequest): Promise<Job> {
    const current = this.jobs.get(itemId);
    if (current && current.key === req.key && !TERMINAL.has(current.state)) return current;
    const job: Job = { itemId, key: req.key, kind: req.kind, state: "queued", elapsed: 0 };
    this.jobs.set(itemId, job);
    this.host.changed();
    let res;
    try {
      res = await this.host.fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...req, object: `${this.page}/${itemId}` }),
      });
    } catch (e) {
      this.settle(job, { state: "failed", elapsed: 0, message: `the dev server did not answer (${String(e)})` });
      return job;
    }
    if (!res.ok) {
      const message = await errorOf(res);
      // A missing tool: say which in the toolbar too.
      if (res.status === 503) void this.checkHealth();
      this.settle(job, { state: "failed", elapsed: 0, message });
      return job;
    }
    const body = (await res.json()) as { state?: JobState };
    if (!this.follows(job)) return job;
    job.state = body.state ?? "queued";
    this.host.changed();
    // Done at once (already on disk) still asks for the mesh's facts.
    this.poll(job, body.state === "done" ? 0 : POLL_FIRST_MS);
    return job;
  }

  // Stop the object's job outright (the service cancels even past the bake).
  async cancel(itemId: number): Promise<void> {
    const job = this.jobs.get(itemId);
    if (!job || TERMINAL.has(job.state)) return;
    this.jobs.delete(itemId);
    this.host.changed();
    try {
      await this.host.fetch(`/api/generate/${encodeURIComponent(job.key)}`, { method: "DELETE" });
    } catch {
      // Nothing to do: the job is no longer followed either way.
    }
  }

  // A finished mesh's size and triangle count, asked of the service once per
  // key and answered on a later call (null until then, or for a key the
  // service has no record of).
  facts(key: string): { bytes: number; triangles: number } | null {
    if (!this.known.has(key)) {
      this.known.set(key, null);
      void this.status(key).then((s) => {
        if (s?.state === "done" && s.bytes !== undefined && s.triangles !== undefined) {
          this.known.set(key, { bytes: s.bytes, triangles: s.triangles });
          this.host.changed();
        }
      });
    }
    return this.known.get(key) ?? null;
  }

  // Which tools the service has, asked once (and again after a 503).
  async checkHealth(): Promise<ToolHealth | null> {
    this.healthAsked = true;
    try {
      const res = await this.host.fetch("/api/generators");
      if (res.ok) this.toolHealth = (await res.json()) as ToolHealth;
    } catch {
      this.toolHealth = null;
    }
    this.host.changed();
    return this.toolHealth;
  }

  get healthChecked(): boolean {
    return this.healthAsked;
  }

  // Put any result that landed during a drag on its object, now that it may be
  // written. The frame loop calls this every frame; it is free when nothing
  // waits.
  flush(): void {
    if (!this.pending.length || !this.host.canWrite()) return;
    for (const job of this.pending.splice(0)) this.land(job);
  }

  // --- internals -------------------------------------------------------------

  // Is this still the job its object is waiting for?
  private follows(job: Job): boolean {
    return this.jobs.get(job.itemId) === job;
  }

  private async status(key: string): Promise<JobStatus | null> {
    try {
      const res = await this.host.fetch(`/api/generate/${encodeURIComponent(key)}`);
      return res.ok ? ((await res.json()) as JobStatus) : null;
    } catch {
      return null;
    }
  }

  private poll(job: Job, delay: number): void {
    this.host.later(() => void this.look(job, delay), delay);
  }

  private async look(job: Job, delay: number): Promise<void> {
    if (!this.follows(job)) return;
    const s = await this.status(job.key);
    if (!this.follows(job)) return;
    if (!s) {
      // The server restarted mid-job (a job lives only as long as the server)
      // or never had it: say so rather than poll for ever.
      this.settle(job, { state: "failed", elapsed: job.elapsed, message: "the dev server has no record of this job (restarted?); Generate again" });
      return;
    }
    this.settle(job, s);
    if (!TERMINAL.has(s.state)) this.poll(job, Math.min(POLL_MAX_MS, Math.max(POLL_FIRST_MS, delay * 2)));
  }

  private settle(job: Job, s: JobStatus): void {
    if (!this.follows(job)) return;
    job.state = s.state;
    job.elapsed = s.elapsed;
    job.message = s.message;
    if (s.bytes !== undefined && s.triangles !== undefined) {
      job.bytes = s.bytes;
      job.triangles = s.triangles;
      this.known.set(job.key, { bytes: s.bytes, triangles: s.triangles });
    }
    if (s.state === "done") {
      if (this.host.canWrite()) this.land(job);
      else this.pending.push(job);
    }
    this.host.changed();
  }

  // A finished mesh onto its object, if the object is still there and still
  // wants exactly this mesh. Otherwise the result stays in the service's cache
  // for whenever the object comes back round to it.
  private land(job: Job): void {
    const wanted = this.host.wantedKey(job.itemId);
    if (wanted === job.key) this.host.swap(job.itemId, job.key);
    this.host.changed();
  }
}
