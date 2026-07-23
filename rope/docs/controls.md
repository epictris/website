# Controls — input → movement, per state

Pseudocode for the branching logic. `x` = move input (−1/0/+1), `toward`/`away`
= x relative to the wall normal. On mobile surfaces all velocity is relative to
the surface's contact-point velocity; every exit keeps it.
`docs/game-design.md` covers the physics constraints.

Universal rule: **ledge grabs are deliberate** — a ledge is grabbed only while
inputting toward it. This holds everywhere a grab could occur: sliding up
past a lip, sliding down a wall, or falling through the air alongside one.
Without toward-input the player keeps their current velocity past the ledge.
A ledge below the player's centre is never grabbed (no yank-down while flying
past, rising or falling). A fast fall still catches because the corner is
above centre the frame after passing it.

| Input | Action |
|-------|--------|
| R / T | move (`x`) |
| Space | jump (press buffered a few frames) |
| left-click hold | fire hook / keep rope; release detaches |
| right-click | retract-tug |
| C / S | retract / extend (lower swing CoM) |
| L | toggle ledge-grab overlay (debug, render-only) |

```
GROUNDED:
  x         → accelerate along surface tangent (cap: run speed)
  no x      → friction toward rest
  jump      → up velocity, keep horizontal (+ surface velocity) → AIRBORNE
  run off ledge → AIRBORNE with current velocity (never grabs it)
  hit wall:
    static           → stop | x toward → WALL(run)
    mobile ≠ support → stay grounded (wedge rule: mover can push, never freeze)
    own support steepened → WALL(slide)

AIRBORNE:
  x         → weak air accel (weaker still if rope taut)
  jump      → only within coyote window
  x toward + grabbable corner in reach of swept path:
    rising  → LEDGECLIMB · falling → LEDGEHANG
    (never a corner below centre)
  land on: floor → GROUNDED · wall (unless x away) → WALL · ceiling → stay

WALL:
  x away    → detach → AIRBORNE
  x toward + moving up → wall-run (keep momentum up the wall)
  else      → wall-slide (capped descent)
  jump      → wall-jump ~45° up+away → WALLJUMP
  x toward + grabbable corner in reach:
    moving up   → LEDGECLIMB
    else        → LEDGEHANG
  no x toward → never grab (universal rule): slide up past the lip, down the
                wall, or fall past the ledge with current velocity

WALLJUMP (~0.4 s):
  x         → half air accel
  timeout / land / wall → AIRBORNE | GROUNDED | WALL

LEDGEHANG:
  catch phase → swings down the hang face (entry momentum + easing, grip
                friction decay) to the rest pose: centre exactly on the
                grab-radius edge; climb waits for the catch
  settled     → locked to the grabbed body (movers carry the player exactly,
                impart no forces)
  x toward  → LEDGECLIMB (once caught)
  x away    → release → AIRBORNE
  jump      → ledge jump ~45° up+away → WALLJUMP
  ledge rotates ungrabbable, or rope taut → release → AIRBORNE
  catch blocked > ~0.75 s → release → AIRBORNE
  (hang follows a moving ledge)

LEDGECLIMB (scripted two-phase: up the hang face, then over onto the top):
  jump      → ledge jump ~45° up+away → WALLJUMP
  x away    → cancel → AIRBORNE
  ledge rotates ungrabbable → release → AIRBORNE
  blocked > ~1 s → timeout → AIRBORNE   (never input-locked longer)
  else      → other input ignored until done

ROPE (any state):
  fire hold → hook + rope · release → detach
  C / right-click → shorten (steady / burst)
  S         → lower CoM (faster swings)
  taut      → positional constraint; wins over hanging
```

Guarantees (enforced by `input-frozen` / `climb-stalled` invariants in every
playtest and bundle replay): held input always moves the player unless a static
wall blocks it; movers push, never freeze; no state ignores input beyond ~1 s.
