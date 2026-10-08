// A script's steps as a live list at the bottom of the terminal: what is done
// (and how long it took), what is running (and for how long), what is still to
// come. Lines a script logs meanwhile print above the list, which stays put.
//
//   const progress = new StepProgress("[scene]", [{ id: "bake", label: "bake textures" }, ...]);
//   progress.start("bake");             // the step before it is done
//   progress.note("bake", "3 of 29");   // shown beside the step
//   progress.log("a line");             // printed above the list
//   progress.finish();                  // or progress.fail(), then print on
//
// Off a terminal (a pipe, a log file) nothing is redrawn: each step's start is
// one line, and the finished list is printed once at the end.

export interface StepDef {
  id: string;
  label: string;
}

type State = "pending" | "running" | "done" | "skipped" | "failed";

interface Step extends StepDef {
  state: State;
  note?: string;
  started?: number;
  ended?: number;
}

const color = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const bold = paint("1");
const green = paint("32");
const cyan = paint("36");
const red = paint("31");

const SYMBOL: Record<State, string> = {
  pending: dim("·"),
  running: cyan("▸"),
  done: green("✓"),
  skipped: dim("-"),
  failed: red("✗"),
};

/** 4.2s, 42s, 3m07s; tenths only for a finished step under a minute. */
function duration(ms: number, tenths: boolean): string {
  const s = ms / 1000;
  if (s < 60) return tenths ? `${s.toFixed(1)}s` : `${Math.floor(s)}s`;
  const whole = Math.floor(s);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
}

export class StepProgress {
  private readonly steps: Step[];
  private readonly live = !!process.stdout.isTTY;
  private readonly began = Date.now();
  private drawn = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ended: number | undefined;

  constructor(
    private readonly prefix: string,
    defs: StepDef[],
  ) {
    this.steps = defs.map((d) => ({ ...d, state: "pending" }));
    if (this.live) {
      this.timer = setInterval(() => this.redraw(), 1000);
      this.redraw();
    }
  }

  /** Start `id`; the running step, if any, is done. */
  start(id: string, note?: string): void {
    const step = this.find(id);
    if (!step) return;
    if (step.state === "running") {
      if (note !== undefined) this.note(id, note);
      return;
    }
    this.close("done");
    step.state = "running";
    step.started = Date.now();
    step.note = note ?? undefined;
    if (!this.live) {
      const at = this.steps.indexOf(step) + 1;
      console.log(`${this.prefix} step ${at}/${this.steps.length}: ${step.label}${note ? ` (${note})` : ""}`);
    }
    this.redraw();
  }

  /** What `id` is on, or what it did; shown beside it (on a terminal). */
  note(id: string, note: string): void {
    const step = this.find(id);
    if (!step) return;
    step.note = note;
    this.redraw();
  }

  /** `id` will not run; the running step is left running. */
  skip(id: string, note?: string): void {
    const step = this.find(id);
    if (!step) return;
    step.state = "skipped";
    step.note = note;
    this.redraw();
  }

  /** A line printed above the list. */
  log(line: string): void {
    this.clear();
    console.log(line);
    this.draw();
  }

  /** The running step is done; the list is drawn for the last time. */
  finish(): void {
    this.close("done");
    this.stop();
  }

  /** The running step failed; the list is drawn for the last time. */
  fail(): void {
    this.close("failed");
    this.stop();
  }

  private find(id: string): Step | undefined {
    const step = this.steps.find((s) => s.id === id);
    if (!step) this.log(`${this.prefix} (progress: no step "${id}")`);
    return step;
  }

  private close(state: "done" | "failed"): void {
    for (const s of this.steps) {
      if (s.state !== "running") continue;
      s.state = state;
      s.ended = Date.now();
    }
  }

  private stop(): void {
    if (this.ended !== undefined) return;
    this.ended = Date.now();
    clearInterval(this.timer);
    // In place of the live list on a terminal, and where it stays.
    this.clear();
    for (const line of this.lines()) console.log(line);
  }

  private lines(): string[] {
    const now = this.ended ?? Date.now();
    const width = Math.max(...this.steps.map((s) => s.label.length));
    const columns = this.live ? (process.stdout.columns || 100) : Infinity;
    const out = this.steps.map((s) => {
      const time =
        s.started === undefined ? "" : duration((s.ended ?? now) - s.started, s.ended !== undefined);
      const label = s.state === "running" ? bold(s.label) : s.state === "pending" || s.state === "skipped" ? dim(s.label) : s.label;
      const head = `  ${SYMBOL[s.state]} ${label}${" ".repeat(width - s.label.length)}  ${time.padStart(6)}`;
      // The visible width of `head`, without its colour codes.
      const used = 2 + 1 + 1 + width + 2 + Math.max(6, time.length);
      let note = s.note ?? "";
      const room = columns - used - 3;
      if (note.length > room) note = room > 1 ? `${note.slice(0, room - 1)}…` : "";
      // Padding is outside the colour codes, so a bare row trims clean.
      return note ? `${head}  ${dim(note)}` : head.trimEnd();
    });
    out.push(dim(`  ${this.ended === undefined ? "elapsed" : "total"} ${duration(now - this.began, this.ended !== undefined)}`));
    return out;
  }

  private clear(): void {
    if (this.drawn > 0) process.stdout.write(`\x1b[${this.drawn}F\x1b[J`);
    this.drawn = 0;
  }

  private draw(): void {
    if (!this.live || this.ended !== undefined) return;
    const lines = this.lines();
    process.stdout.write(lines.join("\n") + "\n");
    this.drawn = lines.length;
  }

  private redraw(): void {
    if (!this.live || this.ended !== undefined) return;
    this.clear();
    this.draw();
  }
}
