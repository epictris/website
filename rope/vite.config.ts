import { defineConfig, type Plugin } from "vite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
                writeFileSync(fileFor(name), JSON.stringify(parsed, null, 2) + "\n");
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

export default defineConfig({
  server: { port: 3100 },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: join(import.meta.dirname, "index.html"),
        editor: join(import.meta.dirname, "editor.html"),
      },
    },
  },
  plugins: [levelApi(), editorRoute()],
});
