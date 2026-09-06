// The production process for rope: serves the built app out of dist/ and hosts
// the playtest store (src/server/) that production play streams into. The sim
// runs client-side; the only game code that runs here is the replay the store
// uses to verify a sealed run, and that runs in a subprocess.

import { file } from "bun";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { adminHtmlPath, handlePlaytest } from "./src/server/routes";
import { PlaytestStore, type Verdict } from "./src/server/store";
import { sourceHash } from "./src/sim/treeStamp";

const PORT = Number(process.env.PORT ?? 8080);
const DIST = join(import.meta.dir, "dist");
// Where runs are kept. `/data/playtests` in the container (a bind mount, see
// compose.yml); a scratch directory beside the source when run by hand.
const PLAYTEST_DIR = process.env.PLAYTEST_DIR ?? join(import.meta.dir, ".playtests");
const SWEEP_MS = 60_000;
const VERIFY_TIMEOUT_MS = 180_000;

const log = (line: string) => console.log(`[playtest] ${line}`);

// The tree this process serves, computed the way the build stamped it into the
// page: the same files, the same hash (see src/sim/treeStamp.ts). The commit
// arrives from the deploy as GIT_COMMIT, since the image has no `.git`.
const here = {
  commit: process.env.GIT_COMMIT?.trim().slice(0, 7) || "unknown",
  srcHash: sourceHash(import.meta.dir),
};

async function verifyInSubprocess(path: string): Promise<Verdict | null> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "src", "server", "verify.ts"), path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), VERIFY_TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  if (proc.exitCode !== 0) {
    log(`verify ${path} exited ${proc.exitCode}: ${err.trim().split("\n").pop() ?? ""}`);
    return null;
  }
  return JSON.parse(out.trim()) as Verdict;
}

const store = new PlaytestStore({ dir: PLAYTEST_DIR, here, verify: verifyInSubprocess, log });
const adminHtml = readFileSync(adminHtmlPath(), "utf8");

setInterval(() => {
  const r = store.sweep();
  if (r.sealed.length || r.forgotten || r.expired || r.purged) {
    log(`sweep: sealed ${r.sealed.length} idle run(s), forgot ${r.forgotten} session(s), expired ${r.expired}, purged ${r.purged}`);
  }
}, SWEEP_MS);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const handled = await handlePlaytest(req, {
      store,
      socketIp: server.requestIP(req)?.address ?? null,
      adminHtml,
    });
    if (handled) return handled;

    const url = new URL(req.url);
    let pathname = normalize(decodeURIComponent(url.pathname));
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    if (pathname === "/editor" || pathname === "/editor/") pathname = "/editor.html";

    const full = join(DIST, pathname);
    // Reject path traversal outside DIST.
    if (full !== DIST && !full.startsWith(DIST + "/")) {
      return new Response("forbidden", { status: 403 });
    }

    let f = file(full);
    if (!(await f.exists())) f = file(join(DIST, "index.html"));
    return new Response(f);
  },
});

console.log(`rope serving dist/ on :${PORT}; playtests in ${PLAYTEST_DIR} (tree ${here.srcHash} @${here.commit})`);
