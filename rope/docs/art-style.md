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

Then the set is **brushed**: `scripts/stroke-textures.ts` lays a few thousand dabs over the flattened maps, each the colour of what is under it with a painter's variation, along the picture's edges and clipped where the colour changes, one layout shared by the albedo, the normal and the roughness so a stroke is one plane, one facet and one sheen. That is the handwriting the reference cave is painted in; the facets and cracks under it are the picture.

The generated surfaces (wood, the metals) are painted at source instead: `paintField` in `render3d/assets.ts` is a lattice of irregular patches, each one tone with a gentle gradient across it, a dark seam drawn between them, and a normal built from each patch's own tilt. They are not brushed yet.

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

- **Light falls in bands.** The wrapped cosine of the sun and of the hemisphere fill's sky-to-ground blend is cut into three bands with soft edges. A painted facet lands wholly in one band and is one tone; the ball crosses the bands as a painter's sphere, a lit side, a mid tone and a shadow side.
- **Nothing that stays put on a rolling ball.** The sun makes no highlight, and the environment is reflected softly with its sun clipped out, because a highlight or a hot reflection sits where the view puts it rather than where the ball's rotation does, and reads as a sticker. The horizon of the reflection stays, since a metal is its reflection. Sheens come from the lamps, which the ball moves past.

## The ball and chain: painted steel

**Since 2026-09-22 the BALL itself is a modelled prop** (`iron-ball` in `MESH_ASSETS`, see [**The asset store**](asset-store.md)) wearing the maps it was modelled with, and everything below is the surface the rest of the assembly wears - the chain, the manacle, and the ball's own stand-in until the model lands.
It is a commissioned hammered cast-iron ball with a thin forged loop at its pole, wearing a full PBR set of its own: a dark mottled albedo with rust blooms, a normal map carrying the hammer facets, and packed AO/roughness/metalness in which the roughness averages 0.46 and the metalness 0.63 - the rust is not metal - so it reads as worked iron rather than as chrome.

That is a **deliberate exception to this file rather than a revision of it**, and the two claims it puts under strain are named here because they were paid for: the avatar's surface is now a photograph rather than strokes (the argument against which is the whole of "Painting the photographed iron" below), and where the roughness map dips the environment is reflected sharply enough to test "nothing that stays put on a rolling ball" above.
The painted light is still worn - a prop's own materials go through `paintMaterial` like everything else, so the sun makes no highlight and its reflection is clipped out of the sky.
What remains to be judged is whether the lamps' sheen now sits on the ball as a patch, and that is a judgement to be made by PLAYING it on a real GPU rather than off a headless still.

The avatar wears its own set, **`painted steel`**, and it is the one surface in the game that is strokes rather than a photograph flattened: `scripts/bake-strokes.ts` lays a few thousand soft, part-opacity dabs over a steel-grey ground on a wrapped canvas, with a faint ridge along each stroke for the normal map and a dab-by-dab roughness, and writes the result into `assets-src/painted-steel/` as the set's raw, from where the ordinary pipeline (`bun run assets:paint "painted steel"`) optimises and hashes it like any other.
The reference is an oil painting of a clean polished steel ball on a chain: a mid grey covered in broad low-contrast strokes that follow the form, and a shine that is the room reflected softly - warm ground below, pale sky above, a soft horizon.
The strokes are paint on the object and turn with it; the reflection is the scene's own, soft and with its sun clipped (above), so the ball has a sheen and no sticker.
Two numbers carry the read and both were wrong first: the **tile** is 2 m, so a stroke is a third of the ball (at half a metre the strokes were three pixels at play size - grain again), and the **metalness** is 0.6, so the strokes' own mid grey carries the ball's value in a dark level, where a mirror of a dark cave is a dark ball.
The chain wears the same set at a multiple (`FORGED_SMALL`) that puts a link at the ball's grain, and the tint (`FORGED_TINT`) is nearly white since the strokes are baked at the steel's own value.

Before this the avatar wore the photographed `rusted iron`, and everything tried on it is in the list below: its rust flecks were photographic detail on a painted ball whatever brush flattened them, and no treatment of its reflection was both metal and free of a fixed patch.
- **The wrap stops at the terminator**, so a normal turned away from a lamp gets none of it.
- **Nothing is glossy**: roughness has a floor, so highlights are washes and a metal reflects a soft tone rather than the sky.

`?paint=0` in the browser, or `cli shot --query paint=0` headless, draws the same frame without the patch; that A/B in the live browser on a real GPU is how a change to it is judged.
The headless runner's SwiftShader is not what the player sees.

Full detail: [**Painted light**](lighting-and-surfaces.md#painted-light).

## Tuning

| What | Where |
|---|---|
| A set's brush, cracks, saturation, tint | its `paint` records in `TEXTURE_ASSETS`, then `bun run assets:paint "<set>"` |
| A set's stroke width; the strokes' opacity, variation, clipping, flow | `strokes` on the set in `TEXTURE_ASSETS`; the constants at the top of `scripts/stroke-textures.ts` |
| How far apart facets shade | the set's `normalScale` (no re-bake) |
| The generated patch look | `SEAM_WIDTH`, `SEAM_DARKEN`, `PATCH_TILT`, `PATCH_SLOPE` in `render3d/assets.ts` |
| Number and softness of the light bands, the wrap, the gloss floor, the reflection's roughness and ceiling | the constants at the top of `render3d/paint.ts` |
| The ball: how metal, how glossy | the model's own maps - a new delivery, then `assets:optimize` and `assets:publish` (see `iron-ball` in `MESH_ASSETS`) |
| The chain and the ball's stand-in: stroke size, how metal, how dark | `painted steel`'s `tile`, `metalness` and `normalScale` in `TEXTURE_ASSETS`; `FORGED_TINT` in `render3d/ballVisual.ts` |
| The strokes themselves: palette, size, opacity, count, ridge depth | the constants at the top of `scripts/bake-strokes.ts`, then `bun run scripts/bake-strokes.ts` and `bun run assets:paint "painted steel"` |
| The water's own painting | `render3d/water.ts` (see [water](water.md)) |

## What was tried and is not the answer

Each of these looked plausible and was rejected on a picture; the reasons are kept because they are cheap to re-find and expensive to re-learn.

- **A Kuwahara over a shrunk map, grown back** - the first bake. Its patches are its own window, soft dabs wherever the picture is, and the grow-back blurred every edge; a wash blur on the roughness made every surface look wet. It read as blotchy, blurry and flat. The mean shift finds the picture's own regions at whatever size they are and draws their edges sharp.
- **Cracks on moss.** The AO multiply that draws a rock's fissures turned mossy ground brown: moss is raised, so its AO is dark exactly where the moss is.
- **A seam crease in the generated height field.** A step in the height differenced into a normal is a bevel - lit on one side, dark on the other - and the wood came out as chocolate tiles. The seam is drawn in the albedo only, and the normal is each patch's own tilt.
- **A saturating light ramp** - a wrap and a smoothstep that lights every facet facing the sun fully. Under a sun that hits the wall nearly face-on it put every facet at one tone and flattened away exactly the facets the maps had made. Bands separate them.
- **A wrap that crosses the terminator.** It fed sun to normals just past the geometric edge, where the shadow map's grazing depth test is least reliable, and drew white speckles along every crack of a face turned from the sun.
- **A scale on the specular term** for the gloss. A metal's whole colour is its specular; scaled down, the ball goes black. A roughness floor is the same metal, matte.
- **Bands on the diffuse alone.** They painted every dielectric and left the ball and chain, 85% metal, as a smooth sky reflection sliding over a sphere; the avatar's metalness had to come down so the diffuse had something to carry.
- **Banding the reflection by brightness.** It turned the sky's bright region on the ball from a soft gradient into a crisp oval that never moved as the ball rolled. The reflection is a soft tone now, and the sun's highlight went for the same reason.
- **Four bands.** Right for facets, wrong for a sphere, which four cut into stripes; three is a painter's sphere.
- **Painting the photographed iron.** Its rust flecks survived every brush (a mean shift never merges a small island of another colour), a blur made them blooms that still read as a photograph at play size, and its reflection was either a fixed oval or, flattened, a grey rubber ball. The avatar needed a surface that was strokes to begin with.
- **A heavily dabbed dark cannonball** as that surface. The first stroke bake followed a darker reference; the one settled on is a clean polished steel, mid grey with low-contrast strokes.
- **Strokes at 2 cm.** Three pixels at play size is grain, whatever it is made of; a painter's stroke on this ball is a third of it.

## What is not done

- Layer 3, the paper grain and vignette, is not built.
- The older texture sets (the `rock-*` family, `moss`, `grass`, `mud`, `forest-floor`, `factory-brick`) are neither painted nor reproducible: they predate the `raw` record and the ball level does not wear them.
- None of it has been played on a real GPU; every picture so far is a headless SwiftShader grab.
- The painted maps are baked locally and not yet published to the release store.
