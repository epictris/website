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
`cli render3d`'s `lens:` cases assert all of this: the focal-length conversion, an 85 mm lens still framing the plane to a hundredth of a pixel, the z offset moving the correspondence to its own plane (and off z = 0), a 2 m lens not clipping the plane, and the block's px/m and editor round trips.

The two projections agreeing is **asserted, not eyeballed**: `cli render3d` runs three.js's own projection against the 2D transform at five camera placements and through a pan, at the corners of the frame where a wrong dolly distance shows first, and holds them to a hundredth of a view pixel.
`?probe3d=1` is the same claim made visible - a known world rect drawn as a plane in the scene and as an outline on the overlay, which must coincide at any zoom, position or mid-blend frame.

### Free view pose

`syncCamera` is two steps: `poseFromCamera(camera, lens, orbit)` reduces the 2D camera, the level's lens and the editor's orbit to a `ViewPose`, and `applyPose(threeCam, pose, aspect)` places a three.js camera at it.
A pose is five numbers in three's frame: a `target` (x, y up, z toward the viewer, metres), `yaw` and `pitch` about it (radians, both zero is head-on), `halfHeight` and `fovYDeg`.
It exists so a host can hold a camera the 2D one cannot describe: the editor's Visuals workspace keeps a pose of its own, whose target may leave the gameplay plane, and hands it to `Scene3D.setViewPose` (null hands the camera back to the 2D one).

- The view is sized by **`halfHeight`**, the world metres from the frame's centre to its top edge at the target's depth, not by the camera's distance.
  It is the one number both lenses are sized by - the orthographic frustum is it, and the perspective camera stands `poseDistance(pose) = halfHeight / tan(fovY / 2)` back - so a single pose drives both to the bit, and a lens change reframes nothing and moves the camera, which is the rule a level's lens already follows.
- **The split changed nothing.** `applyPose` keeps the written-out head-on branch, `poseDistance` is `cameraDistance`'s arithmetic operation for operation, and `cli render3d`'s `visuals:` case holds `syncCamera`, `applyPose(poseFromCamera(...))` and the workspace's `headOn` to a verbatim copy of the old `syncCamera` in every number of the camera (position, quaternion, up, near, far, projection and world matrices, frustum) at five placements, three orbits (one past the pitch clamp) and both lenses.
  A one-ulp change to the distance turns it red.
- Under a pose, `Scene3D` places both cameras from it (the aspect still from the 2D camera's viewport), so `pick`, `unprojectToPlane` through `scene3d.camera` and the gizmo see the view that was drawn.
  The sun's shadow frustum and the light budget's "nearest the view" follow the pose's target instead of the 2D camera.
- `unprojectToPlane` takes an optional `z`, the plane that far off the gameplay plane, for guides drawn at an object's own depth.
  Under a free pose the camera can stand behind a plane it is asked about, and that is the null answer.

`Scene3D` also carries the editor's own layer and the queries its surface tools need, all editor-only:

- `editorLayer`, a group in the scene that survives `setLevel`, is raycast by `pick` (fat lines picked `LINE_PICK_PX` either side) and skipped by `setHighlight` and `meshesOf`.
- `hitsAt(x, y)` is `pick` with three's whole intersection kept, nearest first; `pickSurface(x, y, accept)` answers the nearest hit with a face whose tag `accept` takes, as a world point and a world normal; `meshesOf(tag)` lists every non-instanced mesh drawn for a tag.
  All three are ported from the fork (karin_website `381b923`), including its fix of `pick` measuring depth by `hit.point.sub(...)`, which rewrote the hit point in place.
  A hit on something that is not a mesh (a guide's sprite: a corner handle, a light's icon) is kept like any other; until 2026-09-25 a lens test on `mesh.isMesh` dropped every sprite, so no handle could be picked at all (found driving the Visuals workspace; the `visuals:` cases raycast the guides directly and could not see it).

## The frame target

The WebGL canvas is made **without** antialiasing, and nothing is drawn onto it directly.
Every frame goes into one 4x multisampled target the size of the canvas (`render3d/frameTarget.ts`), and the canvas receives the finished picture as one single-sample copy at the end.
That is what lets a pass read the frame back (the depth of field's blur reads its colour and depth) and write into the same samples, only where it changes something.
Before 2026-10-05 the depth of field rewrote the whole frame onto an antialiased canvas, every pixel's four samples and its depth, which cost 0.45 ms at 4K and took an RTX 4070 SUPER from 144 Hz to ~136.
Measured in the live page, fullscreen and interleaved, the GPU frame went from 4.70 to 4.03 ms with the blur off and from 5.40 to 4.54 with it on, and both held 144 Hz.

The target is flagged as three's XR target and stored as plain RGBA8, so every program is the one three builds for the canvas (tone mapped and sRGB encoded in the shader) and translucent layers blend in the canvas's own space.
In an ordinary linear float target the sky moved from (20,40,62) to (2,29,56).
The flag is three's internal, so a three upgrade has to be checked against the previous picture (`cli shot --3d` before and after).
Drawing back into the samples after they have been resolved relies on three not discarding them, which it only does on the Oculus browser.

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

## What the scene draws

**A level's look is its Blender scene, and the level itself draws almost nothing** (see [blender-scenes](blender-scenes.md)).
Since 2026-09-29 the level format has no geometry objects: a collision object is what a body is made of, and what it looks like is whatever object in the level's scene carries the body's `name`.
`BodyVisual` (`render3d/bodyVisuals.ts`) is the ONE class for every body, and what it builds is only what a mesh cannot be:

- **Water** (`render3d/water.ts` for a current and its fall, `stillWater.ts` for a pool, both after Tris's studies and sharing `waterLook.ts`; see [water](water.md)), whose surface the current runs across; its slab is the body's `waterZ`/`waterDepth` and its tint the body's `color`.
- **A conveyor's band** (see [Conveyor belts](#conveyor-belts)), built from the belt collision object itself.
- **The body's lights** (see [lighting-and-surfaces](lighting-and-surfaces.md)).
- **Debug geometry**: every collision piece whose `debug.on` is set (`CollisionObjectData.debug`, the Debug section of a shape's panel in the editor), extruded through its `debug.depth` and filled flat (`texture: "color"`) with its `debug.color` at its `debug.opacity`.
  Every setting falls back to what the piece already says - the depth to its `thickness` (default `DEFAULT_THICKNESS`), the colour to the body's `color`, the opacity to 1 - so `{ on: true }` is the piece drawn as itself.
  It is per piece and opt-in, in every level, scene or not, and for a volume (a killzone, a force area) as for a wall; a belt has none, since it draws its own band.
  It is an instrument rather than a look: what a level with no scene is blocked out in (the test levels), and what a piece a dressed level has nothing over is seen by.
  A see-through piece (`opacity` below 1) writes no depth and casts no shadow.
  **G** hides all of it at once, in the game and in the editor's ▶ Test (`Scene3D.setDebugShown`), to see the Blender scene alone; every test opens with it shown, and authoring always shows it.
  The editor's **all debug** forces it the other way (`Scene3D.setAllDebugShown` → `BodyVisual.setDebugForced`): every piece is drawn, switched on or not, with its own settings, render-side so the level data is untouched; the game never sets it.
- A body the **sim spawned** (a sandbox rock, the hook) extrudes its own shapes, scene or not.

A piece with debug geometry switched off draws nothing, scene or not: an invisible wall stays invisible, and `just scene` reports the body names with no object behind them.

Until 2026-10-07 (level format 1) the switch did not exist: a level that named no scene drew every piece of every non-area body as a **grey box**, by a rule no piece could opt out of, and a dressed level drew none.
`normalizeLevelData` folds a format-1 level into format 2 at load (`withDebugFromGreybox`) by switching on exactly the pieces the grey box drew, with every setting left to its fallback, so an old level - or a recorded bundle carrying one - looks as it always did.
The fold is keyed on `LevelData.format` rather than read off the data because a format-2 level with every piece switched off holds the same keys as a format-1 one.

A body is a `THREE.Group` carrying the interpolated pose, with one child per drawn piece at that piece's placement - rigid within the body, so written **once** at build.
The per-frame sync is therefore two writes per body into vectors it already owns; chain links go through one `InstancedMesh` with `count` set per frame rather than per-link `Mesh` churn.
A body that built no engine body (one with no collision object: a lone light) stands at its authored transform, and `sync` has nothing to do.
Each piece carries the collision object it was built from as its pick tag (`pickTagOf`), and a scene's dressing node carries its body's first object, so a raycast in the editor answers with something the editor can act on.

Two rules are inherited from elsewhere rather than invented here:

- A **code-built circle is a sphere and an authored one is a disc** (a cylinder), which is the same split `lib/shapeGeometry.ts` makes about mass (`computeMass` versus `prismMass`).
  Drawing them by the rule they are weighed by is what stops a 4 cm hook being drawn as a 20 cm slab.
- Debug geometry is, unless told otherwise, as thick as the piece **weighs**: `thickness` is what a piece's mass is computed from, and it is the only depth a level states. `debug.depth` overrides it for the drawing alone.

A belt's authored colour is kept as a **tint with a brightness floor** over a generated surface: colours were authored for a flat renderer where a colour *is* the appearance and most of them are near-black greys, so multiplying a texture by `#000000` leaves a hole.
The hue is kept exactly and only the lightness is remapped into `TINT_FLOOR..1`.
A flat fill (`"color"`) wears its colour exactly, and an authored set wears none.

An **extruded solid is contained by the outline it states.**
Three's bevel runs from the caps *outward*, so a 2 cm bevel put every drawn body 2 cm proud of its own shape on all four sides - a floor slab taller than the collision box the ball rests on, seen as the ball sinking into the ground.
`bevelOffset: -bevelSize` makes it a chamfer off the outline instead, and `cli render3d` asserts the bounding box against the authored size *with the bevel on*.

Areas stay on the 2D overlay in both modes - a killzone's skulls and a force area's arrows are flat marks on a region of *space* (see [**Area glyphs**](areas-and-friction.md#area-glyphs), and "pass-through geometry must read as pass-through" in `docs/game-design.md`).
Hook-only bodies do **not**: their debug geometry sits a quarter of a metre behind the plane, and in 3D that setback is the whole cue, so the grate lattice is drawn in 2D mode only (a scene puts their dressing wherever Blender does).

## Bodies and scene objects

A level is a list of **bodies**, and a body is a list of **scene objects**: a collision shape, a light, or a chain **anchor**.
Everything a body has exactly one of - what it collides as, its fill, its friction, a force area's magnitude, its `name` - lives on the body; everything it may have several of lives on its objects, placed in the body's own frame.

That shape replaced three separate mechanisms at once, and each of them was working around the same missing thing:

- A **compound body** was a `group` STRING TAG on several flat entries, matched by name at load. It is now one body with several collision objects, so nothing has to agree about a tag and the properties a body has one of cannot be authored several times and then quietly collapsed onto the first member's (`syncGroupProps` is gone with it, and the editor's own "grouping" with it: an item carries the body it is IN, always, so "ungrouped" stopped being a state).
- **Decoration** was `collision: false` on a body-shaped entry, then a body with a geometry object and no collision object; now it is not in the level at all, since the look is the scene's.
- A **light** was its own top-level list with no parent, so it could not ride anything (see [**Light and air**](lighting-and-surfaces.md#light-and-air)).

The body's **authored** frame and its **engine** frame are deliberately different points.
The engine origin has to be the collision objects' combined centre of mass - every lever arm in the engine is measured from `globalPosition` - and it moves as pieces are added; the authored one has to stay put, or every offset in a body would shift whenever a piece was added to it.
`buildLevelBodies` absorbs the difference once, at load (`BuiltBody.origin`), which is the same job `buildSceneChains` does for chain anchors and `dressScene` for a scene's bound nodes.

`material` and `thickness` stay **per collision object**, which is the one property a body does not have just one of: its mass, centre of mass and inertia are sums over its pieces, so a stone head on a wooden shaft is exactly what those sums are for.

Every length goes through `scaleObject` both ways.
Forgetting one is silent (the editor rewrites the whole file every 750 ms, so a dropped field is gone from disk before anyone notices it was read), which is why `cli render3d` asserts both round trips: the format's px → m → px, and the editor's `modelFromDisk`/`modelToDisk`, which goes through a different shape entirely. Both are compared over **flattened** placements rather than bytes, because a body's transform and its objects' placements are two halves of one answer and the editor legitimately re-origins a body onto its first object when it saves; a byte comparison would read that as a lost field.

**The retired forms are still an input**, and permanently: the Godot extractor writes the flat form, so `levelData.ts` arrives that way, and every bundle recorded before 2026-09-29 embeds a level with geometry objects in it.
`normalizeLevelData` folds every retired form - the flat entries, the `impermeable` kind, the `backgrounds` list, the top-level `lights` list and the geometry objects (`withoutLook`) - into this one, inside `scaleLevelData`, which is the one gate a level cannot reach the sim or the editor without passing through.
It is **bit-identical by construction**: a migrated body's own origin is (0, 0, 0) and its objects keep the world placements the flat entries carried, so the centre-of-mass arithmetic reads exactly the numbers it read before, and a group's body is emitted where its first member sat so `World.add` stamps the same build index.
A body that held nothing but geometry objects is dropped, and since such a body never built an engine body, no build index moves.

## Conveyor belts

A collision object whose shape is a `belt` (see [**Conveyor belts**](conveyors.md)) draws its BAND as its own geometry (`BeltRing`, `render3d/beltTread.ts`), in every level, scene or not: the band's surface moves, which a scene's mesh cannot.
The band's look is on the belt shape itself (`BeltLook`: `width`, `texture`, `color`, `tileScale`), because the belt is the one thing that draws it.
It is not an extruded outline: the extruder's side-wall UVs are anchored in the object's own x and y so a wall's texture meets the cap's, which on a loop runs u along the runs and turns it into the depth axis wherever the outline goes vertical, and a belt's running surface wants u by ARC LENGTH.
The ring is an outer wall on the loop, an inner wall `thickness` inside it, and front and back caps (the band's edge) at `±width / 2`; each face has its own normals, so the edges are creases and no two faces share a plane.
Its UVs are metres, as the extruder's are: `u` is arc length along the outer surface at the rate that makes the surface's repeat (`tileMetres`) the nearest length going round a whole number of times, so there is no seam where `s` wraps and nothing stretches round a wheel, and the caps and the inner wall carry the same `u` as the surface they stand on; `v` runs on round the cross-section, continuous over every rim but the back of the outer wall.
Inside the band is the hollow: nothing is drawn at the wheels, which the level's scene dresses.

What says the belt runs is its surface.
A textured band **scrolls**: every frame its `u` is `(s - speed · t) · rate` with `t` the SIM clock, `(frame - 1 + alpha) / 60` (`beltRenderTime`, the instant the bodies are interpolated to), so a replay shows the same belt at the same frame and a paused game shows it standing.
The scroll is written into the ring's own UV buffer rather than a map's `offset`, because materials are shared through the cache in `assets.ts` and an authored set's maps are swapped into that shared material as they arrive; a belt whose phase has not changed skips the write.
An UNTEXTURED band - the flat fill, `texture: "color"` - has nothing to scroll and keeps its **cleats**: a ring of thin pale slats (one `InstancedMesh` per belt) set 4 mm inside the surface (or a fifth of the band, if less), through the whole width and 4 mm out past both caps, so what shows is a slat end on the rim of the front cap, and a slat never reaches the band's inner face.
Both run at the belt's `speed`; `Scene3DLevel.frame` is how the clock reaches the scene, and a host with none (the editor's preview) draws the belts still.
Cleat placement allocates nothing (`beltFrameAt` is `beltPointAt`/`beltTangentAt` written into a scratch record, and `cli render3d` holds the two to agree).
`cli render3d`'s `belt:` cases hold the ring's walls, caps and normals against the loop, `u` against arc length with a whole number of repeats, and the scroll's rate and sign; `cli shot --3d --frames` on `TEST_BELT` is the evidence for how it looks.

## Blender scenes

A level naming a `scene` is dressed by one GLB exported from `assets-src/scenes/<scene>.blend` (see [blender-scenes](blender-scenes.md)).
`Scene3D.setLevel` hands `SceneDressing` (`render3d/sceneDressing.ts`) every authored body's name, visual root, rest pose and whether it collides; when the file lands, `dressScene` hangs each node named like a body under that body's root at Blender's pose minus the rest pose, so it is drawn where Blender put it and carried by the body, and adds the rest to the scene as scenery at the identity.
Bound nodes carry the body's first object as their pick tag; scenery carries none.
A bound node is handed to its body (`BodyVisual.adoptDressing`), which gives a body carrying a waking light its own copies of the node's emissive materials for the light to drive.
A node on a body that collides always casts a shadow; any other node casts only if it is not wholly behind the plane.
The file is served from `/scenes/<scene>/scene.glb`, cached per page like a prop's, weighted in the preload list by the store's pin or the local `meta.json` (`levelStoredFiles`).

Retired with the geometry objects on 2026-09-29, and recorded here so they are not rebuilt by accident: **per-object projection** (a geometry object drawn through an orthographic lens inside the perspective scene, by a vertex patch on a twin material), **image planes** (an unlit picture stretched over a shape, `imageAssets.json`), **generated meshes** (boulders and mushroom patches generated behind the dev server and keyed by a hash of their input, `generatedAssets.json`) and the 2D renderer's **decor** layer.
A painted backdrop, a generated rock or a mushroom patch is now made in Blender (the formations add-on builds rocks with the same boulder generator, [blender-formations](blender-formations.md)).

## Traps

- **`PX`-sized constants do not survive projection.** A fixed on-screen size written as `<px> * PX` assumes the 2D renderer's uniform transform. Everything like that stays on the overlay, and nothing in the 3D scene may depend on `PIXELS_PER_METER` except through `space.ts`.
- **`Scene3D` must be instantiable twice** - the game page and the editor both have one - so everything mutable lives on the instance. The `playerRig.ts` module-global pattern is the anti-pattern this is written against. The material cache in `assets.ts` is shared deliberately: it is immutable once built and belongs to no scene. There are two named exceptions. The first is the avatar's own entry (`SurfaceRequest.avatar`), whose fog `avatarSurface.ts` patches; it is shared with nothing but the avatar, and a page draws one (see [**The avatar's own surface**](lighting-and-surfaces.md#the-avatars-own-surface)). The second is outside the cache altogether: a waking body's own copy of each emissive material of its scene dressing (`BodyVisual.adoptDressing`), whose `emissiveIntensity` the light rig writes every frame so the dressing brightens with its light; the body owns and frees the copies, so nothing shared is ever written (see [**Waking lights**](lighting-and-surfaces.md#waking-lights)). A rig hands the authored intensity back when it lets the body go.
- **Transform sync must not allocate**, and must read `renderPosition/renderRotation(alpha)` only. The debug overlay is the one deliberate exception (it exists to show what the sim believes) and it stays 2D.
- **Where the chain's links fall is shared code.** `render/chainMetrics.ts` holds the one continuous arc walk both renderers use, because that is the one part of chain drawing that has ever been wrong (`session-1467f`) and two copies of it would drift.
