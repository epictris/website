# Pivot and spring bodies

## Pivot bodies

A rigid body may be **pivot-mounted** (`LevelBodyData.pivot`): bolted to a frictionless bearing at its centre of mass, so it spins under torque and never translates - a windmill fin the player lands on or hooks onto to swing around.
It is a flag on the `rigid` kind rather than a kind of its own, for the reason `impermeable` is a flag: a pivot body IS a rigid body - mass, inertia, Coulomb friction, the rope's torque arm - with one degree of freedom removed, and a kind would restate all of that to say one thing.

Translation is removed at the source rather than fought.
`RigidBody2D.inverseMass` reads 0 while `pivot` is set, so every impulse path - the contact solver, the character push, a cannonball's explosion - moves it nothing by the same arithmetic that moves a static nothing; `World.integrate` skips gravity and zeroes `linearVelocity`, which is what a direct velocity write (an area current, water's flow lerp) needs, since an inverse mass of 0 does not cover one; and `depenetrateRigid` declines the body outright, an overlap it is in being the contact solver's to resolve in rotation.
The origin being the centre of mass is what makes gravity torque-free about the bearing, so an unbalanced fin still hangs exactly where it was authored.
Water's angular drag still applies - a wheel in a river is slowed by it - and the mass stays the pieces' real sum, which is what a pushing character's impulse is sized against.

The rope is the one solver that does not deal in inverse mass - `correctShapePositionAndRotation` splits a correction by `inertia / (inertia + mass·arm²)` - so `getDynamicBodyState` hands it a pivot as `mass: Infinity`, and the one indeterminate limit (`angularFactor`, Inf/Inf) is written out as `1/arm`: the whole correction lands in rotation, and `arm·Δθ` is exactly the length the solve asked the body to remove.
The velocity credit is a no-op for the same reason the axle never moves.
The impulse-pairing audit exempts the linear half - the difference is the bearing's reaction, which nothing models - and keeps the angular half in full.

`cli contacts` `pivot-body` and `pivot-chain` are the detectors: the hold under gravity is exact (integrate skips the body, so the assertion is drift `=== 0`, not small), an off-centre impulse spins it by `cross(r, J)/I` while the axle holds, a falling box torques it the way the blow points through the pair solver, a hung weight turns it through the rope's torque arm (which is what reaches the `1/arm` branch), and the authored flag is asserted READ against a free control body - a build dropping it produces a level that looks identical and plays as a fin that falls out of the sky.
The editor authors it as a `pivot` checkbox on the rigid body's panel and marks the bearing with a ring-and-dot at the centre of mass, drawn for a body of one as well - unlike the compound diamond, being pivot-mounted is otherwise invisible on the canvas.

### An authored bearing, and the torsion spring

The bearing does not have to be the centre of mass.
`LevelBodyData.pivotX`/`pivotY` put it at an authored point in the body's own frame - a branch hinged where it meets the trunk - and `pivotFreq`/`pivotDamping` add a torsion return spring about it, so the body bends away under a load (a hanging player, a thrown crate, chain tension) and springs back to its authored angle when the load leaves.
This is the "tree branch" mechanic, and it is deliberately NOT the linear spring: a spring body translates and never rotates, where a branch is locked to rotating about its hinge.

The implementation is one move and everything else follows: `buildLevelBodies` re-origins the body onto the bearing (`reoriginTo` - the pieces' local offsets absorb the shift, the inertia gains the parallel-axis term, and the centre of mass is kept in the body's local frame as `RigidBody2D.pivotComOffset`).
With the origin AT the hinge, `inverseMass` 0 holds the axle and every lever arm the engine measures from `globalPosition` is the hinged body's own, so contacts, the rope's `1/arm` branch, explosions and the character push are all exact for a hinged body with no code of their own.
What does need code is gravity, which is no longer torque-free about the bearing: `World.integrate` applies `m·g × r` about the hinge, summed with the torsion spring's `-w²·Δθ - 2ζw·ω` into ONE acceleration and applied once - the damping term must read the frame's incoming angular velocity, not one with gravity's increment already in it, or the settled angle sits a measurable 10% off the closed form.
Both terms are guarded so a plain centre-of-mass pivot adds literally nothing and every recorded pivot replay stays bit-identical.

The frequency is in Hz for the linear spring's reasons - a rate crosses `scaleLevelData` untouched, and `k = I·w²` is implied so the free oscillation is mass-independent - while the bearing point is a length and scales.
The angle is deliberately not wrapped: a body wound a full turn unwinds a full turn, which is what a torsion spring does.
`mechanicalEnergy` reads a pivot body's gravitational potential off the CENTRE OF MASS (the bearing origin never moves, so PE read off it turns the whole KE↔PE exchange of a free swing into an unforced gain) and carries the torsion elastic term `0.5·I·w²·Δθ²`.

`cli spring` carries the detectors (`pivot-droop`, `pivot-pendulum`, `pivot-period`, `pivot-authored`, `spawn-at-rest`, `winch-load` for what a wind-up does to a sprung anchor, and `whirl-anchor` for the pivot-anchor slingshot - see the spin rollback under the ball chain), because like the linear spring the whole behaviour is arithmetic with a closed form: the droop is the root of `I·w²·Δθ = m·g·d·cos θ`, a free off-centre bearing is a physical pendulum at `2π·sqrt(I/(m·g·d))` with the axle asserted at `=== 0` drift, the torsion oscillator runs at `1/f` with the energy flat, and the authored fields are asserted read, scaled, clamped, and bit-for-bit inert on a plain pivot.
`TEST_BRANCH` is the worked level - the spring level's chasm with the leaf replaced by a bough hinged at the far wall.
In the editor, ticking `pivot` offers `pivot x`/`pivot y` (blank = the centre of mass; the axle ring draws at the authored point) and `return (Hz)`/`damping` for the spring; the point is held frame-local in the model (`EdItem.pivotAt`), so every gesture that moves or turns the body carries the bearing with it for free.

### Sprung bodies spawn at rest

A spring body, a torsion-sprung branch and a free off-centre pivot all SPAWN at the rest pose the suite proves they settle to (`applyRestPose` in `buildBodies.ts`), so a level does not open with its leaves and branches visibly falling into place.
The authored pose keeps its whole meaning - it is the spring's anchor and the torsion spring's rest angle - and the spawn displacement is the same closed-form equilibrium `cli spring` asserts the sim settles to: a fixed point of the integrator, the statement `buildVines` already makes about a catenary, so a settled body is at rest on frame one.
A centre-of-mass pivot and a plain rigid body spawn EXACTLY at their authored pose, which is the bit-identity rule; recorded bundles containing spring bodies legitimately diverge (informational, per the usual bundle semantics).

Two frame correspondences are load-bearing.
`BuiltBody.origin` is captured BEFORE the displacement, because `localPlacement` resolves every geometry object, decoration and chain anchor against the frame the authored placements were written in - captured after, a leaf's visual stands at the authored spot while its body hangs below it.
And a chain or vine anchor on a sprung body resolves its material point through `anchorWorldPoint` (`chains.ts`): the authored placement mapped through that correspondence onto the body's spawned transform, so the anchor rides the settle and a taut chain's derived length is the distance between the anchors AS THEY LAND - resolved through the authored placement instead, the chain spawns slack by the droop and yanks on frame one.
The undisplaced path deliberately keeps the plain `worldPlacement` answer, since the local round trip costs two rotations of float noise and every level with no sprung body must stay bit-identical.

The editor shows the same thing twice.
Its 3D scene is built through the same `buildLevelBodies`, so the drawn model simply stands at the rest pose; and the 2D canvas draws a dashed **settled ghost** of each displaced body's collision outlines at the rest pose (`settledGhosts` in `editor/model.ts`, cached per model revision - it is a full level build), while the authored outline stays what is drawn and edited, it being the datum the spring hangs from.
`spawn-at-rest` in `cli spring` pins all of it: the three spawn poses against the closed forms, zero movement over 300 untouched frames, the exact authored spawn of the two controls, the chain length between the anchors as they land, and the ghosts reading the same three displacements with none for the controls.

## Spring bodies

A rigid body may instead be **spring-mounted** (`LevelBodyData.springFreqX` / `springFreqY` / `springDamping`): anchored to its authored position through a two-axis spring-damper, so it sags under its own weight, sags further under a load - a hanging player, a resting rock, chain tension - and springs back with a visible underdamped overshoot when the load leaves.
The first use is a plant whose leaf the player grabs, the spring standing in for the stem bending (`TEST_SPRING`).

It is a flag-set on `rigid` for exactly the reason `pivot` is, and the reason is the load paths: every one of them - contacts, the character push, the rope and chain solvers, explosions, water - already speaks to a `RigidBody2D` through impulses, so a `RigidBody2D` with one extra force couples to all of them with no new plumbing.
The alternative, an `AnimatableBody2D` running its own spring sim, collides as infinite mass and would feel none of them without bespoke force-sensing at every interaction site.

Where `pivot` removes translation, `spring` removes **rotation** - a leaf on a stem translates, it does not spin - and the two are mutually exclusive, since together they describe a body that cannot move at all.
The removal is at the source in the same way: `inverseInertia` reads 0 while `spring` is set, which covers every impulse path at once, and `World.integrate` zeroes `angularVelocity` before the rotation step because an inverse inertia of 0 does not cover a direct write (water's angular drag is one).
It is deliberately NOT `inertia = Infinity`: `mechanicalEnergy` computes `0.5·inertia·w²` and `Infinity·0` is NaN.
The rope is again the one solver that does not deal in inverse inertia, so `getDynamicBodyState` hands it a spring body as `inertia: Infinity` and the split's other indeterminate limit is written out alongside the pivot's (`linearFactor = 1`, `angularFactor = 0`): the whole correction lands in translation, which is the axis the spring then recovers along.

The force is a damped harmonic oscillator per axis about the anchor, `a = -w²·offset - 2·zeta·w·velocity`, folded into the same semi-implicit Euler step gravity takes.
Applied in the gravity phase and not as an impulse, which is what keeps it outside `auditImpulses`'s window - it snapshots velocities around `solveContacts` only, so a force applied there needs no pair bookkeeping, exactly like gravity.
The audit's **angular** half is exempted for a spring body, mirroring the linear exemption a pivot gets: with inverse inertia 0 an applied torque turns it nothing and the difference is the stem's reaction, which nothing models.
The linear half stays audited in full, which is the point - being loadable through ordinary impulses is the whole reason this is a rigid body.

Authored as a **frequency in Hz**, not a stiffness, and the choice carries three things.
It is a 1/s rate, so like `drag` it passes through `scaleLevelData` untouched and there is nothing that can be mis-scaled.
The free oscillation is mass-**independent** (`k = m·w²` is implied), so a leaf re-authored in a heavier material bounces at the same rate and droops the same amount under its own weight.
And the two numbers an author is actually choosing have closed forms - `droop = g/w²`, and an external load `F` adds `F/(m·w²)` - so a heavy stiff plant barely notices the player and a light whippy one plunges.
That second one is deliberately mass-dependent, and the editor shows both as live readouts beside the frequency, next to the mass readout they are tuned against.
0 or absent on an axis **pins** that axis to the anchor instead (a leaf that only bobs vertically); frequencies are clamped to 0..8 Hz, which is already visually rigid and well under the ~19 Hz where semi-implicit Euler stops being stable at the fixed 1/60 step.

The one load path that was missing is the **ledge hang**, which pins the player kinematically to the corner and applies no force to the body it hangs from - correct for a static or a mover, and for a spring body it means a hanging player weighs nothing.
`applyHangLoad` (`classes/states/ledgeLoad.ts`) transfers it explicitly, one frame's `m·g·dt` at the corner, from both `LedgeHangState` and `LedgeClimbState`.
The coupling is one-way and stable by construction: the player is positionally pinned and the hang re-derives the corner's world position every frame, so it rides the droop down the way it already rides a mover, while the body feels a constant weight.
Standing on a spring body is the case that is *not* principled yet - the character push (`CHARACTER_PUSH_FACTOR`) transfers approach velocity rather than standing weight, so a stood-on leaf depresses somewhat but not by a derived `m·g/k`.

`cli spring` is the detector, and it asserts the arithmetic rather than a settled solver: the droop against `g/w²` at three frequencies, the hang against `F/(m·w²)` through `applyHangLoad` itself, a chain-hung weight against the *same* `F/(m·w²)` (the chain is the one load path that is a positional constraint rather than an impulse), the per-axis periods against `1/f` by zero crossings, the two locks at `=== 0` (they are held by a snap, so "small" would be the bug), a box resting on the leaf with the audit armed, the elastic-energy term, the authored fields with their clamp and the pivot exclusion, and a no-spring body's free fall bit-for-bit.

`chain-drain` is the odd one out and worth reading before the next "the swing feels dead" report.
The obvious way to ask whether the chain is treating a spring body honestly is an energy budget - a PBD link is rigid, does no work, so it may remove nothing beyond the dashpot's `2·zeta·w·m·v²` - and it does not work, because the chain rewrites the body's velocity twice a frame (the integrate step, then the solve's credit) and that integral comes out three times larger or smaller depending which sample you take.
What is unambiguous is the **comparison**: two rigs identical but for the anchor, one on a `StaticBody2D` and one on a spring body, same weight, same chain, same kick.
The static rig is the rope solver's own baseline, and this engine's chain is genuinely lossy - a taut pendulum on a rock-solid wall gives up **97% of its kick in 20 seconds**, which is a property of the PBD solve and nothing to do with spring bodies.
Measured side by side the spring anchor gives up 15.83 J against the wall's 15.69 J and leaves the weight moving four times faster, so a swing on a spring body dies no faster than one on a wall; what makes an authored one *feel* dead is the authored damping, which at zeta 0.15 and 1 Hz on a 110 kg body is a ~200 N·s/m dashpot sitting between the chain and the world.
Lower `springDamping`, a higher frequency or a heavier body are the three knobs, and the editor's droop readouts are what they are tuned against.
`mechanicalEnergy` carries the elastic term `0.5·m·(wx²·dx² + wy²·dy²)`, without which the leaf springing back reads to `EnergyMonitor` as an unforced gain; damping only removes energy, so its one-sided bound stays valid.
`playtests/ledge-spring-leaf.json` is the mechanic end to end - run off a lip, catch the leaf, ride it 31 cm down, let go - and it is red on a hang that transfers no weight.
`session-111f` is the recorded artifact: an authored ball level whose chain is anchored to a spring platform, in the corpus so the coupling stays bit-for-bit.
The editor authors the three fields beside the pivot checkbox, each control disabling the other, and marks the mounting with a coil at the centre of mass, aligned to whichever axes are actually sprung.
