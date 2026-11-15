# Bouncy mushrooms

Choose **Mushroom** in the editor's scene tools, then click to place one. Each click picks one of four painted cap variants and a size between 75% and 135%. Flat, rounded and broad caps have different proportions and spot patterns. The model name, scale and matching collision are saved, so reopening does not randomise the mushroom.

A mushroom is a static body containing a cap collision, a library model and a waking blue light. Adjust the body's **Bounce** and **Launch** to tune its throw (default restitution 1, launch 6.5 m/s). The stem is decorative. Scale the whole body to keep collision and model matched; changing only the model's scale does not alter collision.

An impact widens the mushroom, compresses its stem, and rebounds to rest. The stem foot stays planted. `World.contactPulses` retains the latest fresh contact on each launch surface, including impulse and simulation time, so rendering can skip the impact frame without losing the animation. The visual response never changes collision or physics. Pausing also pauses the response.

The models are generated from `src/level/mushroomVariants.json`:

```sh
blender -b --python tools/blender/mushrooms/build_bouncy_mushroom.py
bun run model:export bouncy-mushroom --raw
bun run model:export bouncy-mushroom-flat --raw
bun run model:export bouncy-mushroom-round --raw
bun run model:export bouncy-mushroom-wide --raw
```

Blender sources are under `assets-src/models/`, with packed original painted cap textures. Exports are under `public/models/`. These are local library assets; publish through the existing asset workflow when shipping a level that uses them. No existing level is changed by installing this tool.
