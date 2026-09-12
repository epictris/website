# Sleep: a settled body costs nothing

Rigid bodies and authored chains sleep (2026-09-10).
It is the vine's rule ([**A settled vine costs nothing**](vines.md#a-settled-vine-costs-nothing)) taken for everything: a body that has gone nowhere for half a second is skipped by `World.integrate`, by the contact gather as a source and by every depenetration pass, and a chain whose bodies are all asleep is out of the frame's chain set - not swept, not settled, not re-solved by the coupled sweep.
The whole ball arena left alone costs **0.09 ms** a physics frame asleep against 1.0 ms awake, and the ball hanging off a lantern among five sleeping ones is a 4.5-7 ms step under a 4x throttle where it was 12-14 (`session-392f`, `cli sleep` and the numbers in [**Transform caches**](physics-foundations.md#cross-platform-determinism) for the half that was arithmetic).

**The rest rule is net displacement over a window, never velocity**, and both halves come from the vine.
A body hanging on a chain carries a permanent velocity churn - gravity takes it 2.7 mm down and the chain solve credits it the lift back, every frame for ever - so a speed test never sleeps it, and per-frame movement is a limit cycle about a point it does not leave.
`World.settleSleep` runs at the end of every frame: a body that has not left the mark it opened its window on by `SLEEP_DRIFT` (2 mm, and 2 mrad of rotation - 2 mm at the end of a metre plank) after `SLEEP_FRAMES` (30) is asleep, and one that leaves it by `MOVING_DRIFT` (5 cm, 50 mrad) has clearly been set moving and starts its window again from where it is.
A body sleeps with its velocity zeroed: it is the churn it was put to sleep for not having, and a body woken carrying it would jump.
`RigidBody2D.canSleep` says whether the rule applies at all - not the avatar (input can move it on any frame), not its hook, not a cannonball, and not a vine link, which sleeps with its vine.

**Damping is what lets a hung body reach the rule at all**, exactly as `LINK_DAMPING` was for a vine: a PBD length constraint dissipates nothing, a body in free air touches nothing, and the sweep's tolerance feeds the swing.
Undamped, every lantern in the arena swung for ever at 3-60 mm and restarted its window at frame 29 for the whole session.
`dampChainBodies` takes 1% of a scene-chain body's velocity a frame (`CHAIN_BODY_DAMPING` 0.99, lighter than the vine's 0.98 because iron on a chain rings longer than rope, and a knob to play), before the phase's snapshot for the reason the vine damps before its own, and never from a body the avatar's chain has hold of (`RigidBody2D.held`): what a swing on a lantern feels like is the ball's chain phase's to decide, and this must not change it.

**What wakes a body is anything that could move it**, and each is a case in `cli sleep`:
- a contact from an awake body (`World.resolveDynamicCollisions`, after the gather). The gather is done FOR the pair's leading side and the lower id led, so a sleeping lead returned nothing and an awake crate slid clean through a sleeping one with the lower id; the awake side leads now (`collectPairContacts`, the `lead` case);
- the avatar's chain: every body on the rope's path is `keepAwake`d at the top of the frame, the anchor it took this frame included, so a held body's window never runs (the `hook` case);
- a mover: a platform that moved this frame wakes whatever is within a contact's reach of it (`World.wakeTouching`), because a kinematic body is never a contact's leading side and nothing else would notice; one parked at the end of its route lets its cargo sleep (the `platform` case);
- a force area, water, and any impulse (`applyImpulse`);
- its chain (`SceneChain.wakeIfDisturbed`, top of the frame): an awake chain wakes any body still flagged asleep, since the solve is about to move it - a no-op on a body already awake, which is what lets it be asked every frame without holding anything awake.

**A sleeping chain wakes when something could move it, and "something" had to be narrowed twice.**
A chain watches its two ends and every wrappable body in the level (the wrap list), and "any watched body moved" was true on every frame the ball rolled anywhere.
Now an end or a body on the path moving at all wakes it with its bodies (`carried`); any other watched body only by moving into the box the chain sleeps in grown by `WAKE_REACH` (0.25 m - the hook at 12 m/s is 0.2 m a frame), and that wake is tentative (`reached`): the chain is solved that frame and its bodies are woken only if the solve moved one (`sleepIfSettled`), so a ball swinging past a row of lanterns costs each a solve on the frames it is close, not a window of gravity and contacts.
And `transformVersion` now moves only when the VALUE does (`CollisionObject2D.globalPosition`): the winch's haul rollback writes every rigid body's transform back unconditionally, and a write of the same number bumping the version woke every sleeping chain in the level on every frame the ball wound its chain.

**Chains are settled at build** (`settleChainsAtBuild`), the vine's `settleVinesAtBuild` for chains, so a level arrives with its hanging things asleep instead of spending the first five seconds of play swinging them out (180-330 frames a lantern on `session-392f`).
The loop runs gravity and the chain phase and nothing else, so only a chain whose every rigid body hangs clear of anything mobile and of every area, and is neither a pivot nor sprung, is settled there - static scenery beside a body is fine, the chain phase's own settle pushes a chain body out of statics - and a chain sharing a body with one that cannot be is left with it.
The rest settle live, as everything did before.

What this changes: replays.
A body sleeping is a body whose residual velocity was zeroed, so a recording made before this diverges from the new physics somewhere after its first hanging thing settles (`cli bundles`: 69 of 93 drifted-since-recorded against 67 before, `session-821f` now drifts at f199 instead of f298).
One bundle turned red with it - `session-821f` gains 26 J over the thirty frames to f316 with the ball riding a swinging lantern by the ring on its handle, nothing asleep within a metre and the chain awake and undamped (held) - which is the new trajectory reaching a gain the ring-and-handle rig can produce (see [**The manacle on a rail**](rails.md)) rather than anything sleep does on those frames; it is open, and it is the one red in the corpus.
