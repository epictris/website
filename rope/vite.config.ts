import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
import { buildSync } from "esbuild";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { treeStamp, type TreeStamp } from "./src/sim/treeStamp";
import { DEFAULT_LEVEL, LEVELS } from "./src/level/registry";
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

function treeStampPlugin(): Plugin {
  const root = import.meta.dirname;
  const git = (args: string[]): string | null => {
    try {
      return execSync(`git ${args.join(" ")}`, { cwd: root, encoding: "utf8" });
    } catch {
      return null;
    }
  };
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
                // them keeps the file's mtime (and the watcher) quiet.
                const unchanged =
                  existsSync(fileFor(name)) && readFileSync(fileFor(name), "utf8") === text;
                if (!unchanged) writeFileSync(fileFor(name), text);
                send(200, { ok: true, name });
              } catch {
                send(400, { error: "invalid JSON body" });
              }
            });
            return;
          }

          if (req.method === "DELETE") {
            if (existsSync(fileFor(name))) rmSync(fileFor(name));
            return send(200, { ok: true });
          }

          return send(405, { error: "method not allowed" });
        } catch (e) {
          return send(500, { error: String(e) });
        }
      });
    },

    // levels/*.json is imported by src/level/registry.ts (levels/ball.json backs
    // the BALL entry), so a plain-JSON change would full-reload every open page.
    // The editor autosaves - reloading it out from under the author on every
    // write is exactly wrong - so level writes are excluded from HMR entirely.
    // A level is only read at page load anyway; reload by hand to pick one up.
    handleHotUpdate(ctx) {
      if (ctx.file.startsWith(dir + "/")) return [];
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
// The list is resolved HERE, at config load, because it is a fact about the
// level files and the asset manifest and both are on disk: a build step cannot
// build a scene, so `levelStoredFiles` answers the same question by walking the
// level data (see render3d/levelAssets.ts, and the drift warning it describes).
//
// `transformIndexHtml` runs in dev serve and in build alike, so the dev server
// and the shipped page carry the same thing. Only `index.html` gets a preload
// list: the editor and `shot.html` build scenes too, but neither is a page
// anybody waits on, and a preload for a level they may not open would be a
// download for nothing.
function storeScript(): Plugin {
  // One table of files for every level, since levels share surfaces and this is
  // markup that ships on every page load. ~2 KB gzipped for the whole registry.
  const build = (): string => {
    const index = new Map<string, number>();
    const files: [string, number][] = [];
    const levels: Record<string, { b: 0 | 1; i: number[] }> = {};
    for (const [id, spec] of Object.entries(LEVELS)) {
      levels[id] = {
        b: spec.controller === "ball" ? 1 : 0,
        i: levelStoredFiles(spec.data).map((f) => {
          let at = index.get(f.file);
          if (at === undefined) {
            at = files.push([f.file, f.bytes]) - 1;
            index.set(f.file, at);
          }
          return at;
        }),
      };
    }
    return JSON.stringify({ f: files, l: levels, d: DEFAULT_LEVEL });
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
  plugins: [treeStampPlugin(), storeScript(), levelApi(), prodReplays(), editorRoute()],
});
