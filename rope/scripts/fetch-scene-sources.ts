// Fetch the Blender scenes' sources this checkout pins into `assets-src/`
// (see `scripts/sceneSources.ts`).
//
//   bun run assets:fetch-sources   (`just sources`)
//
// A file already here that matches its pin is left alone. One that DIFFERS is
// left alone too, and said so: it is somebody's unpublished work (a `.blend`
// saved since the last `just publish`), and a fetch that overwrote it would
// be the one way to lose it. Delete it, or publish it, to take the pinned one.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./assetStore";
import { readManifest, sourceUrl, SOURCES_DIR } from "./sceneSources";

let fetched = 0;
let current = 0;
const kept: string[] = [];
const failures: string[] = [];
for (const [path, pin] of Object.entries(readManifest())) {
  const file = join(SOURCES_DIR, path);
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    if (bytes.length === pin.bytes && sha256(bytes) === pin.sha256) current++;
    else kept.push(path);
    continue;
  }
  const res = await fetch(sourceUrl(path));
  if (!res.ok) {
    failures.push(`${path}: HTTP ${res.status} from ${sourceUrl(path)}`);
    continue;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) {
    failures.push(`${path}: the release holds a different file than this checkout pins (replaced since?)`);
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.${process.pid}.tmp`, bytes);
  renameSync(`${file}.${process.pid}.tmp`, file);
  fetched++;
  console.log(`[sources] ${path} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
}
for (const path of kept) {
  console.warn(`[sources] kept ${path}: it differs from the pin (unpublished edits?); delete it to fetch the pinned one`);
}
console.log(`[sources] ${fetched} fetched, ${current} current, ${kept.length} kept`);
if (failures.length) {
  for (const f of failures) console.error(`[sources] ${f}`);
  process.exit(1);
}
