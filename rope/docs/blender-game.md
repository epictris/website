# The Game add-on

Since 2026-10-08 everything in Blender that comes from the level editor is one add-on, **Game**, `tools/blender/game/`: the game camera and the game's look over it, formation guides edited as that camera sees them, depth moves about its eye, and guides copied from the level's collision outlines.
Until then it was all part of the formations add-on, which now only makes guides and builds rocks from them ([blender-formations](blender-formations.md)); the split keeps Formations free of anything the level decides.
Game needs Formations enabled: the guides it edits and the rocks it moves are Formations', and it works through Formations' own modules (`game/formations_addon.py` finds the enabled extension, so both share one copy and one set of hooks).
Everything it reads from the level, `just scene-guide <level>` bakes into the level's guide, `<scene>-guide.blend`, linked into the scene ([blender-scenes](blender-scenes.md)).

## Install

```sh
just formations-install   # first: Game needs it
just game-install         # once per machine; links the add-on into Blender and enables it
```

The add-on is the **Game** tab in the 3D viewport's sidebar (N).
A file saved before the split keeps its toggles, its depth step, the look's saved scene state and any guide editing in progress: the add-on renames them on load (`game/__init__.py`, `on_load`).

## The game camera

`just scene-guide <level>` bakes the **game camera** into the level's guide as `guide.camera`, linked into the scene with the rest of the guide.
It is the level's lens (its `camera.focalLength`, 35 mm-equivalent against the 24 mm sensor height, so Blender's vertical fit reproduces the field of view exactly) standing where the game's camera stands, keyed on every frame at 60 fps.
The poses come out of the game's own code (`src/sim/cameraTrack.ts`): the real `CameraController` stepped at 1/60, and the 3D pose from `poseFromCamera` with the level's lens, which is what `Scene3D` draws through every frame.

- **Along the paths** (the default): a follow point walks each of the level's camera paths from its start to its end at 3 m/s (`--speed`), and the controller follows it through every region and path rule on the way.
  There is no canonical run of a level, and the route is what the level's camera is authored around.
- **A ride** of a recorded run: `just scene-guide ball --ride playtests/regressions/session-1010f.json.gz` replays the sim and feeds the camera exactly what `cli camera --ride` does, for the view one playthrough had.

**Look Through Game Camera** makes it the scene camera, gives the scene its 60 fps, its frame range and a 1920x1080 frame, and puts it on the first frame, the start of the route, so scrubbing the timeline is travelling the route and the camera view is the game's view at that frame.
The buttons under it ride the camera back along the route, pause it and ride it forward, at the game's pace (the scene drops frames rather than slowing down when it cannot keep up); the frame field beside them scrubs.
The camera is head-on and never turns, as the game's never does.
What it cannot show is the game's light: that is the level's (`environment`), and the viewport's is Blender's.

**Lighting**, **Fog** and **Depth of Field** (the toggle reads **DoF**) under it are the game's look over that view, each a toggle (`tools/blender/game/look.py`), each built from numbers the guide takes straight from the game's code, so nothing is a copy that can drift.

**Lighting** is the game's light at rest instead of the scene's own.
`just scene-guide` builds it into the guide file from `lightingOf` (`src/render3d/environment.ts`, which the game's `Environment` builds from too) and the always-on light objects `LightRig` builds (waking lights start dark and fireflies move, so neither is there): a `guide.lights` collection (the sun and the spots and points, outside the `Guide`, so nothing lights the scene until asked) and a `guide.world`.
The toggle links both in, makes `guide.world` the scene's world, hides the scene's own lights, and sets the view transform to the game's tone mapping; off puts the world, the view settings and the lights' visibility back.
Every conversion is measured in EEVEE against three's physical lights rather than assumed:

| Game (three.js) | Blender |
|---|---|
| sun, intensity I | sun, strength I (both light white diffuse to I/pi) |
| spot or point, I candela | power 4 pi I W |
| hemisphere fill, sky over ground, intensity I | the world, sky above and ground below at I/pi (the same diffuse irradiance, linear in the normal's height) |
| the generated sky it reflects, at `envIntensity` | the same pixels in the world, sampled with three's equirectangular mapping |
| the background colour it clears to (never tone mapped) | the world to camera rays, at the colour the tone mapping shows as those bytes |
| ACES Filmic at exposure 1 | ACES 1.3 at exposure log2(1 / 0.6) (three divides by 0.6 first; mean error 0.005 over a grey ramp and random colours) |

A white diffuse card facing the camera under the guide's world and sun renders within 3 % of three's formula with the same numbers.
What is not the same: three's light reach fades out as `(1 - (d/range)^4)^2` and Blender's cuts off at the range; the sun's shadow is softened by a 5 degree disc, which matches the game's fixed-width filter only about a metre from the occluder; the hemisphere fill has no specular in three and the world does in Blender; and the materials are Blender's, not the exported game's.
A level that names a captured sky (`hdri`) still gets the generated one.

**Depth of Field** makes `guide.camera.dof` the scene camera: the game camera (it rides on it) with Blender's own depth of field, its focus and f-number keyed per frame so that the blur behind the plane is the game's Medium (`DOF_MAX_BLUR`, `FOCUS_BAND` in `src/render3d/depthOfField.ts`).
The game's thin lens has a circle of `dofMaxBlur` of the frame's height at infinity times `1 - focus / depth`; Blender's has diameter `f^2 / (N (s - f)) * |1 - s/d|` on the sensor, so the f-number is `f^2 / (48 dofMaxBlur (s - f))` against the 24 mm sensor height (measured within a pixel of the game's at 15 m, 30 m, 100 m and 1 km).
It blurs in front of the focus too, where the game keeps everything sharp.

**Fog** is a compositor tree, `Game look` (`Formations game look` until 2026-10-08), which the toggle makes the scene's compositor with the Depth pass and the viewport compositor in camera view on (Material Preview and Rendered shading, and renders).
The game mixes its fog in after tone mapping, over the colours as they are shown, so the tree does too: the image goes to the display through the scene's view transform (its exposure applied around the conversion, which takes none), the fog `1 - exp(-(density * depth)^2)` mixes in the fog colour's sRGB bytes (never over the sky), and the result is inverted back to scene linear for the view transform to apply again (a round trip that changes no pixel by more than 1/255).
Off hands the compositor and the Depth pass back as they were; a scene with a compositor of its own refuses it.
A guide written before 2026-10-05 has none of the three: rerun `just scene-guide <level>` and reopen the scene.

## Editing guides through the camera

A formation's **guide** (its outline, recipe key `outline`) is a polygon in its own X/Z plane, which may stand tens of metres behind the gameplay plane, tilted, mirrored and scaled by its placement.
It is the rock's only source; the level's collision outlines never are (see [below](#guides-from-collision-outlines)), and nothing here reads or writes one.
What matters is where its silhouette lands on screen, so **Edit Guides** (Edit Outlines until 2026-10-07) edits the guides as they are seen.
Each is projected from the game camera's eye, at the current frame, onto the gameplay plane (`y = 0`) as a flat 2D handle curve, and the view looks through the game camera, so a handle sits exactly on the rock it shapes.
A rock built on the plane from a copy of a collision outline therefore shows its handle right over that outline; the handle is the guide's, and moving it leaves the collision where it was.
An edited point goes back along its camera ray to the formation's own guide plane, which keeps depth, tilt, mirroring and scale.
It edits the selected formations, or every formation when none is selected; nothing else takes clicks while it runs.

- **G** moves points, **Tab** toggles between points and whole guides.
- **Copy** / **Paste** duplicate guides, placed like the formation they came from; **New** starts a square at the 3D cursor.
- **Delete** retires a formation to the hidden `Formation backups` collection on Apply (one never built is simply removed); **Discard** restores everything since the last Apply.
- **Add Point** puts a midpoint between selected neighbours, or after a single selected point; **Remove Points** keeps at least three.
- **Apply** writes the edits into the guides, **Done** applies and leaves, **Discard** leaves without.

Every change is validated (a simple polygon, finite, not edge-on to the camera, the formation not moved meanwhile, its mesh not hand-edited) before any guide is written.
The projection is from ONE frame, shown in the panel: scrubbing while editing moves the camera and not the handles.

**Rebuild Changed**, under the editing buttons, is Formations' own ([blender-formations](blender-formations.md#formations)), there so an edit can be built without changing tabs.
It and Formations' **Replant Growth** apply the guides being edited first and end the editing, wherever they are pressed: Formations runs `core.BEFORE_BUILD` before it reads any guide, and Game puts its `edit.finish` there when it registers.

**Depth**: Forward and Back move the selected formations toward or away from the camera by the step.
With **Keep screen size** they scale about the game camera's eye, so they keep their size and place on screen from there; without, it is a plain move and they shrink with distance.
Growth rides along (it hangs from the placement), and is then stale: it is sized for its depth.

## Guides from collision outlines

**Collision outlines are a reference, never a source** (2026-10-07, Tris: "The 2D collision outlines should serve exclusively as a visual reference").
The `guide.*` curves the scene links from the level's guide file are unselectable, and Formations refuses anything linked from another file as a guide.
**Create Guide from Outline** (the eyedropper, under Collision outlines) copies one: click a collision outline in the viewport (the one under the cursor is highlighted; the innermost wins where they nest; Shift+click keeps picking, Esc or right-click ends) and a free guide named `Guide` is made in `Formation guides`, the same points at the same place, selected for New Formation (Formations panel).
The copy is geometry and pose only: the guide records nothing about the outline, and nothing is written to the outline, so the editor can add, move or remove collision without any guide or rock in the scene changing.
Edit the guide like any curve (Edit Mode, or Edit Guides once it is a rock's), and the collision stays as the level has it.
A piece with a hole (a belt's band) is two splines and is refused.
