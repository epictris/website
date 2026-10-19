# Crystal background patches

In the level editor, open **Visuals → + Crystals**. Click a model surface,
choose **Preview crystals**, then **Apply**. To scatter patches, select a
host model (or click it) and choose **Preview scatter**. Apply saves the
whole preview batch. Cancel discards it. Saved patches can be regenerated
with **Edit selected plant** using the same recipe workflow as ferns.

- Adjust shard count, height, patch radius, glow and blue/violet, amethyst or
  mint/cyan colours. Shape and variation contains size variation, lean and seed.
- Scattering samples surface area, favours upward faces and respects both the
  requested spacing and a minimum of twice the patch radius. Individual shard
  anchors are projected onto the host; unsupported shards are skipped.
- Open clusters of slender six-sided prisms use the original soft painted
  washes, with four mineral colour variations, broad soft pigment clouds and subtle
  edge highlights. The embedded colour/emission texture survives GLB export.
  Glow combines emissive self-illumination with soft, depth-tested translucent
  veils around each individual shard. These survive GLB export without a global bloom pass.
- Default patches contain 11 shards, fewer than 600 triangles and two draw
  calls (solid shards and soft halo). Crystals do not sway and use the existing decorative geometry save
  path; they do not create collision shapes.
- Fixed seeds reproduce geometry and texture. Existing foliage recipes retain
  their original validation and generation.

Verification: `bun run scripts/test-crystals.ts` and `bun run typecheck`.
The browser check in `artifacts/crystal-check` also exports/reloads the GLB,
checks its paint and emission maps, and saves/reloads the recipe via the real
foliage endpoint. Preview: `artifacts/crystal-check/preview.png`.

## Individual crystals

Use **Shards per patch** for the count, **Patch height** and **Shard width ×**
for overall proportions. **Shape variation** gently varies hexagonal proportions and crown height. Straight prism faces and a mix of full points, short points and small clipped terminal facets
keep the crystals recognisable. All prisms have six sides; there are no slab-like
four-sided bodies or long blade-like tops. Each crystal keeps a stable seeded shape.

Expand **Individual crystals**, choose a numbered crystal (1 is the centre;
the others spiral outward), and set its height and width in metres.
These explicit dimensions override the patch proportions. **Reset this crystal**
returns it to automatic sizing. Preview, then Apply; the overrides are retained
when you edit a saved patch. Reducing the count hides higher-numbered overrides;
increasing it restores them. Changing one crystal's dimensions leaves its
neighbours unchanged.

Body facets meet at staggered heights with broad diagonal cuts, subtle changes in
width and an uneven shoulder. Shape variation controls these surface-plane changes
as well as the asymmetric tips. Painted washes remain soft, without drawn seam lines.
