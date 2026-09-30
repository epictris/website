# Moss collar experiments (2026-09-29)

Research scripts behind the "Moss Collar Study" report: four ways of growing a painterly carpet of leaves over a faceted rock, built headlessly in Blender 5.2 and proven in three.js.
They are experiments, not the pipeline; nothing here is imported by the game.
Since 2026-09-29 the moss add-on (`tools/blender/moss`) grows the `e_cutout.py` process from the brush's stamps, and since 2026-09-30 an ivy carpet grown out from an origin in its place (see `docs/blender-moss.md`); these scripts stay as the record of how the look was arrived at and as a quick bench for changing it outside a scene (`common.py`'s rock, stamps, scene and cameras are what the add-on is checked against headlessly).

- `common.py` - the shared scene: a chiselled rock, a brush-style stamp mask (centre, normal, radius, strength composited in painting order, as the moss add-on records it), the hull normal, the leaf atlas, Eevee render, glTF export, stats.
- `a_cards.py` - leaf-card clusters scattered by the mask, every card shaded with the hull normal.
- `b_shells.py` - shell texturing, N offset copies of the masked patch with a noise threshold per shell.
- `c_cushion.py` - the solid smoothed cushion baseline.
- `d_hybrid.py` - the earlier shape: a thin underlay, two layers of small leaf-clump cards, hanging strands.
- `e_cutout.py` - the current one: one flat-coloured angular blob per card from a nine-shape polygon atlas (spiky, fanned leaf cluster, faceted round, heart-shaped vine leaf; alpha blurred and re-thresholded so corners are soft), hull-tangent cards (no random tilt) in nine thin layers to 10 cm, three sub-heights each, the outer band a quarter-round shoulder that rolls into the rock, every card rotated the least that faces the game camera by 30 deg, so overlapping blobs layer and never cross, underlay in the leaf colour, vines of tapering ovate leaves held in front of the rock.
- `harness/` - loads an exported GLB into three.js with a sun and hemisphere fill, renders three views and prints the materials GLTFLoader built.

Run one, from this directory:

```sh
blender -b --factory-startup --python e_cutout.py          # writes out/e_cutout.{png,glb,json} + _close/_under renders
DENSITY=1500 NAME=a2_cards blender -b --factory-startup --python a_cards.py
cd ../../.. && bun tools/blender/moss-experiments/harness/run.ts e_cutout.glb   # writes out/three_e_cutout.png
```

`out/` is scratch output and is not meant to be committed.
