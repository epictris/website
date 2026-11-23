// The one-off migration that retires the orthographic route's solid-guide
// leaves (plans/sculpt-guides.md, scripts/solidGuideMigration.ts): every
// `extrude`, `hull` and `ellipsoid` leaf in every level and formation asset
// becomes a mesh leaf of itself, held to the same volume.
//
//   bun run guides:migrate [--dry]
//
// Close the editor first: an open editor tab autosaves its level over this.
// A level holding a retired leaf will not load until this has run
// (`RETIRED_SOLID_PRIMS` in src/level/levelFormat.ts).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrateDoc, type RawDoc } from "./solidGuideMigration";

const ROOT = join(import.meta.dirname, "..");
const STORE = join(ROOT, "public", "generated");
const dry = process.argv.includes("--dry");

const dirs = ["levels", "formation-assets"].map((d) => join(ROOT, d)).filter((d) => existsSync(d));
let migrated = 0;
let refused = 0;
for (const dir of dirs) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, file);
    const doc = JSON.parse(readFileSync(path, "utf8")) as RawDoc;
    const done = migrateDoc(doc, STORE, dry);
    for (const g of done) {
      const label = `${path.slice(ROOT.length + 1)} body ${g.body}${g.name ? ` (${g.name})` : ""} formation ${g.formation}`;
      const volumes = `${g.volumeBefore.toFixed(6)} -> ${g.volumeAfter.toFixed(6)} m3 (${g.off.toExponential(2)} relative)`;
      console.log(`  ${g.ok ? (dry ? "would migrate" : "migrated") : "REFUSED"}  ${label}: ${volumes}`);
      if (g.ok) migrated++;
      else refused++;
    }
    if (!dry && done.some((g) => g.ok)) writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  }
}
console.log(`[guides] ${migrated} guide${migrated === 1 ? "" : "s"} ${dry ? "would be " : ""}migrated${refused ? `, ${refused} refused (left as they were)` : ""}`);
if (refused) process.exit(1);
