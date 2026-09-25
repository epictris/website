// One generation: write the request into a scratch directory, run the kind's
// command in its own process group, and hand back the GLB it wrote. The HTTP
// service (service.ts) queues these; `bun run generators:check` calls it
// directly for its end-to-end case.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GeneratorKind, ParamSchema, ParamValue, ParamValues } from "../../level/generatorParams";
import type { GeneratorInput } from "../../render3d/generated";
import type { Tools } from "./paths";

export type { GeneratorKind };

export interface Command {
  file: string;
  args: string[];
}

export interface Generator<Input> {
  kind: GeneratorKind;
  /** tools/blender/<dir>: the Python sources and params.json. */
  dir: string;
  /**
   * Checks the request's `input` (and `soup`, for a kind that is handed
   * derived geometry the key does not cover) against the merged params;
   * throws with a message for the author.
   */
  validateInput(input: unknown, soup: unknown, values: Readonly<Record<string, ParamValue | null>>): Input;
  /** What the mesh key hashes and meta.json records (generatedKey's input). */
  keyInput(input: Input): GeneratorInput;
  /** Files written beside meta.json, by name: what the key input leaves out. */
  sidecars(input: Input): Record<string, unknown>;
  /** The request file the Python reads. */
  request(input: Input, overrides: ParamValues, schema: ParamSchema): unknown;
  /** What the kind cannot run without, said for the author; null when all is here. */
  missing(tools: Tools): string | null;
  /** The process to run; only asked once `missing` is null. */
  command(tools: Tools, root: string, requestFile: string, outDir: string): Command;
  /** Where the command leaves the GLB. */
  output(outDir: string): string;
  /** A wedged Blender is killed after this long (ms). */
  timeout: number;
  failure(stdout: string, stderr: string, fallback: string, kept: string): string;
}

// Output kept for the failure message (characters, the most recent); the fork's
// execFile maxBuffer, which killed the run when exceeded, is kept here instead
// as a rolling window, so a chatty Blender cannot fail a generation.
const OUTPUT_KEEP = 4 * 1024 * 1024;

// Printed by blender_build.py and editor_patch.py once the geometry is final.
export const BAKE_MARKER = "GENERATOR: bake started";

// Grace between SIGTERM and SIGKILL for a cancelled process group (ms).
const KILL_GRACE = 2000;

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Called once, when the run prints BAKE_MARKER. */
  onBake?: () => void;
  onLine?: (line: string) => void;
}

export interface RunResult {
  glb: string;
  jobDir: string;
  stdout: string;
}

export async function makeJobDir(kind: GeneratorKind): Promise<string> {
  return mkdtemp(join(tmpdir(), `trisball-${kind}-`));
}

export async function runGenerator<Input>(
  gen: Generator<Input>,
  tools: Tools,
  root: string,
  input: Input,
  overrides: ParamValues,
  schema: ParamSchema,
  jobDir: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const requestFile = join(jobDir, "request.json");
  const outDir = join(jobDir, "out");
  await writeFile(requestFile, JSON.stringify(gen.request(input, overrides, schema)));
  const missing = gen.missing(tools);
  if (missing) throw new Error(missing);
  const command = gen.command(tools, root, requestFile, outDir);

  return new Promise<RunResult>((resolve, reject) => {
    // Detached: rockgen.py starts Blender as ITS child, and killing Python
    // alone would leave that Blender running; the group goes down together.
    const child = spawn(command.file, command.args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // The generators' __pycache__ would otherwise land in tools/blender.
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...(tools.blender ? { BLENDER_PATH: tools.blender } : {}) },
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let baked = false;
    let settled = false;
    let reason: Error | null = null;

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
      } catch {
        // already gone
      }
    };
    const stop = (why: Error) => {
      if (reason) return;
      reason = why;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE).unref();
    };
    const timer = setTimeout(() => stop(new Error(`timed out after ${gen.timeout / 1000} s`)), gen.timeout);
    const onAbort = () => stop(new Cancelled());
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-OUTPUT_KEEP);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        options.onLine?.(line);
        if (!baked && line.includes(BAKE_MARKER)) {
          baked = true;
          options.onBake?.();
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-OUTPUT_KEEP);
      if (options.onLine) for (const line of chunk.split(/\r?\n/)) if (line) options.onLine(line);
    });
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ glb: gen.output(outDir), jobDir, stdout });
    };
    child.on("error", (e) => finish(new Error(`${command.file}: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (pending) options.onLine?.(pending);
      if (reason instanceof Cancelled) return finish(reason);
      const fallback = reason?.message ?? `exit ${code ?? signal}`;
      if (reason || code !== 0) return finish(new Error(gen.failure(stdout, stderr, fallback, jobDir)));
      finish(null);
    });
  });
}
