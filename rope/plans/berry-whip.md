# Berry whip: a berry the ball hangs from does not feel the ball

Status: RESOLVED 2026-10-12 (uncommitted, unplayed). The write-up below is the diagnosis as it stood before the fix; the resolution is here.

## Resolution

Attempt 1 (a berry keeps the haul as a free holder, `freeHolder` excluding only a `passable` link) is the fix for the reports, and it is in the tree.
What made it run away in the whip rig was not the rule but the berry's SPIN, which the rig exposed and the rule made worse:

- At f48-49 of the ball.json plant 0 berry 1 leg (24 f/rev) the pair separation and the surface refusal handed the berry -10.5 rad/s (their impulses split with the holder's rotation about the contact, and the cuff on the berry's rim is a lever).
  Nothing governs a vine link's rotation: the rope puts no torque arm on a link, the vine's constraints act at its centre, and a held vine is not damped (`stepVines` returns before the damping loop for a held vine).
  So the berry spun for ever, carrying the cuff round at 2 m/s.
- Each frame from there, with the aim stalled (`aimSpin` 0), the orbiting cuff wound 10 cm of coil onto the ball (`coil` 1.2 to 3.0 rad over f58-70) - over-length no translation can remove - the solve hauled the berry into the ball, the pair push-out pushed it back, and `absorbBlockedLength` leased the over-length up to the push-out's size: lease 5 mm at f21, 150 mm at f66, 2.4 m by f230 on a 0.30 m chain.
  A ball whirled on a 2.7 m path is the 46 m/s.
- The old rule pumps the same lease on the same leg (0.5 m by f182), so the rig's "old" numbers were never a baseline.

The fix for that half: a vine link does not turn (`VineLink.inverseInertia` returns 0, as a spring body's does; `Rope.getDynamicBodyState` treats every link as it treated the ring's link).
Lease on that leg: 37 mm. Ball 2.9 m/s, berry 4.7.

Whip rig after both halves, with a STATIC control (the berry replaced by a static circle at its rest, same inputs):

| level, period | static | old rule | keep |
|---|---|---|---|
| ball.json, 48 f/rev | 2.0-2.2 m/s | 2.9-3.6 | 2.8-3.8 |
| ball.json, 24 f/rev | 2.2 | 2.9-5.6 | 2.9-5.4 |
| berry-test, 48 f/rev | 2.4-7.5 | 4.8-6.7 | 5.2-8.1 |
| berry-test, 24 f/rev | 7.8-8.6 | 5.6-8.6 | 8.9-13.4 |

berry-test's ball is 176 kg on 1.1-1.3 m chains; at 24 f/rev its static control is itself 8 m/s, which is the kinematic winch's own power, so that rig carries no bar.

The detector for the rule is the plank's statement about a berry (`scripts/test-berry-vines.ts`, "a wind-up keeps bearing down on the berry it hangs from"): hanging from a berry on 0.66 m sags BALL's three berries 83, 94 and 197 mm below the plant's unloaded rest; a slow wind (240 f/rev) holds 75, 90 and 182 of it with keep, and with the old rule lets them spring to 7, 15 and 37 mm ABOVE the rest while the ball still hangs there.
The detector for the lock is the whip (`hung-anchor`'s rig on BALL's berries at 48 and 24 f/rev): the berry's angular velocity is exactly zero on every frame, the lease stays under 30 cm, ball and berry under the bars, still held, no growth.
The forks: 221f f150-178 9.48 m/s / +2435 J to 4.55 / +124; 501f f320-372 2.94 / +195 J to 1.62 / 0.
Guards: `cli vines` 20/21 (ring-square, red on main), `cli spring` 22/22, `cli contacts` 56/58 (hook-sparks and chain-sweep, red on main).
The `__BERRY_RULE` switch is gone from the tree, so `fork.ts` and `whip.ts` now run the one rule on both legs.
Not yet done: a browser bundle against the fix with `cli diverge`, and the feel (how much a berry gives, its recoil on release) is Tris's to play.

What follows is the write-up as it stood before the fix.
Everything here is about berry vines (`VineData.starberry`, docs/vines.md "Berry vines"), which are uncommitted on `main` and unplayed apart from these two recordings.

## The report

Tris, playing BALL with the berry vines:

- `session-501f`: "the berry seems to move around quite unnaturally while I'm hanging off it."
- `session-221f` (the end of it): the player can gain huge amounts of speed by being "whipped" round a swinging berry, "since the weight of the ball pulling up the chain wasn't stopping the body from swinging".
- Tris's framing: "this exact issue was already solved for the case of rigidbodies hanging from chains" - that is `BallLevel.keepsHaul` (docs/ball-chain.md, `session-149f`, the hung plank whip).

Both bundles are in `playtests/bundles/` (gitignored scratch), recorded on this tree, and replay bit-exact (`cli replay`: HEALTHY).
Because they sit in `playtests/bundles/`, `cli bundles` and `bun run test` now replay them too.
Both replay HEALTHY: the energy monitor disarms while the aim is turning the ball, which is every frame of the whip.

## The mechanism, measured

The ball's mass is 52 kg on BALL.
On BALL's berry vines (`levels/ball.json` vines 7 and 9) a berry is 9 kg, a stalk joint 4 kg and a cord link 4.9 kg.
berry-test's ball is 176 kg, with 9 kg berries and 4.25 kg links.
A berry is a `VineLink` with `passable = false` (`src/engine/body.ts`).

When the ball winds (the aim turns the ball, so `spinShare > 0`), the chain phase in `BallLevel` (`src/level/ballLevel.ts`) does this to whatever holds the chain's far end:

1. `rope-solve` (`sweepChains` with `settleSet: this.heldVine !== null`, ~l.1514) splits the length correction between the ball and the bodies on the chain's path by inverse mass, so the berry is pulled toward the ball.
2. `spin-rollback` (~l.1643-1665) takes the spin's share of that correction back off every path body except those `keepsHaul` accepts. `freeHolder` excludes every `VineLink`, so a berry is always rolled back.
3. The winch pass (`winchOwed`, ~l.1768-1783) then solves the same constraint again with every other path body held immovable (`Rope.solveLengthHolding`). It hauls the ball alone toward the berry, and the ball is credited velocity for it.
4. `hang-load` (~l.1940-1980) hands the ball's weight to a rolled-back PIVOT or SPRING holder only, not to a berry.

So on every winding frame the berry is treated as bolted to the sky for the ball, and as unloaded for its own vine.
The vine swings on by itself, and the ball is hauled after a point that moves of its own accord.
This is the `session-149f` failure (docs/ball-chain.md, "A free rigid body the ball is hauling on across open air"), wearing the one holder `keepsHaul` excluded.

Numbers (`cli trace --body`):

- 221f f159: `rope-solve` moves berry 263 by (+5.0, +14.3) mm toward the ball and `spin-rollback` takes back exactly (-5.0, -14.3).
  The winch pass hauls the ball 16-18 mm a frame and credits it about 1.1-1.3 m/s a frame.
  The berry is swinging UP at 1.7 m/s with the 52 kg ball hanging from it.
  Over f150-172 the ball goes from 3.1 to 9.5 m/s while rising 1.3 m: +2439 J of ball energy, aimSpin 10-25 rad/s.
- 501f f330 (a pump, aimSpin -9): the berry's (-5.7, +4.3) mm is rolled back to the digit and the ball is credited +0.42 m/s a frame.
  Over f320-350 the ball gains 195 J from winding against a berry that never answers.
- 501f between pumps (no winding, so no rollback): the berry swings round its stalk joint as the ball passes under it (stalk angle from vertical 35 to 20 degrees, berry at up to 1.6 m/s).
  That is roughly physical: the chain is taut throughout at 0.650 m.
  What looks wrong is a thin stalk holding a 52 kg ball 20-35 degrees off vertical, which is a separate, stiffness question (see "Not the same problem" below).

Note also that each non-winding frame splits the berry between two solves.
The vine-only `scene-chains` pass lifts it 7-8 mm (about -0.45 m/s of credit), then the coupled `rope-solve` drags it 2.5 mm back.
This was not chased further.

## Why vine links were excluded in the first place

From the comments at the rollback and the winch pass, and docs/ball-chain.md:

- `session-1260f`: a 0.05 kg vine link rolled back with its length dropped refused 100% of the aim (the ball would not turn toward the cursor).
  The winch pass is what fixed that.
  `cli vines` `ball-steer` is the detector, and it is 5.8 degrees of loop lag against a 45 degree bar.
- The comment calls a vine link "the limit case of a light holder (~0.05 kg against the ball) whose whole vine the coupled sweep has to be left to apportion".
  Berries are 9 kg and cord links 4-5 kg today, so that premise is stale for berry vines at least.
- `session-215f`: a constraint-held anchor that KEEPS its share of winding the unwind then refuses is paid for winding that never happened, and the pair runs away (3 to 25 m/s in 35 frames).
  `cli contacts` `hung-anchor` is the slingshot detector for that: 1.6 m/s for a static anchor, bar 5 m/s.

## What was tried (both reverted)

### Attempt 1: berries keep the haul (`keepsHaul`)

The change was `freeHolder` excluding `body instanceof VineLink && body.passable` instead of every `VineLink`, so a berry in free air is neither rolled back nor winched against.

It fixes both recordings (forked A/B, same state, same inputs, `plans/berry-whip/fork.ts`):

| window | rule | ball peak | ball energy gain |
|---|---|---|---|
| 221f f150-178 | old | 9.49 m/s | +2439 J |
| 221f f150-178 | keep | 4.55 m/s | +124 J |
| 501f f320-372 | old | 2.94 m/s | +195 J |
| 501f f320-372 | keep | 1.62 m/s | 0 J |

With keep, the berry is dragged down and stays loaded in 221f, and in 501f the winding swings the berry round until it hangs over the ball.
Winding up the chain to the berry still works (`cli continue --hold deploy --whirl 30` from 501f f320 climbs from y 2.3 to 1.4).
`cli vines` (20/21, the one failure being ring-square, red on main), `cli spring` 22/22 and the berry test 8/8 all passed.
`cli contacts` failed only hook-sparks and chain-sweep, both red before the change.

It fails the whip rig (`plans/berry-whip/whip.ts`: hook a berry, hang, then circle the aim round the ball for 10 s as `hung-anchor` does):

| level, period | old (ball / berry peak) | keep (ball / berry peak) |
|---|---|---|
| berry-test, 48 f/rev | 4.3-6.5 / 4.5-8.8 m/s | 5.4-10.6 / 5.7-20.6 m/s |
| berry-test, 24 f/rev | 7.2-8.7 / 4.2-8.1 m/s | 10.6-25.9 / 8.7-46.2 m/s |
| ball.json, 48 f/rev | 3.5-14.2 / 4.1-12.8 m/s | 2.8-4.3 / 2.7-4.1 m/s |
| ball.json, 24 f/rev | 3.0-6.2 / 2.4-5.4 m/s | 5.4-46.2 / 4.0-48.1 m/s |

So keep is better on BALL in five of six legs, but it has a runaway (46 m/s on one ball.json berry at 24 f/rev, 26 m/s ball and 46 m/s berry on berry-test).
The old rule is itself a slingshot in this rig (up to 14 m/s against `hung-anchor`'s 5 m/s bar), which is Tris's complaint.

### Attempt 2: hand the berry the ball's weight (`hang-load`)

The rollback was kept, and a rolled-back berry was added to the `hang-load` holders, as pivots and springs get it.
The whip rig then ran away harder: berries up to 88 m/s, ball up to 53 m/s.
docs/ball-chain.md already records that a FREE body answers this impulse with acceleration (`session-324f`), and a berry evidently does too: the impulse is the 52 kg ball's weight on a 9 kg body, and the vine sweep only corrects it a frame later.
Do not retry this one.

## Assessment and next steps

The diagnosis is solid: the berry being rolled back and winched against is what makes 221f's whip and 501f's pumps, and keeping its share fixes both recordings.
What is missing is a statement of WHY keep runs away in a sustained whirl.
Find that before writing another fix (the project's "no fix before a measured cause").

1. **Diagnose the keep runaway first.**
   Put attempt 1 back behind a temporary switch (`(globalThis as any).__BERRY_RULE === "new"`, which both instruments set), run `whip.ts 24`, and find the first frame the berry's speed leaves the rim speed of the winding.
   For that, use a scratch probe or `cli trace` on a bundle recorded from the rig (`cli record` takes a script).
   Questions to answer, with numbers:
   - Which phase pays the berry: `rope-solve` credit, `scene-chains` (the vine sweep correcting the berry back), or `chain-settle` (`settleChainBodies` SETS a chain-held body's velocity from the phase's displacement)?
     The suspicion is that two solves are each paid velocity for the same correction.
   - Is the ball touching the berry during the runaway?
     Berries are solid to the ball, so a wound-tight ball should read `ridingPath` and be rolled back as before.
     If the contact carries no `normalImpulse`, or the cuff mounted on the berry changes what touches what, the free-air gate is being passed when it should not be.
   - Is the unwind refusing the frame's turn (`unwindRefund`, `window used` in the trace)?
     A berry keeping a share of refused winding is `session-215f` exactly.
2. **Likely fix: keep, but bounded.**
   Keep the berry's coupled share in free air (attempt 1), and bound what it is credited for the winding by the frame's rim speed - the bound the braced haul relies on ("nothing on the path is credited more than rim speed", docs/ball-chain.md).
   `Rope.boundRotationCredit` and `creditBound` are the existing bounds to read first.
   docs/ball-chain.md records that a credit bound computed from the bodies' own velocities chases a runaway once the pump has polluted them (`session-136f`).
   Bound against the ball's spin and spool (`lengthPerRadian`), not the berry's velocity.
3. **The principled alternative: one solve.**
   The ball's chain and the held vine are solved in separate passes (`scene-chains`, then `rope-solve`), and every one of these failures is a credit paid by one pass for a correction another pass undoes.
   docs/scene-chains.md describes tied chains on a substepped island solver, with "the ball's chain as a row of that island with its winch as a drum" (plans/rope-bridge.md).
   Solving a held berry vine and the ball's chain as one island is the textbook answer, and a much larger change.
   Assess it before committing to option 2 if option 2 needs more than one bound.
4. **Audit ordinary vines.**
   Plain vine links are excluded from `keepsHaul` for the same reason.
   The hook threads onto a plain vine through the vine ring (`lib/vineClamp.ts`, docs/vine-ring.md), so the chain's holder differs.
   Run the whip rig on a plain vine and say whether the same whip exists (docs say audit the class, not the instance).

## Verifying a fix

- **Red then green:** turn the whip rig into a case (in `scripts/test-berry-vines.ts`, or `cli vines` beside `ball-steer`).
  The case makes the `hung-anchor` statement about a berry: ball peak under its 5 m/s bar at 48 and 24 f/rev, the berry bounded too, and the chain still held.
  Show it red on the current tree and green with the fix.
  This is a no-energy-from-nowhere statement, not a feel bar, so it does not need to wait for a playtest.
- **The forks:** 221f f150-178 and 501f f320-372 through `fork.ts`.
  Target about the keep numbers above: no runaway, and the berry dragged toward the ball while it is loaded.
- **The guards:**
  - `cli vines` (`ball-steer` above all);
  - `cli contacts` (`hung-anchor`);
  - `cli spring` (`whirl-anchor`, `winch-anchor-load-hung`);
  - `bun run scripts/test-berry-vines.ts`;
  - then `bun run test`.
  Red before any of this: `contacts` hook-sparks and chain-sweep, `vines` ring-square, `sleep` arena, `assets` (CREDITS.md and the scene store), `levels` (the BALL mover), and `bundles`.
- **A browser bundle** recorded against the fix, with `cli diverge` run on it (rope/CLAUDE.md).
- **Feel** is Tris's to judge once it is green: how much a berry gives under the ball, and the berry's recoil when the chain lets go.
  With keep, a released berry sprang back at 3-4 m/s in the 221f fork.

## Not the same problem

- The stalk holds a hanging 52 kg ball 20-35 degrees off vertical (501f f340-364).
  Stalk stiffness is `0.5 - 0.2 * sway` (`src/level/vines.ts:728`, `buildStalkBends` in `vineBend.ts`), the momentum-free `StalkClamp`.
  Whether a loaded stalk should yield further is a feel question for Tris, separate from the whip.
- Stiff spans at stiffness >= 0.75 (struts lose to the bends) is a separate open item in docs/vines.md.

## Rules that bind this work (rope/CLAUDE.md)

- Edit source with the Edit tool, never sed.
- No fix before a measured cause.
- Two failed attempts means revert and report.
- Update docs/vines.md and docs/ball-chain.md in the same change.
- Never `git stash` while something runs in the background.
- Never pkill vite (Tris's dev server is on 3100).
- Never `git checkout` a level file: the editor autosaves.
- Bash timeouts stay at 30 s or less unless a longer one is justified.
- No em dashes.
- Commit only when asked.
