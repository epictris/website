# The painterly art style

Since 2026-09-17 the game is drawn as a **digital painting**, after three reference pictures: a cave mouth of faceted rock with crisp dark cracks and moss in soft blobs, a teal cavern of flat planes of tone, and a hollow in a hedge of dabbed leaves.
What they have in common, and what every decision below serves: **large flat planes of tone with crisp edges between them, no grain anywhere, cracks drawn as lines, and light that falls in a few tones rather than a gradient.**

This page is the map of how that is achieved.
The detail lives where each piece lives - the texture pipeline in [**asset-store**](asset-store.md), the shader patch in [**lighting-and-surfaces**](lighting-and-surfaces.md#painted-light), the water in [**water**](water.md) - and this page says how they fit and what was decided.

## The decision: paint the maps and the light, not the screen

The obvious way to make a 3D game painterly is a screen-space filter - a Kuwahara or oil-paint pass over the finished frame - and it was rejected before anything was built, for three reasons that hold for this game in particular.
Its strokes are **pixel-aligned**, and the camera here never stops panning, so the world swims under strokes that stay put - the shower-door look.
**Thin things smear**: the chain links, a vine, the hairlines on the water.
And it gives up the canvas's own MSAA for a render target and a full-screen pass on every frame.

So the look is built in three layers, each locked to the world rather than to the screen:

1. **The maps are painted** on their way through the asset pipeline (the strokes ride the surface and cost nothing per frame).
2. **The light is painted** by one shader patch on every lit material (the same lamps, shadows, fog and tone mapping, falling in bands).
3. A screen-space finish, if wanted, of nothing but **paper grain and a vignette** - things that are meant to be screen-fixed. Not built; strokes never go here.

The water went first, the same day, and set the rule the rest follows: **stylised colour, real light**.
A painted surface in a lit scene reads as a sticker unless the light on it is the scene's own.

## Layer 1: painted maps

`bun run assets:optimize-texture ... --paint <px>` flattens a map into **plateaus** with a mean shift: every region of near-one-colour collapses to exactly one colour and the edge between two regions stays where it was.
On the albedo that is flat planes with crisp breaks; on the **normal map it is facets** - regions of one normal turning sharply into the next - and under the sun the facets are the flat planes of tone a painter lays down.
The facets are most of the look: dark rock's albedo is nearly flat brown, and every plane the reference showed was lighting.
A rock's albedo also gets its cracks multiplied in from the set's own AO map (`cavity`), a saturation lift, and for mossy ground an olive tint; the rock sets carry `normalScale: 1.6` so neighbouring facets are a stroke apart in tone.
Brushes in use: 30 on rock and ground, 40 on marble cliff, 20 on the avatar's rusted iron.

The generated surfaces (wood, the metals) are painted at source instead: `paintField` in `render3d/assets.ts` is a lattice of irregular patches, each one tone with a gentle gradient across it, a dark seam drawn between them, and a normal built from each patch's own tilt.

The whole store is **reproducible from the manifest alone**: each map records `raw`, `channel` and `paint` beside its hash, and `bun run assets:paint` rebuilds every map from `assets-src/` by that recipe and prints the hash and size to paste for any that changed.
Re-baking all six painted sets reproduced every byte.

**Adding a texture** is three steps - raws under `assets-src/<set>/`, one `TEXTURE_ASSETS` entry naming `file`, `raw`, `channel` and `paint` with an empty hash, then:

```sh
bun run assets:paint "<set>" --publish
```

Full detail, including every flag and why each map is treated differently: [**Painted surfaces**](asset-store.md).

## Layer 2: painted light

`render3d/paint.ts` is one shader patch, `paintMaterial`, worn by every lit material at the one place each kind is built: generated and authored surfaces, a prop's own materials, the vine, and the water over its own painting.
It makes three edits inside three's physically-based shading and leaves everything else alone.

- **Light falls in bands.** The wrapped cosine of the sun and of the hemisphere fill's sky-to-ground blend is cut into four bands with soft edges. A painted facet lands wholly in one band and is one tone; the ball crosses the bands as a lit crescent, a mid tone and a shadow tone.
- **The wrap stops at the terminator**, so a normal turned away from a lamp gets none of it.
- **Nothing is glossy**: roughness has a floor, so highlights are washes and a metal reflects a soft tone rather than the sky.

`?paint=0` in the browser, or `cli shot --query paint=0` headless, draws the same frame without the patch; that A/B in the live browser on a real GPU is how a change to it is judged.
The headless runner's SwiftShader is not what the player sees.

Full detail: [**Painted light**](lighting-and-surfaces.md#painted-light).

## Tuning

| What | Where |
|---|---|
| A set's brush, cracks, saturation, tint | its `paint` records in `TEXTURE_ASSETS`, then `bun run assets:paint "<set>"` |
| How far apart facets shade | the set's `normalScale` (no re-bake) |
| The generated patch look | `SEAM_WIDTH`, `SEAM_DARKEN`, `PATCH_TILT`, `PATCH_SLOPE` in `render3d/assets.ts` |
| Number and softness of the light bands, the wrap, the gloss floor | the constants at the top of `render3d/paint.ts` |
| The water's own painting | `render3d/water.ts` (see [water](water.md)) |

## What was tried and is not the answer

Each of these looked plausible and was rejected on a picture; the reasons are kept because they are cheap to re-find and expensive to re-learn.

- **A Kuwahara over a shrunk map, grown back** - the first bake. Its patches are its own window, soft dabs wherever the picture is, and the grow-back blurred every edge; a wash blur on the roughness made every surface look wet. It read as blotchy, blurry and flat. The mean shift finds the picture's own regions at whatever size they are and draws their edges sharp.
- **Cracks on moss.** The AO multiply that draws a rock's fissures turned mossy ground brown: moss is raised, so its AO is dark exactly where the moss is.
- **A seam crease in the generated height field.** A step in the height differenced into a normal is a bevel - lit on one side, dark on the other - and the wood came out as chocolate tiles. The seam is drawn in the albedo only, and the normal is each patch's own tilt.
- **A saturating light ramp** - a wrap and a smoothstep that lights every facet facing the sun fully. Under a sun that hits the wall nearly face-on it put every facet at one tone and flattened away exactly the facets the maps had made. Bands separate them.
- **A wrap that crosses the terminator.** It fed sun to normals just past the geometric edge, where the shadow map's grazing depth test is least reliable, and drew white speckles along every crack of a face turned from the sun.
- **A scale on the specular term** for the gloss. A metal's whole colour is its specular; scaled down, the ball goes black. A roughness floor is the same metal, matte.

## What is not done

- Layer 3, the paper grain and vignette, is not built.
- The older texture sets (the `rock-*` family, `moss`, `grass`, `mud`, `forest-floor`, `factory-brick`) are neither painted nor reproducible: they predate the `raw` record and the ball level does not wear them.
- None of it has been played on a real GPU; every picture so far is a headless SwiftShader grab.
- The painted maps are baked locally and not yet published to the release store.
