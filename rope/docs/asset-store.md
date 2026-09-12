# The asset store

Four kinds of binary: props (`.glb` under `public/meshes/`), authored texture maps (`.webp` under `public/textures/`), the water renderer's raw maps (`public/water/`) and captured skies (`.hdr` under `public/hdri/`).
Every one of those directories is **gitignored**: the bytes live in a permanent GitHub Release (tag `assets`) on this repo and are fetched at build time (`bun run assets:fetch`, run by the Dockerfile before `bun run build`).
They are the only binaries this tree has - every other surface is generated in code - which is why they carry a process the rest of the project does not need.
`storedAssets()` (`scripts/assetStore.ts`) flattens all four manifests into one list of files, and the fetch, the budget, the sha check, the basename-collision check and the orphan sweep all iterate **that** rather than a manifest, so no kind can be checked while another quietly is not.

**Not git, and specifically not Git LFS**, because an asset has to be **deletable**.
A binary in git history is permanent, and an LFS object pushed to GitHub goes on consuming the quota after the file is removed - the only supported purge is deleting the repository, which is not an option for a repo with a deploy wired to it.
A release asset is one `gh release delete-asset` away.
Being able to change your mind about a prop is worth more here than anything git gives you for the bytes.

The trade, stated once: **deleting an asset breaks builds of old commits**, whose manifest entries name bytes that no longer exist.
That is the direct cost of deletability, and the failure is loud (the fetch stops the build) rather than a quietly different-looking game.

The tag carries no version meaning - it is a file store that happens to live on GitHub, flat, keyed by the basename of `MeshAsset.file`.
Each entry pins a **`sha256`**, because a release asset can be replaced in place: the hash is the only thing that says *which* boulder a given revision of this repo meant, and both the fetch and `cli assets` verify it.
It also records **`bytes`**, the file's size, which is what the loading bar is a fraction of (see [**The loading screen**](loading-screen.md)).
Both are written by `assets:publish` into the line it prints, and both are held to the file on disk by `cli assets`, because neither is a number anybody should be typing by hand.
Nothing in the chain is authenticated - the release is public, and a token would have to reach the Docker build as an `ARG`, where it is readable by anyone who pulls the image.

They are also the one thing here that gets **worse silently**.
A level renders identically whether its props are 40 KB or 6 MB, every test stays green, and what changes is how long the first frame takes and how much of the LFS bandwidth quota a month of CI spends - neither of which anybody reads off a build.
So three things are asserted rather than advised.

**A budget, in the suite.** `cli assets` holds the whole directory to **100 MB**, and any single file to **8 MB**.
The store imposes nothing worth budgeting against - a release caps one asset at 2 GiB and neither total size nor download bandwidth at all - so the bar is an engineering one and has to be argued rather than quoted.
Two things pay for these bytes: the Docker image the VM pulls on every deploy, since props are baked in at build, and the time a level takes to dress itself once it is open.
100 MB is roughly where the image stops being something you rebuild and redeploy without thinking about it, and at ~1 MB a prop that is a hundred-odd props - a lot more level than exists.
It is deliberately **not** a quota, so raising it is allowed; do it by deciding those two costs are worth paying, not because the number was in the way.
The per-file bar is not a target to author up to - a textured prop in this game's style is well under 1 MB, and 8 MB is what catches a raw Blender export with 2k PNGs in it before that becomes the habit.

**A pipeline, pinned - one per kind.** `bun run assets:optimize <in> <out>` runs `gltf-transform` with the settings recorded in `scripts/optimize-asset.ts`: meshopt for geometry, WebP textures capped at 1k, and **no mesh simplification by default** - decimation changes the silhouette, the silhouette is what this look is made of, and that is not something a build step gets to do quietly to every prop that passes through.

What that argument does not justify is refusing decimation outright, which is where this stood until a 3 x 3 m background wall panel turned out to be carrying **134,041 triangles**.
`sewer-wall` and `sewer-arch` are a UE5 **Nanite** set: authored for a renderer that streams its own level of detail, dropped into one that has none and draws every triangle.
The ball arena stands four of each two metres behind a gameplay plane it views almost orthographically, so 768k triangles - **95% of the whole scene** - were background scenery, which water's transmission pass then drew a second time on every frame it was visible (see [**Water**](water.md)).
At a tenth of the triangles the same frame differs by 1.5% RMSE, because the brick relief that reads on screen is in the normal map; the geometry was buying self-shadowing at grazing angles and very little else.

So `--simplify <ratio>` is **opt-in, per asset, and recorded**: `bun run assets:optimize in.glb out.glb --simplify 0.1`, with the ratio stored in that prop's `MESH_ASSETS` entry beside its sha256.
Recording it is not bookkeeping - it is the one fact about the shipped bytes that cannot be recovered from them, since a decimated prop and a prop modelled at that density are the same file.
Without it the raw in `assets-src/` cannot be re-optimised into the same asset, and the next person to run the pipeline over it silently ships the full-density mesh again.
The error budget is fixed at 1% of the mesh's own extent so the ratio is what binds; a tight one quietly stops the decimation early and reports success, which reads as the flag not working.

The rule of thumb the sewer set establishes: **check a prop's triangle count against what it is for.** `gltf-transform inspect` prints it. Background parallax geometry wearing a normal map wants thousands, not hundreds of thousands, and an asset advertising Nanite, ZBrush or photogrammetry is one to measure before believing.
Typically 5-10× off an unoptimised export, looking identical.

`--center` is the same shape of flag about a prop's **origin**, and it is opt-in and recorded for the same reason.
`mountVisual` does not recentre a prop, which is deliberate: a pivot at a cage's base or two thirds of the way up a doorway is information about the prop, and a level places it by that point.
What that assumes is that the origin is somewhere on the prop at all, and an asset exported out of a level rather than modelled as a prop carries the world coordinates of wherever it stood in that level instead.
`metal-bars` arrived with its geometry 8.9 m from its own origin, which places as a prop that is most of a room away from where it was put - read as the prop having failed to load rather than as a pivot.
The flag runs `gltf-transform center --pivot center` into a temp file the optimise then reads, and `center: true` goes in that prop's `MESH_ASSETS` entry beside its sha256: a centred prop and a prop modelled about its own centre are the same file, so without the record the raw cannot be re-optimised into the same asset.

**A model PACK is one file and several manifest keys**, and `bun run assets:extract <pack.glb> <out.glb> <Node>=<prop-name> ...` is the step in front of the pipeline that makes one.
A pack shares its materials, and a texture set is the overwhelming majority of a prop's bytes: the 24 rocks of `pbr-rock-cliffs-pack` are ~20 KB of geometry each and 370 KB of 1k maps they all have in common, so one file each is 9.4 MB of which 8.7 MB is the same three images written out 24 times - paid again on every download, and again in VRAM, each time a level scatters more than one of them.
Extracted together they are one **624 KB** file, one fetch and one GPU upload however many of them a level uses.
`MeshAsset.node` is what addresses one: several entries name the same `file` and each names its own node inside it, `loadMesh` caches per FILE rather than per key, and `storedAssets()` lists that file once so the fetch, the budget and the basename-collision check all see one thing rather than 24 of it.
Extraction is a step of its own because it is the one that takes decisions - which nodes, and what each prop is called - and because a pack is only re-extractable if the node name behind each prop is written down, which the prop's `MESH_ASSETS` entry is where it is written.
It also bakes each node's WORLD rotation and scale into its vertices (a Sketchfab/FBX export wraps the pack in the centimetres-to-metres scale and the Z-up-to-Y-up rotation) and drops the translation that is the prop's place in the pack's layout, so what comes out is in metres, Y-up, on its own origin, and needs no `scale`/`rot*` in 24 entries that would each have to agree.
`assets:optimize --keep-nodes` is **not optional** for one: the optimiser joins meshes that share a material by default, which for a pack means every prop welded into a single object with no name left to address.

`bun run assets:optimize-texture <in> <out.webp> --map <base|normal|roughness|metallic|ao|emissive> [--size 1024]` is the same argument for a texture map, through ImageMagick (which this repo already asks for, to turn an SVG snapshot into a PNG - adding a native image dependency to a project whose only binary is its assets would cost more than it saves).
The `--map` is not bookkeeping, it picks the **encoding**: an albedo and an emission map are pictures and go to lossy WebP at q90, while a normal, roughness, metallic or AO map is **data** - a vector or a number per texel - so it is encoded **lossless** and resized in linear space. A lossy codec's ringing around an edge is not a softer picture there, it is a surface that shades wrongly, seen as shimmering highlights along every crack; an sRGB-aware downscale of a roughness map averages numbers as if they were brightnesses and brightens every one of them.
1k is the ceiling for the same reason the prop pipeline caps its textures there.

`bun run assets:optimize-hdri <in.exr|in.hdr> <public/hdri/name.hdr> [--size 1024] [--exposure 1]` is the third pipeline, for a captured sky (see [**Light and air**](lighting-and-surfaces.md#light-and-air)), and it is the one that does **not** go through ImageMagick.
The format choice is the point of it: Poly Haven ships half-float EXR, which for a 2k sky is 24 MB - a quarter of the whole budget for one image nobody looks at directly - while Radiance RGBE carries one shared exponent per pixel instead of three and the same sky at 1k is 1.6 MB, giving up a mantissa of 8 bits per channel where the convolution averages thousands of texels into every sample anyway.
ImageMagick reads the EXR correctly and its Radiance **writer does not round-trip**: the mean linear luminance of this sky comes back 2.9 million times what went in, and the per-pixel ratios are not consistent with each other, so it is not even a scale factor that could be divided out.
A sky wrong by a constant is a level lit wrongly and a sky wrong per pixel is a level lit by noise, and neither announces itself as anything but "the lighting looks off" - so the script decodes with three's own `EXRLoader`, resamples by **area averaging in linear light** and encodes RGBE itself.
Both of those are load-bearing rather than fastidious: a Lanczos or Mitchell kernel rings around a discontinuity and the sun in this sky is 130,000x the mean, so the halo around it is *negative* radiance several times brighter than anything else in the picture; and three's two loaders disagree about row order (`EXRLoader` reports `flipY: false`, `HDRLoader` `flipY: true`), so a conversion that does not reverse them is a level lit by its own ground.
The script **prints its own round trip** - source, resampled and re-decoded mean and peak luminance - because an encoder nobody checks is one that silently stops being one; this sky converts at +0.10% mean and +0.18% peak.
`--size` is the equirect's width and the height is half of it; 1k is ample for lighting and too soft for a visible background (see `hdriBackground`).

Both format choices are about what has to be **paid at runtime**, and this is the trap the pipeline was written around: an optimisation that lands in a glTF's `extensionsRequired` is not a smaller read, it is a file the loader **refuses** - and the prop falls back to its placeholder box, which is a silent failure by design.
So meshopt comes with `setMeshoptDecoder` wired into `gltfLoader()` (~25 KB, ships with three, rides the same dynamic import so a page with no props still fetches neither).
Textures are **WebP rather than KTX2** for the same reason twice over: KTX2 needs the external `ktx` binary at build time *and* `KTX2Loader` plus its transcoder at runtime, where WebP needs neither - three.js reads it through `EXT_texture_webp` - and is within a few percent on disk.
What KTX2 buys is staying compressed in **VRAM**, which is a decision for when there are enough props for VRAM to be the constraint rather than download size. It is not now.

**Redistributable and non-commercially licensed, or it does not go in the store.** The release is public, so an asset in it is a standalone, reusable copy of that file on a stable URL - which is redistribution however internal the intent, and is exactly what a stock-asset licence like Poliigon's forbids while permitting unlimited use of the same texture *in* a project. The distinction is not the purpose, it is whether the bytes are obtainable as bytes.
Serving the same maps from the deployed game is the ordinary end-product case and is not the same thing; hosting them next to no product is.
So the test an asset has to pass is that its licence permits **handing the file on**, not merely using it: CC0 (Poly Haven, ambientCG) and CC BY (most of the props here) both do, and a licence that permits use but not redistribution stays off the manifest entirely. If one is ever genuinely needed, the shape of the answer is a private store with a build-time secret, not a quieter public one.

**A NON-COMMERCIAL clause is acceptable here, and that is a fact about this repo rather than about the pipeline.** This tree is a prototype - the proof that the rope, the wrap points and the feel work - and the game itself is built in Unity, where none of these assets follow it.
Nothing here is sold, and nothing here is a demo for something that is, so a CC BY-NC asset is being used and redistributed inside the licence rather than at the edge of it.
What that permission does NOT survive is this repo becoming a product: if anything here is ever monetised, or lifted wholesale into something that is, every NC asset has to come out first, and `license` in the manifest is the field that says which ones those are (`cli assets` requires it, and `CREDITS.md` prints it, so the list is never a search).
It is also the reason to prefer a CC0 or CC BY source when both would do: a prop with no NC on it is one less thing that has to be replaced on the day the answer changes.

**Provenance, in the manifest.** `MeshAsset`, `TextureAsset`, `HdriAsset` and `RawAsset` all require `source`, `author` and `license`, and `cli assets` fails without them. It is per ENTRY rather than per file, so a texture set is credited once as a surface however many of its six maps it ships.
The file is opaque and the licence lives on a web page nobody revisits, so a binary with no source is a liability rather than an asset - a year later "can this ship" has no answer but "delete it and remodel".
`author` is separate from `source` because a licence like **CC-BY obliges you to credit a person**, and a link to the page you found it on is not that.

`CREDITS.md` is **generated** from those fields (`bun run assets:credits`) and checked against them by `cli assets`, so it cannot drift.
Attribution is a licence obligation, and a hand-kept credits list is one that gets forgotten on exactly the day the asset is added - a violation that looks like nothing at all. The manifest is the file you cannot avoid editing to add an asset, so the credits derive from it - props and surfaces under their own headings.
Note that the generated file discharges the *record*; a CC-BY asset shipping in the game also wants that credit reachable by a player, which is a UI decision rather than a tooling one.

A grab through `cli shot --3d` **waits for every asset** before it draws (`assetsSettled`), and that is not a convenience: a screenshot that races the loads photographs whichever props and maps happened to have arrived, so the same command produces the placeholder box one run and the real prop the next - evidence of nothing. The game deliberately does not wait, since the placeholder and the generated surface exist precisely to cover that gap.

`cli assets` separates five failures because they have five different fixes: a manifest key with no **file** (usually an unfetched clone, but also what a deleted release asset looks like - in game it draws the grey placeholder, which is deliberate and therefore easy to ship without noticing), a **stale** file whose bytes are not the sha256 its entry names, two entries **colliding** on a basename (one flat namespace in the release, so the second would overwrite the first), an **orphan** file no entry names (bytes in the budget nothing can draw), and a **missing licence**.
It is not part of `cli render3d`, which is deliberately pure - no GPU, no canvas, no level, and no filesystem.

**A prop's own emission needs waking.** glTF's default `emissiveFactor` is black and three.js multiplies the emission map by it, so a prop exported with a beautiful emission map and no factor - which is what a modelling tool will happily write - renders exactly as if the map were not there, and looks like a texture that failed to load rather than like a value that is zero.
`wakeEmission` lifts that one case (a map, and a factor that is exactly black) to white on load; a prop that authors any emissive colour of its own is left alone, and one with no map is untouched.
It is the same rule `surfaceFor` applies to this project's own texture sets, which is the point - a prop and a surface that both ship an emission map should not need different knowledge to light up.
What it does **not** do is light the room: emission is appearance, and what lights is a LIGHT OBJECT in the same body (see [**Light and air**](lighting-and-surfaces.md#light-and-air)), never a prop's materials - reading a light's colour, reach and aim out of a picture is guessing at all three.

The cheapest prop is still the one with **no textures at all**: a `.glb` exported bare and given a `visual.texture` wears that surface (`mountVisual` assigns it over the file's own materials), so a boulder can be ~20 KB of geometry wearing the same stone the extruded walls wear - which also makes it look like it belongs to the level rather than like an import. A prop that names no texture keeps the materials it was exported with.

The output directories and the split that matters: `public/meshes/`, `public/textures/`, `public/water/` and `public/hdri/` are **build output** - only ever the optimised copy, only ever written by `assets:fetch` or the `assets:optimize*` scripts - while `assets-src/` holds the **raw downloads** as they arrived.
Both are gitignored. A raw is kept because re-optimising is what you do when the pipeline's settings change, and it is re-downloadable from the `source` its manifest entry records if it is ever lost.

The whole loop:

```sh
just asset assets-src/rock.glb public/meshes/rock.glb        # optimise + upload a prop
bun run assets:optimize assets-src/gate.glb public/meshes/gate.glb --center   # ...re-origined on its own bounds
# paste the printed MESH_ASSETS entry into src/render3d/assets.ts

# a PACK: many props out of one download, sharing one copy of their materials
bun run assets:extract ~/Downloads/pack.glb assets-src/rocks.glb Cliffs_SmallStone_1=rock-1 ...
bun run assets:optimize assets-src/rocks.glb public/meshes/rocks.glb --keep-nodes
bun run assets:publish public/meshes/rocks.glb
# one MESH_ASSETS entry per prop, all naming that file, each with its own `node`

# a surface is the same loop, once per map it has:
bun run assets:optimize-texture assets-src/stone_col.png public/textures/quarry-stone-base.webp --map base
bun run assets:optimize-texture assets-src/stone_nrm.png public/textures/quarry-stone-normal.webp --map normal
bun run assets:publish public/textures/quarry-stone-base.webp
# paste the printed map lines into ONE TEXTURE_ASSETS entry, with its `tile`

# a captured sky: one file, its own pipeline (NOT ImageMagick - see above)
bun run assets:optimize-hdri assets-src/golden_gate_hills_2k.exr public/hdri/golden-gate-hills.hdr
bun run assets:publish public/hdri/golden-gate-hills.hdr
# paste the printed line into HDRI_ASSETS, with a `label` for the editor's picker

bun run assets:credits                                       # regenerate CREDITS.md
bun run replay assets                                        # check it
just assets                                                  # on another machine
gh release delete-asset assets rock.glb                      # change your mind
```
