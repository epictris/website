# Collision layers and masks

Every piece of collision geometry belongs to one or more **categories** (its `layer`) and collides with the ones it names (its `mask`).
Two pieces meet only when each is in the other's mask - Box2D's rule, and for Box2D's reason: either side alone can decline the pair and neither can force it.

```ts
export function shapesCollide(a: CollisionShape2D, b: CollisionShape2D): boolean {
  return (a.layer & b.mask) !== 0 && (b.layer & a.mask) !== 0;
}
```

The mask is on the **shape**, and it has to be.
The case it exists for is the **stool**: its seat is in the gameplay plane and stops the avatar, while its four legs are offset in z to either side of that plane, so the avatar walks between them, the hook flies past them and the chain hangs past them - and yet the legs are what the stool stands on, what carries its weight and what tips it over.
Seat and legs are one rigid body because a stool is one thing, so nothing but the piece can say which of them is in the player's way.
Moving the legs to a body of their own would make them a second thing to place, weigh and knock over, and welding that body to the seat is the compound body the engine already has.

It is the rule the rest of the project already states, applied to one more question: **`obj` identity answers "does this move as one rigid piece with that", `shape` identity answers "is this the same surface"**, and *which things a surface is in the way of* is the second (see [**Shapes**](physics-foundations.md#shapes)).

## The categories

| Bit | Name | What is on it |
|---|---|---|
| 1 | `LAYER_SCENERY` | ordinary level geometry and props - every static, every rigid body, every level ever authored |
| 2 | `LAYER_ANCHOR` | geometry only the hook may find: a `passable` body, a vine link (see [hook-surfaces](hook-surfaces.md#hook-only-bodies)) |
| 4 | `LAYER_PLAYER` | the avatar - `Player` on the grapple levels, `BallPlayer` on the ball ones |
| 8 | `LAYER_HOOK` | the chain end - the grapple `Hook`, the ball's `BallHook` and its cuff |
| 16 | `LAYER_ROPE` | the rope/chain PATH |

They are **disjoint**, and deliberately.
A mask is read one bit at a time, so a piece that says "not the player" while the avatar is also on `LAYER_SCENERY` would still meet the avatar on the scenery bit the two of them shared - the exclusion would silently do nothing.
So the avatar is `LAYER_PLAYER` and nothing else, and what used to be `collisionMask: 1` is now `MASK_SOLID` (`SCENERY | PLAYER | HOOK`), which is the same set of bodies under a name that says what it is: *everything in the way*.
`MASK_ALL` is every category, which is what a piece is born with and therefore what every level that authors nothing behaves as.

`LAYER_ROPE` has no body on it at all.
The rope is a sequence of wrap points around scene geometry, not a thing in the world, so the layer exists only as the asker's half of a mask test - which is exactly what `wrappable` is:

```ts
get wrappable(): boolean { return (this.mask & LAYER_ROPE) !== 0; }
```

"Solid, but not rope geometry" and "collides with everything except the rope" are the same sentence, and there is one mechanism behind them, so they cannot drift apart.
Every rope path still reads `shape.wrappable` - `wrappableSurfaces`, the self-intersection resolvers, `syncCoil`, `tieablePieces` - because that is the vocabulary they are written in; what changed underneath is where the bit is stored.

## Layers are on the body, masks are on the shape

Membership is what a thing IS, and a body is one thing: the avatar is the avatar in all of its pieces.
So `CollisionObject2D.collisionLayer` is where a layer is set, a shape answers with its body's unless it has been given one of its own, and `passable` moves a whole body onto `LAYER_ANCHOR` without knowing what pieces it has or when they were mounted.

The mask is the opposite case, which is the whole of the paragraph above: one stool, one seat, four legs, three different answers.

## Every path asks the same function

`shapesCollide` is called from six places in `World`, and it is one function rather than six bit tests for the reason the shape-versus-body rule exists at all: the class of bug it stops is a filter applied to one path and forgotten on the next.
A leg the avatar walks between and is then depenetrated out of is a leg that has not been excluded from anything.

- `moveAndCollide`'s forward sweep, and its depenetration passes - being pushed out of a piece IS being blocked by it, so the two have to answer the same way.
- `collectContacts` → `collectPairContacts`, before the geometry: a pair that is not in each other's way has no manifold to gather.
- `gatherDepenetration`, the rigid recovery sweep.
- `integrateContinuous`, the swept step. This is the one path that can halt a body against geometry no discrete pass admits exists, so a filter missing from it is a body stopped dead in mid-air.

...and once outside it, in `BallLevel.separateBallFromPathBodies` - the chain phase's own pair separation, the only positional recovery that is not `World`'s.
That is the one the mask was first missing from, and it is worth the paragraph because of *how* it was missing.
The routine picks its partners by **body**: whatever the chain's path touches, the ball is separated from.
A body is not one answer, so a ball anchored to the stool's **seat** had the whole stool on its path and was shoved back out of the legs it had just been let through - 21 mm a frame, with a 15-frame chain stall and a 4.7 cm blocked-length lease while the push fought the winch (`session-369f` f272-f308; 0 mm and no stall after).
The symptom is exactly the shape of a half-applied filter: *the ball passes through the legs normally and is blocked by them while attached*.

`cli contacts` `collision-mask` drives that one end to end through a real `BallLevel` - the ball starts inside the leg, throws straight up, catches the seat and must still be where it was - because a chain path is not a thing a hand-built `World` has.

Queries that are not a shape carry the same pair as two numbers.
`RayOptions.collisionMask` is which categories the ray may hit (tested against each piece's `layer`) and `RayOptions.collisionLayer` is the category the ray is cast **on behalf of** (tested against each piece's `mask`) - the half that lets a piece decline a query.
A stool leg is scenery to every ray and still not something the avatar's own wall probes may find.
Both are optional, and a diagnostic query that states neither sees the world whatever it is authored as.

The rest, each honouring it in one place:

- The grapple `Hook` raycasts as `LAYER_HOOK` for `MASK_ALL`; the avatar's wall and ground probes (`onWallState`, `airborneState`) raycast as `LAYER_PLAYER` for `MASK_SOLID`.
- `BallHook.reaches` gates all three of its attach paths - the swept bar, the blocking contact and the resting probe - and it is separate from `bites` because the two say different things: a hook-proof piece still *deflects* the hook, while a piece the cuff is not in the way of is nothing to it at all.
- `SlackSimulation.resolveRopeCollisions` - the grapple rope's drawn slack - drops a piece the rope is not in the way of, so the slack drapes over the same geometry the taut path wraps.
- `LedgeDetection.findGrab` drops a piece the avatar is not stopped by, and so does the corner-burial scan beside it (and `drawLedgeOverlay`, which has to show exactly the set `findGrab` walks): a corner you cannot be stopped by is not a corner you can hang off.

One simplification is left, deliberately: `CollisionShape2D.isVertexExposed` - a piece asking whether its **own siblings** have buried a corner - does not read masks.
It is computed once at build and cached because the arrangement of a body's pieces is rigid, and a per-mask answer would be a cache per asker on a path the ledge query walks every frame.
What it costs is a corner of the seat that a leg happens to bury reading as occluded although the avatar passes through that leg, which needs the pieces to actually overlap at the corner in question - legs are inset from a seat's edge, and it is the seat's outer corners a player grabs.

## Authoring

A level names what passes **through** a piece, not what collides with it:

```jsonc
{ "type": "collision", "shape": { ... }, "passes": ["player", "hook", "chain"] }
```

Absent means a piece everything collides with, which is every piece authored before masks existed.
A list of exclusions rather than of inclusions for the same reason `wrappable` was a `false` and never a `true`: a positive list would silently drop whatever category the engine gains after a level was written.

Only the three are authorable.
A piece that collided with no scenery would be a piece that falls through the floor, which is what `passable` on the **body** already says and says better, and a piece is never in the way of hook-only scenery in the first place - so the mask a level can write is always a mask that leaves the level standing.

The retired `wrappable: false` is folded into `passes: ["chain"]` by `normalizeLevelData`, inside `scaleLevelData`, because that is the one gate a level cannot reach the sim or the editor without passing through.
A migration a loader can forget is missing wherever the next loader is added, and the failure is silent - the wheel's rim simply starts catching the chain it has been ignored by since the level was drawn.

The editor's inspector offers it as a **collides with** row of three ticked boxes beside `hook-proof`, `rail` and `viscous`, per shape and not collapsed onto the body.
It is stated positively there and negatively in the file because the two readers want opposite things: an author is looking at a piece and asking what it is in the way of, while a level file needs *absent* to mean the ordinary case.
The `chain` box is what the "chain-through" checkbox was, inverted - one mechanism says both now, so it belongs beside its siblings rather than on its own.
A piece that anything passes through is drawn with the dotted edge a hook-only body wears, which is passed through by everything.

## The detector

`cli contacts` `collision-mask` builds the stool - one rigid body, a seat and a leg standing on a floor - and asks every path that can stop something, with the **seat as the control in each**: a case that reported "passed through" for both pieces would be asserting that the stool had been deleted.
The character sweep, the character's own depenetration, the contact gather, the rigid depenetration sweep, the continuous sweep, the raycast, ledge detection and the ball's hook.
Then the fold (`wrappable` is the leg's rope bit and nothing else), and then the point of all of it: the stool **stands**, because the leg it is not in the avatar's way with is what holds it up.

## What this is not

`impermeable` is not a mask and could not become one: a hook-proof surface still **blocks** the hook, it simply refuses to be anchored to, so hook-proofing is about what happens on contact rather than about whether there is one ([hook-surfaces](hook-surfaces.md#hook-proof-surfaces)).

`passable` stays a flag on the body.
It is expressible as a mask - layer `ANCHOR`, and nothing collides with it - but it also drives `isSolid`, the rope's wrap list and how the body is drawn, and "is this thing in the way at all" is a question about a body in a way that "which things is this surface in the way of" is not.
What it does share is the mechanism at the point of the test: setting it writes `collisionLayer`, and every query filters on the layer it wrote.
