// Pool game server: static file host + WebSocket relay with rooms.
//
// The server is a dumb relay + presence tracker. It never runs physics.
// Both clients run the same deterministic engine, so we only need to
// forward shot parameters and live-aim presence between peers in a room.
//
// Slot assignment: the first socket in a room is player 0 ("host"), the
// second is player 1. Any further sockets are spectators (slot >= 2).

import { file } from "bun";
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const DIST = join(import.meta.dir, "client", "dist");

type SocketData = {
  room: string;
  id: string;
  slot: number;
};

type Room = {
  sockets: Set<Bun.ServerWebSocket<SocketData>>;
  /** Monotonic counter so a rejoining peer keeps taking the next free slot. */
  nextSlot: number;
};

const rooms = new Map<string, Room>();

function getRoom(code: string): Room {
  let room = rooms.get(code);
  if (!room) {
    room = { sockets: new Set(), nextSlot: 0 };
    rooms.set(code, room);
  }
  return room;
}

/** Lowest free slot in [0,1], else next spectator index. */
function assignSlot(room: Room): number {
  const taken = new Set([...room.sockets].map((s) => s.data.slot));
  for (let i = 0; i < 2; i++) if (!taken.has(i)) return i;
  return Math.max(2, room.nextSlot++);
}

function peers(room: Room): { slot: number; id: string }[] {
  return [...room.sockets].map((s) => ({ slot: s.data.slot, id: s.data.id }));
}

function broadcast(
  room: Room,
  payload: unknown,
  except?: Bun.ServerWebSocket<SocketData>,
) {
  const msg = JSON.stringify(payload);
  for (const s of room.sockets) if (s !== except) s.send(msg);
}

const server = Bun.serve<SocketData, undefined>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const code = url.searchParams.get("id") ?? "lobby";
      const id = crypto.randomUUID();
      const ok = server.upgrade(req, { data: { room: code, id, slot: -1 } });
      if (ok) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/healthz") return new Response("ok");

    // Static file serving with SPA fallback to index.html.
    const safe = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    const asset = file(join(DIST, safe));
    if (safe !== "/" && (await asset.exists())) {
      return new Response(asset);
    }
    return new Response(file(join(DIST, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
  websocket: {
    open(ws) {
      const room = getRoom(ws.data.room);
      ws.data.slot = assignSlot(room);
      room.sockets.add(ws);

      // Tell the newcomer who they are and who is already here.
      ws.send(
        JSON.stringify({
          t: "hello",
          slot: ws.data.slot,
          id: ws.data.id,
          peers: peers(room).filter((p) => p.id !== ws.data.id),
        }),
      );
      // Tell everyone else a peer joined (host will answer with a state sync).
      broadcast(
        room,
        { t: "peer-join", slot: ws.data.slot, id: ws.data.id },
        ws,
      );
    },
    message(ws, message) {
      const room = rooms.get(ws.data.room);
      if (!room) return;
      // Relay verbatim; tag the sender slot so clients can attribute presence.
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(String(message));
      } catch {
        return;
      }
      obj.from = ws.data.slot;
      // Directed messages (obj.to === slot) go to one peer; else broadcast.
      const raw = JSON.stringify(obj);
      for (const s of room.sockets) {
        if (s === ws) continue;
        if (obj.to !== undefined && s.data.slot !== obj.to) continue;
        s.send(raw);
      }
    },
    close(ws) {
      const room = rooms.get(ws.data.room);
      if (!room) return;
      room.sockets.delete(ws);
      if (room.sockets.size === 0) {
        rooms.delete(ws.data.room);
        return;
      }
      broadcast(room, { t: "peer-leave", slot: ws.data.slot, id: ws.data.id });
    },
  },
});

console.log(`pool server on :${server.port} (static: ${DIST})`);
