# Hook-proof, chain-through and hook-only geometry

## Hook-proof surfaces

**Impermeable** is a flag on the **shape** (`CollisionShape2D.impermeable`, authored as `LevelBodyData.impermeable` per level entry): the grapple hook is destroyed on that surface and the ball's is deflected, instead of either anchoring.
It is solid in every other respect - being hook-proof is about the rope and nothing else - so the avatar stands on it, bodies collide with it and the rope still wraps its corners.

It was a body **kind** for as long as it could only ever be static scene geometry, and that cost the two things levels actually want.
A kind is one per body, so nothing could be `rigid` *and* hook-proof: a crate that falls, is hauled about by a chain and still refuses the hook was not expressible at all.
And a compound body was hook-proof in whole or not at all, so a wall with a single attachable ledge among hook-proof faces - the shape of most deliberate level geometry - could not be authored either.
Per shape it is both, and the flag is where the rest of the project already says it should be: **`obj` identity answers "does this move as one rigid piece with that", `shape` identity answers "is this the same surface"**, and which surface the hook reached is the second question (see [**Shapes**](physics-foundations.md#shapes)).

Every path that decides therefore names a **piece**, and each of the three had to be given one:
`World.intersectRay`'s `RayResult` carries the `shape` it hit (the grapple `Hook` reads it), `bodySweepCircle` and `bodyOverlapCircle` return the piece of the earliest / deepest hit (`BallHook`'s sweep and probe), and `attachToBlockingContact` already had one, since a `ContactConstraint` names the shapes it formed on.
The remaining body-level reading was `BallPlayer`'s attach callback, which is a backstop behind `BallHook`'s own decision and now resolves the piece nearest the anchor point.

Rendering is per piece for the same reason - a body that is hook-proof on one face and attachable on the next has to draw as the two things it is.
`geometryStyle` takes the piece (the compound path already strokes each piece where it lies outside its siblings, so it is one style call per stroke), the editor's `strokeCompoundOutline` hands its style callback the item being stroked, and the SVG snapshot's `bodyColor` takes the shape.
Nothing else moved: the ball arena renders **0 pixels** different from before the change.

Levels on disk still carry the retired `kind: "impermeable"`, and `normalizeLevelData` folds it into `static` + `impermeable: true`.
It runs inside `scaleLevelData` rather than at each loader, because that is the one gate a level cannot reach the sim or the editor without passing through - the conversion between the pixels on disk and the metres everything downstream is written in.
A migration a caller can forget is one that is missing wherever the next caller is added, and the failure is silent: the body builds as an ordinary static and the hook simply starts catching on a wall that has repelled it since the level was designed.

`cli contacts` `impermeable-shape` is the detector, and it asserts both hooks against one compound body: the hook-proof piece turns each away, its sibling anchors each, a hook-proof **rigid** body deflects the ball's hook, and the retired kind still loads hook-proof.
Both hooks, because they reach a surface by different means - a raycast that destroys, a sweep/probe that deflects - and a fix applied to one of them alone is exactly the class of bug the shape-versus-body rule exists to stop.

### Chain-through pieces

**`wrappable`** is the other per-shape rope flag, and the mirror of hook-proof: `CollisionObjectData.wrappable: false` (absent = true) sets `CollisionShape2D.wrappable` off, which the engine already had for the ball's mounting loop - **solid, but not rope geometry**.
Every rope path honours it in one place each: `wrappableSurfaces` drops the piece from the scan, the self-intersection resolvers decline it, `syncCoil` will not wind onto it, and a chain end authored on it is re-tied to the nearest piece of the body the rope *can* hold (`tieablePieces`).
The avatar stands on it, bodies collide with it and the hook still bites it.

The case it exists for is the **treadwheel crane**: a wheel whose rim the player rolls and whose hub winds the chain, which must be one body so they turn together, with a chain that leaves the hub straight through the rim.
A rope that starts inside a piece has no consistent wrap of it in any case - the straight span leaves the rim without bending, so there is nothing for the scan to hold - which is why the flag is per shape and not something the solver could infer.
The editor authors it as a `chain-through` checkbox beside `hook-proof` and draws the piece with the dotted edge a hook-only body wears; `chainable` refuses it as a chain host, and `anchorHost` prefers a wrappable sibling, so a chain dropped on the wheel lands on its hub.

## Hook-only bodies

A **`passable`** body (`CollisionObject2D.passable`) is the mirror image of a hook-proof surface (see **Hook-proof surfaces**): the hook attaches to it, and **nothing collides with it** - the avatar, the ball, loose debris and the rope/chain all pass straight through.
It is what background scenery you can swing from is made of - a metal grate, a girder, a chandelier, a leaf on a stem - geometry that must not block the level it decorates.

It was the **`anchor` body kind** and an `AnchorBody` class, and it is a flag on the body now for the reason the `impermeable` kind became one, plus one more.
A kind is what a body IS, so hook-only could only ever be immovable scenery; the thing levels actually want it for is a leaf on a sprung stem, which is a `rigid` body that still falls, still sags when the player hangs off it and still stops nothing.
A flag composes with `static` and `rigid` alike.
It stays per BODY and not per shape, which is where hook-proofing lives: hook-proof asks *which surface did the hook reach*, a question about one face, while this asks *is this thing in the way at all*, and a body half in the way is not a thing a level can mean.

Four mechanisms keep it out of the sim, none of them a per-call-site special case:

- `PhysicsBody2D.isSolid` is false while it is set, and every collision path in `World` already filters on that (it is what a `VineLink` is excluded by).
  `moveAndCollide`'s sweep and its depenetration passes, the contact gather and the depenetration sweep all drop it.
- It goes **further** than `isSolid` in the one place a vine deliberately does not: a vine link is blocked by statics, which is how a vine drapes over a ledge, while a `passable` body is blocked by nothing at all.
  `gatherDepenetration` answers with no overlaps for one and `collectContacts` drops its pairs against statics too, which is what stops the scenery a leaf hangs in front of shoving the leaf out of itself.
- Setting it moves the body onto its own collision layer (`LAYER_ANCHOR`), which the setter does rather than the caller, so the two cannot disagree.
  Every existing raycast asks for `LAYER_SOLID`, so they all miss it; the grapple `Hook` is the one query that asks for both, which is exactly what makes it attachable.
  `BallHook`'s swept and probe contacts test no `isSolid` at all, for the same reason.
- `buildLevelBodies` adds it to the world but keeps it **out of the returned wrap list** (the list is exactly the solid bodies), so a passing span has nothing to catch on, and `Rope` itself refuses to wrap a body whose `isSolid` is false (the `isPassThrough` gate in `regeneratePath` *and* in both self-intersection resolvers).
  The second half is not redundant: the wrap list is only the *scan* list, whereas the self-intersection resolvers wrap whatever a rope node is **already attached to**, list or no list.
  Since the hook's whole purpose is to attach to one, that path is reached on every anchored chain - without the gate the chain bent around the grate it was hooked to, which is precisely the collision this exists to avoid.

What it does **not** switch off is the body's own motion: a hook-only `rigid` body still falls, still hangs on its spring, is still dragged by an area current and is still hauled by a chain attached to it.
What it stops having is contacts.

Queries that scan bodies generically (ledge detection, the debug overlay, the embedding invariants) filter on `isSolid` - a grate corner is not a ledge.
The editor offers no friction on one (nothing rests on it) and no hook-proof checkbox (it exists to be caught on).
The 2D renderer, the editor and the SVG snapshot draw it first, behind the solid geometry it sits among, punched with a grate lattice and edged with dots; in **3D** the lattice is dropped and the body's setback behind the gameplay plane is what says the player passes through it.
