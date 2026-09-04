// The identity of the SOURCE a bundle was recorded from, rather than of the last
// commit before the dev server started.
//
// `__GIT_COMMIT__` was `git rev-parse` evaluated once at Vite config load, so a
// dev server started at 08:02 stamped every bundle for the rest of the day with
// a commit two behind HEAD, and none of them said which uncommitted edits were
// live. On 2026-09-04 seven bundles said `f0ed27a` while the served tree changed
// hourly, and two "still broken" recordings turned out to have been made on code
// that was already reverted - found by rebuilding variants in a worktree, which
// is an afternoon spent learning what the bundle should have said itself.
//
// `srcHash` is a hash over the CONTENTS of the source the app is built from, so
// it moves the moment an edit does, committed or not. A bundle carries it, and
// every replaying command says whether the tree it is replaying on is that
// source.
//
// NODE ONLY. It reads the filesystem, so nothing in the browser bundle may
// import it: the dev server computes the stamp and serves it through the
// `virtual:tree-stamp` module (see vite.config.ts), and the CLI computes it
// directly. It lives here rather than in `scripts/` because the CLI and the
// plugin must compute the *same* hash, and a second implementation of "the same
// hash" is a bug waiting for a quiet afternoon.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface TreeStamp {
  // Short HEAD commit, or "unknown" outside a git checkout.
  commit: string;
  // Does the working tree differ from that commit at all?
  dirty: boolean;
  // 12 hex characters over the contents of every source file the app is built
  // from. This is the field that actually identifies the tree; `commit` and
  // `dirty` are for a human reading the header.
  srcHash: string;
}

// What the build includes and what a level is. Anything outside these two lists
// cannot change the simulation, and hashing it would make the stamp move for
// reasons a bundle is not evidence about.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".json", ".css", ".glsl", ".frag", ".vert"];
// Directories under `src/` that hold no source: none today, but assets and
// generated output have lived there before and would make every stamp differ.
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return; // A directory that is not there contributes nothing, and is not an error.
  }
  for (const name of entries) {
    if (SKIP_DIRECTORIES.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (SOURCE_EXTENSIONS.some((e) => name.endsWith(e))) {
      out.push(path);
    }
  }
}

// The hash over `<root>/src` and `<root>/levels`.
//
// Paths go into the hash as well as contents, and they go in relative to the
// root with `/` separators: a file renamed and nothing else is a different tree,
// and a hash that changed with the checkout's absolute path or the platform's
// separator would call two identical trees different.
export function sourceHash(root: string): string {
  const files: string[] = [];
  walk(join(root, "src"), files);
  walk(join(root, "levels"), files);
  files.sort();
  const h = createHash("sha1");
  for (const f of files) {
    h.update(relative(root, f).split(sep).join("/"));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

// `git` is called through a callback rather than imported, because the two
// callers already have one: the CLI's `git()` fails loudly on a broken repo, and
// the Vite plugin must not take the dev server down over one.
export function treeStamp(root: string, git: (args: string[]) => string | null): TreeStamp {
  // Trimmed here rather than in each caller's `git`: both hand back raw stdout,
  // and a commit with a newline in it lands in the middle of a printed line.
  const commit = git(["rev-parse", "--short", "HEAD"])?.trim();
  // Scoped to `root`, not the whole repo: this stamp is about the rope tree, and
  // an edit somewhere else in the monorepo cannot change what it serves.
  const status = git(["status", "--porcelain", "--", "."]);
  return {
    commit: commit || "unknown",
    dirty: status !== null && status.trim() !== "",
    srcHash: sourceHash(root),
  };
}
