// HTTP in front of the store: the open ingest route the page posts to, the
// admin API the admin page and `cli pull` read, and the admin page itself.
//
// Nothing here authenticates. Ingest is open on purpose (the friends playing
// have a URL and nothing else), and everything under `/admin` and
// `/api/playtest/admin/` is behind Caddy's basic_auth (see ../../Caddyfile),
// which is the one place a password lives. The rope container has no published
// port, so a request that reaches this code has come through Caddy.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_API, INGEST_PATH, MAX_BODY_BYTES } from "../playtest/protocol";
import { FEEDBACK_PATH } from "../playtest/feedback";
import type { PlaytestStore } from "./store";

const PID_COOKIE = "pid";
// 400 days, the longest Chrome allows, refreshed on every response.
const PID_MAX_AGE = 400 * 24 * 60 * 60;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

// The `pid` cookie, as a response header. HttpOnly, so the page cannot read or
// forge it, and refreshed on every response so an active player never ages out
// of their own identity. `Secure` only where the request actually arrived over
// HTTPS - a local `bun run serve.ts` is plain HTTP and a Secure cookie there is
// one the browser silently drops.
function pidCookie(pid: string, req: Request, url: URL): Record<string, string> {
  if (!pid) return {};
  const secure =
    url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  return {
    "set-cookie": `${PID_COOKIE}=${pid}; Path=/; Max-Age=${PID_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
  };
}

function cookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// Caddy sets X-Forwarded-For to the connecting client and strips the header
// from untrusted incoming requests, so the first entry is the client. Direct
// connections (a local `bun run serve.ts`) have no header and no forwarded
// address worth more than the socket's.
function clientIp(req: Request, socketIp: string | null): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return socketIp ?? "unknown";
}

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await req.text();
  return text.length > MAX_BODY_BYTES ? null : text;
}

export interface RouteContext {
  store: PlaytestStore;
  socketIp: string | null;
  adminHtml: string;
}

// Returns null for a request that is not the store's, so the caller serves the
// game as before.
export async function handlePlaytest(req: Request, ctx: RouteContext): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  // The two OPEN routes: runs stream into one and ratings post to the other.
  // Both mint and refresh the same `pid` cookie, which is what makes a player's
  // runs and their ratings one player - so the response headers are built once,
  // here, rather than copied.
  if (path === INGEST_PATH || path === FEEDBACK_PATH) {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    const body = await readBody(req);
    if (body === null) return json(413, { error: `body over ${MAX_BODY_BYTES} bytes` });
    const ip = clientIp(req, ctx.socketIp);
    const pid = cookie(req, PID_COOKIE);
    const r =
      path === INGEST_PATH
        ? ctx.store.ingest(body, ip, pid)
        : ctx.store.feedback(body, ip, pid);
    return json(r.status, r.body, pidCookie(r.pid, req, url));
  }

  if (path === "/admin" || path === "/admin/") {
    return new Response(ctx.adminHtml, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!path.startsWith(ADMIN_API + "/")) return null;
  const parts = path.slice(ADMIN_API.length + 1).split("/").map(decodeURIComponent);
  const store = ctx.store;

  if (parts[0] === "index" && parts.length === 1 && req.method === "GET") {
    return json(200, store.adminIndex());
  }

  // Every rating, newest first, with the players so the page can show names
  // rather than uuids. Whole rather than paged for the reason the store reads
  // the file whole: this is a handful of friends, and a line is ~300 bytes.
  if (parts[0] === "feedback" && parts.length === 1 && req.method === "GET") {
    return json(200, {
      feedback: store.readFeedback().sort((a, b) => b.at - a.at),
      players: store.adminIndex().players,
      here: store.adminIndex().here,
    });
  }

  if (parts[0] === "runs" && parts[1]) {
    const id = parts[1];
    if (!store.hasRun(id)) return json(404, { error: "no such run" });
    if (req.method === "GET" && parts.length === 2) {
      return new Response(store.readRun(id), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (req.method === "GET" && parts[2] === "gz") {
      return new Response(store.readRunGz(id) as unknown as BodyInit, {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${id}.json.gz"`,
          "cache-control": "no-store",
        },
      });
    }
    if (req.method === "DELETE" && parts.length === 2) {
      return json(200, { deleted: store.deleteRun(id) });
    }
    if (req.method === "PATCH" && parts.length === 2) {
      const patch = (await req.json().catch(() => null)) as { starred?: boolean; note?: string } | null;
      if (!patch || typeof patch !== "object") return json(400, { error: "body is not an object" });
      return json(200, store.annotate(id, patch));
    }
    return json(405, { error: "method not allowed" });
  }

  if (parts[0] === "players" && parts[1]) {
    const id = parts[1];
    if (req.method === "PATCH" && parts.length === 2) {
      const patch = (await req.json().catch(() => null)) as { name?: string | null } | null;
      if (!patch || typeof patch !== "object") return json(400, { error: "body is not an object" });
      const p = store.renamePlayer(id, patch.name ?? null);
      return p ? json(200, p) : json(404, { error: "no such player" });
    }
    if (req.method === "POST" && parts[2] === "merge") {
      const body = (await req.json().catch(() => null)) as { from?: string } | null;
      if (!body || typeof body.from !== "string") return json(400, { error: "body is {from}" });
      const p = store.mergePlayers(id, body.from);
      return p ? json(200, p) : json(404, { error: "no such player" });
    }
    if (req.method === "DELETE" && parts.length === 2) {
      const n = store.deletePlayer(id);
      return n < 0 ? json(404, { error: "no such player" }) : json(200, { deletedRuns: n });
    }
    return json(405, { error: "method not allowed" });
  }

  return json(404, { error: "not found" });
}

export function adminHtmlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "admin.html");
}
