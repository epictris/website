// The editor's side of the job runner (src/server/formations.ts,
// docs/formations.md "The job runner"): asking for builds, hearing every job's
// state over one event stream, and the panel that shows them.
//
// Every job the dev server knows is shown, whoever asked: two editor tabs see
// each other's builds. A finished job's result is handed to `onDone`, which the
// editor uses to record what a formation built (`formation.built`).

import type { JobEvent, JobKind, JobResult, JobState } from "../server/formations";
import type { FormationData } from "../level/levelFormat";
import { meshesStored } from "./solidGuides";

export type { JobResult, JobState };

export class FormationJobs {
  readonly jobs = new Map<string, JobState>();
  private readonly listeners = new Set<() => void>();
  private readonly doneListeners = new Set<(job: JobState) => void>();
  private source: EventSource | null = null;
  // This tab's name to the server, so a hold it set is let go when it closes.
  readonly client = `ed-${Math.random().toString(36).slice(2, 10)}`;
  private fingerprintNow: string | null = null;
  private fingerprintAsked = false;

  connect(): void {
    if (this.source) return;
    const source = new EventSource(`/api/jobs?client=${this.client}`);
    this.source = source;
    source.onmessage = (msg) => {
      const e = JSON.parse(msg.data as string) as JobEvent;
      const changed: JobState[] = [];
      if (e.type === "snapshot") {
        this.jobs.clear();
        for (const j of e.jobs) {
          this.jobs.set(j.id, j);
          changed.push(j);
        }
      } else {
        const was = this.jobs.get(e.job.id);
        this.jobs.set(e.job.id, e.job);
        if (was?.state !== e.job.state) changed.push(e.job);
      }
      for (const j of changed) {
        if (j.state === "done") {
          // The generators may have changed under it: ask again.
          this.fingerprintAsked = false;
          for (const l of this.doneListeners) l(j);
        }
      }
      for (const l of this.listeners) l();
    };
  }

  onChange(l: () => void): void {
    this.listeners.add(l);
  }

  onDone(l: (job: JobState) => void): void {
    this.doneListeners.add(l);
  }

  async ask(kind: JobKind, formation: FormationData, label: string): Promise<string | null> {
    this.connect();
    // A guide's mesh stored a moment ago (a sculpt's commit, Apply, a cut) is
    // named before its upload lands: the build reads it from the store.
    await meshesStored();
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, formation, label }),
    });
    const body = (await res.json()) as { id?: string; error?: string };
    if (!res.ok || !body.id) throw new Error(body.error ?? `the job runner answered ${res.status}`);
    return body.id;
  }

  cancel(id: string): void {
    void fetch(`/api/jobs/${id}`, { method: "DELETE" });
  }

  hold(held: boolean): void {
    void fetch("/api/jobs/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: this.client, held }),
    });
  }

  // The newest job of `kind` for `hash` (any kind when absent).
  latest(hash: string, kind?: JobKind): JobState | null {
    let best: JobState | null = null;
    for (const j of this.jobs.values()) {
      if (j.hash !== hash || (kind && j.kind !== kind)) continue;
      if (!best || j.queuedAt > best.queuedAt) best = j;
    }
    return best;
  }

  // The generators' fingerprint now, or null until the server has said; `then`
  // is called once it has.
  fingerprint(then: () => void): string | null {
    if (!this.fingerprintAsked) {
      this.fingerprintAsked = true;
      fetch("/api/formations/fingerprint")
        .then((r) => r.json() as Promise<{ fingerprint?: string }>)
        .then((b) => {
          if (b.fingerprint && b.fingerprint !== this.fingerprintNow) {
            this.fingerprintNow = b.fingerprint;
            then();
          }
        })
        .catch(() => {});
    }
    return this.fingerprintNow;
  }
}

const pct = (p: number | undefined): string => `${Math.round((p ?? 0) * 100)}%`;
const ago = (t: number): string => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

// One job as a row: what, how far, and what went wrong.
export function jobRow(job: JobState, jobs: FormationJobs): HTMLElement {
  const row = document.createElement("div");
  row.className = `ed-job ed-job-${job.state}`;
  const top = document.createElement("div");
  top.className = "ed-job-top";
  const name = document.createElement("span");
  name.className = "ed-job-name";
  const verb = { geometry: "Generate", bake: "Bake", asset: "Accept", decoration: "Grow" }[job.kind];
  name.textContent = `${verb} ${job.label}`;
  const state = document.createElement("span");
  state.className = "ed-job-state";
  const took = job.startedAt ? ago(job.startedAt) : "";
  state.textContent =
    job.state === "running" ? `${pct(job.progress)} ${took}` : job.state === "done" && job.startedAt && job.endedAt
      ? `done in ${((job.endedAt - job.startedAt) / 1000).toFixed(1)}s` : job.state;
  top.append(name, state);
  if (job.state === "queued" || job.state === "running") {
    const x = document.createElement("button");
    x.className = "ed-job-cancel";
    x.textContent = "×";
    x.title = "Cancel this job";
    x.addEventListener("click", () => jobs.cancel(job.id));
    top.appendChild(x);
  }
  row.appendChild(top);
  if (job.state === "running" || job.state === "queued") {
    const bar = document.createElement("div");
    bar.className = "ed-job-bar";
    const fill = document.createElement("div");
    fill.style.width = pct(job.progress);
    bar.appendChild(fill);
    row.appendChild(bar);
  }
  if (job.step && job.state !== "done") {
    const step = document.createElement("div");
    step.className = "ed-job-step";
    step.textContent = job.step;
    row.appendChild(step);
  }
  if (job.state === "failed" && job.error) {
    const err = document.createElement("pre");
    err.className = "ed-job-error";
    err.textContent = job.error;
    row.appendChild(err);
    const log = document.createElement("a");
    log.href = `/api/jobs/${job.id}/log`;
    log.target = "_blank";
    log.textContent = `whole log (${job.log})`;
    row.appendChild(log);
  }
  return row;
}

// The jobs panel: every job, newest first, in a corner of the editor. Hidden
// while there are none; finished jobs fold away after FADE unless they failed.
const FADE = 30_000;

export function mountJobsPanel(host: HTMLElement, jobs: FormationJobs): void {
  const panel = document.createElement("div");
  panel.className = "ed-jobs";
  const head = document.createElement("div");
  head.className = "ed-jobs-head";
  const title = document.createElement("span");
  title.textContent = "Jobs";
  const clear = document.createElement("button");
  clear.textContent = "clear";
  clear.title = "Hide the finished jobs";
  let clearedBefore = 0;
  clear.addEventListener("click", () => {
    clearedBefore = Date.now();
    draw();
  });
  head.append(title, clear);
  const list = document.createElement("div");
  list.className = "ed-jobs-list";
  panel.append(head, list);
  host.appendChild(panel);
  const draw = (): void => {
    const now = Date.now();
    const shown = [...jobs.jobs.values()]
      .filter((j) => !j.endedAt || (j.endedAt > clearedBefore && (j.state === "failed" || now - j.endedAt < FADE)))
      .sort((a, b) => b.queuedAt - a.queuedAt);
    panel.style.display = shown.length ? "" : "none";
    list.replaceChildren(...shown.slice(0, 12).map((j) => jobRow(j, jobs)));
  };
  jobs.onChange(draw);
  // Elapsed times and fading, between events.
  setInterval(draw, 1000);
  draw();
}
