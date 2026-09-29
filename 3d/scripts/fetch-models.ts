// Downloads the depth model (api/models.ts) into MODELS_DIR (default
// 3d/models/), pinned by its sha256: a file already present with the right
// hash is kept, a download with the wrong one is refused. The Dockerfile
// runs this in a build stage, so a deploy never depends on Hugging Face at
// runtime. `bun run models`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MODEL_FILES, MODELS_DIR } from "../api/models";

const dir = MODELS_DIR;
mkdirSync(dir, { recursive: true });

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

let failed = false;
for (const f of MODEL_FILES) {
  const path = join(dir, f.name);
  if (existsSync(path) && (await sha256(path)) === f.sha256) {
    console.log(`ok      ${f.name}`);
    continue;
  }
  console.log(`fetch   ${f.name} (${(f.bytes / 1e6).toFixed(1)} MB)`);
  const res = await fetch(f.url);
  if (!res.ok || !res.body) {
    console.error(`error   ${f.name}: HTTP ${res.status} from ${f.url}`);
    failed = true;
    continue;
  }
  const tmp = `${path}.part`;
  const out = Bun.file(tmp).writer();
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    out.write(chunk);
    bytes += chunk.length;
  }
  await out.end();
  const got = hash.digest("hex");
  if (got !== f.sha256 || bytes !== f.bytes) {
    rmSync(tmp, { force: true });
    console.error(`error   ${f.name}: got ${bytes} bytes with sha256 ${got}; expected ${f.bytes} bytes, ${f.sha256}`);
    failed = true;
    continue;
  }
  renameSync(tmp, path);
  console.log(`ok      ${f.name}`);
}
if (failed) process.exit(1);
