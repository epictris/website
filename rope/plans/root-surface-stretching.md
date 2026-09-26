# Root surface stretching fix

## Diagnosis

The editor sends its collision polygon in metres to the version-2 Python root generator. The generated mesh is loaded at uniform scale, and Blender exports its XZ gameplay plane to glTF XY. The inspected runtime path does not apply nonuniform scaling.

`asset-generators/roots/sideview_surface.py` maps texture coordinates from only the silhouette XZ coordinates. Front and back share this projection. Surface area near the rounded silhouette is much larger than its texture area, stretching bark when seen from above or obliquely.

An independent reproduction using `rope/public/generated-roots/10c84455-4c74-4da3-b7cc-1fb253807d1d/blockout.json`, seed 4321, measured surface-to-projected-texture area ratios of 8.21 at the 90th percentile, 22.47 at the 99th percentile, and 327.95 maximum. The generated depth was 0.529 m for a requested 0.38 m. The thickness solver uses one median branch width and subsequent swelling adds more depth.

## Implementation plan assigned to Sol

1. Replace the silhouette-only bark mapping with surface-aware mapping, with appropriate seams, grain direction, normals, and portable glTF PBR textures.
2. Bound visual thickness consistently with requested depth and investigate local thickness at narrow branches and forks. Preserve the exact collision outline and gameplay data.
3. Make editor, server, and Python depth validation agree; currently the UI/server allow 5 m while Python allows 3 m.
4. Add regression coverage for surface texture distortion, depth, determinism, closed geometry, and unchanged gameplay. Run the relevant Python and API tests plus TypeScript validation.
5. Export a fresh test asset and inspect front, overhead, and oblique views. Existing immutable generated assets need regeneration; do not silently overwrite them.

## Compatibility and scope

Saved generated assets reference an older generator directory in their provenance. The current default generator lives in this repository; `ROOTS_PROJECT` can override it. Confirm the running server uses the updated source when verifying in the editor.

Preserve unrelated in-progress editor, boulder, and vine work. Treat visual verification and test results as implementation acceptance criteria, and explicitly report any unverified part.

## Implemented and verified

The surface now uses padded UV charts selected by triangle normal. Disconnected patches occupy separate atlas islands, so crossing prongs do not overwrite one another. The mesh remains welded and Blender writes UVs per face corner. The bark atlas samples the full 3D surface position and a smooth normal, blending the established side grain with bark patterns across the depth on top and end-facing surfaces. Exposed end grain is still baked from authored end profiles. The atlas uses flat tangent-space normal pixels so chart borders keep the welded geometry normals; fine bark normal relief is a follow-up quality improvement.

Final volume fitting limits the complete generated depth to the requested maximum. Python now accepts the same 0.02–5 m range as the editor and server. Gameplay outlines and collision data are unchanged.

On the saved fork shape, the original projected UV had a maximum surface-to-texture area ratio of 327.95 and generated 0.529 m thickness for a 0.38 m request. The revised mesh measures a maximum UV ratio of 1.723 and exactly 0.38 m thickness. The front silhouette remains the same. Blender 5.2 exported fresh LOD0–2 GLBs and rendered before/after front, overhead, and oblique images under identical lighting in `rope/plans/root-fix-preview`. The overhead view no longer has the broad stretched dark patches seen in the old asset.

Verification: `python -m unittest test_sideview_roots.py` passes 15 tests, including saved-fork and tapered-root UV/depth regressions. Blender 5.2 `test_blender_sideview.py` passes all authoring/export checks, including three successive exports. `node --test scripts/root-generator.test.mjs` passes 2 tests and `tsc --noEmit` passes (run by parent). The live editor viewport was not exercised. Existing immutable generated root URLs are unchanged; regenerate a root in the editor to use the new mesh and texture.
