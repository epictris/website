// Pool game server: static file host + WebSocket relay with rooms.
//
// The server is a dumb relay + presence tracker. It never runs physics.
// Both clients run the same deterministic engine, so we only need to
// forward shot parameters and live-aim presence between peers in a room.
//
// Slot assignment: player slots 0 and 1 are *owned* by a client id (`cid`, a
// stable per-browser identity). The first player owns slot 0, the second slot 1;
// claiming slot 1 flips the room to `started`. Once started the two slots stay
// reserved for their owners: a socket whose cid owns a slot (that isn't currently
// live) reconnects into it; anyone else joins as a spectator (slot >= 2). A
// player who drops keeps their slot reserved until they return.

import { file } from "bun";
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const DIST = join(import.meta.dir, "client", "dist");

type SocketData = {
  room: string;
  id: string;
  cid: string; // stable client identity (survives reconnects), owns a player slot
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
  /** Monotonic counter for spectator slot ids. */
  nextSlot: number;
  /** When the room was first opened — for sorting the joinable lobby list. */
  created: number;
  /** Retained shot log, re-sent to any (re)joining socket. */
  log: GameLog | null;
  /** The two player slots' owner cids (null until claimed). Reserved across a
   *  drop so the same browser reconnects into its slot. */
  owners: [string | null, string | null];
  /** True once both player slots are claimed — a real game is under way. Sandbox
   *  (one waiting player) rooms are the only ones offered in the lobby. */
  started: boolean;
};

const rooms = new Map<string, Room>();

function getRoom(code: string): Room {
  let room = rooms.get(code);
  if (!room) {
    room = {
      sockets: new Set(),
      nextSlot: 0,
      created: Date.now(),
      log: null,
      owners: [null, null],
      started: false,
    };
    rooms.set(code, room);
  }
  return room;
}

/** Is a player slot currently held by a live socket? */
function liveHolder(room: Room, slot: number): boolean {
  for (const s of room.sockets) if (s.data.slot === slot) return true;
  return false;
}

/** Assign a joining socket its slot: reclaim an owned-but-vacant player slot,
 *  else take a free player slot (claiming ownership), else spectate. */
function claimSlot(room: Room, cid: string): number {
  // Reconnect: this browser owns a player slot that nobody is currently holding.
  for (let i = 0; i < 2; i++)
    if (room.owners[i] === cid && !liveHolder(room, i)) return i;
  // Already own a (live) slot in another tab → don't grab a second one.
  if (room.owners.includes(cid)) return Math.max(2, room.nextSlot++);
  // Fresh player: take the first unclaimed, unheld player slot.
  for (let i = 0; i < 2; i++)
    if (room.owners[i] === null && !liveHolder(room, i)) {
      room.owners[i] = cid;
      return i;
    }
  // Both player slots are spoken for → spectator.
  return 2 + room.nextSlot++;
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
      // Stable per-browser identity so a reconnecting player reclaims their slot.
      const cid = url.searchParams.get("cid") || crypto.randomUUID();
      const ok = server.upgrade(req, { data: { room: code, id, cid, slot: -1 } });
      if (ok) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/healthz") return new Response("ok");

    // Lobby: the joinable games — rooms holding exactly one waiting player.
    // Newest first. (CORS-open so the dev client on another port can poll it.)
    if (url.pathname === "/rooms") {
      const list = [...rooms.entries()]
        .filter(([, r]) => !r.started && r.sockets.size === 1)
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
      ws.data.slot = claimSlot(room, ws.data.cid);
      room.sockets.add(ws);
      // Claiming the 2nd player slot starts the game (and closes the lobby entry).
      if (room.owners[0] !== null && room.owners[1] !== null) room.started = true;

      // Tell the newcomer who they are, whether the game is in progress, and who
      // is already here.
      ws.send(
        JSON.stringify({
          t: "hello",
          slot: ws.data.slot,
          id: ws.data.id,
          started: room.started,
          peers: peers(room).filter((p) => p.id !== ws.data.id),
        }),
      );
      // Tell everyone else a peer joined (host will answer with a state sync).
      broadcast(
        room,
        { t: "peer-join", slot: ws.data.slot, id: ws.data.id, started: room.started },
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
