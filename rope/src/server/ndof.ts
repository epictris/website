// THE SPACEMOUSE BRIDGE (dev only; docs/editor.md, "SpaceMouse").
//
// A 3Dconnexion SpaceMouse on Linux is read by `spacenavd`, the same daemon
// Blender listens to, which publishes the cap's motion on a UNIX socket. A page
// cannot open that socket, so this plugin does: it connects on the first
// editor's `ndof:hello`, and forwards every event to the pages over Vite's own
// HMR WebSocket (`ndof:motion`, `ndof:button`, `ndof:status`), which the editor subscribes to
// through `import.meta.hot` (src/editor/ndof.ts).
//
// Why spacenavd rather than WebHID: the daemon already owns the device (it
// grabs the evdev node, and Blender shares it as a client), it needs no udev
// rule and no browser permission prompt, and its own settings - sensitivity,
// dead zone, axis inversion (`spnavcfg`, /etc/spnavrc) - apply to the editor
// as they do to Blender, so the cap feels the same in both.
//
// The wire format is spacenavd's original (protocol 0), which a client that
// sends nothing is spoken: 32-byte packets of eight native-endian int32s,
//
//   [0, x, y, z, rx, ry, rz, period]   motion, about +-350 at full deflection
//   [1, button, ...]                   press
//   [2, button, ...]                   release
//
// in spacenavd's axes (src/editor/ndof.ts turns them into the view's).
//
// Every page hears every event. Which one acts on it is the page's question
// (the focused editor), since only the browser knows which tab has focus.

import { connect, type Socket } from "node:net";
import type { Plugin, ViteDevServer } from "vite";

// `SPNAV_SOCKET` names another (a fake daemon, for driving the editor headless).
const SOCKET_PATHS = process.env.SPNAV_SOCKET ? [process.env.SPNAV_SOCKET] : ["/var/run/spnav.sock", "/run/spnav.sock"];
const PACKET_BYTES = 32;
// How long to wait before trying the socket again after it was missing or
// closed: spacenavd restarting, or not installed at all, costs one failed
// connect every few seconds and nothing else.
const RETRY_MS = 3000;

export interface NdofMotion {
  // spacenavd's axes, raw: about +-350 at full deflection.
  t: [number, number, number];
  r: [number, number, number];
}

export interface NdofButton {
  // spacenavd's button number, from 0.
  button: number;
  pressed: boolean;
}

export interface NdofStatus {
  connected: boolean;
}

export function ndofBridge(): Plugin {
  return {
    name: "ndof-bridge",
    apply: "serve",
    configureServer(server) {
      const bridge = new Bridge(server);
      server.ws.on("ndof:hello", () => bridge.want());
      server.httpServer?.on("close", () => bridge.close());
    },
  };
}

class Bridge {
  private socket: Socket | null = null;
  private connected = false;
  private wanted = false;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pending = Buffer.alloc(0);
  private pathIndex = 0;

  constructor(private readonly server: ViteDevServer) {}

  // An editor wants the cap: connect if not already, and tell it where things
  // stand either way (a page that loads after the connect missed the status).
  want(): void {
    this.wanted = true;
    if (this.socket || this.retry) {
      this.sendStatus();
      return;
    }
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.destroy();
    this.socket = null;
  }

  private open(): void {
    if (this.closed || !this.wanted) return;
    const path = SOCKET_PATHS[this.pathIndex % SOCKET_PATHS.length]!;
    const socket = connect(path);
    this.socket = socket;
    this.pending = Buffer.alloc(0);
    socket.on("connect", () => {
      this.connected = true;
      this.server.config.logger.info(`  ndof: connected to spacenavd (${path})`, { timestamp: true });
      this.sendStatus();
    });
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", () => {
      // Followed by "close", which does the work. A missing socket is the
      // common case on a machine without spacenavd: the next path is tried.
      if (!this.connected) this.pathIndex++;
    });
    socket.on("close", () => {
      const was = this.connected;
      this.connected = false;
      this.socket = null;
      if (was) {
        this.server.config.logger.info("  ndof: spacenavd went away", { timestamp: true });
        // A cap held off centre when the daemon went must not keep flying.
        this.server.ws.send("ndof:motion", { t: [0, 0, 0], r: [0, 0, 0] } satisfies NdofMotion);
        this.sendStatus();
      }
      if (this.closed) return;
      this.retry = setTimeout(() => {
        this.retry = null;
        this.open();
      }, RETRY_MS);
    });
  }

  private receive(chunk: Buffer): void {
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let latest: NdofMotion | null = null;
    while (buf.length >= PACKET_BYTES) {
      const type = buf.readInt32LE(0);
      if (type === 0) {
        // Only the newest motion of a burst matters: it is a state (where the
        // cap is), not a delta.
        latest = {
          t: [buf.readInt32LE(4), buf.readInt32LE(8), buf.readInt32LE(12)],
          r: [buf.readInt32LE(16), buf.readInt32LE(20), buf.readInt32LE(24)],
        };
      } else if (type === 1 || type === 2) {
        // In order: the motion before a press is sent before it.
        if (latest) this.server.ws.send("ndof:motion", latest);
        latest = null;
        this.server.ws.send("ndof:button", { button: buf.readInt32LE(4), pressed: type === 1 } satisfies NdofButton);
      }
      buf = buf.subarray(PACKET_BYTES);
    }
    if (latest) this.server.ws.send("ndof:motion", latest);
    this.pending = Buffer.from(buf);
  }

  private sendStatus(): void {
    this.server.ws.send("ndof:status", { connected: this.connected } satisfies NdofStatus);
  }
}
