# Game boulder mesh preset

The editor's boulder endpoint sets `game_low_poly: true` in the generator
defaults. Omit the flag or set it to `false` to use the approved stone recipe.
The approved generator, sample model, Blender scene, preview, and validation
files are preserved in
`../../../procedural-asset-generators/boulders/saved-versions/2026-09-25-approved-stone/`.

The game preset keeps the approved slate material and collision silhouette. It
uses fewer, broader side chunks; budgets about 3,000 faces before the final
edge treatment; and bevels only stronger edges with one segment. The narrow
worn bevel faces interpolate their normals while broad faces stay flat.
After the final outline clip, it caps isolated upper and lower depth tips on
structural chunks. Each cap is restricted to a narrow extreme of a chunk and
stays clear of the protected gameplay depth band. This removes the thin rear
fin in the concave sample without globally smoothing its side planes.

| Sample | Triangles | Exported GLB | Outline error | Centre slice error |
| --- | ---: | ---: | ---: | ---: |
| Approved concave | 22,084 | 3,425,996 bytes | 0.01659 | 0.01679 |
| Game concave, same seed and outline | 7,404 | 1,674,368 bytes | 0.01710 | 0.01776 |
| Game upright | 7,328 | 1,773,316 bytes | 0.01865 | 0.02300 |

The concave game mesh has **66.5% fewer triangles** and a **51.1% smaller GLB**.
Both game examples passed watertight mesh, outline, and gameplay centre-slice
validation with a 0.04 tolerance. The same-stage exported GLB comparison is
[approved side](boulder-game-approved-side.png) and
[game side](boulder-game-low-poly-side.png); the
[pointed game mesh before tip clipping](boulder-game-pointed-before.png) shows
the fin that prompted this follow-up. Additional previews show the
[concave](boulder-game-low-poly-concave.png) and
[upright](boulder-game-low-poly-upright.png) shapes.
