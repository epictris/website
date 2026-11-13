// Blender scenes and models in dev: `public/scenes/<scene>/{scene.glb,meta.json}`
// and `public/models/<model>/{model.glb,meta.json}` served by hand (see
// docs/blender-scenes.md and docs/blender-models.md), and `GET /api/models`,
// the models exported here or pinned, which the editor offers.
//
// Served here rather than by vite's public handler for the reason the pictures
// and the generated meshes are: that handler knows only the files its watcher
// has seen at startup, and both directories are kept off the watcher so an
// export landing while the editor is open reaches no HMR - so a scene or model
// exported after the server started would otherwise be answered with the page.
// And NOT cached, unlike those: a scene or a model is re-exported in place for
// as long as it is being worked on, and the loop is "run `just scene` (or
// `just model`), refresh", which a cached mesh would turn into "refresh, see
// the old one, wonder".

import { createReadStream, existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Connect, Plugin } from "vite";
import { MODEL_ASSETS, MODEL_MESH_FILE, MODEL_META_FILE, MODEL_NAME, MODELS_API, MODELS_DIR } from "../render3d/models";
import { SCENE_MESH_FILE, SCENE_META_FILE, SCENE_NAME, SCENES_DIR } from "../render3d/scenes";

function exportFiles(
  root: string,
  dir: string,
  name: RegExp,
  files: Record<string, string>,
  missing: (entry: string) => string,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const [entry, file, ...rest] = (req.url ?? "").split("?")[0]!.replace(/^\//, "").split("/");
    if (!entry || !file || rest.length || !name.test(entry) || !files[file]) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const path = join(root, "public", dir.slice(1), entry, file);
    stat(path).then(
      (info) => {
        res.setHeader("Content-Type", files[file]!);
        res.setHeader("Content-Length", info.size);
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "HEAD") res.end();
        else createReadStream(path).on("error", () => res.destroy()).pipe(res);
      },
      () => {
        res.statusCode = 404;
        res.end(missing(entry));
      },
    );
  };
}

export function sceneService(): Plugin {
  return {
    name: "scene-service",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use(
        SCENES_DIR,
        exportFiles(root, SCENES_DIR, SCENE_NAME, { [SCENE_MESH_FILE]: "model/gltf-binary", [SCENE_META_FILE]: "application/json" }, (scene) =>
          `Scene "${scene}" is not exported here; \`just scene <level>\`, or \`bun run assets:fetch\` for a published one`,
        ),
      );
      server.middlewares.use(
        MODELS_DIR,
        exportFiles(root, MODELS_DIR, MODEL_NAME, { [MODEL_MESH_FILE]: "model/gltf-binary", [MODEL_META_FILE]: "application/json" }, (model) =>
          `Model "${model}" is not exported here; \`just model ${model}\`, or \`bun run assets:fetch\` for a published one`,
        ),
      );
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
