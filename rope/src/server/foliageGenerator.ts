import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";
import { validateSavedFoliage } from "../render3d/foliage/recipe";

export function foliageGenerator(): Plugin {
  return { name: "decorative-foliage", configureServer(server) {
    const root = join(server.config.root, "public/generated-vines");
    server.middlewares.use("/api/foliage", async (req, res) => {
      const send = (status: number, data: unknown) => {
        res.statusCode = status; res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(data));
      };
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET") {
        const id = path.replace(/^\//, "");
        if (!/^[a-f0-9-]{36}$/.test(id)) return send(404, { error: "Plant recipe not found." });
        try { return send(200, JSON.parse(await readFile(join(root, id, "recipe.json"), "utf8"))); }
        catch { return send(404, { error: "Plant recipe not found. Keep recipe.json with the model." }); }
      }
      if (req.method !== "POST" || path && path !== "/") return send(405, { error: "Use POST to save a plant." });
      if (req.headers.origin) {
        try {
          const origin = new URL(req.headers.origin);
          if (origin.host !== req.headers.host || origin.protocol !== "http:") throw new Error();
        } catch { return send(403, { error: "Save plants from this editor's origin." }); }
      }
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { error: "Expected JSON." });
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 24 * 1024 * 1024) return send(413, { error: "Plant and leaf images exceed 24 MB. Use smaller images." });
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        validateSavedFoliage(body.saved);
        if (typeof body.glb !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.glb)) throw new Error("Invalid plant model.");
        const glb = Buffer.from(body.glb, "base64");
        if (glb.length < 20 || glb.length > 16 * 1024 * 1024 || glb.toString("ascii", 0, 4) !== "glTF" ||
            glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length) throw new Error("Invalid or oversized GLB.");
        const id = randomUUID(); const dir = join(root, id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "vine.glb"), glb);
        await writeFile(join(dir, "recipe.json"), JSON.stringify(body.saved));
        send(200, { mesh: `foliage-v1:${id}:${glb.length}` });
      } catch (error) { send(400, { error: error instanceof Error ? error.message : "Could not save plant." }); }
    });
  } };
}
