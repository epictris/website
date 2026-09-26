// Where the generators' interpreters are, found the way the fork found them.
//
// Python: PYTHON_PATH, else the repository's own venv (`bun run
// generators:setup` makes `rope/.venv` from tools/blender/requirements.txt),
// else `python3` on PATH. The venv comes before the system interpreter because
// the system one usually lacks shapely and scipy.
// Blender: BLENDER_PATH, else `blender` on PATH (the fork also tried the
// Windows install folder; this repository is developed on Linux).

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface Tools {
  python: string | null;
  blender: string | null;
  /** `rope/.venv` exists. */
  venv: boolean;
}

export function venvPython(root: string): string {
  return join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

/** An executable named `name` on PATH, as `which` would find it. */
export function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return null;
}

// A variable naming a file that is not there finds nothing, so the service says
// "not found" up front instead of every job failing on a spawn error.
const fromEnv = (name: string): string | null => {
  const value = process.env[name];
  return value && existsSync(value) ? value : null;
};

export function findTools(root: string): Tools {
  const venv = existsSync(venvPython(root));
  const python = process.env.PYTHON_PATH ? fromEnv("PYTHON_PATH") : venv ? venvPython(root) : onPath("python3");
  const blender = process.env.BLENDER_PATH ? fromEnv("BLENDER_PATH") : onPath("blender");
  return { python, blender, venv };
}

export interface ToolVersions {
  /** e.g. "3.14.0", or null when there is no interpreter or it would not run. */
  python: string | null;
  /** e.g. "5.2.0". */
  blender: string | null;
  /** The interpreter imports every package the boulder generator needs. */
  deps: boolean;
}

// A version probe that hangs (a wedged Blender) must not hang the endpoint (ms).
const PROBE_TIMEOUT = 15_000;

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT }, (error, stdout, stderr) =>
      done(error ? null : `${stdout}${stderr}`),
    );
  });
}

export async function toolVersions(tools: Tools): Promise<ToolVersions> {
  const [python, blender, deps] = await Promise.all([
    tools.python ? run(tools.python, ["--version"]) : null,
    tools.blender ? run(tools.blender, ["--version"]) : null,
    tools.python ? run(tools.python, ["-c", "import numpy, shapely, scipy, PIL, matplotlib"]) : null,
  ]);
  return {
    python: /Python (\d+\.\d+\.\d+)/.exec(python ?? "")?.[1] ?? null,
    blender: /Blender (\d+\.\d+\.\d+)/.exec(blender ?? "")?.[1] ?? null,
    deps: deps !== null,
  };
}
