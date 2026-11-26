// Models in dev: `public/models/<model>/{model.glb,meta.json}` served by hand
// (see docs/blender-models.md), and `GET /api/models`, the models exported here
// or pinned, which the editor offers.
//
// Served here rather than by vite's public handler for the reason the pictures
// and the generated meshes are: that handler knows only the files its watcher
// has seen at startup, and the directory is kept off the watcher so an export
// landing while the editor is open reaches no HMR - so a model exported after
// the server started would otherwise be answered with the page. And NOT
// cached, unlike those: a model is re-exported in place for as long as it is
// being worked on, and the loop is "run `just model`, refresh", which a cached
// mesh would turn into "refresh, see the old one, wonder".

import { createReadStream, existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Connect, Plugin } from "vite";
import { MODEL_ASSETS, MODEL_MESH_FILE, MODEL_META_FILE, MODEL_NAME, MODELS_API, MODELS_DIR } from "../render3d/models";

const MODEL_FILES: Record<string, string> = {
  [MODEL_MESH_FILE]: "model/gltf-binary",
  [MODEL_META_FILE]: "application/json",
};

function modelFiles(root: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const [model, file, ...rest] = (req.url ?? "").split("?")[0]!.replace(/^\//, "").split("/");
    if (!model || !file || rest.length || !MODEL_NAME.test(model) || !MODEL_FILES[file]) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const path = join(root, "public", MODELS_DIR.slice(1), model, file);
    stat(path).then(
      (info) => {
        res.setHeader("Content-Type", MODEL_FILES[file]!);
        res.setHeader("Content-Length", info.size);
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "HEAD") res.end();
        else createReadStream(path).on("error", () => res.destroy()).pipe(res);
      },
      () => {
        res.statusCode = 404;
        res.end(`Model "${model}" is not exported here; \`just model ${model}\`, or \`bun run assets:fetch\` for a published one`);
      },
    );
  };
}

export function modelService(): Plugin {
  return {
    name: "model-service",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use(MODELS_DIR, modelFiles(root));
      server.middlewares.use(MODELS_API, (req, res, next) => {
        if (req.method !== "GET" || (req.url ?? "/").split("?")[0] !== "/") return next();
        const dir = join(root, "public", MODELS_DIR.slice(1));
        const exported = existsSync(dir)
          ? readdirSync(dir).filter((m) => MODEL_NAME.test(m) && existsSync(join(dir, m, MODEL_MESH_FILE)))
          : [];
        const names = [...new Set([...exported, ...Object.keys(MODEL_ASSETS)])].sort();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(names));
      });
    },
  };
}
