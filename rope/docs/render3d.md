# 3D rendering

The ball & chain is drawn in 3D (`src/render3d/`, three.js), in the style of *Getting Over It* and *A Difficult Game About Climbing*: gameplay on a single plane, a perspective camera, PBR surfaces, one warm sun with shadows, and - where a level asks for it - fog fading the layers behind.
**The physics is untouched by all of it.**
It is still 2D, still metres, still a fixed 1/60 step, still deterministic, and every replay in `playtests/` still replays bit-for-bit - the 3D renderer is a parallel consumer of exactly the interpolated state the 2D one reads (`renderPosition/renderRotation/renderShapes(alpha)`, `RopeContact.renderGlobalPosition(alpha)`), and it never writes anything the sim can see.

`?render=2d` selects the old path anywhere; `?render=3d` selects the new one.
The default is 3D for the ball level and 2D for the grapple levels, because the Player state-machine slice (its rig, its rope, its ledge overlay) is deliberately still 2D - a grapple level in 3D is a 3D world with a 2D avatar in it, which works but is not what anyone asked for yet.
A machine with no WebGL falls back to the 2D renderer rather than to a blank page.

## Two canvases, one camera

The WebGL canvas sits **under** the existing 2D one, which clears transparent and keeps everything that is genuinely 2D: the debug overlay, the aim reticle, the area glyphs, the FPS counter, the vignette, and in the editor the collision outlines, handles and marquee.
`fitCanvas` sizes both from one arithmetic, so a pixel on one is a pixel on the other, and the top canvas keeps the pointer events - the scene below is drawn, never clicked.
`overlayOnly` on `render`/`renderBall` is what drops the backdrop and the bodies from the 2D pass; it defaults **off**, so `shot.html`, `cli shot` and `cli render` are untouched.

That stacking is what makes "see the collision boundary on top of the geometry it describes" free, and it stands entirely on the **camera correspondence**.
The existing `Camera` (metres + zoom) and `CameraController` (regions, blending, locks, `viewportScale`) stay the authority; the perspective camera is derived from them every frame in `render3d/space.ts`, with **zoom becoming dolly distance**:

```
visibleHeight = camera.viewportHeight / (camera.zoom * PIXELS_PER_METER)   // metres at z = 0
dist          = (visibleHeight / 2) / tan(fovY / 2)
threeCam.position = (camera.position.x, -camera.position.y, dist)
```

So camera regions, blends and `viewportScale` keep working untouched, and props off the plane parallax naturally as the view zooms.
The FOV is a narrow ~34° on purpose: the gameplay plane reads almost orthographic, so a wall at the top of the frame is barely foreshortened and the outline a level was authored against is still what the player sees, while off-plane layers still move at their own rate.

The two projections agreeing is **asserted, not eyeballed**: `cli render3d` runs three.js's own projection against the 2D transform at five camera placements and through a pan, at the corners of the frame where a wrong dolly distance shows first, and holds them to a hundredth of a view pixel.
`?probe3d=1` is the same claim made visible - a known world rect drawn as a plane in the scene and as an outline on the overlay, which must coincide at any zoom, position or mid-blend frame.

## The coordinate mapping

Physics is x right, y **down**, rotation clockwise-positive.
Three is right-handed, y **up**.
The single conversion lives in `space.ts` and nothing converts anywhere else:

```
three.position.x =  body.x
three.position.y = -body.y
three.position.z =  z          // 0 is the gameplay plane, +z toward the camera
three.rotation.z = -body.rot
```

The y-negation also mirrors a polygon loop, which is why `extrude.ts` measures the loop's signed area and re-winds it: physics polygons are wound clockwise-on-screen with y down (see [**Shapes**](physics-foundations.md#shapes)), and `ExtrudeGeometry` wants counter-clockwise in its own frame for the front cap to face the camera.
That happens to be what the negation produces, which is a coincidence worth stating rather than relying on - `cli render3d` asserts the cap's normals.

## Nothing draws a collision shape but a geometry object

A collision object is what a body is **made of**; a geometry object is what it **looks like**; and a body with no geometry object is drawn by nothing at all - a solid, invisible wall, which is a thing a level may want.
They used to be one authored thing: a collision shape drew itself whenever nobody said otherwise, which meant there was no way to say "this collides differently from how it looks" without also saying how it looks, and every question about appearance had to be asked of a shape that had opinions about mass.

**AND IT IS DECOUPLED IN BOTH DIRECTIONS.** A geometry object carries its own `shape` and its own placement, always, and nothing about what is drawn is read off a collision object - not the form, not the position, not the rotation, not the depth, not the surface.
A primitive nudged 10 cm left, turned 5° and made twice as wide moves, turns and grows on screen while the body goes on colliding exactly as it did.

It was not always: a geometry object with no shape used to draw the body's collision outlines, which is how a wall wore brick without restating its outline and what every migrated body was given.
The saving was real and the cost was that the two were not actually separate things - the geometry object's own `x`, `y`, `rot`, `w` and `h` were **dead fields on the commonest object in every level**, silently overridden by the shape it was standing in for, and "this collides differently from how it looks" was still unsayable for the one case (a different SIZE or PLACE) an author reaches for first.

The old default is still written down, twice, and both halves state the outline rather than borrowing it:

- `withGeometryPrimitives` (`levelFormat.ts`) gives a body converted from a **legacy flat entry** one primitive per collision object, each carrying that piece's shape, placement, `thickness` as its `depth` and `material` as its `texture`. That is the only form the old default was ever authored in, and `levelData.ts` still arrives that way from the Godot extractor.
- `scripts/migrate-primitives.ts` did the same thing **once, on disk**, to the levels already in the nested form (`levels/*.json`: 159 dressings became primitives). It inverts the retired `outlineDressings` pairing, so a compound body dressed by one geometry object gets one primitive per piece, and it is kept because it is the record of what those files were.

Both are pixel-identical by construction, and the second is why there is no load-time migration for the nested form at all: a file says what it draws, and the loader does not edit it on the way past.

"No geometry object **at all**" is the load-bearing half of the legacy one. Any geometry object is the body saying how it looks, and that answer stands: a lamp whose collision box carries an authored mesh looks like the lamp, and twinning it too extrudes a grey brick inside the fitting - visible in play, invisible in the editor, and exactly the kind of thing a migration must never invent.
It is idempotent because it has to be - the legacy path is reached by any file still carrying retired panels or lights.

The editor holds the same line at the other end: **Add geometry** on a selected collision shape makes the primitive that draws it (`addGeometryFor`), copying the same five things `primitiveOf` copies, and a draw alone still produces a collision object and nothing else.
The look fields sit on the geometry panel alone; on a collision shape they edited a value `toLevelData` has never written for a collision object, which is a dial connected to nothing.

What this costs, stated plainly because it is the trade the decoupling makes: **a wall widened after it is dressed is widened twice** - there is no longer a single edit that silently means both.
The fix for when that bites is the **matched-outline link**, and it is an editor feature rather than a fallback in the format, which is what keeps the decoupling honest.
`GeometryObjectData.matchCollision` marks a primitive as MIRRORING a collision object in its own body, and the editor keeps the two outlines - `pos`, `rot` and `shape` - equal in **both directions** (`syncMatchedOutlines`, run from `markDirty` so every edit path flows through it without knowing the link exists): resize, move or turn either and the other follows.
The outline is still stated in full on both objects - the game and every loader read a matched file exactly as an unmatched one - and the partner is not named on disk: the editor re-finds the collision object with the identical outline at load, which the link's own invariant guarantees exists, so there is no index to go stale when a body's objects are reordered.
A hand-edited file whose halves have drifted snaps the look back onto the collision shape when the body has one collision object (the collision outline is what the level plays as), and drops the link rather than guessing when it has several.
**Add geometry** creates its twin already matched, since starting in step is what "give this shape a look" almost always wants; the `match collision` checkbox on the geometry panel is where the link is dropped to diverge the two on purpose, and ticking it back snaps the geometry onto the collision shape.
A matched pair follows its collision partner through **Ctrl+Shift+G** the way an anchor follows its shape - the pair is one authored thing, and a gesture about bodies must not break the link as a side effect.
`cli render3d`'s `matchedOutline` cases are the detectors, because none of this is visible in a picture: a level renders identically with or without the link, so a save that drops the flag or a sync that stops propagating is exactly the double-edit pain back again, behind a checkbox claiming otherwise.

A body is a `THREE.Group` carrying the interpolated pose, with one child per collision shape at that piece's `localOffset`/`localRotation` - rigid within the body, so written **once** at build.
The per-frame sync is therefore two writes per body into vectors it already owns; chain links go through one `InstancedMesh` with `count` set per frame rather than per-link `Mesh` churn.

Two rules are inherited from elsewhere rather than invented here:

- A **code-built circle is a sphere and an authored one is a disc**, which is the same split `lib/shapeGeometry.ts` makes about mass (`computeMass` versus `prismMass`). Drawing them by the rule they are weighed by is what stops a 4 cm hook being drawn as a 20 cm slab.
- A geometry object's `depth` is its own, and the migration seeded it from the collision object's **`thickness`** - so a migrated body is as thick as it weighs, and stays that way only for as long as an author wants it to. `thickness` is what a piece's MASS is computed from and is never read for the look again.

Authored colours are kept, but as a **tint with a brightness floor**: the levels were authored for a flat renderer where a body's colour *is* its appearance and most of them are near-black greys, so multiplying a stone texture by `#000000` leaves a hole where a wall should be. The hue is kept exactly and only the lightness is remapped into `TINT_FLOOR..1`, which preserves the authored ordering while leaving every surface enough albedo to show its grain and respond to the sun.

Areas stay on the 2D overlay in both modes - a killzone's skulls and a force area's arrows are flat marks on a region of *space* (see [**Area glyphs**](areas-and-friction.md#area-glyphs), and "pass-through geometry must read as pass-through" in `docs/game-design.md`).
Hook-only bodies do **not**: they extrude a quarter of a metre behind the plane, and in 3D that setback is the whole cue, so the grate lattice is drawn in 2D mode only rather than stamped flat over a body the scene has already put behind the level.

## Bodies and scene objects

A level is a list of **bodies**, and a body is a list of **scene objects**: a collision shape, a piece of 3D geometry, a light, or a chain **anchor**. Everything a body has exactly one of - what it collides as, its fill, its friction, a force area's magnitude - lives on the body; everything it may have several of lives on its objects, placed in the body's own frame.

That shape replaced three separate mechanisms at once, and each of them was working around the same missing thing:

- A **compound body** was a `group` STRING TAG on several flat entries, matched by name at load. It is now one body with several collision objects, so nothing has to agree about a tag and the properties a body has one of cannot be authored several times and then quietly collapsed onto the first member's (`syncGroupProps` is gone with it, and the editor's own "grouping" with it: an item carries the body it is IN, always, so "ungrouped" stopped being a state).
- [**Decoration**](editor-model.md#decoration) was `collision: false` on a body-shaped entry - a shape that had to carry, and then ignore, every physics field. It is now a body with a geometry object and no collision object, so there is nothing to ignore.
- A **light** was its own top-level list with no parent, so it could not ride anything (see [**Light and air**](lighting-and-surfaces.md#light-and-air)).

The body's **authored** frame and its **engine** frame are deliberately different points. The engine origin has to be the collision objects' combined centre of mass - every lever arm in the engine is measured from `globalPosition` - and it moves as pieces are added; the authored one has to stay put, or every offset in a body would shift whenever a piece was added to it. `buildLevelBodies` absorbs the difference once, at load (`BuiltBody.origin`), which is the same job the retired `resolveDecor` did for decoration and `buildSceneChains` still does for chain anchors.

A **geometry object** is the choice between the two ways a thing gets a look:

- `kind: "primitive"` (or absent) draws its own `shape` as a solid: a **rect is a rectangular prism**, a **circle is a cylinder** (three's own lathe rather than a 24-gon extrusion, so a barrel's highlight travels round it smoothly) and a polygon is that outline extruded. `depth`, `bevel`, `texture` and `tileScale` are its own; `depth` defaults to `DEFAULT_THICKNESS` on a body that collides and `DECOR_DEPTH` on one that does not, and `bevel` to none.
- `kind: "mesh"` replaces it with a named **GLB prop** from the manifest, placed by the object's own `x`/`y`/`rot` plus `z`, `rotX`, `rotY` and a dimensionless `scale`. It keeps the materials its own file carries **unless** the object names a `texture`, in which case it wears that instead - which is what lets a bare, geometry-only export (~20 KB) be dressed as the same stone the walls are made of, and what makes "a GLB **or** a primitive" the real choice rather than "a GLB or a textured primitive".

There is deliberately no third answer for "drawn by nothing": a body draws its geometry objects and nothing else, so an invisible wall is a body with **no geometry object**, which is also what an editor draw produces before anything dresses it.
A primitive with no `shape` at all draws the same unit placeholder an unfetched prop does - visible and obviously wrong, rather than silently absent.

`drawnObjects` (`render3d/bodyVisuals.ts`) is the whole rule and is one line - a body's geometry objects, in authored order - and it is exported so the claim can be checked without a GPU, a canvas or a DOM: a collision object never appears in it, however bare the body.

The **2D** renderer draws the other half - a body's collision shapes - so it must not also fill the primitive stating the same outline in the same place, which would lay the same colour down twice and darken every wall by its own opacity.
`collectDecor` is where that is decided: a form on a colliding body reaches the 2D pass only if it is **off that body's plane** (a backdrop welded into a swinging crate, which is what a welded `z` means), and a body that collides with nothing is drawn whatever its depth, nothing else in that view standing for it at all.
The 3D renderer needs no such rule, since it never draws a collision shape.

An **extruded solid is contained by the outline it states.** Three's bevel runs from the caps *outward*, so the old 2 cm default put every drawn body 2 cm proud of its own shape on all four sides - a floor slab taller than the collision box the ball rests on, seen as the ball sinking into the ground, and invisible to every check here because the sim was right throughout. `bevelOffset: -bevelSize` makes it a chamfer off the outline instead, and `cli render3d` asserts the bounding box against the authored size *with the bevel on*, which is the case the old size assertions could not make (both asked for `bevel: 0`).

`mountVisual` (`render3d/bodyVisuals.ts`) is the single place that choice is cashed out, and `BodyVisual` is now the ONE class for every body - a wall, a swinging crate, a backdrop 20 m behind the plane and a lamp with no fitting are all a body with objects in it. What used to be a second class for decoration is the case where the body built no engine body: its root stands at the authored transform instead of tracking one, and `sync` has nothing to do.

`material` and `thickness` stay **per collision object**, which is the one property a body does not have just one of: its mass, centre of mass and inertia are sums over its pieces, so a stone head on a wooden shaft is exactly what those sums are for.

Every length goes through `scaleObject` both ways.
Forgetting one is silent (the editor rewrites the whole file every 750 ms, so a dropped field is gone from disk before anyone notices it was read), which is why `cli render3d` asserts both round trips: the format's px → m → px, and the editor's `modelFromDisk`/`modelToDisk`, which goes through a different shape entirely. Both are compared over **flattened** placements rather than bytes, because a body's transform and its objects' placements are two halves of one answer and the editor legitimately re-origins a body onto its first object when it saves; a byte comparison would read that as a lost field.

**The retired flat form is still an input**, and permanently: the Godot extractor writes it, so `levelData.ts` arrives that way. `normalizeLevelData` folds every retired form - the flat entries, the `impermeable` kind, the `backgrounds` list and the top-level `lights` list - into this one, inside `scaleLevelData`, which is the one gate a level cannot reach the sim or the editor without passing through. It is **bit-identical by construction**: a migrated body's own origin is (0, 0, 0) and its objects keep the world placements the flat entries carried, so the centre-of-mass arithmetic reads exactly the numbers it read before, and a group's body is emitted where its first member sat so `World.add` stamps the same build index. The whole committed bundle corpus replays byte-for-byte across the change, which is the test that this is a re-shaping and not a rewrite.

## Traps

- **`PX`-sized constants do not survive projection.** A fixed on-screen size written as `<px> * PX` assumes the 2D renderer's uniform transform. Everything like that stays on the overlay, and nothing in the 3D scene may depend on `PIXELS_PER_METER` except through `space.ts`.
- **`Scene3D` must be instantiable twice** - the game page and the editor both have one - so everything mutable lives on the instance. The `playerRig.ts` module-global pattern is the anti-pattern this is written against. The material cache in `assets.ts` is shared deliberately: it is immutable once built and belongs to no scene.
- **Transform sync must not allocate**, and must read `renderPosition/renderRotation(alpha)` only. The debug overlay is the one deliberate exception (it exists to show what the sim believes) and it stays 2D.
- **Where the chain's links fall is shared code.** `render/chainMetrics.ts` holds the one continuous arc walk both renderers use, because that is the one part of chain drawing that has ever been wrong (`session-1467f`) and two copies of it would drift.
