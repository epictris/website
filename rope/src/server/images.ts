// The editor's picture upload (dev only): `POST /api/images?name=<file name>`
// with the file's bytes as the body.
//
// It is the whole of adding a picture, in one step: optimised to WebP through
// ImageMagick (the tool the texture pipeline already needs), hashed, written to
// `public/images/<key>.webp` and pinned in `src/render3d/imageAssets.json` with
// its size, pixel dimensions and provenance, and CREDITS.md regenerated so
// `cli assets` stays green. What it does not do is upload to the release store:
// that is `bun run assets:publish-images` (in `just publish`), run before the
// level that shows the picture is committed, as for generated meshes.
//
// The key is the file's name slugged plus the first 8 hex of the optimised
// bytes' sha256, so an upload never overwrites anything: a re-painted picture
// is a new key, and an older commit's key still names the bytes it was
// written against. Uploading the same picture twice lands on the same key.

import type { IncomingMessage, ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { IMAGE_ASSETS, IMAGES_DIR, imageFile, registerImageAsset, type ImageAsset } from "../render3d/images";
import { CREDITS_PATH, renderCredits } from "../../scripts/credits";

// The longest side a picture is stored at. A backdrop is seen across the whole
// frame, so it wants more than the 1k a tiling map is capped at; 4096 is the
// texture size every WebGL2 device is required to take.
const MAX_SIDE = 4096;
// Lossy, like an albedo (see `assets:optimize-texture`): a picture is a picture.
const QUALITY = 90;
// A raw upload larger than this is not a picture anybody meant to ship.
const BODY_LIMIT = 64 * 1024 * 1024;

export const IMAGE_MANIFEST = "src/render3d/imageAssets.json";

export function imageService(): Plugin {
  return {
    name: "image-service",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/images", (req, res) => {
        if (req.method === "GET") return send(res, 200, IMAGE_ASSETS);
        if (req.method !== "POST") return send(res, 405, { error: "Use GET or POST." });
        if (!sameOrigin(req)) return send(res, 403, { error: "Upload from this editor's origin." });
        const name = new URL(req.url ?? "/", "http://x").searchParams.get("name") ?? "image";
        readBytes(req).then(
          (bytes) => {
            try {
              send(res, 200, ingest(server, name, bytes));
            } catch (e) {
              send(res, 400, { error: e instanceof Error ? e.message : String(e) });
            }
          },
          (e) => send(res, 400, { error: String(e) }),
        );
      });

      // Served here rather than by vite's public handler, which knows only the
      // files its watcher has seen - and `public/images/` is kept off the
      // watcher, so a picture uploaded after the server started would be
      // answered with the page. `immutable`, because a key names one picture
      // for ever.
      server.middlewares.use(IMAGES_DIR, (req, res, next) => {
        const name = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
        if (!/^[a-z0-9-]+\.webp$/.test(name) || (req.method !== "GET" && req.method !== "HEAD")) return next();
        const file = join(server.config.root, "public", IMAGES_DIR.slice(1), name);
        stat(file).then(
          (info) => {
            res.setHeader("Content-Type", "image/webp");
            res.setHeader("Content-Length", info.size);
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            if (req.method === "HEAD") res.end();
            else createReadStream(file).on("error", () => res.destroy()).pipe(res);
          },
          () => {
            res.statusCode = 404;
            res.end("Picture not found; `bun run assets:fetch`, or upload it again in the editor");
          },
        );
      });
    },
  };
}

function ingest(server: ViteDevServer, name: string, bytes: Buffer): { key: string; asset: ImageAsset } {
  const root = server.config.root;
  if (spawnSync("which", ["magick"]).status !== 0) {
    throw new Error("ImageMagick (`magick`) is required to add a picture; install it and retry.");
  }
  const scratch = mkdtempSync(join(tmpdir(), "image-upload-"));
  try {
    const raw = join(scratch, "raw");
    const out = join(scratch, "out.webp");
    writeFileSync(raw, bytes);
    const convert = spawnSync(
      "magick",
      [raw, "-auto-orient", "-strip", "-resize", `${MAX_SIDE}x${MAX_SIDE}>`, "-quality", String(QUALITY), out],
      { encoding: "utf8" },
    );
    if (convert.status !== 0) throw new Error(`not a picture ImageMagick can read: ${convert.stderr.trim()}`);
    const info = spawnSync("magick", ["identify", "-format", "%w %h %[opaque]", out], { encoding: "utf8" });
    const [w, h, opaque] = info.stdout.trim().split(" ");
    const optimised = readFileSync(out);
    const sha256 = createHash("sha256").update(optimised).digest("hex");
    // The same picture uploaded again, under any file name, is the entry it
    // already has: two keys for one set of bytes is two things to publish and
    // credit that are the same thing.
    // Its file is written back if it has gone (an unfetched checkout, a
    // cleaned `public/`), which the upload is the bytes for.
    const same = Object.entries(IMAGE_ASSETS).find(([, a]) => a.sha256 === sha256);
    if (same) {
      const dest = join(root, "public", same[1].file.replace(/^\//, ""));
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, optimised);
      }
      return { key: same[0], asset: same[1] };
    }
    const key = `${slug(name)}-${sha256.slice(0, 8)}`;

    const asset: ImageAsset = {
      file: imageFile(key),
      sha256,
      bytes: optimised.length,
      width: Number(w),
      height: Number(h),
      ...(opaque === "False" ? { alpha: true } : {}),
      source: `uploaded in the editor (${name})`,
      author: gitUser(root),
      license: "own work",
    };
    const dest = join(root, "public", asset.file.replace(/^\//, ""));
    mkdirSync(dirname(dest), { recursive: true });
    // Written, not renamed: the scratch directory is usually on another
    // filesystem (tmpfs), which a rename cannot cross.
    writeFileSync(dest, optimised);
    registerImageAsset(key, asset);
    writeManifest(server, root);
    writeFileSync(CREDITS_PATH, renderCredits());
    server.config.logger.info(`[images] ${name} -> ${asset.file} (${w}x${h}, ${(asset.bytes / 1024).toFixed(0)} KB)`);
    return { key, asset };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Sorted by key, so two uploads in either order write the same file.
function writeManifest(server: ViteDevServer, root: string): void {
  const path = join(root, IMAGE_MANIFEST);
  const sorted: Record<string, ImageAsset> = {};
  for (const key of Object.keys(IMAGE_ASSETS).sort()) sorted[key] = IMAGE_ASSETS[key]!;
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
  // The manifest is outside vite's watcher (see `server.watch.ignored`: it is a
  // config dependency, and a write to one restarts the server), so the module
  // graph is told by hand, for the next page load. The open editor already has
  // the entry: it registered the one this request returned.
  for (const env of Object.values(server.environments)) {
    for (const mod of env.moduleGraph.getModulesByFile(path) ?? []) env.moduleGraph.invalidateModule(mod);
  }
}

function slug(name: string): string {
  const stem = name.replace(/\.[^.]*$/, "");
  const s = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "image";
}

function gitUser(root: string): string {
  const r = spawnSync("git", ["config", "user.name"], { cwd: root, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : "unknown";
}

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > BODY_LIMIT) throw new Error(`upload larger than ${BODY_LIMIT / (1024 * 1024)} MB`);
    chunks.push(chunk);
  }
  if (!total) throw new Error("empty upload");
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sameOrigin(req: IncomingMessage): boolean {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}
