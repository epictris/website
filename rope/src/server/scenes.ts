// Blender scenes in dev: `public/scenes/<scene>/{scene.glb,meta.json}` served
// by hand (see docs/blender-scenes.md).
//
// Served here rather than by vite's public handler for the reason the pictures
// and the generated meshes are: that handler knows only the files its watcher
// has seen at startup, and `public/scenes/` is kept off the watcher so an export
// landing while the editor is open reaches no HMR - so a scene exported after
// the server started would otherwise be answered with the page. And NOT
// cached, unlike those: a scene is re-exported in place for as long as the
// level is being dressed, and the loop is "run `just scene`, refresh", which a
// cached mesh would turn into "refresh, see the old one, wonder".

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";
import { SCENE_MESH_FILE, SCENE_META_FILE, SCENE_NAME, SCENES_DIR } from "../render3d/scenes";

const TYPES: Record<string, string> = {
  [SCENE_MESH_FILE]: "model/gltf-binary",
  [SCENE_META_FILE]: "application/json",
};

export function sceneService(): Plugin {
  return {
    name: "scene-service",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(SCENES_DIR, (req, res, next) => {
        const [scene, file, ...rest] = (req.url ?? "").split("?")[0]!.replace(/^\//, "").split("/");
        if (!scene || !file || rest.length || !SCENE_NAME.test(scene) || !TYPES[file]) return next();
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const path = join(server.config.root, "public", SCENES_DIR.slice(1), scene, file);
        stat(path).then(
          (info) => {
            res.setHeader("Content-Type", TYPES[file]!);
            res.setHeader("Content-Length", info.size);
            res.setHeader("Cache-Control", "no-store");
            if (req.method === "HEAD") res.end();
            else createReadStream(path).on("error", () => res.destroy()).pipe(res);
          },
          () => {
            res.statusCode = 404;
            res.end(`Scene "${scene}" is not exported here; \`just scene <level>\`, or \`bun run assets:fetch\` for a published one`);
          },
        );
      });
    },
  };
}
