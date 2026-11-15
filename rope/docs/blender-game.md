# The Game add-on

Since 2026-10-08 everything in Blender that comes from the level editor is one add-on, **Game**, `tools/blender/game/`: the game camera and the game's look over it, depth moves about its eye, and guides copied from the level's collision outlines.
Until then it was all part of the formations add-on, which now only makes guides and builds rocks from them ([blender-formations](blender-formations.md)); the split keeps Formations free of anything the level decides.
Game needs Formations enabled: the guides it edits and the rocks it moves are Formations', and it works through Formations' own modules (`game/formations_addon.py` finds the enabled extension, so both share one copy and one set of hooks).
Everything it reads from the level, `just scene-guide <level>` bakes into the level's guide, `<scene>-guide.blend`, linked into the scene ([blender-scenes](blender-scenes.md)).

## Install

```sh
just formations-install   # first: Game needs it
just game-install         # once per machine; links the add-on into Blender and enables it
```

The add-on is the **Game** tab in the 3D viewport's sidebar (N).
The `game.light-preview*` helper walls and fog volumes are locked against
selection on load. The shared foliage, moss and ivy placement ray also skips
them, so clicking through a preview volume plants or paints on the rock behind
it without changing the preview's lighting or visibility.
A file saved before the split keeps its toggles, its depth step and the look's saved scene state: the add-on renames them on load (`game/__init__.py`, `on_load`).

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
`just scene-guide` builds it into the guide file from `lightingOf` (`src/render3d/environment.ts`, which the game's `Environment` builds from too): a `guide.lights` collection containing the sun and shelter shadow walls, and a `guide.world`. **Editor point and spot lights are not copied into Blender.** Older guides' copied lights are hidden when Game Lighting is applied; regenerate the guide to remove them.
The toggle links both in, makes `guide.world` the scene's world, hides the scene's own lights, and sets the view transform to the game's tone mapping; off puts the world, the view settings and the lights' visibility back.
Every conversion is measured in EEVEE against three's physical lights rather than assumed:

| Game (three.js) | Blender |
|---|---|
| sun, intensity I | sun, strength I (both light white diffuse to I/pi) |
| hemisphere fill, sky over ground, intensity I | camera-visible diffuse material fill at I/pi, interpolated by the normal's height; unshadowed, including inside caves |
| the generated sky it reflects, at `envIntensity` | the same pixels in the world, sampled with three's equirectangular mapping |
| the background colour it clears to (never tone mapped) | the world to camera rays, at the colour the tone mapping shows as those bytes |
| ACES Filmic at exposure 1 | ACES 1.3 at exposure log2(1 / 0.6) (three divides by 0.6 first; mean error 0.005 over a grey ramp and random colours) |

A white diffuse card facing the camera under the guide's world and sun renders within 3 % of three's formula with the same numbers.
What is not the same: the sun's shadow is softened by a 5 degree disc, which matches the game's fixed-width filter only about a metre from the occluder; environment specular reflections are occluded by geometry in Blender; and the materials are Blender's, not the exported game's. Runtime editor lights can still affect the game, but are intentionally absent from the Blender preview.
A level that names a captured sky (`hdri`) still gets the generated one.

**Preview Emission (Cycles)** selects Cycles and Rendered viewport shading.
The actual emitting mesh surfaces cast light, with occlusion and bounce light;
there are no generated point lights, position offsets or grouping.
The preview applies the same 50× illumination gain as the export bake.
Camera rays retain the authored visible glow; diffuse/bounce rays receive the
gain. Repeated clicks do not multiply it again, disabling Lighting restores
the authored sockets, and export removes the preview nodes before baking.
The game's hemisphere ambient fill is applied directly to camera-visible
diffuse materials, so cave walls cannot block the blue rock fill. It uses the
guide's sky/ground colours, surface normal, base colour and metallic fraction.
That component is removed from a temporary copy of the guide world to avoid
double lighting outdoors. Toggling Lighting off restores the original world
and material links; export removes this fill before any bake.
The sky environment's diffuse contribution is also unshadowed. Preview
cosine-convolves the guide's sky pixels into a shared 64×32 radiance texture,
at the guide's environment intensity, sampled by the surface normal. This
approximates the game's roughest PMREM level; it is not an exposure multiplier.
The world retains its glossy contribution but supplies no additional diffuse
sky light, preventing double lighting outside the cave.
Material emission colour and strength are the source of truth. Material Preview
still uses Eevee; use Rendered shading for this reference. The viewport uses
64 samples and denoising and progressively refines after an edit; no preview
bake is required. Brightness clamping and fast-GI approximations are disabled.
Old `game.emission-light.*` proxies and the `game.emission-preview` volume are
disabled on load and never exported. Old additive preview material wrappers
are removed. Saved `game_light_spill` settings are ignored.
Game export uses Cycles emission lightmaps for static geometry and a baked
lighting field for dynamic objects. That export bake still takes time.

Game Lighting also forces Material Preview to use scene lights and the scene
world instead of its studio HDRI, and reapplies the guide's tone mapping and
exposure even when the toggle was already on. This corrects saved exposure
drift. `just scene-guide` includes the game's shelter walls as transparent
shadow casters in `guide.lights`, so a cut-open cave does not receive sunlight
through its missing front wall. They never export as scenery.

Cycles is the mesh-lighting reference, not a pixel-identical game renderer.
The game retains its own environment, shaders and dynamic effects; its lightmaps
and interpolated probe field approximate the reference. Runtime glow-flora
pulses, ivy translucency and moving emitters are not a static lighting bake.

The old `game.light-preview.fog` scattering box is disabled on load and whenever
Game look is applied. It was illuminated physical mist on top of the fog
compositor, producing a bright white box and a blue wash absent from the game.
Fog now uses the same authored regions as the renderer: the Position pass
projects view rays onto the gameplay plane and evaluates rotated rectangles
or circles with their inward smoothstep falloff. No regions in the level means
global fog; an explicitly empty list means no fog. The guide carries the
region data and defaults from the game. The camera-position drivers follow
the animated game camera as it travels its route.

**Depth of Field** makes `guide.camera.dof` the scene camera: the game camera (it rides on it) with Blender's own depth of field, its focus and f-number keyed per frame so that the blur behind the plane is the game's Medium (`DOF_MAX_BLUR`, `FOCUS_BAND` in `src/render3d/depthOfField.ts`).
The game's thin lens has a circle of `dofMaxBlur` of the frame's height at infinity times `1 - focus / depth`; Blender's has diameter `f^2 / (N (s - f)) * |1 - s/d|` on the sensor, so the f-number is `f^2 / (48 dofMaxBlur (s - f))` against the 24 mm sensor height (measured within a pixel of the game's at 15 m, 30 m, 100 m and 1 km).
It blurs in front of the focus too, where the game keeps everything sharp.

**Fog** is a compositor tree, `Game look` (`Formations game look` until 2026-10-08), which the toggle makes the scene's compositor with the Depth pass and the viewport compositor in camera view on (Material Preview and Rendered shading, and renders).
The game mixes its fog in after tone mapping, over the colours as they are shown, so the tree does too: the image goes to the display through the scene's view transform (its exposure applied around the conversion, which takes none), the fog `1 - exp(-(density * depth)^2)` mixes in the fog colour's sRGB bytes (never over the sky), and the result is inverted back to scene linear for the view transform to apply again (a round trip that changes no pixel by more than 1/255).
Off hands the compositor and the Depth pass back as they were; a scene with a compositor of its own refuses it.
A guide written before 2026-10-05 has none of the three: rerun `just scene-guide <level>` and reopen the scene.

## Guides are edited in Edit Mode

A formation's guide is edited where it stands, as an ordinary 2D curve in Blender's Edit Mode, its points held on its plane ([blender-formations](blender-formations.md#editing-a-guide)).
Until 2026-10-16 this panel had **Edit Guides** instead (Edit Outlines until 2026-10-07): it projected each guide from the game camera's eye onto the gameplay plane as a handle curve, sent edited points back along their camera rays, and made everything else in the scene unselectable while it ran, with its own Copy, Paste, New, Delete, Add Point, Remove Points, Apply, Done and Discard.
It was removed on 2026-10-16 (Tris: "I don't like the "Edit Guides" mode. Remove it."), after a session left running in River had kept the guides copied from collision outlines from being clicked, with nothing in the viewport to say why.
A file saved while one ran has it ended on load as Done ended it (`game/legacy.py`): an edited handle is written into its guide, everything selectable before is again, and the handles go; a formation it marked Delete is kept, and the console says so.

## Depth

Forward and Back move the selected formations toward or away from the camera by the step.
With **Keep screen size** they scale about the game camera's eye, so they keep their size and place on screen from there; without, it is a plain move and they shrink with distance.
Growth rides along (it hangs from the placement), and is then stale: it is sized for its depth.

## Guides from collision outlines

**Collision outlines are a reference, never a source** (2026-10-07, Tris: "The 2D collision outlines should serve exclusively as a visual reference").
The `guide.*` curves the scene links from the level's guide file are unselectable, and Formations refuses anything linked from another file as a guide.
**Opacity** (under Collision outlines, 2026-10-17, Tris: "instead of "Show Collision Outlines" I want an opacity slider") is how opaque the solid outlines are filled, 0.35 by default, the scene's own setting (`game_outline_opacity`).
The fills are the guide file's materials, linked, and a driver on them reading the scene never evaluated (it was flagged invalid), so the add-on sets each fill's factor (the Mix Shader `scene_guide.py` names `Opacity`) and its Solid-shading alpha directly: Blender allows that on linked data but never saves it, and a reload of the guide brings back the file's own 0.35, so a depsgraph handler (`outlines.keep_fills`) writes the scene's value back wherever it differs, and the file's load applies it.
At 0 the outlines and their `guide.<name>.origin` empties are hidden, since an area's outline is a wire and a wire cannot fade; the plane, the spawn and the cameras stay.
Hiding is the outliner's eye on each in the current view layer (a linked object's own visibility is the guide file's).
It replaced the **Show Collision Outlines** toggle; a file saved with the outlines hidden by it opens at 0.
Hidden outlines cannot be picked, so Create Guide from Outline waits for the opacity to be raised.
**Create Guide from Outline** (the eyedropper, under Collision outlines) copies one: click a collision outline in the viewport (the one under the cursor is highlighted; the innermost wins where they nest; Shift+click keeps picking, Esc or right-click ends) and a free guide named `Guide` is made in `Formation guides`, the same points at the same place, selected for New Formation (Formations panel).
The copy is geometry and pose only: the guide records nothing about the outline, and nothing is written to the outline, so the editor can add, move or remove collision without any guide or rock in the scene changing.
The guide is a 2D curve like the outline it came from, so Tab and G move its points on the gameplay plane ([blender-formations](blender-formations.md#editing-a-guide)), and the collision stays as the level has it.
A piece with a hole (a belt's band) is two splines and is refused.
