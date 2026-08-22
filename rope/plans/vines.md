# Hanging vines

A new level object: a vine (rope/chain) hanging from an anchor on a body, free at the bottom.
The player passes straight through it.
The hook grabs it at any point along its length.
It dangles with visible slack drape, responds to being grabbed and winched, and drapes/wraps around scene geometry - but never around the player.

The load-bearing verdict up front: a vine is **a chain of small pass-through rigid links joined by `SceneChain` pair constraints, plus one wrap-point `Rope` spawned from the vine's anchor to the grabbed link for exactly as long as the hook holds it**.
The links carry the drape and the grab surface; the wrap rope carries the load.
Everything else in this plan is consequences of that split.

## Why not the standard approach, and why not the house approach either

The standard game rope is a uniform particle chain - 20 to 100 verlet/PBD particles, distance constraints between neighbours, a fixed iteration count, and an accepted amount of stretch and sponginess.
This codebase's `Rope` (`src/classes/rope.ts`) exists specifically as a rejection of that: it models a rope as a handful of wrap points around geometry plus one length constraint, so length is exact by construction rather than approached by iteration.
The rejection is not aesthetic; it is measured, in this repo, in `src/level/chains.ts`:

- A Gauss-Seidel pass over coupled distance constraints leaves order-dependent residual that reads as elastic: 73 mm of stretch on a 1.03 m chain (7%), independent of load mass, until the sweep loop was added.
- Convergence cost scales with tension: the `chain-order` rig at 14 degrees off horizontal wants ~200 sweeps to reach 5 mm tolerance and is capped at 64.
- Position-correction solvers here also carry bespoke bookkeeping that took several sessions to get right: velocity credit for corrections (`settleChainBodies`), the push-out feedback loop that tunnelled a plank through a ledge (session-147f), the blocked-length lease, topology credit scaling.

So a plain dense PBD vine that the player hangs from would reintroduce the exact failure the rope system was built to avoid, in the one place it is most visible: a taut vine with 80 kg swinging on it.
And any *new* solver type (XPBD, rigid segments with joints) would have to re-derive all of the bookkeeping above from scratch.

But the house approach alone - a wrap-point rope from anchor to a tip weight, or a few "knot" bodies joined by wrap spans - fails the two hard requirements:

- **Grab anywhere.** A wrap-point rope is a constraint, not a surface. The hook raycast (`src/classes/hook.ts`) hits bodies; a rope path is not a body. Grabbing mid-rope would need a ray-vs-span test plus splitting the rope at the hit point into two coupled ropes with a phantom body between them - a new mechanism with real bookkeeping, for every grab and release.
- **Visible slack drape.** A taut wrap rope hangs dead straight. `SlackSimulation` (`src/classes/slackSimulation.ts`) can *draw* a slack curve, but it is cosmetic and collides with nothing the constraint system knows about - the drawn vine would lie about where the grabbable vine is.

### The resolution: separate the load path from the drape path

The key observation is that the stretchy-chain problem is a **load** problem, not a chain problem.
Gauss-Seidel residual and convergence cost both scale with tension.
An idle vine carries only its own weight - a few kilograms, not the 476 kg slab in the `chains.ts` measurements - so a link chain in that regime converges in a few sweeps and its residual stretch is sub-pixel.

Load appears only at the moment the hook grabs.
At that moment we spawn a single wrap-point `Rope` from the vine's anchor to the grabbed link, with rest length equal to the vine's arc length from anchor to that link.
This is the long-range attachment (LRA) idea from the PBD literature, but built from the house rope, which makes it strictly better than textbook LRA: a straight-line LRA constraint is wrong the moment the rope bends around a corner, whereas a wrap-point rope routes itself around geometry and keeps its length exact along the routed path.

Under load the force flow is:

- Player weight and winch tension go through the player's grapple rope into the grabbed link, and from the grabbed link through the LRA rope directly to the anchor. One unstretchable constraint, corner-aware. The system's whole reason to exist, used exactly where it earns its keep.
- The pair constraints between links above the grab point only have to keep those links *lying along* the taut LRA line. They carry link self-weight, nothing more, because the LRA has already matched their summed rest length - so they sit exactly taut or slightly slack.
- Links below the grab point go slack and drape. Visibly, physically, because they are real bodies.

So the "standard PBD chain" appears in this design only in the regime where its known failure cannot occur, and the wrap-point rope appears exactly where its guarantee matters.

## The `VineLink` body and how it passes through everything

New class in `src/engine/body.ts`:

```ts
export class VineLink extends RigidBody2D {
  // collisionLayer = LAYER_ANCHOR, isSolid = false
}
```

It must be a `RigidBody2D`, not an `AnchorBody`-style direct `PhysicsBody2D` subclass: it needs gravity integration, mass, and the whole chain phase (`snapshotChainBodies`, `settleChainBodies`, `creditScale`) is written against `instanceof RigidBody2D`.
That puts it inside the `StaticBody2D | RigidBody2D` allowlists that every collision path uses (`isSolidTarget` in `world.ts:153`, `moveAndCollide` at `world.ts:394`), so it needs explicit opt-outs.
The rule that makes them coherent: **a non-solid body blocks nothing, and is blocked only by statics.**

1. `moveAndCollide` (`world.ts:394`): skip targets with `!target.isSolid`. This is what lets the player walk and swing through a vine. Today nothing reaches that loop with `isSolid === false` (`AnchorBody` is outside the allowlist by class), so the guard is a no-op for every existing scene.
2. `collectContacts` (`world.ts:1037`): a pair where the *obstacle* side is non-solid is dropped; a pair whose moving side is non-solid is kept only if the other side is a `StaticBody2D`. Concretely: link-vs-static contacts exist (that is how a vine drapes over a ledge and piles on the floor), link-vs-link, link-vs-ball, link-vs-any-rigid contacts do not (a vine never pushes anything, never stacks, never fights its own pair constraints through the contact solver). This is precisely the "stacking and contact problems" that `docs/game-design.md` cites against body-per-link chains, removed by construction rather than solved.
3. `gatherDepenetration` (`world.ts:935`): skip `!other.isSolid` others, so no body is ever depenetrated out of a vine link.
4. The hook needs no change at all: its ray already scans `LAYER_SOLID | LAYER_ANCHOR` (`hook.ts:55`) and attaches to whatever body it hits. Links live on `LAYER_ANCHOR`, so the hook sees them and every mask-1 query (player raycasts, ledge detection) does not.
5. The grapple rope pins to a link but never wraps the vine: `isPassThrough` (`rope.ts:33`) already reads `!isSolid`. Same for the LRA rope routing past the intermediate links - the wrap generator ignores them entirely, which is exactly right.

Every one of these guards is a behavioural no-op until a non-solid `RigidBody2D` exists, and no existing level builds one.
**Verify that claim mechanically, not by inspection: the full `cli contacts` suite and all recorded playtests/replays must stay bit-identical after the engine changes land, before any vine code is written on top.**

Link geometry: a circle shape.
Two radii are in play and they are different numbers: the **grab radius** (the collision shape, sized to at least half the link spacing so consecutive links overlap and the hook ray cannot slip between them) and the **visual gauge** (what the renderer draws, much thinner).
With 0.1 m spacing, a 0.06 m grab radius gives continuous coverage; draw the vine at ~0.03 m.

Link mass: start at 0.4 kg per link and tune.
Heavier than a real vine on purpose - PBD corrections split by mass ratio and nobody sees kilograms.
Do not make them so heavy that a hanging vine visibly loads a spring body or rigid platform it is anchored to.

## Constraints

- One `SceneChain` per adjacent pair of links, plus one from the anchor body to the first link. `RopeContact` at link centres (`Vec2.ZERO` offset) for link-to-link; the anchor-body end goes through the same `snapToSurface` projection chains use (`chains.ts`), for the same self-intersection reason.
- Pair chains keep solving against `NOTHING`. Spans are 0.1 m; wrapping within one is meaningless, and this is what keeps a per-pair solve an order cheaper than a wrap-enabled solve (measured in `chains.ts`).
- All vine chains are appended to the level's `sceneChains` list. That single decision buys the entire existing phase for free: the residual-gated alternating sweep (`sweepChains`), static depenetration with the funded-velocity clamp (`settleChainBodies`), velocity credit with topology scaling, and the blocked-length lease. None of it is vine-specific and none of it should be reimplemented.
- The pair constraint is an inequality, as `Rope` already is (`rope.ts:232`): a compressed vine folds instead of acting as a rod, which is what makes the drape and the floor pile look right.

Drape over geometry is emergent from two existing mechanisms and needs no new code: link-vs-static contacts in `World.integrate`, and the chain phase's own `depenetrateRigid` against statics in `settleChainBodies`.

## Grab, LRA lifecycle, and coupling

Grab requires zero hook changes.
The hook flies, its ray hits a link, the existing attachment callback fires, and the player's rope ends in a `RopeContact` on that link (`rope.ts:261`).
Hauling a chain-held rigid through a `RopeContact` is already a proven path: the `ball-winch-hung-anchor` playtest is exactly this shape.

The LRA is managed statelessly by the level, derived each frame rather than event-driven, so release, hook destruction, and re-fire all fall out of one rule:

- If `player.rope` exists and its far-end contact object is a `VineLink`, there must be an LRA `SceneChain` from that vine's anchor contact to that link, with length = the sum of the pair rest lengths from anchor to that link. Create it if absent.
- Otherwise there must be none. Remove it if present.

The LRA chain differs from a scenery chain in one way: it solves against the level's static bodies instead of `NOTHING`, so its spans wrap corners.
Give `SceneChain` an optional wrap-candidate list defaulting to `NOTHING` rather than inventing a sibling class; `sweepChains`' residual loop already reads `rope.overLength` and works unchanged.
At most one LRA exists at a time (there is one player rope), so the per-sweep cost is bounded at one wrap-enabled solve.

Coupling is the one genuinely delicate piece, and its precedent is `ballLevel.ts:300-430`.
Today `level.ts` solves the player rope before `World.integrate` (`level.ts:177`) and the scene chains after (`level.ts:193`), fully uncoupled.
That is correct while they share no body.
The moment the player rope pins to a vine link they share one, and solving them in separate phases is session-521f verbatim: each phase's correction becomes the other's residual, and the winch spends its correction moving an anchor the other constraints put straight back.
The `extra` slot in `sweepChains` was built for exactly this.
So: keep the player rope's `physicsStep` where it is (it is what moves the player), and when the rope's far end is a `VineLink`, pass it as `extra` into the chain sweep - extend `stepSceneChains` with an optional `extra` parameter that it forwards.
The `extra` path also gives the early-exit gate (convergence measured by how much the sweep still disturbs the extra rope), which is what keeps the wrap-enabled solve from running all 64 sweeps every frame - `chains.ts` documents why gating on the scene set's own residual instead would double the physics frame.

Credit accounting needs no new mechanism but must be left alone deliberately: the player is credited by its rope's own `solvePass` calls (each pass credits its own displacement, so pre-integrate and in-sweep passes sum to the total), and vine links are credited by `settleChainBodies` like every chain body.
Do not add the player to `snapshotChainBodies` - it is not on any scene chain's path, so it is excluded by construction.

Two behaviours fall out for free and should be left as they fall out:

- Winching while holding a vine hauls the player up to the grab point, with the LRA refusing to let the vine pay out - the same books as winching against any rigid anchor.
- A vine grabbed around a corner routes tension around that corner through the LRA's wrap nodes, while the links drape where their contacts put them. The two paths can disagree by a few centimetres near the corner (tension routed along the wrap path, links lying along their contacts). Accept this for v1; the links visually dominate and mostly agree because both follow the same geometry.

## Level format, build, editor

`levelFormat.ts`, mirroring `ChainData`'s anchor-id lesson (never body indices, never world points):

```ts
export interface VineData {
  anchor: number;    // AnchorObjectData id, same as a chain end
  length: number;    // metres of vine below the anchor
  spacing?: number;  // metres between links; default 0.1
  color?: string;    // absent = renderer's vine colours
}
```

`length`/`spacing` are metres and must go through the same `scaleLevelData` treatment chain lengths get.

New `src/level/vines.ts` modelled line-for-line on the shape of `chains.ts`: `buildVines(data, built)` resolves the anchor id (dropping a vine whose anchor is missing or whose body built nothing, same tolerance as `buildOne`), spawns `ceil(length / spacing)` links straight down from the surface-snapped anchor point, registers them in the world and the level's body list, and returns per-vine records `{ anchorContact, links, chains }`.
The chains go into `sceneChains`; the record is what the LRA rule and the renderer consume.
A spawn pose that intersects geometry needs no special handling - the first frames' contact solve and chain-phase depenetration settle it, which is the same answer the game already gives any authored overlap.

Editor (`src/editor/`): a vine authors as an anchor object plus a length, so reuse the chain tool's anchor-placement half and drag out the length.
Editor rendering draws the straight-down rest pose; live behaviour is the game's job.
The editor refuses a vine with non-positive length, mirroring its refusal of a same-body chain.

## Rendering

Draw the vine through the link centres - a smoothed polyline at the visual gauge, vine colouring, behind the player like chains are drawn behind geometry.
`chainMetrics.ts` is the wrong tool here: it exists to place links along a *wrap path* because chains have no per-link bodies, and a vine has real link positions - the honest source.
Do not draw the LRA rope; it is a constraint, not a thing, and the links already show where the vine is.
Leaves/decoration are a follow-up on top of the same polyline.

## Performance budget and measurement gates

A 3 m vine at 0.1 m spacing is 30 bodies and 31 chains.
Three specific costs, each with a measurement gate before optimising:

1. Pair-chain sweeps: 31 cheap solves per sweep, residual-gated. Expect low single-digit sweeps at rest (tension is self-weight only). Measure like the `chains.ts` sweep table: worst over-length and wall clock over a settled window and over a grab-and-swing window.
2. The LRA's wrap-enabled solve, once per sweep while grabbed, early-exited by the `extra` gate. If profiling shows it dominating, the known lever is splitting path regeneration (once per frame) from length passes (per sweep) - `Rope` already exposes regeneration separately (`rope.ts:282`) - but do not build that until measured.
3. `collectContacts` is O(n²) over bodies with a conservative box reject (`world.ts:1059`). 30 extra bodies is well inside what the box reject was measured to absorb, but confirm on the busiest level with the `PhaseTrace` marks that already exist.

If spacing must grow to hit budget, 0.15 m costs grab-anywhere nothing (grab radius grows with it) and coarsens the drape slightly.

## Testing

Engine guards first, in isolation: land the three `world.ts` opt-outs plus `VineLink` with no callers, and prove every existing `cli contacts` case and recorded playtest bit-identical.
That is the whole reason the guards are keyed on a property no existing body has.

Then a `sim/vineCases.ts` in the house style (see `springCases.ts`, `contactCases.ts`), covering at minimum:

- Rest: vine hangs straight, settles, worst pair over-length under `CHAIN_TOLERANCE`-scale bounds over a settled window.
- Drape: vine over a ledge corner and vine pooling on a floor - no jitter, no creep, links stay out of statics.
- Pass-through: player walks and swings through a resting vine with zero velocity change.
- Grab and hang: hook a mid link, player hangs; anchor-to-grab arc must not measurably exceed rest arc (this is the LRA's entire job - assert it, in millimetres).
- Winch: haul toward the grabbed link; compare travel against the same rig grabbed on a static anchor, the `ball-winch-hung-anchor` methodology.
- Corner grab: grab a vine hanging past a corner so the LRA must wrap; assert routed length, and that releasing removes the LRA and the vine relaxes.
- Release/refire: fire, grab, release, regrab a different link; assert exactly zero or one LRA exists at every frame.

Record at least one playtest of free play on a vine level for the replay suite.
Determinism needs no new mechanism - everything here is fixed-order solves over fixed-order lists - but the replay is what proves it stays true.

## Implementation order

1. Engine: `VineLink` + the three non-solid guards in `world.ts`. Gate: existing suites bit-identical.
2. `VineData` + `buildVines` + pair chains into `sceneChains` + renderer. Gate: rest/drape/pass-through cases green; a vine dangles and drapes in a test level.
3. Grab + LRA + `extra` coupling in `stepSceneChains`/`level.ts`. Gate: grab/winch/corner/release cases green.
4. Editor authoring + a real level using vines. Gate: recorded playtest, perf numbers from the measurement section.
