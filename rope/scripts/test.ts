// The whole verification suite, as one command and one exit code.
//
// `bun run test` is what "all green" means from now on. Before it existed the
// suite was a list of commands in CLAUDE.md that had to be remembered and run by
// hand, so a change could be called verified having run three of them - and one
// case (`rigid-ramp-hold`) was red on purpose, so `cli contacts` could not gate
// anything at all until expected-fail marking landed (see contactCases.ts).
//
// Steps run in order and cheapest-first, but a failing step does NOT stop the
// run: knowing that the typecheck and four of five suites are red is worth more
// than knowing the typecheck is. The summary at the end is the deliverable.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join("src", "tools", "cli.ts");

interface Step {
  name: string;
  cmd: string[];
}

// Every playtest script in the directory, so a new scenario is covered by
// existing here rather than by being added to a list.
const playtests = readdirSync(join(ROOT, "playtests"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map<Step>((f) => ({ name: `play ${f}`, cmd: ["bun", "run", CLI, "play", join("playtests", f)] }));

const steps: Step[] = [
  { name: "typecheck", cmd: ["bunx", "tsc", "--noEmit"] },
  { name: "selftest", cmd: ["bun", "run", CLI, "selftest"] },
  { name: "contacts", cmd: ["bun", "run", CLI, "contacts"] },
  { name: "spring", cmd: ["bun", "run", CLI, "spring"] },
  { name: "vines", cmd: ["bun", "run", CLI, "vines"] },
  { name: "corners", cmd: ["bun", "run", CLI, "corners"] },
  { name: "tangents", cmd: ["bun", "run", CLI, "tangents"] },
  { name: "decompose", cmd: ["bun", "run", CLI, "decompose"] },
  { name: "camera", cmd: ["bun", "run", CLI, "camera"] },
  { name: "render3d", cmd: ["bun", "run", CLI, "render3d"] },
  { name: "assets", cmd: ["bun", "run", CLI, "assets"] },
  { name: "ledges", cmd: ["bun", "run", CLI, "ledges"] },
  ...playtests,
  { name: "bundles", cmd: ["bun", "run", CLI, "bundles"] },
];

const failures: string[] = [];
for (const step of steps) {
  console.log(`\n\x1b[1m▶ ${step.name}\x1b[0m`);
  const r = spawnSync(step.cmd[0]!, step.cmd.slice(1), { cwd: ROOT, stdio: "inherit" });
  const code = r.status ?? 1;
  if (code !== 0) failures.push(`${step.name} (exit ${code})`);
}

console.log(`\n\x1b[1m── summary ──\x1b[0m`);
console.log(`${steps.length - failures.length}/${steps.length} steps passed`);
for (const f of failures) console.log(`  FAIL ${f}`);
console.log(failures.length === 0 ? "RESULT: GREEN" : "RESULT: RED");
process.exit(failures.length === 0 ? 0 : 1);
