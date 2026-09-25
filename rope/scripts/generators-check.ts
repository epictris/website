// `bun run generators:check`: the generator service and its Python, as one
// command and one exit code.
//
//   1. the service's own cases (scripts/generators.test.ts): validation, keys,
//      schemas, the queue;
//   2. the Python schema cases: boulders/test_params.py (the port reproduces the
//      fork's request for an approved rock, field by field) and
//      mushrooms/test_params.py (the add-on and params.json agree);
//   3. end to end, when Python and Blender are both here: a 1 m square outline
//      through rockgen.py and Blender, and a 1 m square surface through the
//      mushroom patch, each checked for a GLB with triangles in it.
//
// A step whose tools are missing is SKIPPED with the reason printed, never
// silently; only a FAIL makes the exit code non-zero.

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boulder } from "../src/server/generators/boulder";
import { glbTriangles } from "../src/server/generators/glb";
import { mushrooms } from "../src/server/generators/mushrooms";
import { findTools, toolVersions } from "../src/server/generators/paths";
import { makeJobDir, runGenerator, type Generator } from "../src/server/generators/run";
import { loadSchema } from "../src/server/generators/schema";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
type Verdict = "PASS" | "FAIL" | "SKIP";
const results: { name: string; verdict: Verdict; note: string }[] = [];
const record = (name: string, verdict: Verdict, note = "") => {
  results.push({ name, verdict, note });
  console.log(`--- ${verdict} ${name}${note ? `: ${note}` : ""}`);
};

function step(name: string, cmd: string[], env: Record<string, string> = {}): void {
  console.log(`\n=== ${name}: ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  record(name, r.status === 0 ? "PASS" : "FAIL", r.status === 0 ? "" : `exit ${r.status ?? r.signal}`);
}

async function endToEnd<I>(name: string, gen: Generator<I>, input: I): Promise<void> {
  console.log(`\n=== ${name}`);
  const tools = findTools(ROOT);
  const missing = gen.missing(tools);
  if (missing) return record(name, "SKIP", missing);
  const jobDir = await makeJobDir(gen.kind);
  const started = performance.now();
  try {
    const result = await runGenerator(gen, tools, ROOT, input, {}, loadSchema(ROOT, gen.dir), jobDir, {
      onLine: (line) => console.log(`  ${line}`),
    });
    const bytes = readFileSync(result.glb);
    const triangles = glbTriangles(bytes);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    if (triangles <= 0) return record(name, "FAIL", `the GLB has no triangles (${secs} s)`);
    record(name, "PASS", `${triangles} triangles, ${bytes.byteLength} bytes, ${secs} s`);
    rmSync(jobDir, { recursive: true, force: true });
  } catch (e) {
    record(name, "FAIL", (e as Error).message);
  }
}

step("service cases", ["bun", "test", "./scripts/generators.test.ts"]);

const tools = findTools(ROOT);
const versions = await toolVersions(tools);
console.log(
  `\npython ${tools.python ?? "none"} (${versions.python ?? "?"}, packages ${versions.deps ? "present" : "MISSING"}), ` +
    `blender ${tools.blender ?? "none"} (${versions.blender ?? "?"}), rope/.venv ${tools.venv ? "present" : "absent"}`,
);
const noBytecode = { PYTHONDONTWRITEBYTECODE: "1" };
if (!tools.python) {
  record("boulder params", "SKIP", "no Python: run `bun run generators:setup`, or set PYTHON_PATH");
  record("mushroom params", "SKIP", "no Python: run `bun run generators:setup`, or set PYTHON_PATH");
} else {
  if (versions.deps) step("boulder params", [tools.python, "tools/blender/boulders/test_params.py"], noBytecode);
  else record("boulder params", "SKIP", `${tools.python} lacks numpy/shapely/scipy/Pillow/matplotlib: run \`bun run generators:setup\``);
  // Standard library only.
  step("mushroom params", [tools.python, "tools/blender/mushrooms/test_params.py"], noBytecode);
}

if (tools.python && !versions.deps)
  record("boulder end to end", "SKIP", `${tools.python} lacks the generator's packages: run \`bun run generators:setup\``);
else await endToEnd("boulder end to end (1 m square)", boulder, { outline: [[0, 0], [1, 0], [1, 1], [0, 1]] });
await endToEnd("mushrooms end to end (1 m square)", mushrooms, {
  positions: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1],
});

console.log("\n=== generators:check");
for (const r of results) console.log(`${r.verdict.padEnd(4)} ${r.name}${r.note ? `  (${r.note.split("\n")[0]})` : ""}`);
const failed = results.filter((r) => r.verdict === "FAIL").length;
const skipped = results.filter((r) => r.verdict === "SKIP").length;
console.log(`${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
