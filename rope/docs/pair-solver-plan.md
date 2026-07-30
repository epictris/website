# Plan: a real rigid-vs-rigid pair solver

## The defect

Rigid-vs-rigid contacts never exchange momentum.
Each body independently cancels its own approach velocity at the shared contact, and neither drives the other, so a body landing on another *stops* it rather than knocking it round.

Measured on `session-120f`, where the top of two compound groups lands square on the bottom one:

```
f62  ENTER StaticBody2D n=1   w=-0.0082
     StaticBody2D[1]          w -0.0082 -> +0.1017   floor contact spins it up
     ENTER RigidBody2D n=1    w=+0.0988
     ENTER RigidBody2D n=1    w=-0.0587              top group cancels it
     frame ends               w=-0.0110
```

The impact that should drive the bottom group's rotation is what removes it.

The cause is structural.
`World.resolveDynamicCollisions` loops over bodies, and for each body over every `(shape, shape)` pair against every other body, calling `resolveRigidLoop` / `resolveRigidCircle`.
Those routines only ever write to `body`.
The pair A-B is therefore visited **twice**, once with A as `body` and once with B as `body`, and each visit solves half the contact (`RIGID_PAIR_SHARE = 0.5`) in ignorance of the other.
Two independent one-sided solves are not an impulse pair: nothing makes them equal and opposite, so momentum is not conserved and none is transferred.
The circle rigid-rigid branch is worse still: it measures the approach as `body.linearVelocity.dot(normal)`, with no angular term and no reading of the other body at all.

## The fix in one sentence

Compute one impulse per contact, once for the pair, and apply it equal and opposite.

## This is a solved problem

What this plan builds is the **sequential impulse solver** (Catto, GDC 2006) - the formulation Box2D uses and effectively every 2D game engine has converged on.
That is deliberate: nothing about this game's rigid bodies is novel, and every design question below should be answered "what does Box2D do" unless the rope gives a specific reason not to.
The novel mechanic is the rope constraint solver, and it is exactly the part this plan does not touch: it stays a PBD pass that runs after `World.integrate`, reads the velocities the contact solve leaves, and writes positions directly.
The contact solver's job is to hand that pass a scene whose velocities are physically sane, in the same frame order as today.

Mapping the standard pieces onto this plan:

| Standard piece | Status here |
|---|---|
| One constraint per manifold point, solved for the pair | The core of this plan (Phases 1-2) |
| Accumulated impulses, running total clamped at zero | Already in `resolveRigidLoop`; hoisted to the pair |
| Restitution bias captured pre-solve | Already done; carried over |
| Coulomb friction clamped against the accumulated normal impulse | Already the rule in all three friction sites; unified in Phase 3 |
| **Warm starting from last frame's impulses** | Missing everywhere; added in Phase 2 |
| **Restitution velocity threshold** | Missing; added in Phase 2 |
| Position correction with slop | Partially (the depenetration sweep); see **Positional recovery** below |
| Broadphase, islands, sleeping, CCD, sub-stepping | Deliberately not built; see **Deliberate deviations** |

## What is already in place

Several pieces of this were built during the resting-contact work and carry over unchanged:

- **Positional recovery is already separate.** `resolveDynamicCollisions` closes with a scene-wide sweep of `depenetrateRigid`, so the contact routines solve velocity only. The pair solver inherits that split and does not need to touch position.
- **Accumulated, iterated impulses with a running-total clamp** already exist in both `resolveRigidLoop` branches (`NORMAL_SOLVER_ITERATIONS`, `totals`). The formulation is right; it is applied to one body instead of two.
- **Restitution is captured pre-solve** rather than re-derived per iteration, which is the trap that makes an iterated solver invent energy.
- **Coulomb-capped friction** exists in three places and is correct in each.
- **The two-point manifold** (`engine/manifold.ts`, SAT + incident-face clipping) is the standard 2D narrowphase and needs no change beyond emitting feature ids (Phase 1).

So this is less "write a solver" than "hoist the solver that is already there up to the pair level, and stop visiting each pair twice".

## Phases

### Phase 0: commit the tests first

Nothing here is verifiable without a regression net, and the scenarios used to validate every fix so far live in a scratch directory and get re-derived by hand each time.
Promote them into the repo as `src/sim/contactCases.ts` plus a `cli contacts` command, in the style of `sim/cornerCases.ts` (pure scenarios with the answers written down):

| Case | Asserts |
|---|---|
| `settle` | four awkward polygons dropped on a floor reach `abs(w) < 0.01` and a rotation span under 0.2 deg over the last 120 frames |
| `stack` | a four-body pile on itself reaches the same |
| `ramp-hold` | a box on 5, 20 and 30 deg ramps drifts under 10 cm in 15 s |
| `ramp-break` | a box on a 40 deg ramp slides (breakaway is `atan(mu_s)`, about 35 deg) |
| `topple` | a box dropped at 20 and 40 deg settles flat, `abs(rot) < 1 deg` |
| `pivot` | a tall slab tipped past balance reaches `abs(w) > 2 rad/s` on the way down |
| `impact-transfer` | **new**, and the case this plan exists for: a body dropped onto a resting body must leave the struck body with angular momentum of the right sign and a plausible magnitude |
| `momentum` | **new**: across the impact frames of `impact-transfer`, the pair's total linear momentum changes by exactly gravity's impulse, within tolerance - the invariant a pair solver gives that no one-sided solve can |
| `penetration` | across all of the above, no standing overlap above about 5 mm |

Assert bounds, never exact numbers.
Land this phase on its own, with no behaviour change, so the baseline is recorded in the repo rather than in a chat log.

### Phase 1: separate gathering from solving

Pure refactor with no behaviour change: `collectContacts` lands as new code that nothing calls yet (the old routines keep running until Phase 2 flips over), so `cli bundles` staying bit-identical is trivially guaranteed and the review is about shape and determinism alone.

Add `collectContacts(): ContactConstraint[]`, where a constraint is one manifold point:

```ts
interface ContactConstraint {
  a: RigidBody2D;              // always dynamic
  b: PhysicsBody2D;            // dynamic, or static (infinite mass)
  point: Vec2;
  normal: Vec2;                // fixed convention: out of b, toward a
  depth: number;
  featureId: number;           // which face/vertex pair produced this point (from the clip),
                               // stable frame to frame - the warm-start matching key
  // solver state, filled during the solve
  normalImpulse: number;
  tangentImpulse: number;
}
```

Three things this must get right:

- **Each pair appears once.** Iterate ordered pairs (`i < j` over `this.bodies`) rather than "every body against every other". This is the double-visit, and removing it is what makes `RIGID_PAIR_SHARE` unnecessary.
- **Order is a pure function of body index and shape index**, so the solve is deterministic. `replay selftest` must stay green.
- **Feature ids.** The manifold clip already knows which reference face and incident edge produced each point; encode that as a small integer so next frame's matching contact can be recognised. This is Box2D's `b2ContactID`, and it is what warm starting keys on.

Static targets stay in the list as one-sided constraints with zero inverse mass and inertia, which lets the same solver handle both and removes the static/dynamic branch split.

Keep the existing exclusions: `removed`, `exceptions`, `isSolidTarget`, and `getShapes()` iteration for compound bodies.
The O(n²) pair loop stays: at this scene scale a broadphase is complexity with no payoff.

### Phase 2: the normal solve

Precompute per constraint:

```
rA = point - a.globalPosition
rB = point - b.globalPosition
invEffN = a.inverseMass + b.inverseMass
        + (rA x n)^2 * a.invI + (rB x n)^2 * b.invI
```

with `invI` forced to zero for a body whose `kinematicRotation` is set, exactly as the current code does, and both inverse terms zero for a static `b`.

**Restitution** is captured once, pre-solve, from the pair-relative approach velocity at the point (both bodies' `velocityAtPoint`, not `a`'s alone).
Combine rule: `max(a.restitution, b.restitution)`, the Box2D convention.
Apply a **velocity threshold**: approach slower than about 0.5-1 m/s earns no bounce.
Without the threshold, restitution above zero makes resting contacts micro-bounce forever on the velocity gravity re-adds each frame; every engine gates it.
Default restitution is 0 and rigid-rigid contacts currently have none at all, so with defaults this is bit-equivalent and the threshold costs nothing.

**Warm starting**: before iterating, apply each constraint's *previous frame's* accumulated impulses (matched by `(a.id, b.id, shapeIndexA, shapeIndexB, featureId)`) equal and opposite, and start the running totals there instead of at zero.
This is the piece the current engine has never had, and it is not an optimisation: with 4-10 iterations a cold-started solver re-derives the entire support load of a stack from scratch every frame and never quite gets there, which is precisely the class of residual-jitter bug the resting-contact work has been fighting one symptom at a time.
Warm started, the iterations only correct the *change* since last frame, so stacks and piles hold with the same iteration budget.
The cache is a plain map keyed by the tuple above, rebuilt each frame; looking a key up is deterministic - the determinism rule (see Risks) is about *iteration order*, which stays the pair loop's, never the map's.
A stale entry (contact gone) is simply dropped; a wrong guess costs iterations, not correctness.

Then iterate the whole list `VELOCITY_ITERATIONS` times (take Box2D's default of **8**; the current 4 was tuned for single-manifold convergence), accumulating per constraint and clamping the running total at zero, applying each increment equal and opposite:

```
a.linearVelocity  += n * (dP * a.inverseMass)
a.angularVelocity += (rA x n) * dP * a.invI
b.linearVelocity  -= n * (dP * b.inverseMass)
b.angularVelocity -= (rB x n) * dP * b.invI
```

`RIGID_PAIR_SHARE` is deleted here.
That constant only ever existed because each side solved half in ignorance of the other, which is precisely what this phase removes.

Not adopted, on purpose: Box2D's 2x2 **block solver** for two-point manifolds (exact simultaneous solve of a face's pair of points).
Sequential accumulation converges to the same answer with a couple more iterations; the block solve is a refinement to reach for only if `settle`/`stack` show residual rock at 8 iterations, not before.

### Phase 3: friction on the pair

Fold the three current friction implementations into one tangential constraint per contact, in the same iteration loop as the normals, through the two-body tangential effective mass (`invEffT`, same form as `invEffN` with `t` for `n`).
Order within an iteration: **tangent first, then normal** - Box2D's ordering, so the non-penetration solve gets the last word over anything friction just did.
Accumulate the tangent impulse and clamp it to the Coulomb cone against that constraint's **own accumulated normal impulse**: `|tangentImpulse| <= mu * normalImpulse`.

The `gravityBite` estimate does not survive into the pair solver.
It exists because the one-sided routines size the friction budget from the normal velocity they just killed, which at rest is one frame of gravity and sometimes zero; the accumulated normal impulse *is* the support load, so `mu * Pn` is the whole cap, warm starting keeps it honest across frames, and the estimate would double-count.

**Define one combine rule.** The three current sites each compute `body.contactFriction * other.surfaceFriction`, which is asymmetric the moment both bodies are rigid.
Take the geometric mean of the two sides' products (Box2D combines with `sqrt(muA * muB)`); against a static body with `surfaceFriction = 1` and the default coefficients this reduces to the current arithmetic, which is what the replay corpus was recorded under.

Two body-level knobs need a home:

- `contactDamp` is currently applied once per `(shape, shape)` pair, which a pair loop would apply several times over. Move it to once per body per frame. (It is a nonphysical drag a standard engine would express as global linear damping; it stays because its default is replay-locked.)
- `contactBrakeScale` is a ball-controller device on the kinetic path. Carry it as a per-body scale on braking tangential impulses.

**Relative slip becomes legitimate again.** `applyRigidContactFriction` deliberately measures slip against the world rather than the other body's surface, because a one-sided routine that reads the other body's motion invents energy, and the ball is the worst possible thing to read it from: its spin is kinematic, and its linear velocity is whatever the chain solve last credited it (`session-611f`, where a hanging ball walked its anchor 3.6 m across the level).
A true pair solve is equal and opposite by construction, so slip measured between the two contact points - the standard formulation - conserves momentum and the reaction lands on the ball.
That is the *intended* outcome, but it re-opens the path, so `impact-transfer` needs a sibling case: a ball spinning against a crate must not accelerate it without bound.
The physics argument for why it cannot: the drive is friction-capped at `mu * Pn`, and the reaction decelerating the ball is now real - but the ball's spin being kinematic means the "reaction" onto its angular velocity is discarded, so the case must be asserted, not assumed.

### Phase 4: stiction and the stick anchor

Stiction is a body-versus-static idea and should stay one.
Recommended split:

- The **velocity** half of the grip is subsumed by Phase 3: it is already a Coulomb-capped tangential impulse solved at the contact points.
- The **position pin** stays as it is. It solves a different problem (gravity's per-frame integration step, which no velocity constraint can remove under this engine's integrate-then-solve ordering - see **Deliberate deviations**), and it now correctly anchors a *material* point of the body (`stickLocal`) rather than the body centre or the geometric manifold point.
- `ungrippedFrames` / `STICK_RELEASE_FRAMES` and the anchor-carry through the depenetration sweep stay unchanged.

The `stuck` return value becomes "did any static constraint for this body stay inside its friction cone", which the pair solver can report directly.

For the record: a standard engine has no stick anchor.
It gets resting stability from warm starting plus solving velocities *before* integrating positions, so gravity's step never lands unopposed.
This engine integrates first (replay-locked, and the rope phase depends on it), so the pin is the honest patch for the ordering and is kept deliberately, not as a leftover.

### Phase 5: leave the circle path alone at first

`resolveRigidCircle` carries the ball and chain avatar's steering branch and a centred-circle path that is bit-identical to every recorded replay.
Do not fold it in during this work.

Route **rigid-versus-rigid** contacts through the pair solver and leave **body-versus-static** on the existing routines for the first landing.
That is where the defect is, it keeps the ball's static behaviour untouched, and it makes the diff reviewable.
Unifying static contacts into the same solver is a worthwhile follow-up once `contactCases` has been green across a few changes - and a valuable one, because warm-started static manifolds are where Box2D's resting-stack quality actually comes from, and several of the resting-contact patches above (the damp, the iteration tuning) exist to compensate for its absence.

### Phase 6: check the rope

`Rope` and `BallLevel` run after `World.integrate` and read the velocities the contact solve leaves.
Changing those velocities has repeatedly moved the chain's blocked-length lease.
Re-run the full ball corpus and watch `rope-grew` and `rope-stalling` specifically; both tolerances have already been moved once each and should not be moved again without the same standard of evidence (measure the corpus distribution, render the frame, confirm the block is real).

The warm-start cache needs no rope-awareness: the rope rewriting the ball's velocity after the solve does not invalidate cached impulses, because a cached impulse is a starting guess, not a claim about state - a bad guess costs iterations and nothing else.

## Positional recovery

The scene-wide `depenetrateRigid` sweep stays as the position pass for this landing: the pair solver changes velocity resolution only, and the plan inherits the existing velocity/position split unchanged.

Known limitation to carry forward, not fix now: the sweep resolves only the two deepest overlaps per body per pass, resolves them to **full depth**, and knows nothing about the contact set the velocity solver just used.
The standard alternative is a nonlinear Gauss-Seidel position pass over the *same* `ContactConstraint` list - per-contact, correcting only penetration beyond a slop (a few mm) and only a fraction of it per iteration (Box2D uses 0.2), which is gentler and converges piles that the two-deepest heuristic cannot.
The two most recent bundles standing at 20.1 mm and 12.5 mm against a 5 mm corpus is the signature of that limitation, and momentum transfer (which shoves bodies into each other harder) will lean on it more.
Plan of record: land the pair solver on the existing sweep, and if `penetration` regresses, replace the sweep's rigid-rigid share with an NGS pass over the contact list as its own follow-up.

One part of the recovery is **not** negotiable: the full-depth, geometry-wins push-out of the *ball* against scenery.
The chain phase derives the ball's velocity from realised displacement and its whole accounting (`session-1474f`, `session-537f`) is built on the push-out running first and winning; partial correction there would hand the rope a body still inside a wall.
Rope compatibility is the reason this engine keeps a nonstandard position pass at all.

## Deliberate deviations from the standard pipeline

Recorded here so nobody later "fixes" them into Box2D orthodoxy without noticing what they hold up:

- **Integrate-then-solve ordering.** Box2D applies forces, solves velocities, *then* integrates positions. This engine moves bodies first and solves contacts on the post-move overlap. Reordering would re-time every recorded replay and the rope phase (which is specified to run after `integrate`), for no gameplay gain; the cost - contacts acting one frame late, gravity's step landing before friction can answer it - is exactly what the slop, the stick anchor and the depenetration sweep exist to absorb.
- **The stick anchor** (Phase 4): a position pin standard engines do not need, kept because of the ordering above.
- **`contactDamp`**: nonphysical per-contact drag with a replay-locked default.
- **No broadphase, no islands, no sleeping.** Scene scale does not justify them. Sleeping is the standard answer to the "momentum transfer destabilises settled piles" risk below; if that risk materialises beyond what `settle`/`stack` tolerate, island sleeping is the wheel to import rather than more damping.
- **No CCD / speculative contacts, no sub-stepping.** Body speeds are bounded by the invariants; tunnelling has never been the failure mode (the rope's failure modes are geometric, and have their own tooling).

## Verification at each phase

`cli contacts` (new), `cli bundles`, `replay selftest`, all playtests, `cli ledges`, `cli corners`, `tsc --noEmit`.

Phases 0 and 1 must be bit-identical: `cli bundles` should report `maxDrift` around 0 px for faithful bundles.
Phases 2 onward will diverge recorded bundles, which is informational; the invariants are the pass/fail signal.
The `momentum` case is the sharp new check: momentum conservation is the property the pair solver exists to provide, so assert it directly rather than only through downstream symptoms.

## Risks

- **The ball is a `RigidBody2D`.** Anything routed through the pair solver can now push the ball. Its velocity is partly owned by `BallLevel` (the chain phase derives it from realised displacement), so a contact impulse landing on the ball outside that accounting is a new interaction. Phase 5's scoping limits the exposure but does not remove it: ball-versus-crate is rigid-versus-rigid and goes through the new solver on day one.
- **Momentum transfer is destabilising by nature.** Piles that currently sit still because nothing drives them may start moving. `stack` and `settle` are the guards; warm starting is the standard mitigation, which is why it is in Phase 2 and not a follow-up.
- **Penetration may regress.** The positional sweep is unchanged, but bodies that now get shoved will overlap more before it catches up. See **Positional recovery** for the prepared answer.
- **Determinism.** Iteration order over the contact list must be a pure function of body/shape/point index. The warm-start cache is keyed lookup only and safe; the rule broken by "any set or map iteration" is about *ordering* the solve from a map, which nothing here does.

## Sizing

Phase 0 is the largest single piece of writing and the one that pays for itself immediately.
Phases 1 and 2 are the core; Phase 2 carries the two genuinely new mechanisms (warm starting, restitution threshold) and both are small once the constraint list exists.
Phase 3 is where the care goes, because it merges three implementations that each have a reason for the shape they are in, and it changes the friction combine rule.
Phases 4 to 6 are integration and verification.

Land 0 and 1 separately from the rest.
They carry no behaviour change, so if anything downstream goes wrong the bisect point is unambiguous.
