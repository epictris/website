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

/** Authoritative game log: the initial rack plus every shot since. Because the
 *  engine is deterministic, replaying this from `init` reproduces the exact live
 *  state — so a rejoining peer (dropped/suspended socket) can rebuild losslessly,
 *  and replays stay complete across disconnects. `null` until a game starts. */
type GameLog = {
  init: { initial: unknown; breaker: unknown; config: unknown };
  shots: unknown[];
};

type Room = {
  sockets: Set<Bun.ServerWebSocket<SocketData>>;
  /** Monotonic counter so a rejoining peer keeps taking the next free slot. */
  nextSlot: number;
  /** When the room was first opened — for sorting the joinable lobby list. */
  created: number;
  /** Retained shot log, re-sent to any (re)joining socket. */
  log: GameLog | null;
};

const rooms = new Map<string, Room>();

function getRoom(code: string): Room {
  let room = rooms.get(code);
  if (!room) {
    room = { sockets: new Set(), nextSlot: 0, created: Date.now(), log: null };
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

    // Lobby: the joinable games — rooms holding exactly one waiting player.
    // Newest first. (CORS-open so the dev client on another port can poll it.)
    if (url.pathname === "/rooms") {
      const list = [...rooms.entries()]
        .filter(([, r]) => r.sockets.size === 1)
        .map(([code, r]) => ({ code, created: r.created }))
        .sort((a, b) => b.created - a.created);
      return Response.json(list, {
        headers: { "access-control-allow-origin": "*" },
      });
    }

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
      // Hand the newcomer the retained game log so it can rebuild losslessly —
      // this covers a rejoin whose socket was suspended and missed live shots.
      if (room.log) {
        ws.send(
          JSON.stringify({
            t: "shot-log",
            initial: room.log.init.initial,
            breaker: room.log.init.breaker,
            config: room.log.init.config,
            shots: room.log.shots,
          }),
        );
      }
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
      // Maintain the retained game log off the relayed stream.
      if (obj.t === "game-init") {
        // A fresh game (initial rack) resets the log baseline.
        room.log = {
          init: { initial: obj.initial, breaker: obj.breaker, config: obj.config },
          shots: [],
        };
      } else if (obj.t === "rematch") {
        // Rematch starts a new game; drop the old log until its game-init lands.
        room.log = null;
      } else if (obj.t === "shot" && room.log) {
        room.log.shots.push({ shot: obj.shot, place: obj.place, config: obj.config });
      }
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
