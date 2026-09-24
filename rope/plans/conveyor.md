# Plan: conveyor belts

A conveyor is a smooth closed surface that goes round two rollers and carries whatever rests on it, and carries the hook when the hook anchors to it.
An author places the start roller, the end roller, a radius for each, and a signed speed.
This plan says how to build it so it composes with the engine as it stands, and it is written so that it can be implemented without re-deriving it.
Where a number is given it is a default to be played, not a conclusion.

## The verdict

**A belt is a static body with a surface velocity, not a mover.**

Every existing mover (pendulum, rotor, traveller in `docs/movers.md`) moves the body's TRANSFORM and derives contact velocity from the per-frame transform delta (`AnimatableBody2D.commitMove`).
A belt's geometry never moves.
Only its material does, and the straight runs between the rollers cannot be expressed as any body's transform at all.
This is what Box2D does for a conveyor: a per-shape tangent speed added to the relative velocity the friction solve reads (`b2SurfaceMaterial.tangentSpeed` in v3, `b2Contact::SetTangentSpeed` in v2).

The engine already has exactly one hook for it, `PhysicsBody2D.velocityAtPoint`, and every carry path reads it:

- the rigid contact solver's tangent solve (`World.solveTangent`, `c.a.velocityAtPoint(c.point).sub(c.b.velocityAtPoint(c.point))`), the normal solve and the position pin, all unconditionally;
- `World.resolveRigidCircle` (`surfV = other.velocityAtPoint(point)`), unconditionally;
- the ball's ride (`ballPlayer.ts`, `ride.body.velocityAtPoint`), unconditionally;
- the rope's anchor motion (`Rope.velocityAt`, which the winch stall and the puller measure against), unconditionally;
- the grapple avatar's grounded, wall and wall-jump states, GATED on `isMobile` (see the predicate below).

So a `StaticBody2D` whose transform never changes but whose `velocityAtPoint` answers "belt speed along the loop tangent at the nearest point of the loop" is carried by all of the rigid paths with no per-site change, and by the avatar once one gate is renamed.

Two consequences are worth stating, because they are the reason to do it this way:

- **The contact-speed bar does not apply.** A mover's surface has to cross under about 2 cm a frame because the character sweep resolves against a surface that has already moved (`docs/movers.md`).
  A belt's surface has not moved, so the sweep sees a static, and a belt can run at any speed the friction solve can accelerate a body to.
- **Zero speed is bit-identical to static geometry.** A belt of speed 0 must build and play exactly as the same two circles and quad would as ordinary static pieces.
  That is the no-regression proof and the first case.

Rejected: modelling it as a rotor plus a traveller (transform-based, bounded by the bar, and the straight run has no transform), and as a `force` area over a low-friction bed (the river pattern: it accelerates what is inside a volume rather than what touches a surface, has no loop, and carries no hook).

## What was verified in the tree before writing this

- The rope path wraps a `circle` piece on a scene body: `Rope` resolves circle wraps through `RopeGeneration.calculateCircleTangentPoint` in the forward generation and in both self-intersection resolvers (`rope.ts` around lines 1541, 1676, 1884).
  The coil is the ball's own circle only; a roller is an ordinary wrappable circle piece.
  So the chain bends round a roller as the anchor is carried round it with no new wrap machinery.
- The energy invariant (`trace.ts`, `energy-gained`) excludes STATICS AND MOVERS from the energy sum and counts every rigid body's kinetic energy.
  A crate carried by a belt gains energy the invariant reads as unforced.
  The invariant disarms on `World.launchedThisFrame` (trampolines) and on `BallLevel.rollingIn`; a belt needs the same treatment (step 3).
- The stuck detector (`trace.ts`, `STUCK_*`, `mobileBodyNear`) exempts the avatar near a MOBILE body because "the treadmill bug class this detector exists for pins the player near zero displacement".
  An avatar walking against a belt is literally that, so the same exemption must fire for a belt (step 3).
- The grapple avatar's `GroundedState.carriedVelocity` returns null unless `supportBody.isMobile`, and the `PROJECT_VELOCITY`, `CEILING` and `wallJumpingState` branches read `velocityAtPoint` only under `collider.isMobile`.
  A belt is not mobile (its transform is fixed) and must not become so: `isMobile` also drives the AABB tree entry, the rope's continuous-sweep pose baseline (`Rope.recordSweepBaseline`, `sweepPose`) and the ledge states following a body.
  Hence the new predicate in step 3.
- The scenery stiction pin (`World`, the `offer` closure near line 2553) and the steered ball's grip (`applyStaticGrip`, near line 2767) both decline a non-rigid MOBILE body.
  Both are position pins along the surface, and on a belt they would fight the carry: a resting crate pinned to a belt judders instead of moving.
  Both must decline a belt (step 3).
- `wakeTouching` is called from the mover loop in both `Level.step` (`level.ts` 245-254) and `BallLevel.step` (`ballLevel.ts` 844-853) only for a mover that moved this frame.
  Settle at build sleeps only the bodies on scene chains (`settleChainsAtBuild`), so a crate authored on a belt is not slept at build.
  A belt still has to wake what touches it every frame it runs (step 3).
- The build already has the pattern for "several pieces sharing one record": `Piece.rail` / `RailBuild` / `attachRails` in `buildBodies.ts` give every piece of a stroked curve the same `RailCurve`, declared in `engine/shapes.ts` (which may not import from `lib/`).
  A belt follows it exactly.
- The manacle bite (`BallPlayer`, attach site near line 1230) stores the anchor as the HINGE PIN one `MANACLE_HINGE` proud of the bite along the arrival facing, and mounts a hidden, unwrappable cuff piece on the anchor body (`mountCuff`).
  A carried anchor must carry the cuff piece with it.
- `RopeContact.position` is body-local and its `globalPosition` cache is keyed on the body's transform version and the `position` Vec2's IDENTITY, so assigning a fresh Vec2 to `position` is how a moving contact is moved (`RopeClamp` does this through `setParam`).
- `RopeAttachment` is a bare subclass of `RopeNode` (`lib/ropeContact.ts` 116); `RopeClamp` (rails) and `RopeEmbed` (viscous) extend it with a contact that moves.
  The belt's attachment is a third, and by far the simplest: it is driven, not solved.
- Shape kinds on disk are `rect | circle | poly | curve` (`levelFormat.ts` `ShapeData`); `scaleShape` is the one scaler and comments say a new kind cannot be missed by it; `makePieces` in `buildBodies.ts` is where a curve becomes pieces; `outlineOfData` / `outlineOfShape` in `render/shapePath.ts` is the one place every renderer and the editor get an outline from; the editor converts on-disk shapes in `editor/model.ts` (`edShape`, `shapeOf` inside `toLevelData`).
- The mover suite (`sim/moverCases.ts`, `cli movers`, registered in `scripts/test.ts`) is the template for a suite of a mechanic that reaches no digest.

## Vocabulary and the closed forms

A **belt** is two circles, the start roller `C1, r1` and the end roller `C2, r2`, joined by their two EXTERNAL tangent lines.
With `r1 = r2` it is a stadium.
With `r1 != r2` the two runs are not parallel and the loop is still smooth (tangent-continuous) everywhere, which is what "smooth surface" requires and what an author gets for free from external tangents.
Degenerate inputs are build errors, exactly as a curve of one node is (`buildBodies.ts` line 90): `|C2 - C1| <= |r1 - r2|` (one roller inside the other, no external tangents), `r1 <= 0` or `r2 <= 0`.

All of it lives in a new pure module `src/lib/belt.ts`, with no clock and no DOM, on the pattern of `lib/rail.ts` and `lib/path.ts`.
Every transcendental goes through `engine/dmath.ts` (`Mathf`, `Vec2`); `cli dmath` scans for the banned members.

The loop is parameterised by arc length `s` in `[0, P)` measured in the shape's OWN frame, in a fixed order:

1. arc on roller 1 from tangent point `A1` to tangent point `B1` (the outside of the loop, not the side facing roller 2);
2. straight run `B1 -> B2`;
3. arc on roller 2 from `B2` to `A2`;
4. straight run `A2 -> A1`.

The sense of the loop (which way "positive s" goes round) is fixed by construction so that a positive `speed` moves the surface in a definite, documented direction; pick the sense so that on a horizontal belt drawn left to right, positive speed carries the TOP run toward the end roller.
Write the choice down in the module and in `docs/conveyors.md`, and assert it with a case, because it is the one convention an author has to learn.

Functions (names indicative):

- `buildBeltLoop(end: Vec2, r1, r2): BeltLoop` with `C1 = (0,0)`.
  Returns the four tangent points, the two arc angles, the cumulative arc lengths of the four segments and the perimeter `P`.
- `beltPointAt(loop, s): Vec2` and `beltTangentAt(loop, s): Vec2` (unit, in the direction of increasing `s`), with `s` reduced modulo `P` INSIDE these functions only.
- `beltNormalAt(loop, s): Vec2`, outward.
- `beltClosestS(loop, p): number`: the arc length of the point of the outline nearest `p`.
  Closed form: project onto each of the two runs (clamped) and onto each of the two arcs (angle clamped to the arc's range), take the nearest of the four.
  On the two tangent seams the two candidates coincide, so the answer is continuous.
- `beltOutline(loop, step): Vec2[]`: the loop flattened for drawing, at `PATH_FLATTEN_STEP` or finer on the arcs.
- `beltSpeedAt(loop, speed, p): Vec2 = beltTangentAt(loop, beltClosestS(loop, p)).mul(speed)`.

`BeltLoop` is DECLARED in `engine/shapes.ts` (as `RailCurve` is), since a `CollisionShape2D` holds one and `engine/` may not import from `lib/`; the functions live in `lib/belt.ts` and take the declared record.

Cases for the closed forms come first (`cli belts`, `sim/beltCases.ts`): a stadium's perimeter is `2·pi·r + 2·d`; the unequal-radius perimeter against a fine numerical integration; `beltPointAt` at every segment boundary lands on the tangent points; the tangent is continuous across all four seams to 1e-9; `beltClosestS` round-trips `beltPointAt` for a thousand `s` values; a point off the belt projects to where a brute-force search over the flattened outline says it does.

## Steps

### Step 1: geometry (`lib/belt.ts`, `engine/shapes.ts`, `sim/beltCases.ts`, `cli belts`)

As above.
Register `belts` in `src/tools/cli.ts` beside `movers` and `rails`, and in `scripts/test.ts`.
The suite file starts with the header paragraph every suite has, saying what a belt is and which claims are asserted that are not arithmetic (they arrive in steps 3 and 4).

### Step 2: format and build

**On disk** (`levelFormat.ts`): a fifth `ShapeData` kind,

```ts
| { kind: "belt"; dx: number; dy: number; r1: number; r2: number; speed: number }
```

- The start roller's centre is the collision object's own origin, so the object's placement places the belt (the "node zero is the body" argument `moveNodes` makes).
  `dx, dy` is the end roller's centre in the object's frame.
- `speed` is ONE SIGNED NUMBER, px/s on disk and m/s in the sim, and the sign is the direction, exactly as `spinPeriod`'s sign is (`docs/movers.md`, "A rotor is one signed number").
  It scales with the length factor in `scaleShape` as `force` does (length per second); document that in the scaler's comment.
- `scaleShape` gains the arm; the editor round trip (`modelFromDisk` / `modelToDisk`) and `px -> m -> px` are asserted by a case as `cli movers` `authored` does.
- `docs/level-format.md` gets the kind.

**Build** (`buildBodies.ts`):

- `makePieces` for `kind === "belt"` builds THREE pieces: `circle r1` at the origin, `circle r2` at `(dx, dy)`, and the convex quad `B1 B2 A2 A1` between the four tangent points.
  They overlap on the discs, which is fine for collision (a compound body's pieces may overlap; only the stroke's tiling was exact for the sake of mass) but the MASS must be the loop's area, not the sum: a belt is static, so mass is irrelevant to the solve, but `mountPieces` weighs pieces; give the quad the area of the belt minus the two discs' overlap or simply let mass be whatever the pieces sum to and note it.
  Prefer correctness: compute the loop's area (`pi·r1²/2 + pi·r2²/2 + trapezoid` approximately; exact form from the arc angles) once and split it, or accept the sum and write down why (a static body's mass is never read).
- Every piece carries a shared `BeltBuild` record (like `RailBuild`), and an `attachBelts` pass after `buildOne` (like `attachRails`) gives each mounted `CollisionShape2D` the same `BeltLoop` in the body's final local frame plus the `speed`: a new field `belt: BeltLoop | null` on `CollisionShape2D` beside `rail`, and `beltSpeed: number` (0 when no belt).
- The body a belt is built on must be a `StaticBody2D` (a `kind: "static"` body, presumably; if the level author puts a belt shape on a rigid or mover body the build throws with a clear message: a belt on a moving body is a later feature, and silently building it as a static piece would be the "kind of wrong" the format's comments warn against).
- Zero-speed proof: a level with a belt at speed 0 and the same level with the three pieces authored by hand as `circle`, `circle`, `poly` must build bodies whose shapes compare equal and whose digest over 300 frames with a crate dropped on them is bit-identical (`cli belts` `static-equivalent`).

### Step 3: the carry (engine, states, detectors)

**The predicate.** Add to `PhysicsBody2D`:

```ts
// Whether the surface this body presents can have a velocity at a contact.
// `isMobile` is about the TRANSFORM moving (the tree, the sweep baselines,
// a ledge that follows its body); this is about `velocityAtPoint` being
// allowed to answer non-zero. They agree for every body but a conveyor,
// whose transform is still while its surface runs.
get surfaceMoves(): boolean { return this.isMobile; }
```

The belt body overrides it to `true` (only when some piece has `beltSpeed !== 0`, so a zero-speed belt stays a plain static in every branch).
Replace `isMobile` with `surfaceMoves` at EXACTLY these sites, each of which is asking "may this surface carry me" and not "does this body's transform move":

- `groundedState.ts` `carriedVelocity` (line 34), the `PROJECT_VELOCITY` branch (129) and the `CEILING` branch (180);
- `wallJumpingState.ts` (107);
- `onWallState.ts` if it has the same carry read (check `carriedVelocity` there, line 64 reads `velocityAtPoint` and the gate above it);
- `world.ts` the stiction `offer` closure (2553) and `applyStaticGrip`'s release (2767);
- `trace.ts` `mobileBodyNear` (862) for the stuck detector's treadmill exemption.

Leave `isMobile` everywhere else, in particular the grounded state's "prefer a static floor as the locomotion basis" branches (139, 167, 210, 224): a belt IS the locomotion basis when it is underfoot, and its frame does not drift.
Every existing body reads `surfaceMoves === isMobile`, so nothing recorded changes; `replay selftest` and the regression corpus prove it.

**The velocity.** `StaticBody2D` (or a `ConveyorBody extends StaticBody2D` built only when a belt piece is present; prefer the subclass so the plain static keeps its zero-cost `Vec2.ZERO`) overrides `velocityAtPoint(worldPoint)`:
take the point into the body's local frame, for each belt piece compute `beltClosestS` and the distance to the outline, choose the nearest belt, return `beltSpeedAt` rotated back to world.
One belt per body is the normal case; the loop over belts is for a body that authored two.

**The wake.** Belts join the wake pass: both `Level.step` and `BallLevel.step` call `world.wakeTouching(belt)` every frame for every belt body with non-zero speed, in the mover loop's position (before the ball, the chain and the contact solve).
`buildLevelBodies` returns the belts as it returns `movers`.

**The energy invariant.** Add `World.conveyedThisFrame`, set by `solveTangent` and `resolveRigidCircle` when the OTHER body is a belt (`surfaceMoves && !isMobile`) and a non-zero friction impulse was applied, cleared at the top of the step.
`EnergyMonitor.push` treats it as it treats `launched`: the span restarts, because a running belt is a source the input cannot see.
Riders on scripted movers have the same hole today and are out of scope; say so in the doc.

**Cases** (`cli belts`, all through `buildLevelBodies` from a `RawLevelData` so the format is exercised, as `moverCases.ts` does):

- `crate-carried`: a crate dropped on the top run reaches belt speed within a second (Coulomb: `a = mu·g`, so `v/(mu·g)` seconds plus settling), rides to the end, and falls off; assert speed within 2 % of `speed` over the middle of the run, and that it is NOT pinned (position advances every frame).
- `ball-rolls`: a free ball on the belt reaches `v = speed` and `omega = v / r` (rolling without slip against the belt), sign checked against the loop's sense.
- `reverse`: negative speed carries the other way, same numbers.
- `avatar-carried`: the grapple `Player` standing still on the belt is carried at belt speed; walking against it at the belt's speed stands still and the stuck detector does not fire (this is the treadmill case).
- `wakes`: a crate put to sleep by hand on a belt (or a belt started under a sleeping crate by rebuilding with speed) is awake next frame and moving.
- `no-pin`: a crate at rest on a belt has no `stickAnchor`; the same crate on the zero-speed belt does (the stiction pin's behaviour on scenery, `session-477f`, is kept).
- `static-equivalent` from step 2.
- `undisturbable`: a boulder dropped on a belt changes nothing about the belt (it is a static; the case is one line and exists so the claim is written down).
- `energy-armed`: the energy monitor does not fire on a crate being carried for 300 frames.

### Step 4: the hook rides the belt

**The attachment.** `RopeRide extends RopeAttachment` in `lib/belt.ts` (it needs `MANACLE_HINGE` and `RopeContact`; check the import direction against where `RopeClamp` lives and follow it):

- fields: `loop: BeltLoop`, `speed`, `s0` (arc length of the BITE at attach), `frame0`, `phi` (the angle from the outward normal at `s0` to the arrival facing, so the cuff keeps its arrival angle relative to the surface as it goes round a roller), `cuff: CollisionShape2D | null` (the mounted cuff piece, as `RopeEmbed.cuff`).
- `s(frame) = s0 + speed · ((frame − frame0) · DT)`: a PURE FUNCTION OF THE FRAME, never accumulated, reduced modulo `P` only inside `beltPointAt` (the running-total argument `docs/movers.md` makes for the rotor: a wrapped `s` would hand the sweep a whole-lap delta on the seam frame).
- `carry(frame)`: `bite = beltPointAt(loop, s)`, `n = beltNormalAt(loop, s)`, `facing = n.rotated(phi)`, `contact.position = bite.add(facing.mul(MANACLE_HINGE))` as a FRESH Vec2 (the cache is keyed on identity), and the cuff piece's `localOffset = bite`, `localRotation = facing.angle()` with the body's transform version bumped the way `addShape` / `RopeClamp` bump it.
  The contact's `shapeIndex` follows from where `s` is: the roller piece on an arc, the quad on a run (a `pieceAt` on the loop, as `RailCurve.pieceAt`), so the wrap resolvers walk the piece the anchor is on.
- Where it runs: at the top of `BallPlayer`'s physics step, after the movers and before the chain's sweep baseline is read, so the continuous sweep (`Rope.continuous`, `lastEnd`) sees the anchor's motion as end motion and catches it crossing geometry.
  The same call for the grapple `Player`'s rope.
- The velocity the rope reads at the anchor comes from `body.velocityAtPoint(point)` already (`Rope.velocityAt`), and it is the belt's tangent speed at the pin, which agrees with the carry by construction, so the winch does not read the carry as a block and the stall tolerance is not spent on it.

**The attach site** (`BallPlayer`, the chain at the `piece?.rail` / `piece?.viscous` chain): a `piece?.belt` branch BEFORE the plain bite, building a `RopeRide` at `beltClosestS` of the bite point with the cuff mounted as the plain bite mounts it.
A hook-proof belt (`impermeable`) still repels, as for a rail.
The grapple avatar's attach (`Rope` 513/520, `RopeContact.at`) gets the same branch without the cuff.

**What happens at the roller.** The anchor goes round the end roller on the arc and comes back along the return run; the chain wraps the roller's circle piece as the anchor passes under it (the tangent-point wrap the resolvers already produce) and unwraps when the geometry lets it.
The hook is carried for ever, matching mover authority; releasing at the end roller is an authored option for later and is NOT built now.
Say so in the doc.

**Cases** (`cli belts`):

- `ride-pure`: the anchor's position on frame N is the same whether stepped 1..N or restored at frame N from `s0`, `frame0` (a replay lands it).
- `ride-carried`: a hooked ball hanging under a belt's bottom run is carried at belt speed along it (measured over the middle of the run, within 2 %).
- `ride-round-roller`: the anchor bitten on the top run goes round the end roller and onto the bottom run; while it is on the arc the chain has exactly one wrap on that roller's circle piece, and the cuff piece's rotation turns by the arc angle.
- `ride-wrap-sweep`: the carried anchor crossing a scene corner (a post beside the belt) leaves a wrap on the post: the continuous sweep caught it.
- `ride-winch`: winding in while carried does not trip the chain stall (`maxRopeLength` shrinks monotonically and the lease stays zero).
- `ride-detach`: detaching removes the cuff piece and restores the belt body's shape count.
- the corpus: `bun run test` green, `replay selftest` bit-identical, every bundle in `playtests/regressions/` replays.

### Step 5: rendering and the editor

**2D** (`render/renderer.ts`, `render/shapePath.ts`): the three pieces would draw as two discs and a quad with seams.
Give `outlineOfShape` / `outlineOfData` a belt arm that returns the flattened loop (`beltOutline`) as a `poly`, and have the renderer draw the loop ONCE per belt (the first belt piece) and skip the other two.
Tread marks: short ticks across the outline every 20 cm, phased by `(simTime · speed) mod pitch` so a replay shows the same belt; the editor draws the same from `outlineOfData` with the ticks static (as the SVG snapshot pins the force arrows' phase at 0).

**3D** (`render3d/bodyVisuals.ts`, `render3d/extrude.ts`): extrude the loop outline as one solid, as any poly extrusion is.
For the motion, check whether the extrusion's side-wall UVs run by arc length (`extrude.ts` builds its own UVs); if they do, scroll the side material's map offset by `simTime · speed / tileSize` render-side.
If they do not, add a ring of thin tread boxes riding the loop at `beltPointAt(simTime · speed + k · pitch)`, render-side, from the world clock the renderer already reads for interpolation.
Either is render-side by construction and reaches the sim by nothing.
`cli shot --3d --frames` is the evidence for motion (see `docs/debugging-rendering.md`); a still is not.

**Editor** (`editor/model.ts`, `editor/editor.ts`, `editor/render.ts`): an `EdShape` kind `belt` with `end: Vec2`, `r1`, `r2`, `speed`; `edShape` / `shapeOf` convert; the add menu offers it beside circle; the outline comes from `outlineOfData` so the editor and the game agree.
Gestures: the item's own position is the start roller (existing move gesture); the end roller is a draggable node like a path vertex; each radius a round grip on its roller like a curve's tangent grip.
Panel: `r1`, `r2`, `speed` (m/s) fields and a live readout of the perimeter and the lap time `P / |speed|`.
`cli belts` `authored` asserts the editor round trip keeps every field.

### Step 6: level, docs, play

- `levels/belt-test.json` registered as `TEST_BELT` in `registry.ts` (naming as `rail-test.json`, `mud-test.json`): a belt under the spawn with a crate on it, a second belt overhead to hook, a post beside it for the wrap-sweep case to copy, a reverse belt.
  Regenerate `levelData.ts` with `bun scripts/extract-level.ts`.
  NEVER edit an existing `levels/*.json` while the editor may be open (`docs/level-format.md`), and never `git checkout` one.
- `docs/conveyors.md`: what a belt is, the closed forms and the sense convention, the predicate and why it is not `isMobile`, the wake, the energy source, the ride, what was rejected, what is open (release at the roller, belts on moving bodies, riders on movers and the energy hole).
  A row in `CLAUDE.md`'s docs table under "Rope geometry and surfaces", one line in `docs/movers.md` pointing here for "a moving surface on a still body", the kind in `docs/level-format.md` and `docs/editor-model.md`.
- Play: record a browser bundle on `TEST_BELT` and run `cli diverge` on it (the rule in `CLAUDE.md`: headless cannot see the browser).
  This needs a human at the browser; the implementer stops here and says so.

## Blind spots to name when claiming done

- The feel of the carry (how fast a crate comes up to speed, the ball's grip on a running belt) is `mu`, and `mu` is the author's per-body `friction`; no new constant is introduced, so nothing is tuned here.
- Headless cannot see a shader (`docs/debugging-rendering.md`), so the 3D tread motion needs a live-browser look.
- The chain going round a roller UNDER LOAD (the ball hanging from a carried anchor as it passes the arc) is the one geometry the corpus has nothing like; `ride-round-roller` covers the kinematics, not the solve under a swinging ball.
  That is the first thing to play.

## Addendum (2026-09-23, after the first play): N wheels, a thickness, and a hollow loop

The two-roller stadium was the first cut.
What is wanted is a belt DRIVE: any number of wheels, a band of authored thickness wrapped round the OUTSIDE of all of them, and nothing inside the loop but the wheels, so an author can place whatever wheel models look right at the wheel centres.
Nothing committed uses the two-roller form (`levels/belt-test.json` and the two headless bundles are today's, uncommitted), so the form is REPLACED rather than folded: there is no retired form to carry and no bit-identity claim for belts across this change.
`belt-test.json` is rewritten to the new form by hand and the scratch bundle re-recorded.

### Vocabulary

```ts
| { kind: "belt"; wheels: { x: number; y: number; r: number }[]; width: number; speed: number }
```

- `wheels[0]` is at `(0, 0)`, the object's own origin, and is written out anyway (the `moveNodes` argument: it carries a radius and a node with nowhere to put it is a corner the author cannot round).
  Two or more wheels.
- `r` is the WHEEL's radius.
  The belt lies on the wheel, so the belt's outer surface round wheel `i` is a circle of radius `r_i + width`.
- `width` is the band's thickness in the plane, a length, `> 0` (0 is a build error: a band of no thickness has no inside and no outside to draw).
  It is the same word the `curve` shape uses for the same thing, a bar's thickness.
- `speed` as before: signed, px/s on disk, m/s in the sim, positive turns the loop clockwise on screen.

### The loop

The belt path is the CONVEX HULL of the discs of radius `r_i + width`: a taut band round pins.
Every wheel must lie ON the hull; a wheel strictly inside it would be an idler pressing the band inward, which is a different path and is not built (the build throws, naming the wheel, and the editor's `setBelt` refuses the edit as it refuses rollers with no external tangents).
A disc containing another is the same error.

Hull of discs, for N small (say at most 12): for each ordered pair `(i, j)` the external tangent line from disc `i` to disc `j` that keeps every disc on its inner side in the loop's sense; the hull is the cycle of such tangents starting from the wheel with the extreme point.
Brute force over pairs is fine at this N and is easier to get right than the rotating-calipers form; write the closed forms through `dmath`.
Wheels the hull skips are the error above, so the built loop touches every wheel.

The `BeltLoop` record becomes a SEGMENT LIST in loop order, alternating arc and run: arc `i` on wheel `k` (centre, outer radius `r_k + width`, start angle, positive sweep), then the run from its exit tangent point to the next wheel's entry tangent point (unit direction, length).
`cum` and `total` as now over `2 × (wheels on hull)` segments; `pieceAt` per segment.
`beltPointAt`, `beltTangentAt`, `beltNormalAt`, `beltNearest`, `beltClosestS`, `beltPieceAt`, `beltOutline` generalise by walking the segment list; the two-roller case must fall out of the general code, not be kept beside it.
`RopeRide` and `ConveyorBody` are unchanged in kind: `s` is arc length round a longer loop.

### Collision: hollow, and exact where it matters

The pieces of a belt are:

- one `circle` of radius `r_i + width` at each wheel centre (the wheel and the band on it, one solid disc; a wheel is solid, and the inside of a disc is unreachable in the plane anyway);
- one convex QUAD per run: the band along that run, from exit tangent point to entry tangent point, `width` thick, lying INSIDE the outer run line.

Nothing covers the region between the wheels.
That region is enclosed by the band on every side, so nothing in the plane can reach it, and leaving it empty is what lets an author drop a wheel body or a prop inside without it being buried in a static.
The circles keep the arcs EXACT, which is what the wrap resolvers (circle tangent points) and the ride (the anchor on the true surface) rely on; the seams between a disc and its run quads are tangent, as the stadium's were.
Every piece holds the one `BeltLoop`; `beltPieceAt` names the disc on an arc and the run quad on a run.
Mass: the sum of the pieces, as now (a static's mass is never read; the origin is what it decides, and there is no old origin to match).

### Rendering: the band and nothing else

- 2D and SVG: the band is the outer loop (radius `r_i + width`) and the inner loop (radius `r_i`, the same tangents offset inward by `width`) filled EVEN-ODD, so the inside of the loop shows the backdrop; the tread ticks ride the outer loop as now.
  No wheel is drawn: the author places wheel props.
  The editor draws, in addition, a thin circle at each wheel's own radius and a dot at its centre, so the wheels can be seen and grabbed; those are editor marks, not game drawing.
- 3D: the band extruded as a RING (a three.js `Shape` with the inner loop as a hole; `extrude.ts` needs an outline kind that carries holes, or a belt-specific path), the cleats riding the outer surface as now.
  Nothing at the wheels.
  A prop placed at a wheel centre is the author's, and turns only if the author gives it a rotor; a later step could offer "spin with the belt" on a prop, not this one.

### Editor

- `+ Belt` press-drag makes two wheels as now; clicking the MIDPOINT of a run inserts a wheel there (the path's insert gesture), Alt+click on a wheel removes it (never below two).
- Each wheel: a square centre grip (wheel 0 is the item's position and moves with the item) and a round radius grip; the panel has `width`, `speed m/s`, the perimeter and lap readouts, and a per-wheel `r` when a wheel is selected.
- Every edit goes through `setBelt`, which now also refuses a wheel off the hull and a disc inside another; a drag stalls at the last valid belt.
- The round trip case in `render3dCases.ts` covers the new fields, wheel list included.

### Cases (`cli belts`)

- `hull-3`: three wheels in a triangle (the picture: a small wheel top-left, a large one right, a medium one bottom-left): every disc lies on the inner side of every run; each tangent point is on its disc's outer circle; the loop touches every wheel; the perimeter matches a fine numerical integration of the flattened outline; the tangent is continuous across all seams.
- `hull-refuses`: a fourth wheel inside the triangle is a build error naming it; a disc inside another is too; `width: 0` is.
- `hollow`: a point in the middle of the triangle is inside no piece (`bodyContainsPoint` false); a point on the band is; a point inside a wheel is.
- `carried-3`: a crate on a run of the three-wheel belt reaches belt speed; a ball too.
- `ride-3`: a hooked ball carried round the large wheel and along two runs, `s` pure, the wrap on the disc while on the arc.
- The two-wheel cases already there keep passing on the new form (the same numbers, the surface now at `r + width`, so the cases author `r` accordingly).

### Level, docs

- `belt-test.json`: the three belts rewritten to the new form with a small width (6 px), plus a fourth belt shaped like the picture, three wheels, with room inside for a prop.
  Re-record the scratch bundle `playtests/bundles/belt-end-roller.json` and check it scans clean.
- `docs/conveyors.md`: the loop as a hull, the hollow collision and why the disc stays solid, the render ring, the editor gestures; `docs/level-format.md`, `docs/editor.md`, `docs/editor-model.md`, `docs/render3d.md` follow.

### Revision to the addendum: thickness, width and a texture

Three knobs, named so they cannot be confused, and the addendum above is read with these names:

- **`thickness`** (the shape field the addendum calls `width`): the band's depth IN THE PLANE, a length, `> 0`.
  It is collision: the belt's outer surface round wheel `i` is at `r_i + thickness`, the run quads are `thickness` deep.
  Rename every `width` in the addendum's shape, build, hull, hollow and editor sections to `thickness`.
- **`width`**: how wide the band is ACROSS the pulleys, the 3D extrusion depth.
  It is rendering only and lives where every geometry object's depth already lives: the belt's matched geometry twin's `depth`.
  The editor's belt panel shows it as `width` beside `thickness` and writes the twin's `depth`, so an author never has to know it is the twin's field.
- **texture**: the belt takes a surface from the manifest exactly as any geometry object does (`texture` on the twin, `docs/lighting-and-surfaces.md`).
  The panel offers it on the belt directly for the same reason.

**The 3D belt is its own geometry, not an extruded outline.**
A belt's running surface is the OUTER WALL of the ring, and that is the face a texture belongs on, with UVs by ARC LENGTH along the loop (`u = s / tile`) and across the width (`v`), so a rubber tread tiles along the belt without stretching round a wheel, and the texture MOVES with the belt by scrolling `u` by `speed · t / tile` on the sim clock (`(frame - 1 + alpha) / 60`, as the tread ticks already do).
Build a `BufferGeometry` from `beltOutline` of the outer and inner loops: outer wall (arc-length UVs), inner wall, front and back caps (the band's edge, `thickness` deep, textured by the same map at the same `u` so the edge and the surface agree at the rim).
The extruder's own side-wall UVs are anchored to x/y and cannot do this, which is why the first cut used cleats; with arc-length UVs the scroll is the motion and the cleats go.
Untextured, the band is the twin's flat colour and keeps the cleats, so a plain belt still visibly runs.
The 2D renderer keeps the ticks.

Evidence for the motion is a filmstrip (`cli shot --3d --frames`), and the seam where `s` wraps must not show: choose the tile count so a whole number of tiles goes round, the way the tick pitch already does.
