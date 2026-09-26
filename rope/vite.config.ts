import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
import { rootGenerator } from "./src/server/rootGenerator";
import { boulderGenerator } from "./src/server/boulderGenerator";
import { dirtMossGenerator } from "./src/server/dirtMossGenerator";
import { vineGenerator } from "./src/server/vineGenerator";
import { mushroomGenerator } from "./src/server/mushroomGenerator";
import { grassGenerator } from "./src/server/grassGenerator";
import { plantGenerator } from "./src/server/plantGenerator";
import { buildSync } from "esbuild";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { levelFileHash, treeStamp, type TreeStamp } from "./src/sim/treeStamp";
import { DEFAULT_LEVEL, LEVELS } from "./src/level/registry";
import type { RawLevelData } from "./src/level/levelFormat";
import { levelStoredFiles } from "./src/render3d/levelAssets";

// The identity of the SOURCE this server is serving, exposed to the app as
// `virtual:tree-stamp` and stamped into every exported bundle.
//
// It replaces a `define` of `git rev-parse --short HEAD` evaluated once at
// config load, which is a statement about when the server was STARTED: a server
// up since 08:02 stamped every bundle for the rest of the day with a commit two
// behind HEAD and said nothing at all about the uncommitted edits that were
// actually live. See `src/sim/treeStamp.ts`.
const TREE_STAMP_ID = "virtual:tree-stamp";
const TREE_STAMP_RESOLVED = "\0" + TREE_STAMP_ID;

// One `git`, because two plugins need the stamp: the app imports it through
// `virtual:tree-stamp`, and the preload manifest carries it for the level
// select, which never loads the app (see `storeScript`). It must never take the
// dev server down over a broken checkout, hence the swallowed error.
const git = (args: string[]): string | null => {
  try {
    return execSync(`git ${args.join(" ")}`, { cwd: import.meta.dirname, encoding: "utf8" });
  } catch {
    return null;
  }
};

function treeStampPlugin(): Plugin {
  const root = import.meta.dirname;
  // Recomputed lazily rather than on every watcher event: hashing the tree is
  // cheap but not free, and a burst of saves would otherwise pay for each one.
  let cached: TreeStamp | null = null;

  return {
    name: "tree-stamp",
    resolveId(id) {
      return id === TREE_STAMP_ID ? TREE_STAMP_RESOLVED : null;
    },
    load(id) {
      if (id !== TREE_STAMP_RESOLVED) return null;
      cached ??= treeStamp(root, git);
      return (
        `export const commit = ${JSON.stringify(cached.commit)};\n` +
        `export const dirty = ${JSON.stringify(cached.dirty)};\n` +
        `export const srcHash = ${JSON.stringify(cached.srcHash)};\n`
      );
    },
    handleHotUpdate(ctx) {
      // Any source change makes the stamp stale. Invalidating the module is what
      // makes the next full page load pick the new one up; HMR does not
      // propagate through it, and it does not need to - a bundle is stamped when
      // it is downloaded, and the page that downloads it was loaded after the
      // edit or it is not testing the edit.
      cached = null;
      const mod = ctx.server.moduleGraph.getModuleById(TREE_STAMP_RESOLVED);
      if (mod) ctx.server.moduleGraph.invalidateModule(mod);
    },
  };
}

// The hash of each file-backed level's own bytes, exposed to the app as
// `virtual:level-hashes` (see `levelFileHash` in src/sim/treeStamp.ts).
//
// A second stamp beside `virtual:tree-stamp` rather than a field on it, because
// it answers a different question: `srcHash` says which TREE a run was played
// on and moves when anything moves, and this says which LEVEL FILE a piece of
// feedback is about and moves only when that file does. Two ratings of an
// untouched level either side of a renderer edit carry different tree stamps
// and the same level hash, which is exactly what makes them comparable.
//
// INVALIDATION IS THE LEVEL API'S, not the watcher's: `levels/*.json` is
// deliberately outside vite's watcher (see `server.watch.ignored`), so
// `handleHotUpdate` never fires for a level write. The level API's own watcher
// is what sees those, and it calls `invalidateLevelHashes` below.
const LEVEL_HASHES_ID = "virtual:level-hashes";
const LEVEL_HASHES_RESOLVED = "\0" + LEVEL_HASHES_ID;

// Set by the plugin so the level API's watcher can reach it. A module-level
// hook rather than a shared object because the two plugins are constructed
// independently and the config is loaded once.
let invalidateLevelHashes: () => void = () => undefined;

function levelHashesPlugin(): Plugin {
  const root = import.meta.dirname;
  let cached: Record<string, string> | null = null;

  const build = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [id, spec] of Object.entries(LEVELS)) {
      if (spec.file) out[id] = levelFileHash(root, spec.file);
    }
    return out;
  };

  return {
    name: "level-hashes",
    configResolved() {
      invalidateLevelHashes = () => (cached = null);
    },
    resolveId(id) {
      return id === LEVEL_HASHES_ID ? LEVEL_HASHES_RESOLVED : null;
    },
    load(id) {
      if (id !== LEVEL_HASHES_RESOLVED) return null;
      cached ??= build();
      return `export const levelHashes = ${JSON.stringify(cached)};\n`;
    },
    configureServer(server) {
      // The module graph has to be told as well as the cache: a page loaded
      // after a level write must not be served the hash of the file as it was
      // when the server started.
      invalidateLevelHashes = () => {
        cached = null;
        const mod = server.moduleGraph.getModuleById(LEVEL_HASHES_RESOLVED);
        if (mod) server.moduleGraph.invalidateModule(mod);
      };
    },
  };
}

// Dev-only REST API backing the level editor's save/load-from-disk. Levels live
// as JSON files under rope/levels/. Only reachable via `bun run dev`; the built
// app has no server (the editor is a dev tool).
function levelApi(): Plugin {
  const dir = join(import.meta.dirname, "levels");
  const valid = /^[A-Za-z0-9_-]+$/;
  const fileFor = (name: string) => join(dir, `${name}.json`);

  return {
    name: "level-api",
    configureServer(server) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // A level file is in the module graph (registry.ts imports it) but NOT on
      // the watcher - `server.watch.ignored` keeps level writes from restarting
      // the server, and invalidation rides on the watcher event that is no
      // longer delivered. Without this, vite kept serving the JSON module it
      // transformed at startup and a hand reload showed the level as it was
      // hours ago. Invalidate on the write instead, which is a better signal
      // anyway: it is the write, not a guess at what a watcher event meant.
      //
      // No HMR is sent with it. The page picks the new module up on its next
      // load, which is the contract everywhere else here: a level is read once,
      // when the scene is built.
      const invalidate = (file: string) => {
        for (const env of Object.values(server.environments)) {
          for (const mod of env.moduleGraph.getModulesByFile(file) ?? []) {
            env.moduleGraph.invalidateModule(mod);
          }
        }
      };

      // The API is not the only way a level is written. A hand edit, a `git
      // checkout`, a tool - none of them come through here, and none of them
      // reach vite's watcher either, so the module graph kept a copy from
      // startup and the GAME went on opening a level the file had not held for
      // hours while the editor (which reads the file per load, through the GET
      // above) showed the new one: two windows, the same level, different
      // worlds. A watcher of our OWN closes that, and it is not vite's: the
      // event never reaches `handleHMRUpdate`, so a level write still cannot
      // restart the server (see `server.watch.ignored`).
      //
      // No HMR is sent, as above - the page picks the module up on its next
      // load.
      watch(dir, (_event, name) => {
        if (typeof name !== "string" || !name.endsWith(".json")) return;
        invalidate(join(dir, name));
        // ...and the level-hash table, which is derived from these same bytes
        // and has no watcher of its own for exactly the reason this one exists.
        invalidateLevelHashes();
      });

      server.middlewares.use("/api/levels", (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };

        // req.url is relative to the mount point: "/" (list) or "/<name>".
        const name = decodeURIComponent((req.url ?? "/").split("?")[0]!.replace(/^\//, ""));

        try {
          if (req.method === "GET" && name === "") {
            const names = readdirSync(dir)
              .filter((f) => f.endsWith(".json"))
              .map((f) => f.slice(0, -5))
              .sort();
            return send(200, { names });
          }

          if (!valid.test(name)) return send(400, { error: "invalid level name" });

          if (req.method === "GET") {
            if (!existsSync(fileFor(name))) return send(404, { error: "not found" });
            return send(200, JSON.parse(readFileSync(fileFor(name), "utf8")));
          }

          if (req.method === "PUT") {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                const text = JSON.stringify(parsed, null, 2) + "\n";
                // The editor autosaves, so identical writes are common; skipping
                // them keeps the file's mtime quiet.
                const unchanged =
                  existsSync(fileFor(name)) && readFileSync(fileFor(name), "utf8") === text;
                if (!unchanged) {
                  writeFileSync(fileFor(name), text);
                  invalidate(fileFor(name));
                }
                send(200, { ok: true, name });
              } catch {
                send(400, { error: "invalid JSON body" });
              }
            });
            return;
          }

          if (req.method === "DELETE") {
            if (existsSync(fileFor(name))) {
              rmSync(fileFor(name));
              invalidate(fileFor(name));
            }
            return send(200, { ok: true });
          }

          return send(405, { error: "method not allowed" });
        } catch (e) {
          return send(500, { error: String(e) });
        }
      });
    },
  };
}

// Pulled production runs (`cli pull` -> playtests/prod/) for `?replay=prod/<id>`,
// served gunzipped so the page reads them like any other bundle.
function prodReplays(): Plugin {
  const dir = join(import.meta.dirname, "playtests", "prod");
  return {
    name: "prod-replays",
    configureServer(server) {
      server.middlewares.use("/playtests/prod", (req, res) => {
        const name = decodeURIComponent((req.url ?? "/").split("?")[0]!.replace(/^\//, ""));
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
          res.statusCode = 400;
          return res.end("bad name");
        }
        for (const candidate of [join(dir, name), join(dir, `${name}.json.gz`), join(dir, `${name}.json`)]) {
          if (!existsSync(candidate)) continue;
          const raw = readFileSync(candidate);
          res.setHeader("Content-Type", "application/json");
          return res.end(candidate.endsWith(".gz") ? gunzipSync(raw) : raw);
        }
        res.statusCode = 404;
        res.end("no such run; `bun run replay pull` first");
      });
    },
  };
}

// Serve the editor page at the clean path /editor (dev). Production is handled
// by serve.ts, which maps /editor → dist/editor.html.
function editorRoute(): Plugin {
  return {
    name: "editor-route",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (path === "/editor" || path === "/editor/") {
          const query = req.url!.includes("?") ? req.url!.slice(req.url!.indexOf("?")) : "";
          req.url = "/editor.html" + query;
        }
        next();
      });
    },
  };
}


// The byte store, and the preload list it reads.
//
// TWO THINGS GO INTO THE HEAD OF EVERY PAGE, ahead of anything else:
//
//   1. `src/render3d/store.ts`, compiled and inlined as a plain script. It is
//      what fetches and counts every stored byte, and the app talks to it
//      through `window.__ropeStore` (see render3d/download.ts).
//   2. On `index.html` only, the preload list: which files each level needs and
//      what they weigh, so the store can start fetching before the app exists.
//
// INLINED RATHER THAN IMPORTED because vite merges every module script in a page
// into one entry: loaded as its own `<script type="module" src>` the tag simply
// disappeared and the code came back inside the 1.14 MB shared chunk, which is
// the wait it is supposed to start ahead of. As an inline classic script it runs
// during HTML parsing, so the level's 26 MB is arriving at ~40 ms instead of at
// 240 ms (production) or 1530 ms (dev server, where vite serves 5.2 MB of
// unbundled modules). That gap was the whole of the loading bar's empty second.
//
// The list is resolved HERE, off disk, because it is a fact about the level
// files and the asset manifest and both are on disk: a build step cannot build a
// scene, so `levelStoredFiles` answers the same question by walking the level
// data (see render3d/levelAssets.ts, and the drift warning it describes). A
// file-backed level is re-read per page load, so a level the editor is saving
// stays in step without the server restarting under it (see `levelData`).
//
// `transformIndexHtml` runs in dev serve and in build alike, so the dev server
// and the shipped page carry the same thing. Only `index.html` gets a preload
// list: the editor and `shot.html` build scenes too, but neither is a page
// anybody waits on, and a preload for a level they may not open would be a
// download for nothing.
function storeScript(): Plugin {
  // A file-backed level's data as it is ON DISK RIGHT NOW, rather than as it was
  // when this config was loaded (see `LevelSpec.file`). The dev server does not
  // restart on a level write any more - that restart was the editor's autosave
  // cycling the server - and it is the one thing that used to keep this list in
  // step with what the author is editing.
  //
  // A write is not atomic, so a read can land mid-write and get half a file;
  // the compiled-in copy is the answer then, and is at worst as stale as the
  // list used to be between restarts.
  const levelData = (spec: { data: RawLevelData; file?: string }): RawLevelData => {
    if (!spec.file) return spec.data;
    try {
      return JSON.parse(
        readFileSync(join(import.meta.dirname, "levels", `${spec.file}.json`), "utf8"),
      ) as RawLevelData;
    } catch {
      return spec.data;
    }
  };

  // One table of files for every level, since levels share surfaces and this is
  // markup that ships on every page load. ~2 KB gzipped for the whole registry.
  const build = (): string => {
    const index = new Map<string, number>();
    const files: [string, number][] = [];
    const levels: Record<string, { b: 0 | 1; i: number[]; t: string; k: 0 | 1 | 2 }> = {};
    // Which levels the menu offers and what it calls them, resolved HERE for
    // the same reason the file list is: the menu is painted by the inlined
    // store before the app exists, and on a bare `/` the app is never loaded
    // at all - so reading `meta` out of `registry.ts` at runtime would mean
    // downloading the level graph to draw a list of six words.
    //
    // Off the level as it is ON DISK RIGHT NOW (`levelData`) rather than off
    // the copy compiled into this config, so a title typed into the editor's
    // Level panel is on the menu at the next page load rather than at the next
    // server restart. It is `listedLevels()`'s rule applied to those bytes -
    // file-backed ball levels that do not say `unlisted` - which is why the
    // condition is spelled out here rather than the function called: the
    // function reads the compiled-in copy, and the two would disagree for
    // exactly as long as an edit was unsaved.
    for (const [id, spec] of Object.entries(LEVELS)) {
      const meta = levelData(spec).meta;
      const listed = spec.controller === "ball" && !!spec.file && !meta?.unlisted;
      levels[id] = {
        b: spec.controller === "ball" ? 1 : 0,
        t: meta?.title ?? id,
        k: !listed ? 0 : meta?.intro ? 2 : 1,
        i: levelStoredFiles(levelData(spec), spec.controller).map((f) => {
          let at = index.get(f.file);
          if (at === undefined) {
            at = files.push([f.file, f.bytes]) - 1;
            index.set(f.file, at);
          }
          return at;
        }),
      };
    }
    // The tree stamp and the level hashes ride along too, because the LEVEL
    // SELECT can leave feedback (its `rate` link) and a page that never loads
    // the app cannot import `virtual:tree-stamp` or `virtual:level-hashes` to
    // find out what it is serving. Cheap: a commit, a flag and one 12-hex hash
    // per file-backed level.
    const stamp = treeStamp(import.meta.dirname, git);
    const hashes: Record<string, string> = {};
    for (const [id, spec] of Object.entries(LEVELS)) {
      if (spec.file) hashes[id] = levelFileHash(import.meta.dirname, spec.file);
    }
    return JSON.stringify({
      f: files,
      l: levels,
      d: DEFAULT_LEVEL,
      c: stamp.commit,
      y: stamp.dirty ? 1 : 0,
      s: stamp.srcHash,
      h: hashes,
    });
  };

  // Compiled once per config load. `bundle: true` is what turns the module's
  // `export {}` and its types into a self-contained classic script; it has no
  // imports, so there is nothing for the bundler to pull in with it.
  const script = (minify: boolean): string =>
    buildSync({
      entryPoints: [join(import.meta.dirname, "src", "render3d", "store.ts")],
      bundle: true,
      format: "iife",
      target: "es2020",
      minify,
      write: false,
    }).outputFiles[0]!.text;

  // Cached for a BUILD only. A dev server lives for hours, and a compile cached
  // for its lifetime meant an edit to store.ts never reached the page - the one
  // file on the page that vite is not watching, because it is not in the module
  // graph. Recompiling per page load is ~10 ms of esbuild on a file with no
  // imports.
  let compiled: string | null = null;
  let isBuild = false;

  return {
    name: "store-script",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    transformIndexHtml: {
      order: "pre",
      handler(_html, ctx) {
        const tags: HtmlTagDescriptor[] = [];
        // The list first: the store reads it on the line that runs it.
        if (ctx.path.endsWith("/index.html") || ctx.path === "/") {
          tags.push({
            tag: "script",
            attrs: { id: "preload-manifest", type: "application/json" },
            // Not executable, so a `</script>` inside a filename could not close
            // it early anyway - but the escape is free and the data comes off
            // disk.
            children: build().replace(/</g, "\\u003c"),
            injectTo: "head",
          });
        }
        if (isBuild) compiled ??= script(true);
        tags.push({ tag: "script", children: compiled ?? script(false), injectTo: "head" });
        return tags;
      },
    },
  };
}

export default defineConfig({
  server: {
    port: 3100,
    watch: {
      // LEVEL FILES ARE NOT WATCHED AT ALL, and this is what stops the editor's
      // autosave from restarting the dev server every 750 ms.
      //
      // `levels/*.json` is imported by `src/level/registry.ts`, which this
      // config imports for the preload list - so every level file is one of
      // vite's `configFileDependencies`, and a write to a config dependency is
      // a FULL SERVER RESTART (see `handleHMRUpdate`), decided before any
      // plugin's `handleHotUpdate` is consulted. There is no hook that can
      // decline it; the only lever is not delivering the event.
      //
      // Nothing wants the event either way: a level is read at page load, the
      // editor holds the authoritative copy in memory and saves THROUGH
      // /api/levels, and the preload list re-reads the file off disk per page
      // load (see `storeScript`). Reload by hand to pick up a level edit.
      ignored: ["**/levels/*.json", "**/public/generated-roots/**", "**/public/generated-boulders/**", "**/public/generated-dirt-moss/**", "**/public/generated-vines/**", "**/public/generated-mushrooms/**", "**/public/generated-grass/**", "**/public/generated-plants/**"],
    },
    // The playtest store lives in serve.ts, not in Vite. With `bun run serve.ts`
    // beside the dev server, `?record=1` streams into it and /admin shows it.
    proxy: {
      "/api/playtest": "http://localhost:8080",
      "/admin": "http://localhost:8080",
    },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: join(import.meta.dirname, "index.html"),
        editor: join(import.meta.dirname, "editor.html"),
      },
      output: {
        // Rollup names a shared chunk after one arbitrary module inside it, and
        // the arbitrary one it picked became `virtual:tree-stamp` — a three-line
        // module lending its name to the 880 kB the two pages have in common,
        // which is a lie anyone reading a bundle-size listing has to unpick.
        // Named for what it is instead.
        chunkFileNames: (chunk) =>
          chunk.isEntry || !chunk.name.startsWith("_virtual")
            ? "assets/[name]-[hash].js"
            : "assets/shared-[hash].js",
      },
    },
  },
  plugins: [
    rootGenerator(),
    boulderGenerator(),
    dirtMossGenerator(),
    vineGenerator(),
    mushroomGenerator(),
    grassGenerator(),
    plantGenerator(),
    treeStampPlugin(),
    levelHashesPlugin(),
    storeScript(),
    levelApi(),
    prodReplays(),
    editorRoute(),
  ],
});
