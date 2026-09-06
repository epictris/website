# Production playtest recording

Friends play the ball & chain game at rope.tris.sh.
Every run they play is recorded as the minimum a deterministic replay needs, streamed to the production server as it happens, attributed to the person who played it, and managed from an admin page where runs can be viewed, watched, annotated and deleted.
Runs are also pulled back to a dev machine to be replayed, scanned and watched with the existing tooling.

## What already exists, and what it means for this

The sim is a fixed 1/60 step and samples input once per step, so a run is fully described by its per-frame input trace (`SerializedFrame`: a held-action bitmask plus the aim point in world metres, ~56 bytes as JSON).
`main.ts` already keeps that trace for the P download, cleared on every reset, because a bundle must start at level start to replay.
`Recording` is the bundle format every CLI command reads, and `replayRecording` rebuilds the level from the registry name when the bundle carries no inline level data.
The tree stamp (`commit`, `dirty`, `srcHash`) is served to the page through `virtual:tree-stamp` and already lands in every bundle.

Three facts shape the design:

- **The P bundle is 80% debug data.** Of the 313 KB in `session-1080f.json`, 60 KB is the input trace. Per-frame avatar and world digests are what a debugging session needs and what a playtest record does not.
- **A run ends at a reset.** `BallLevel.physicsProcess` calls `onReset` on a jump press and the kill zone calls it on a fall, and `reset()` clears the trace. A playtest session is therefore a sequence of independent runs, each replayable on its own.
- **Production does not know its commit.** `.dockerignore` excludes `.git` from the build context, so `git rev-parse` fails inside the image and every production bundle would say `commit: unknown`. `srcHash` still works, because it hashes the `src/` and `levels/` that are in the context, but a hash alone does not tell you which commit to check out.

## The record

One **session** per page load.
One **run** per level start, numbered within the session.
Everything below is the entire record; anything not listed is deliberately not stored.

Session metadata, written once:

| Field | Why |
|---|---|
| `session` | UUID from `crypto.randomUUID()`, the key for everything else |
| `player` | the server-issued player id from the cookie (see **Who played it**) |
| `ips` | every client address seen during the session, in order of first sighting, stamped by the server |
| `nick` | from `?player=NAME` on the invite link, if present |
| `commit`, `srcHash` | which tree to replay on; `dirty` is asserted false in production |
| `level` | registry id, never inline level data (`ball.json` is 164 KB and lives in the tree at that commit) |
| `device` | `mouse`, `gamepad` or `touch`, as `BallInputSource` already classifies it |
| `ua`, viewport, `devicePixelRatio`, render mode | context for "it felt laggy", none of it touches the sim |

Per run:

- The input trace, exactly as sampled.
  No quantisation of the aim floats: the recording must be what the sim saw.
- A **sparse world digest**, `worldDigestBall` on every 60th frame and on the last frame.
  This is the one piece of debug data worth keeping.
  The browser and bun disagreed on a 1e-17 m overlap on 2026-09-04, and without any digest a production run that diverges on replay would silently play a different game.
  At one digest a second it costs a few hundred bytes a second and lets `cli replay` report both that a divergence happened and which frame and field it began on.
- An **end marker** with the frame count and the reason: `reset`, `kill`, `unload`, or `idle` when the server sealed it because the client vanished.
  A reviewer must be able to tell a finished run from a truncated one.

What is not stored, and why:

- Per-frame `digests` and `worldDigests`: 4 KB per frame of data that a replay regenerates.
- The `selfReplay` verdict: it re-simulates the whole run synchronously and takes ~300 ms per 415 frames, so a ten-minute run would freeze the player's browser for ~25 s. The server-side seal runs the same check instead.
- Wall-clock per frame: the server stamps each batch on arrival, which is enough to compute the effective sim rate over any window.

Sizes, measured on `session-1080f.json`:

| | per frame | per 10-minute run |
|---|---|---|
| input trace, JSON | 56 B | 2.0 MB |
| input trace, gzipped | 13.5 B | 0.5 MB |

At a few hundred sessions a month, with sessions averaging maybe twenty minutes, that is roughly 1 GB a year gzipped.
Well within a boot volume, but enough that sealed bundles should be gzipped and old ones expired.

## Who played it

The IP address is recorded on every batch and is the corroborating signal, but it is not the identity.
Two friends on one home network share an address, a phone changes address when it leaves the house, and a laptop on a VPN changes it every day.
An identity built on the address alone would split one person into many and merge two into one.

The identity is a **server-issued player id**:

- The first batch a browser ever sends arrives without a `pid` cookie.
  The server mints a random id, stores it, and returns it as `Set-Cookie: pid=…; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000` (400 days, the longest Chrome allows, and refreshed on every visit).
- Every later batch from that browser carries the cookie automatically, because the recorder posts to the same origin.
  The page's JavaScript never sees or handles it.
- A server-set HttpOnly cookie is the most durable first-party state a browser offers.
  Safari caps script-written cookies and can purge `localStorage` after seven days without interaction; it leaves server-set cookies alone.

The IP does two jobs beside it:

- **Corroboration.** Every session records the addresses seen, and the admin page shows them next to the player.
  When a batch arrives with a `pid` the server has never seen but from an address a known player used recently, the session is flagged `probably <name>` and the admin page offers a one-click merge.
  This is the cleared-cookies, new-browser and new-phone case, and it needs a human to confirm, not a heuristic to decide.
- **Abuse.** Per-address rate limits on new sessions, below.

The address comes from `X-Forwarded-For`, which Caddy sets to the connecting client and strips from untrusted incoming requests by default.
The rope container has no published port, so nothing reaches it except through Caddy, and the header can be trusted as-is.

The **nickname** is the admin's, not the player's.
An invite link `rope.tris.sh/?player=sam` pre-fills `nick` so the first session already reads as Sam, and the admin page lets the name be edited, so a player who arrives without a link is named once and stays named.
Merging two player ids keeps the older id and records the newer as an alias, so old sessions and new sessions list under one name.

Player records live in `players.json`: id, name, aliases, addresses seen with first and last sighting, session count, first and last seen.
Deleting a player from the admin page deletes their sessions and runs as well, so a friend who asks to be forgotten can be, in one action.

## Streaming

The client batches events and POSTs them to the same origin the game was served from.

- One endpoint, `POST /api/playtest/events`, body `{ session, seq, events }`.
  Event kinds: `start` (session metadata), `run` (run index, level), `frames` (run, `from`, an array of `SerializedFrame`), `digest` (run, frame, world digest), `end` (run, frames, reason).
- `seq` is a single per-session counter.
  The server appends a batch only when `seq` is exactly the next expected, replies `{ ack }`, and answers a gap or a repeat with `409 { expect }` so the client rewinds its unacked queue.
  One counter gives ordering, deduplication and resumption at once.
- One batch in flight at a time, sent every 60 sim frames or when the queue is flushed.
  A batch is ~3.5 KB, under the 64 KB limit `keepalive` requests carry, so several batches can be queued behind a network outage without any of them being refused.
- Frames stay in the client's queue until acked, retried with backoff and jitter.
  A run with a hole in it is worthless, so the client never drops.
- `pagehide` and `visibilitychange: hidden` flush what is queued with `fetch(..., { keepalive: true })`, and the `end` event with reason `unload` goes in that flush.
  Chrome, Firefox and Safari all deliver a keepalive request after the tab is gone.
- Enabled in production builds and by `?record=1` in development, so the whole path is testable against a local `serve.ts`.
  The P download is unchanged.

A WebSocket was considered and rejected.
It needs the same resume-from-seq logic, it cannot send anything after the page is gone, and it adds proxy idle-timeout behaviour to think about.
Plain sequential HTTP batches pass through Caddy with no configuration.

## The server

The routes live in `serve.ts`, which is already the Bun process serving `dist/` for this container, with the store in a new `src/server/playtest.ts` and the admin page in `src/server/admin.ts`.
Same origin as the game, so there is no CORS and nothing to add to the Caddyfile beyond the auth block below.
A separate service was rejected as a second container, a second image and a second deploy for a few kilobytes a second.

**Storage is files on a bind mount**, `/opt/website/playtests` on the VM mounted at `/data/playtests` in the container:

```
/data/playtests/
  sessions/2026-09/<session>.ndjson        # live append log, one event per line
  runs/2026-09/<session>-r<k>.json.gz      # sealed Recording bundles
  trash/<deleted-at>-<session>-r<k>.json.gz  # deleted runs, purged after 30 days
  players.json                             # player id → name, aliases, addresses, counts
  annotations.json                         # run id → starred, note
  index.json                               # one row per run, regenerated on every seal, delete or annotation
```

Why files:

- The consumer is a CLI that already reads bundles from the filesystem and a corpus runner that already walks directories.
- `appendFile` of a whole line from a single process is atomic enough at this rate, and the three JSON files are rewritten whole through a temporary name and a rename.
- Backup is a copy of one directory. There is nothing to migrate, dump or restore.
- SQLite via `bun:sqlite` would win once there is something to index or query beyond what `index.json` holds. At a few hundred runs a month, one regenerated index file is that index, and the admin page filters it in the browser.
- Writing straight to object storage puts credentials and an SDK on the hot path for no gain at this scale. Object storage is the backup target, not the store.

**Sealing** turns a run's events into a `Recording`:
`{ level, git, dirty: false, srcHash, frames, worldDigests, meta }` with `meta` carrying the session fields, the player id, the addresses, the wall-clock span and the end reason.
It runs on the `end` event, and a once-a-minute sweeper seals any run whose session has been idle for fifteen minutes with reason `idle`.
Sealing writes the gzipped bundle to a temporary name and renames it, replays the run against the sparse digests and writes the verdict into `meta`, updates `index.json` and `players.json`, and deletes the session log once every run in it is sealed.

**Deletion** moves the bundle to `trash/` and drops its index row and annotation; the sweeper purges trash older than 30 days.
A mis-click on the admin page costs nothing for a month, and a run that has been pulled to the dev machine keeps that copy regardless.

**Limits**, because ingest is unauthenticated:

- body at most 256 KB;
- a run at most two hours of frames;
- at most a handful of new sessions per address per hour;
- ingest refuses with 507 when the volume has under 1 GB free.

Ingest stays unauthenticated on purpose.
The friends playing have a URL and nothing else, and a key in the URL is friction that buys nothing against a private link.

## The admin page

`rope.tris.sh/admin`, served by `serve.ts` as one static HTML page with inline script that talks to `/api/playtest/admin/*`.
No framework and no build step: the page is a table, a few filters and a handful of buttons, and it lives in the same image as the game.

**Authentication is Caddy's**, not the app's.
The Caddyfile gets a `basic_auth` block over `/admin*` and `/api/playtest/admin/*` with a bcrypt hash read from `{$ROPE_ADMIN_HASH}`, which `compose.yml` passes to the caddy container from the VM's `.env`.
The password is set once on the VM, and the browser prompts for the username and password on the first visit to `/admin`.
Nothing under `/admin` or `/api/playtest/admin/` is reachable without it, including the run bundles the watch page fetches.

Setting or rotating it, without logging on to the VM:

1. Generate the bcrypt hash locally and store it as a GitHub Actions secret in one pipe: `read -s PW && bun -e 'console.log(await Bun.password.hash(process.env.PW, {algorithm: "bcrypt", cost: 14}))' | gh secret set ROPE_ADMIN_HASH`. Caddy verifies with Go's bcrypt, which accepts the `$2b$` hashes Bun produces, and `read -s` keeps the password out of shell history.
2. A `Write runtime secrets` step in `deploy.yml`, before `Pull and restart`, pipes `ROPE_ADMIN_HASH='<hash>'` over the existing SSH connection into `/opt/website/.env` under `umask 077`. Stdin rather than a remote `echo`, so the `$` signs in the hash never meet a shell. Single-quoted in the file because compose parses `.env` with dotenv rules and would otherwise read `$2b` and `$14` as variables.
3. `compose.yml` passes it to the caddy service as `ROPE_ADMIN_HASH=${ROPE_ADMIN_HASH}`; compose reads `.env` from the project directory on its own.
4. The Caddyfile matches `@admin path /admin /admin/* /api/playtest/admin/*` and applies `basic_auth @admin { tris {$ROPE_ADMIN_HASH} }` inside the `rope.tris.sh` block, ahead of the `reverse_proxy`.
5. The deploy job's condition gains `|| github.event_name == 'workflow_dispatch'`, because the paths filter sees no changed files on a manual run and would otherwise skip the deploy. `docker compose up -d` recreates caddy whenever its environment changes.
6. Verify: `curl -sI https://rope.tris.sh/admin` returns 401 and the same with `-u tris` returns 200.

A rotation is step 1 again followed by `gh workflow run deploy.yml`.
The hash is never committed: the repository is public, and a bcrypt hash of a weak password in a public repo is crackable offline.

`cli pull` reads `ROPE_ADMIN_USER` and `ROPE_ADMIN_PASSWORD` from `rope/.env`, which the repo already ignores.
The app never sees a password, there is no session or token code to get wrong, and the browser remembers the credentials for the realm, which is what lets the game page fetch a run bundle for watching (below) without any login flow of its own.
Ingest at `/api/playtest/events` is outside the block and stays open.

What it shows:

- **Runs.** One row per run from `index.json`: date, player, level, commit with a `live` badge when it matches the build currently serving, duration and frames, end reason, replay verdict, device, address, star and note.
  Filter by player, level, date range, end reason and verdict; sort by any column.
  A truncated run (`unload`, `idle`) and a diverging run stand out by colour, because those are the rows worth opening first.
- **Live.** Sessions with an unsealed log: who, which level, frames so far, seconds since the last batch.
  This is how you notice someone is playing right now.
- **Players.** Name, aliases, addresses seen, sessions, first and last seen, and any `probably <name>` suggestions awaiting a merge.
  Rename, merge and delete live here.
- **Storage.** Bytes used, run count, trash size, free space on the volume.

What it does, per run and for a selection:

- **Watch** opens `rope.tris.sh/?replay=run:<id>`.
  The game page fetches `/api/playtest/admin/runs/<id>` (the browser supplies the realm's credentials), feeds the trace through the existing replay path, and plays it through the real renderer and camera at 1x.
  If the run's `srcHash` differs from the live build's, a toast says so before the first frame and the replay still plays, because a slightly different tree is usually still worth looking at, and the exact answer comes from the worktree replay on the dev machine.
- **Download** returns the sealed `Recording` JSON, so a single interesting run can be dropped into `playtests/bundles/` by hand.
- **Star and note**, stored in `annotations.json`, so a run seen at midnight is findable the next day.
- **Delete** moves to trash, with the selection count in the confirm.
- **Delete player** removes the player record and everything attributed to it.

The admin API behind it:

| Route | Does |
|---|---|
| `GET /api/playtest/admin/index` | `index.json`, `players.json`, `annotations.json` and live sessions in one response |
| `GET /api/playtest/admin/runs/<id>` | the sealed `Recording` JSON |
| `DELETE /api/playtest/admin/runs/<id>` | move to trash |
| `PATCH /api/playtest/admin/runs/<id>` | star, note |
| `PATCH /api/playtest/admin/players/<id>` | rename |
| `POST /api/playtest/admin/players/<id>/merge` | absorb another id as an alias |
| `DELETE /api/playtest/admin/players/<id>` | player and all their runs to trash |
| `GET /api/playtest/admin/export?since=<date>` | a tar of sealed bundles, for `cli pull` |

Every write goes through the same store module the seal and the sweeper use, so there is one place that rewrites the JSON files and one place that knows what a run id is.

The admin page is deliberately for looking, watching and housekeeping.
Anomaly scanning, filmstrips, frame queries and A/B comparisons stay in the CLI, where they already exist and where a worktree on the recording's commit gives an exact answer.

## The tree stamp in production

The one prerequisite, and shippable on its own:

- `deploy.yml` passes `GIT_COMMIT=${{ github.sha }}` as a build arg.
- The Dockerfile declares `ARG GIT_COMMIT` and exports it into the build stage's environment.
- The tree-stamp plugin falls back to `process.env.GIT_COMMIT` (shortened) when `git rev-parse` fails, and to `unknown` only after that.

`srcHash` in production is computed over the same `src/` and `levels/` a checkout has, because `.dockerignore` excludes nothing under either, so `cli replay` on a checkout of that commit reports `tree: match`.

## Pulling and reviewing on the dev machine

`cli pull` is the review entry point:

1. Fetch `/api/playtest/admin/export?since=<last pull>` with the admin credentials from a local `.env`, into `playtests/prod/`, which is git-ignored like `playtests/bundles/`.
2. Gunzip anything new and replay it on the current tree.
3. Print one row per run: date, player, level, commit, frames, duration, end reason, and the verdict: `reproduces`, `DIVERGES @f… <field>`, or `tree mismatch (bundle abc1234, here def5678)`.

The export endpoint rather than `rsync` over SSH, because the admin API has to exist for the page anyway, and one authenticated read path is better than two.
`playtests/prod/` on the dev machine is the working archive, and a delete on the server never touches it.

Then the existing tools do the work:

- `cli scan --all` over `playtests/prod/` is the triage step: which of the forty runs since last week had a stall, a spike, an embedding or a flicker.
- `cli shot --frames … --3d` gives a filmstrip of a run without opening a browser.
- `?replay=prod/<run>` plays a run through the real renderer in the dev server.
  The dev server gets a route that serves `playtests/prod/` the way the level API serves `levels/`, so the file does not have to be copied into `public/`.
- A run recorded on an older commit is replayed in a worktree: `git worktree add ../rope-<commit> <commit>`, then `bun run replay replay` there. `cli pull` prints that command next to any mismatch.

One change in the replay core: `replayRecording` compares `rec.digests?.[i]` and `rec.worldDigests?.[i]` positionally, which assumes a digest per frame.
It becomes a lookup by the digest's `frame` field, so a sparse bundle compares on the frames it has and a dense one compares exactly as before.
`cli selftest` covers both shapes.

## Backup and retention

- A nightly cron on the VM runs `rclone copy /opt/website/playtests oci:playtests` to an OCI Object Storage bucket declared in Terraform.
  The whole directory, so `players.json` and `annotations.json` are backed up with the runs.
  `copy`, never `sync`: the 90-day sweep on the VM must not propagate to the backup.
- Cost, against the Always Free limits as documented in September 2026: 10 GB of Standard object storage (20 GB combined on a free-only account), 50,000 API requests a month, and 10 TB of outbound transfer a month.
  The plan's ~1 GB a year gzipped, ~1,000 new objects a month and a few gigabytes a year of pulls sit an order of magnitude or more under each.
  Past the cap, Standard is about $0.0255 per GB-month and Infrequent Access about $0.01 per GB-month plus $0.01 per GB retrieved, which is the tier to move to if the volume ever grows tenfold.
  The Terraform state bucket already counts against the same allowance, by kilobytes.
- Sealed bundles older than 90 days are deleted from the VM by the sweeper, and trash older than 30 days is purged.
  By then they have been pulled and copied.
- Session logs are deleted at seal; a run has one home at a time.
- Addresses are personal data about friends.
  They live only in `players.json` and in each run's `meta`, so deleting a player removes every copy, and the 90-day sweep bounds how long the server holds them.

## Testing

- **Store cases**, added to `bun run test` as `cli playtest`: in-order append, a repeated batch, a gap, a batch over the size cap, a new `pid` minted and an existing one honoured, addresses accumulated across batches, the `probably <name>` flag, seal on `end`, seal on idle, delete to trash and purge, merge keeping the older id, and that a sealed bundle round-trips through `replayRecording` with the sparse digests matching.
- **Admin routes**: every route under `/api/playtest/admin/` returns 401 through the local Caddy config without credentials and works with them; the export tar contains exactly the runs since the given date.
- **E2E before deploy**: run `serve.ts` locally with `PLAYTEST_DIR` pointed at a scratch directory behind a local Caddy with the same Caddyfile, open the built app with `?record=1`, play, throttle the network to offline in devtools for ten seconds and back, then close the tab mid-run.
  The session log must hold every frame up to the close, the sweeper must seal it with reason `idle`, the admin page must show it under the right player with the right address, **Watch** must play it, **Delete** must move it to trash, and `cli replay` on the sealed bundle must print `tree: match` and no divergence.
  Then clear the cookie, play again, and confirm the new session is flagged `probably <name>` and merges.
- **Determinism**: `cli selftest` with a sparse-digest bundle beside the dense one.

## Phases

1. **Tree stamp in production.** Build arg, Dockerfile, plugin fallback. Verify with a P download from rope.tris.sh after deploy.
2. **Recorder and store.** Client `src/playtest/recorder.ts`, server `src/server/playtest.ts` with the `pid` cookie and address capture, routes in `serve.ts`, bind mount in `compose.yml` and the directory in cloud-init. Behind `?record=1` until the E2E above passes, then on by default in production.
3. **Admin page.** Caddy `basic_auth` block and the `.env` hash, `src/server/admin.ts`, the page, `?replay=run:<id>` in `main.ts`, trash and purge.
4. **Review tooling.** Sparse-digest replay, `cli pull` over the export endpoint, `?replay=prod/…` in the dev server, `scan --all` over the pulled corpus.
5. **Backup and retention.** Bucket in Terraform, `rclone` cron, the 90-day and 30-day sweeps.

Phases 1 and 5 are independent of everything else.
Phases 3 and 4 are what make the data useful, and both should land before friends are asked to play, so the first real sessions are attributed and reviewed the same week they happen.

## Implementation notes (2026-09-06)

Where the built thing differs from the plan above, the code is right and this records why.

- **Two runs after a reset replayed a frame out.**
  `BallLevel.physicsProcess` increments the frame counter before the jump check, and the input deserializer seeded its previous frame as empty, so a run whose first frame still had jump held (the frame after the one that reset the level) replayed that hold as a fresh press.
  Recordings now carry `heldAtStart`, the held mask the level's first frame was stepped from, and `recordingDeserializer(rec)` seeds from it.
  The loop in `main.ts` records the frame that triggered a reset to the run it ended, not to the run it began.
  The P download gained the same field.
- **No tar export.** `cli pull` reads the admin index and downloads each missing run from `/api/playtest/admin/runs/<id>/gz`, one request per run. A tar writer without a dependency was more code than a loop.
- **A `pause` end reason.** A page hidden for over a minute restarts the level when it returns, ending its run as `pause`, because the fixed step never saw the gap. `unload` is sent from `pagehide`; a page restored from the back/forward cache starts a fresh run.
- **The store's cases live in `src/server/storeCases.ts`** and run as `cli playtest` inside `bun run test`; the sparse-digest replay is covered there (a sealed run is replayed and compared on its one-a-second digests) rather than in `cli selftest`.
- **Dev setup.** `bun run serve.ts` beside `bun run dev` gives the dev server a store: Vite proxies `/api/playtest` and `/admin` to it, so `?record=1` on the dev page streams into a local `.playtests/` and `/admin` on port 3100 shows it.
- **The verifier is a subprocess**, `bun src/server/verify.ts <bundle>`, so the runner image ships `src/` and `levels/` and the sim needs nothing from `node_modules`.
- **Backup config comes from the deploy**, not cloud-init: `deploy/host-setup.sh` runs as root on every deploy and writes the rclone config (instance principal, no key) and the cron, given `OCI_OS_NAMESPACE` as a repository variable. Cloud-init only runs when an instance is created, and changing it would recreate the VM.
