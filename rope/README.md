# rope 🪝

A tiny browser playground for a grappling-hook character controller — swing, wall-run,
wall-jump, and reel yourself around with a rope that wraps realistically around geometry.

TypeScript port of a C#/Godot prototype (no engine dependency — physics is hand-rolled).

## Play

```sh
bun install
bun run dev      # open http://localhost:3100
```

Keybinds match the original Godot project:

| Input | Action |
|-------|--------|
| `R` / `T` | move left / right |
| `Space` | jump (wall-jump on a wall) |
| left-click | fire the hook toward the cursor |
| right-click | strong retract tug |
| `C` | reel in · `S` reel out |
| `1` / `2` | spawn a small / large box |
| `P` | download a replayable session bundle |

A gamepad (standard mapping) works too, merged with keyboard/mouse:

| Input | Action |
|-------|--------|
| left stick / dpad | move |
| `A` | jump |
| right stick | aim (crosshair) |
| `RT` | fire the hook |
| `LT` | strong retract tug |
| `RB` / `LB` | reel in / reel out |
| `X` / `Y` | spawn a small / large box |

## Ball & chain mode

An alternate character controller at `?level=BALL`: you are a rolling ball that
throws a hooked chain (absolute max length) from the loop on its rim. The hook
flies in a gravity arc and anchors to the first surface it touches; a miss
leaves it dangling at full length until it lands or is released.
Gamepad only for now:

| Input | Action |
|-------|--------|
| left stick | aim — rotates the ball; the chain deploys through the loop on the rim |
| `RB` | shoot chain (hold — releasing lets go) |
| `X` (top face button) | restart level |

## Share a playtest

Press **P** to download a `session-*.json` bundle. Replay it (deterministically, with
sanity checks) headlessly:

```sh
bun run src/tools/cli.ts replay session-1234f.json
```

See `CLAUDE.md` for architecture and the full tooling reference.
