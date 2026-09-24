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

### A level's lens

A level may change the camera with a top-level `camera` block (`LevelCameraData`), edited in the editor's **3D camera** panel under the environment.
It sits beside the environment block rather than inside it because `zOffset` is a length, and the environment block holds none by design.

- `focalLength` is in millimetres, as a 35 mm-equivalent lens: `fovY = 2 atan(12 / f)`.
  Absent is the 34° lens (about 39.3 mm).
  It is not scaled between pixels and metres.
  The dolly above still sets the camera's distance from the zoom, so **the gameplay plane is framed identically at any focal length**, and every overlay stays on it.
  Only how depth reads changes: longer flattens toward orthographic, shorter exaggerates parallax.
- `zOffset` (scene pixels on disk, metres in the sim) moves the whole placement along z.
  The camera stands that much further back (positive) or nearer, looks at and orbits about the point that far off the plane, and so **frames the plane at `z = zOffset` exactly as the 2D view frames the gameplay plane**.
  Away from 0, the gameplay plane itself is drawn smaller (positive) or larger (negative) than the overlay's reticle, glyphs and handles describing it.
  That drift is the chosen trade: the zoom and the camera regions still decide how much world is on screen, and nothing about the 2D camera is re-derived from the 3D one.

Both resolve to one `SceneLens` (`lensOf` in `space.ts`), which `syncCamera` takes in place of the old bare field of view.
The far plane is pushed out, never in, when a long lens stands the camera far back, so no default camera changes its depth range.
Fog is measured from the camera, so moving the camera changes how much fog the gameplay plane takes on.
Orthographic objects (see [Per-object projection](#per-object-projection)) scale to the framed plane, which is the scale the orthographic camera and the overlay use.
`cli render3d`'s `lens:` cases assert all of this: the focal-length conversion, an 85 mm lens still framing the plane to a hundredth of a pixel, the z offset moving the correspondence to its own plane (and off z = 0), a 2 m lens not clipping the plane, and the block's px/m and editor round trips.

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

**Out of the plane, both kinds tip the same way.**
`rotX`/`rotY` turn the drawn thing inside its piece - a prop's holder, an extrusion itself - about the object's own origin, and since an extrusion is built centred on z the pivot is the solid's middle rather than its back face: a rect canted about x is a ramp hinged on itself.
It is a look and nothing more, like every other field on the object: the body collides with the outline its collision objects state, in the plane, and the 2D renderer draws that outline face on.
A surface the ball can actually run up is `rot` on a collision shape; this is what makes a panel read as one seen slightly from the side.

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

## Per-object projection

A geometry object may be drawn through an **orthographic** lens inside a scene drawn through the perspective one: `GeometryObjectData.projection`, `"perspective"` when absent, and the `lens` picker on the editor's geometry panel.
An orthographic object has no perspective divide, so it keeps its size at every depth, shows none of its side faces head on, and does not parallax as the camera pans.
The two lenses agree exactly on the gameplay plane, so an object at `z = 0` only looks different where its extrusion leaves the plane.

It is **not a second camera and a second pass**.
A perspective depth buffer is hyperbolic and an orthographic one is linear, so two passes cannot sort against each other honestly, and every light, shadow and fog term would have to be kept in step across both.
Instead the object is drawn through the same camera, wearing an orthographic twin of its material (`render3d/projection.ts`) whose vertex shader changes one line: before the projection matrix, the view-space `xy` is scaled by `-z_view / plane`, where `plane` is the distance along the view axis to the framed plane (`z = 0`, or the level's camera `zOffset`, passed in the shared `orthoFramedZ` uniform that `Scene3D.render` writes before each draw).
That cancels the perspective divide, so each vertex lands exactly where the editor's orthographic camera would put it.
The depth it writes is still the true perspective depth, so it sorts against every other object by where it really is.

Everything except the screen position is still the object's real position: `mvPosition` itself is untouched, so lighting, the shadow lookup and fog read the authored placement.
The shadow pass uses three's own depth materials, which are never patched, so **an orthographic object casts the shadow its real position throws**, and that shadow is not under what is drawn if the object sits off the plane.
Under the editor's orthographic camera the patch does nothing (it tests three's `isOrthographic`), because the whole scene is already orthographic.

The rest follows from that:

- Twins are cached one per source material and share its program cache key with `|ortho` appended, so a hundred orthographic bricks compile one program.
- Orthographic meshes are not frustum-culled, because culling tests the true bounds against the perspective frustum, and in front of the plane that frustum is narrower than the one the mesh is drawn through.
- `Scene3D.pick` casts a second ray through the orthographic camera, which is synced to the same view every frame, for objects drawn orthographically, and merges the hits by view depth.
- `cloneWithPatches` is the clone that keeps `onBeforeCompile` and `customProgramCacheKey`, which three's own `clone()` drops.
  The editor's selection highlight uses it, so a selected orthographic object stays where it is drawn.
  It also fixes a highlighted object losing its shader patches (water, rocks), which it did before.

`cli render3d`'s `format:` and `render:` projection cases assert the field survives the px-to-m gate and an editor save, that the twin is shared and keyed apart, that its hook really rewrites three's `project_vertex` chunk (a renamed chunk would be a `replace` matching nothing, and the object would silently draw in perspective), and that the highlight keeps it.
What they cannot see is the picture, so the shader was checked with a `cli shot --3d` of a probe level: pairs of boxes at z = -6, -2, 0 and +1.5 m, one of each lens.

## Conveyor belts

A geometry object whose shape is a `belt` (see [**Conveyor belts**](conveyors.md)) draws its BAND as its own geometry (`BeltRing`, `render3d/beltTread.ts`), not an extruded outline: the extruder's side-wall UVs are anchored in the object's own x and y so a wall's texture meets the cap's, which on a loop runs u along the runs and turns it into the depth axis wherever the outline goes vertical, and a belt's running surface wants u by ARC LENGTH.
The ring is an outer wall on the loop, an inner wall `thickness` inside it, and front and back caps (the band's edge) at `±depth / 2`, the object's `depth` being the band's width across the pulleys; each face has its own normals, so the edges are creases and no two faces share a plane.
Its UVs are metres, as the extruder's are: `u` is arc length along the outer surface at the rate that makes the surface's repeat (`tileMetres`) the nearest length going round a whole number of times, so there is no seam where `s` wraps and nothing stretches round a wheel, and the caps and the inner wall carry the same `u` as the surface they stand on; `v` runs on round the cross-section, continuous over every rim but the back of the outer wall.
Inside the band is the hollow: nothing is drawn at the wheels, which an author dresses with props of their own.

What says the belt runs is its surface.
A textured band **scrolls**: every frame its `u` is `(s - speed · t) · rate` with `t` the SIM clock, `(frame - 1 + alpha) / 60` (`beltRenderTime`, the instant the bodies are interpolated to), so a replay shows the same belt at the same frame and a paused game shows it standing.
The scroll is written into the ring's own UV buffer rather than a map's `offset`, because materials are shared through the cache in `assets.ts` and an authored set's maps are swapped into that shared material as they arrive; a belt whose phase has not changed skips the write.
An UNTEXTURED band - the flat fill, `texture: "color"` - has nothing to scroll and keeps its **cleats**: a ring of thin pale slats (one `InstancedMesh` per belt) set 4 mm inside the surface (or a fifth of the band, if less), through the whole width and 4 mm out past both caps, so what shows is a slat end on the rim of the front cap, and a slat never reaches the band's inner face.
Both run at the geometry object's own `speed`; `Scene3DLevel.frame` is how the clock reaches the scene, and a host with none (the editor's preview) draws the belts still.
Cleat placement allocates nothing (`beltFrameAt` is `beltPointAt`/`beltTangentAt` written into a scratch record, and `cli render3d` holds the two to agree).
`cli render3d`'s `belt:` cases hold the ring's walls, caps and normals against the loop, `u` against arc length with a whole number of repeats, and the scroll's rate and sign; `cli shot --3d --frames` on `TEST_BELT` is the evidence for how it looks.

The first cut drew the extruded loop and cleats only, rejecting a scrolled texture because the extruder's UVs could not carry one and because the side wall is seen nearly edge-on.
The ring answers the first; the second turned out to matter less than it read, because the camera sees the front cap face on and the inner wall through the hollow, and both carry the moving `u`.

## Traps

- **`PX`-sized constants do not survive projection.** A fixed on-screen size written as `<px> * PX` assumes the 2D renderer's uniform transform. Everything like that stays on the overlay, and nothing in the 3D scene may depend on `PIXELS_PER_METER` except through `space.ts`.
- **`Scene3D` must be instantiable twice** - the game page and the editor both have one - so everything mutable lives on the instance. The `playerRig.ts` module-global pattern is the anti-pattern this is written against. The material cache in `assets.ts` is shared deliberately: it is immutable once built and belongs to no scene. There are two named exceptions. The first is the avatar's own entry (`SurfaceRequest.avatar`), whose fog `avatarSurface.ts` patches; it is shared with nothing but the avatar, and a page draws one (see [**The avatar's own surface**](lighting-and-surfaces.md#the-avatars-own-surface)). The second is a waking body's own copy of each of its surfaces (`SurfaceRequest.instance`, keyed by the body's index in the level), whose `emissiveIntensity` the light rig writes every frame so the cap brightens with its light; only a body carrying a waking light asks for one, so no other level gains a material, and it is keyed by index rather than minted per build so the editor's rebuild on every edit reuses the same entries (see [**Waking lights**](lighting-and-surfaces.md#waking-lights)). A rig hands the authored intensity back when it lets the body go.
- **Transform sync must not allocate**, and must read `renderPosition/renderRotation(alpha)` only. The debug overlay is the one deliberate exception (it exists to show what the sim believes) and it stays 2D.
- **Where the chain's links fall is shared code.** `render/chainMetrics.ts` holds the one continuous arc walk both renderers use, because that is the one part of chain drawing that has ever been wrong (`session-1467f`) and two copies of it would drift.
