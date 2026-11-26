# Bouncy mushrooms

Choose **Mushroom** in the editor's scene tools, then click to place one. Each click picks one of four starting proportions and a size between 75% and 135%. Mushrooms are generated directly in Three.js: asymmetric purple-to-blue bell caps with rounded, gently lobed rims, fine radial mottling, and irregular raised pale spots. Radial cyan gills and spots carry the glow; curved, tapered stems have fine fibers. Broader, flatter caps have more pronounced edge variation. The existing waking light illuminates nearby surfaces. No Blender export or downloaded model is needed. Existing `bouncy-mushroom` model names also use this renderer.

Select the mushroom's **model** object and open **Mushroom shape**:

- **cap width**: diameter in metres before scale.
- **cap height**: lower values flatten the cap; higher values make a rounded bell.
- **stem height**: distance from the cap origin to the planted foot.
- **scale** (under Model): overall size.

Values are saved per mushroom in the model object's `mushroom` field. Changing these dimensions or model scale also updates the cap collision on a standard mushroom body with one collision object. Custom bodies with multiple collision objects retain their hand-authored collisions. Out-of-plane model tilts remain decorative; physics is two-dimensional.

A mushroom is a static body containing a cap collision, a procedural model and a waking blue light. Adjust the body's **Bounce** and **Launch** to tune its throw (default restitution 1, launch 6.5 m/s). The stem is decorative. Scale the whole body when resizing a complete arrangement, including its light.

**The light sits inside the cap** (since 2026-11-26): in the middle of it, at the model's depth (`mushroomCapCentre`, `src/level/mushroom.ts`), and it follows the cap when the dimensions change unless it has been moved elsewhere.
It lights what is around the mushroom and none of the mushroom itself: the cap, rim, gills and stem glow by their emission alone.
The spots are the cap's emission map and nothing else: a pale cyan core with a deeper cyan halo spreading into the cap around each one, at emissive intensity 2.2.
There is no bloom pass, so the halo is what makes a spot read as a light rather than as pale paint.
The gills glow by their vertex paint at intensity 2, cyan ridges bright and dark troughs barely.
Both follow the waking light: dark until the ball wakes it, held awake in the editor.
`src/render3d/proceduralMushroom.ts` makes that explicit rather than leaving it to which way the faces point (every material is double sided).
A point light inside the cap's box, in the mushroom's own frame, adds nothing to the mushroom's materials, and the meshes are left out of that light's shadow (`customDistanceMaterial`), so a shadow-casting light inside does not get trapped by the cap.
Any other lamp lights the mushroom as usual.
Before this the light had no position of its own: it sat at the body origin (level with the gills) at the default stand-off of a light, 0.35 m toward the camera (`DEFAULT_LIGHT_Z`), and lit the mushroom from the front and side.
The 12 mushrooms in `ball.json` were moved into their caps.

An impact extends the mushroom toward the player along the contact launch direction, without widening the cap sideways, then springs back and forth with diminishing movement before settling to rest. Extension scales smoothly with the actual contact impulse, from subtle light touches up to 28% for strong bounces. The stem foot stays planted. `World.contactPulses` retains the latest fresh contact on each launch surface, including impulse and simulation time, so rendering can skip the impact frame without losing the animation. The visual response never changes physics. Pausing also pauses the response.

Default proportions live in `src/level/mushroomVariants.json`; generation is in `src/render3d/proceduralMushroom.ts`. The older Blender generator and exports remain available for offline artwork but are not used by the game's mushroom renderer.
