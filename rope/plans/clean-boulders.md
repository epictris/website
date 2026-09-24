# Rounded boulders with larger chunks

## Visual target

Keep the original hybrid rock construction and its rounded, multi-face edge treatment. Increase the size of the visible chunks and remove unnecessary polygon density. Preserve deterministic seeds and the editor's authored gameplay outline. The supplied close-ups show the desired soft broken edges; a flat low-poly treatment is not the target.

## Source of excess polygons

The editor endpoint in `src/server/boulderGenerator.ts` invokes `../asset-generators/boulders/stylised_rocks_v5/rockgen.py`. The old editor recipe asked for 24 front slabs and at least 21 side chunks. A fine voxel remesh capped at 0.0065 m generated roughly 330,000 intermediate faces in the measured low-ridge build. Later decimation and the two-segment bevel still left 126,436 exported triangles. The remesh also joins overlapping pieces into one closed solid, so removing it outright would risk holes and disconnected chunks; the fine resolution was the costly part.

## Revised recipe

The editor now asks for ten front slabs and ten broader side chunks from the existing hybrid construction. Secondary flakes are disabled. The original broad chunk bevel, local thin-edge rounding, and final two-segment bevel remain intact. For this recipe, the voxel remesh uses up to 0.012 m cells and the surface is reduced toward 7,000 faces before the final bevel. Older recipes retain their prior settings.

## Validation

Blender 5.2 produced 25,744 final triangles for the low ridge, down about 80% from 126,436. Its GLB shrank from 15.4 MB to 5.5 MB. The upright wedge and broken crown produced 26,224 and 26,978 triangles. All three passed projected-outline, watertightness, connectedness, and gameplay centre-slice validators. A concave aperture with a hole at the editor's zero yaw/pitch also passed, at 29,126 triangles. The final low-ridge GLB exported and passed both validators. A repeated build with the same seed produced byte-identical source geometry. TypeScript typecheck and boulder request tests passed.

Review images: [original low ridge](boulder-baseline-low-ridge.png), [revised rounded low ridge](boulder-rounded-low-ridge.png), and [revised upright wedge](boulder-rounded-upright.png).

The remaining angular fracture faces are intentional large facets. This change addresses the density spike and small random pieces while preserving the original soft, broken edge character.
