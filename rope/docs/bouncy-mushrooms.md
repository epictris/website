# Bouncy mushrooms

Choose **Mushroom** in the editor's scene tools, then click to place one. Each click picks one of four starting proportions and a size between 75% and 135%. Mushrooms are generated directly in Three.js: asymmetric purple-to-blue bell caps with rounded, gently lobed rims, fine radial mottling, and irregular raised pale spots. Radial cyan gills and spots carry the glow; curved, tapered stems have fine fibers. Broader, flatter caps have more pronounced edge variation. The existing waking light illuminates nearby surfaces. No Blender export or downloaded model is needed. Existing `bouncy-mushroom` model names also use this renderer.

Select the mushroom's **model** object and open **Mushroom shape**:

- **cap width**: diameter in metres before scale.
- **cap height**: lower values flatten the cap; higher values make a rounded bell.
- **stem height**: distance from the cap origin to the planted foot.
- **scale** (under Model): overall size.

Values are saved per mushroom in the model object's `mushroom` field. Changing these dimensions or model scale also updates the cap collision on a standard mushroom body with one collision object. Custom bodies with multiple collision objects retain their hand-authored collisions. Out-of-plane model tilts remain decorative; physics is two-dimensional.

A mushroom is a static body containing a cap collision, a procedural model and a waking blue light. Adjust the body's **Bounce** and **Launch** to tune its throw (default restitution 1, launch 6.5 m/s). The stem is decorative. Scale the whole body when resizing a complete arrangement, including its light.

An impact widens the mushroom, compresses its stem, and rebounds to rest. The stem foot stays planted. `World.contactPulses` retains the latest fresh contact on each launch surface, including impulse and simulation time, so rendering can skip the impact frame without losing the animation. The visual response never changes physics. Pausing also pauses the response.

Default proportions live in `src/level/mushroomVariants.json`; generation is in `src/render3d/proceduralMushroom.ts`. The older Blender generator and exports remain available for offline artwork but are not used by the game's mushroom renderer.
