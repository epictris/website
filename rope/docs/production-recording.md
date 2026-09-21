# Production playtest recording

Every run played at swing.tris.sh is streamed to the store in `serve.ts` (see
`plans/playtest-recording.md`): the input trace, one world digest a second, the
tree stamp, and who played it. `src/playtest/recorder.ts` batches sixty frames at
a time to `/api/playtest/events`; `src/server/store.ts` appends each batch to a
per-session log, seals a run into a gzipped `Recording` when it ends (or after
fifteen idle minutes), and verifies it in a subprocess. A run is attributed by a
server-set `pid` cookie, with the address as corroboration only.

- `/admin` (password: Caddy `basic_auth`, hash from the `ROPE_ADMIN_HASH` secret)
  lists runs, live sessions, players and storage; **watch** opens `/?replay=run:<id>`,
  which plays the run on the transport - paused, scrubbed and stepped a frame at a
  time (see [**Watching a replay**](running.md#watching-a-replay)).
- `bun run replay pull` downloads new runs into `playtests/prod/` (gitignored), and the feedback beside them as `feedback.ndjson`
  and replays each against its digests; `cli scan --all` includes that directory.
  Credentials: `ROPE_ADMIN_USER` / `ROPE_ADMIN_PASSWORD` in `rope/.env`.
- `?replay=prod/<id>` plays a pulled run in the dev server; `?record=1` streams a
  dev session into a local `bun run serve.ts` (Vite proxies `/api/playtest`).
- `cli playtest` is the store's case suite, part of `bun run test`.

A recording carries `heldAtStart`, the held mask its first frame was stepped
from: the frame after a reset still has jump held, and a deserializer seeded
empty read that as a fresh press (a reset) on frame 1.

It also carries `checkpoint` when the page was opened at a named spawn
(`?checkpoint=NAME`, see [**Checkpoints**](running.md#checkpoints)) - an invite link that
drops a playtester straight into the area being tested. A sealed run NAMES its level rather
than embedding it, so without that field a run played from a checkpoint would replay from
the level's own spawn and diverge on frame 1: the bundle would be evidence about a
different run. It rides in the session's metadata rather than the run event, since only a
reload can change it, and `Store.seal` copies it into the `Recording`.

## What players said

Beside the runs, the store keeps **feedback**: five stars for fun, a bipolar difficulty answer and a comment, left on the panel that ends a level or from the level select's `rate` link (see [**Levels**](levels.md#the-completion-panel)).

`POST /api/playtest/feedback` is open for the reason ingest is, and shares ingest's `pid` cookie exactly - the same `resolveOrMintPlayer`, the same response header - so a player's runs and their ratings are **one player** whichever they do first, and rename, merge and delete reach both.
It is **append-only**: one JSON line per submission in `<dir>/feedback.ndjson`, never rewritten, never deduplicated.
A player who rates a level, plays it again and rates it differently leaves two lines, and what changed between them is the thing worth reading.
The only two rewrites are admin acts and both say so where they are - `deletePlayer` erases a player's ratings with their runs, `mergePlayers` re-attributes them.

Every record carries the page's claim about the tree and the level FILE it was played on, and the server's own answer beside it (`hereCommit`, `hereLevelHash`), so a client lying about either is visible rather than believed.

A run that ended because the player FINISHED the level seals with the reason **`complete`**, which is its own reason: sealed as `reset` or `kill` it would read as their having failed at the thing they just did.
A reason has to land on `EndReason` and on the store's `END_REASONS` in the same deploy - the store refuses one it does not know, and a refusal is a 400 the client goes dead on.

`/admin` gains a **feedback** tab (when, player, level, `v2 of 3`, stars, comment, commit, level file), and `cli pull` writes the rows to `playtests/prod/feedback.ndjson` and prints them with their version counts.
