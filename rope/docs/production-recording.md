# Production playtest recording

Every run played at swing.tris.sh is streamed to the store in `serve.ts` (see
`plans/playtest-recording.md`): the input trace, one world digest a second, the
tree stamp, and who played it. `src/playtest/recorder.ts` batches sixty frames at
a time to `/api/playtest/events`; `src/server/store.ts` appends each batch to a
per-session log, seals a run into a gzipped `Recording` when it ends (or after
fifteen idle minutes), and verifies it in a subprocess. A run is attributed by a
server-set `pid` cookie, with the address as corroboration only.

- `/admin` (password: Caddy `basic_auth`, hash from the `ROPE_ADMIN_HASH` secret)
  lists runs, live sessions, players and storage; **watch** opens `/?replay=run:<id>`.
- `bun run replay pull` downloads new runs into `playtests/prod/` (gitignored)
  and replays each against its digests; `cli scan --all` includes that directory.
  Credentials: `ROPE_ADMIN_USER` / `ROPE_ADMIN_PASSWORD` in `rope/.env`.
- `?replay=prod/<id>` plays a pulled run in the dev server; `?record=1` streams a
  dev session into a local `bun run serve.ts` (Vite proxies `/api/playtest`).
- `cli playtest` is the store's case suite, part of `bun run test`.

A recording carries `heldAtStart`, the held mask its first frame was stepped
from: the frame after a reset still has jump held, and a deserializer seeded
empty read that as a fresh press (a reset) on frame 1.
