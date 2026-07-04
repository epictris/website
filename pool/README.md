# pool.tris.sh

Real-time 2-player 8-ball pool over WebSockets, with a deterministic physics
engine that supports heavy spin (draw / follow / English), and downloadable
client-side match replays.

## How it works

- **`server.ts`** — a Bun server. Serves the built client (`client/dist`) and
  relays WebSocket messages between the two players in a room. It never runs
  physics; it is a dumb relay + presence tracker.
- **`client/`** — a Vite + SolidJS app.
  - `physics.ts` — deterministic, fixed-timestep pool physics. Same start state
    + same shot ⇒ byte-identical rest positions on both clients.
  - `render.ts` — canvas renderer (felt, rails, pockets, glossy balls, cue,
    aim line + ghost ball, opponent cursor).
  - `rules.ts` — 8-ball rules; every foul resolves to ball-in-hand.
  - `net.ts` — WebSocket message protocol.
  - `replay.ts` — save/load match replays as JSON (client-side only).
  - `Game.tsx` — glues it together (input, loop, networking).

### Determinism = cheap multiplayer + replays

Because the engine is deterministic, a shot is fully described by its parameters
(`angle`, `power`, `follow`, `side`). We only send those over the wire; both
clients re-simulate and stay in sync. A **replay** is just the opening rack plus
the ordered list of shots — re-applying them reproduces the whole match, so
replays are tiny JSON files stored and downloaded entirely on the client.

Live aim (mouse position, cue angle, power, spin) is streamed as fire-and-forget
presence so you can watch your opponent line up a shot.

## Controls

- **Aim** — move the mouse; the cue points from the ball toward the cursor.
- **Power** — the power slider.
- **Spin** — the spin pad (a cue-ball circle): up/down = follow/draw,
  left/right = English. Pile it on for big swerves and rail action.
- **Shoot** — the shoot button or the spacebar.
- **Ball-in-hand** (after a foul, and on the break) — drag the white ball to
  reposition it, then shoot.

## Running locally

Two processes — the Bun relay and the Vite dev server (which proxies `/ws`):

```sh
# terminal 1 — websocket relay on :8080
cd pool && bun install && bun run dev

# terminal 2 — client on :3000
cd pool/client && bun install && bun run dev
```

Open http://localhost:3000 — you'll be redirected to a fresh game URL. Open the
same URL in a second tab/window to be the opponent.

## Deploy

Same pipeline as the other services: pushing to `main` builds `pool/Dockerfile`,
pushes `ghcr.io/<repo>/pool`, and `compose.yml` runs it behind Caddy at
`pool.tris.sh`. The container is a single Bun process serving static files and
the WebSocket on `:8080`. No DNS change is needed (`*.tris.sh` wildcard).
