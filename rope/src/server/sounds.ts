// The editor's sound library and bank (dev only; docs/sound.md#the-sounds-menu).
//
//   GET    /api/sounds                 -> { assets, bank }
//   POST   /api/sounds?name=<file>     <- the file's bytes; -> { key, asset }
//   PUT    /api/sounds/bank            <- the bank (slots and clip edits)
//   PATCH  /api/sounds/assets/<key>    <- { source, author, license }
//   DELETE /api/sounds/assets/<key>    (refused while an event plays it)
//   GET    /sounds/<key>.ogg           the file itself
//
// An upload is the whole of adding a sound, in one step: transcoded by ffmpeg
// to mono Opus at 48 kHz with any leading silence cut (a game sound that
// starts late sounds late), hashed, written to `public/sounds/<key>.ogg` and
// pinned in `src/audio/soundAssets.json` with its size and length, and
// CREDITS.md regenerated. What it does not do is upload to the release store:
// that is `just publish` (`assets:publish-stored`, which uploads every pinned
// file the release does not hold yet), run before committing.
//
// The key is the file's name slugged plus the first 8 hex of the transcoded
// bytes' sha256, so an upload never overwrites anything, and the same file
// uploaded twice lands on the same key.
//
// Both manifests are read from DISK on every request, never imported: this
// module is loaded by vite.config.ts, and an import would be a copy from
// whenever the server started.

import type { IncomingMessage, ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { CREDITS_PATH, renderCredits } from "../../scripts/credits";
import { SOUNDS_DIR, soundFile, type SoundAsset } from "../audio/library";
import { allSlotKeys, assignedSounds, cleanClip, type SoundBank } from "../audio/slots";

export const SOUND_ASSETS_PATH = "src/audio/soundAssets.json";
export const SOUND_BANK_PATH = "src/audio/soundBank.json";

// A raw upload larger than this is not a sound effect anybody meant to ship.
const BODY_LIMIT = 64 * 1024 * 1024;
// Opus at this rate is transparent for effects and about 12 KB a second.
const BITRATE = "96k";

export function soundService(): Plugin {
  return {
    name: "sound-service",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use("/api/sounds", (req, res) => {
        const path = (req.url ?? "/").split("?")[0]!;
        if (!sameOrigin(req)) return send(res, 403, { error: "Edit sounds from this editor's origin." });
        try {
          if (req.method === "GET" && path === "/") {
            return send(res, 200, { assets: readAssets(root), bank: readBank(root) });
          }
          if (req.method === "POST" && path === "/") {
            const query = new URL(req.url ?? "/", "http://x").searchParams;
            const name = query.get("name") ?? "sound";
            readBytes(req).then(
              (bytes) => {
                try {
                  send(res, 200, ingest(server, name, bytes, query.get("keepLeading") === "true", query.get("stereo") === "true"));
                } catch (e) {
                  send(res, 400, { error: e instanceof Error ? e.message : String(e) });
                }
              },
              (e) => send(res, 400, { error: String(e) }),
            );
            return;
          }
          if (req.method === "PUT" && path === "/bank") {
            readBytes(req).then(
              (bytes) => {
                try {
                  const bank = validBank(JSON.parse(bytes.toString("utf8")), readAssets(root));
                  writeJson(server, join(root, SOUND_BANK_PATH), bank);
                  send(res, 200, { ok: true });
                } catch (e) {
                  send(res, 400, { error: e instanceof Error ? e.message : String(e) });
                }
              },
              (e) => send(res, 400, { error: String(e) }),
            );
            return;
          }
          const m = /^\/assets\/([a-z0-9-]+)$/.exec(path);
          if (m) {
            const key = m[1]!;
            const assets = readAssets(root);
            const asset = assets[key];
            if (!asset) return send(res, 404, { error: `no sound "${key}"` });
            if (req.method === "PATCH") {
              readBytes(req).then(
                (bytes) => {
                  try {
                    const body = JSON.parse(bytes.toString("utf8")) as Partial<SoundAsset>;
                    for (const field of ["source", "author", "license"] as const) {
                      if (typeof body[field] === "string") asset[field] = body[field]!.trim();
                    }
                    writeAssets(server, root, assets);
                    send(res, 200, { key, asset });
                  } catch (e) {
                    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
                  }
                },
                (e) => send(res, 400, { error: String(e) }),
              );
              return;
            }
            if (req.method === "DELETE") {
              if (assignedSounds(readBank(root)).has(key)) {
                return send(res, 409, { error: `"${key}" is still assigned to an event; unassign it first` });
              }
              delete assets[key];
              writeAssets(server, root, assets);
              // Its clip edit goes with it: it was how this file played.
              const bank = readBank(root);
              if (bank.clips?.[key]) {
                delete bank.clips[key];
                if (!Object.keys(bank.clips).length) delete bank.clips;
                writeJson(server, join(root, SOUND_BANK_PATH), bank);
              }
              rmSync(join(root, "public", asset.file.replace(/^\//, "")), { force: true });
              return send(res, 200, { ok: true });
            }
          }
          return send(res, 405, { error: "method not allowed" });
        } catch (e) {
          return send(res, 500, { error: String(e) });
        }
      });

      // Served here rather than by vite's public handler, which knows only the
      // files its watcher has seen - and `public/sounds/` is kept off the
      // watcher, so a sound uploaded after the server started would be answered
      // with the page. `immutable`, because a key names one recording for ever.
      server.middlewares.use(SOUNDS_DIR, (req, res, next) => {
        const name = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
        if (!/^[a-z0-9-]+\.ogg$/.test(name) || (req.method !== "GET" && req.method !== "HEAD")) return next();
        const file = join(root, "public", SOUNDS_DIR.slice(1), name);
        stat(file).then(
          (info) => {
            res.setHeader("Content-Type", "audio/ogg");
            res.setHeader("Content-Length", info.size);
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            if (req.method === "HEAD") res.end();
            else createReadStream(file).on("error", () => res.destroy()).pipe(res);
          },
          () => {
            res.statusCode = 404;
            res.end("Sound not found; `bun run assets:fetch`, or upload it again in the editor");
          },
        );
      });
    },
  };
}

function readAssets(root: string): Record<string, SoundAsset> {
  const path = join(root, SOUND_ASSETS_PATH);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, SoundAsset>) : {};
}

function readBank(root: string): SoundBank {
  const path = join(root, SOUND_BANK_PATH);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SoundBank) : { slots: {} };
}

// The bank as the menu sent it, held to what exists: only slots the game has,
// only files the library has, and numbers that are numbers. A slot left with
// nothing in it is dropped, so the file holds what was chosen and no more.
function validBank(raw: unknown, assets: Record<string, SoundAsset>): SoundBank {
  const slots = (raw as SoundBank | null)?.slots;
  if (!slots || typeof slots !== "object") throw new Error("expected { slots: { ... } }");
  const known = new Set(allSlotKeys());
  const out: SoundBank = { slots: {} };
  for (const key of Object.keys(slots).sort()) {
    if (!known.has(key)) throw new Error(`no such event "${key}"`);
    const s = slots[key]!;
    const sounds = (s.sounds ?? []).filter((k) => typeof k === "string");
    for (const k of sounds) if (!assets[k]) throw new Error(`"${key}" names "${k}", which is not in the library`);
    const slot: SoundBank["slots"][string] = {};
    if (sounds.length) slot.sounds = sounds;
    for (const field of ["volume", "refSpeed", "pitchJitter", "pitchFollow", "paceFollow"] as const) {
      const v = s[field];
      if (typeof v === "number" && Number.isFinite(v)) slot[field] = v;
    }
    if (Object.keys(slot).length) out.slots[key] = slot;
  }
  // Clip edits, held to the library and to the file's length; one that
  // changes nothing is dropped.
  const clips = (raw as SoundBank).clips ?? {};
  if (typeof clips !== "object") throw new Error("expected clips: { ... }");
  for (const key of Object.keys(clips).sort()) {
    const asset = assets[key];
    if (!asset) throw new Error(`a clip edit names "${key}", which is not in the library`);
    const clip = cleanClip(clips[key]!, asset.seconds);
    if (clip) (out.clips ??= {})[key] = clip;
  }
  return out;
}

function ingest(server: ViteDevServer, name: string, bytes: Buffer, keepLeading = false, stereo = false): { key: string; asset: SoundAsset } {
  const root = server.config.root;
  if (spawnSync("which", ["ffmpeg"]).status !== 0) {
    throw new Error("ffmpeg is required to add a sound; install it and retry.");
  }
  const scratch = mkdtempSync(join(tmpdir(), "sound-upload-"));
  try {
    const raw = join(scratch, "raw");
    const out = join(scratch, "out.ogg");
    writeFileSync(raw, bytes);
    const convert = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-i", raw,
        ...(keepLeading ? [] : ["-af", "silenceremove=start_periods=1:start_threshold=-60dB"]),
        "-ac", stereo ? "2" : "1", "-ar", "48000", "-c:a", "libopus", "-b:a", BITRATE,
        // Bit-exact: Ogg gives every stream a RANDOM serial number, so without
        // this the same file transcodes to different bytes every time and the
        // dedupe below (and the key's promise of one recording) never holds.
        "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-y", out,
      ],
      { encoding: "utf8" },
    );
    if (convert.status !== 0 || !existsSync(out)) {
      throw new Error(`not a sound ffmpeg can read: ${convert.stderr.trim().split("\n").pop() ?? ""}`);
    }
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
      { encoding: "utf8" },
    );
    const seconds = Number(probe.stdout.trim());
    if (!(seconds > 0)) throw new Error("the sound is silent, or empty once its leading silence is cut");
    const encoded = readFileSync(out);
    const sha256 = createHash("sha256").update(encoded).digest("hex");
    const assets = readAssets(root);
    // The same sound uploaded again, under any name, is the entry it already
    // has; its file is written back if it has gone (an unfetched checkout).
    const same = Object.entries(assets).find(([, a]) => a.sha256 === sha256);
    if (same) {
      const dest = join(root, "public", same[1].file.replace(/^\//, ""));
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, encoded);
      }
      return { key: same[0], asset: same[1] };
    }
    const key = `${slug(name)}-${sha256.slice(0, 8)}`;
    const asset: SoundAsset = {
      file: soundFile(key),
      sha256,
      bytes: encoded.length,
      seconds: Math.round(seconds * 1000) / 1000,
      name,
      // Left for the menu to ask: an upload cannot know where a downloaded
      // file came from or under what licence, and a guess here would be a
      // credit that is wrong rather than one that is missing. `cli assets`
      // fails until all three are filled in.
      source: "",
      author: "",
      license: "",
    };
    const dest = join(root, "public", asset.file.replace(/^\//, ""));
    mkdirSync(dirname(dest), { recursive: true });
    // Written, not renamed: the scratch directory is usually on another
    // filesystem (tmpfs), which a rename cannot cross.
    writeFileSync(dest, encoded);
    assets[key] = asset;
    writeAssets(server, root, assets);
    server.config.logger.info(`[sounds] ${name} -> ${asset.file} (${seconds.toFixed(2)} s, ${(asset.bytes / 1024).toFixed(0)} KB)`);
    return { key, asset };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function writeAssets(server: ViteDevServer, root: string, assets: Record<string, SoundAsset>): void {
  const sorted: Record<string, SoundAsset> = {};
  for (const key of Object.keys(assets).sort()) sorted[key] = assets[key]!;
  writeJson(server, join(root, SOUND_ASSETS_PATH), sorted);
  writeFileSync(CREDITS_PATH, renderCredits());
}

// Pretty, sorted by the caller, and written only when it changed. Both files
// are off vite's watcher (a write must not reload an open editor - see
// `server.watch.ignored`), so the module graph is told by hand, for the next
// page load; open pages hear of it from the menu (`broadcastSounds`).
function writeJson(server: ViteDevServer, path: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
  // The bank can also be edited by offline authoring tools. A same-value PUT
  // must still invalidate Vite's cached JSON; disk equality says nothing about
  // what the module graph currently serves to a newly opened page.
  for (const env of Object.values(server.environments)) {
    for (const mod of env.moduleGraph.getModulesByFile(path) ?? []) env.moduleGraph.invalidateModule(mod);
  }
}

function slug(name: string): string {
  const stem = name.replace(/\.[^.]*$/, "");
  const s = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 40) || "sound";
}

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > BODY_LIMIT) throw new Error(`upload larger than ${BODY_LIMIT / (1024 * 1024)} MB`);
    chunks.push(chunk);
  }
  if (!total) throw new Error("empty body");
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
