# Painterly root bark

## Editor variants

The editor offers three saved root bark choices. `original` uses the committed
`painted-root-base.webp`; `broad` uses `painted-root-broad-base.webp`, encoded
directly from the user's supplied `codex-clipboard-50d9af3a-38a2-4648-b473-d1c48a182efa.png`
without repainting; `soft` uses `painted-root-soft-v4-base.webp`, described below.
Each is 1024 square and pinned separately in the texture manifest. Source PNGs
are preserved in `assets-src/painted-root/` (on Karin's machine). All three runtime
files were first published to the `karin-lu/website` asset store, then copied into
this repository's own `assets` release on 2026-10-16, so their pins carry no
`storeRepo`. Superseded soft runtime drafts are kept locally
under `assets-src/painted-root/superseded-runtime/` rather than shipped.

## Active softer version

The active map is `public/textures/painted-root-soft-v4-base.webp` (1024 square,
WebP quality 92). Source: `assets-src/painted-root/painted-root-soft-v4-base.png`.
The fourth soft version returns to the user's supplied light reference rather
than editing v3. It selectively deepens short groove sections and merges smaller
brush patches, targeting approximately 20% less visual detail (an artistic
target, not a measured pixel reduction). Material settings remain unchanged.

Current prompt (built-in OpenAI image generation, 2026-10-16):

> Edit the attached bark texture, using THIS attachment as the exact starting point. This is a restrained adjustment, not a redesign. Preserve the same warm tan palette, brightness, low-contrast matte gouache look, main vertical grain paths, asymmetric bark planes, knots and groove widths. Make only two changes: (1) Naturally darken a SMALL minority of existing groove sections, about 15-20 percent of their total length, by a modest amount (warm medium clay brown, never black or deep umber). These should be short irregular tapered accents where grain curls around a knot or where a crevice deepens, unevenly distributed. Most grooves must remain exactly as light and soft as in the attachment. No continuous dark outlines, no widening all the grooves, no dark branching network, no regularly spaced dashes. (2) Reduce overall visual detail by approximately 20 percent: merge the smaller secondary brush patches into larger quiet painted shapes and omit a few minor grain fragments. Preserve the main organic structure and hand-painted character; do not blur the image or flatten all variation. No new cracks, fine scratches, hatching, speckles, bevel highlights or extra knots. Flat edge-to-edge square albedo map, consistent diffuse illumination, no objects, shadows, borders or text. Maintain seamless repeat intent on both axes. Output 1024 square.

### Third soft version (superseded)

This third soft version varies tone, width and continuity within each groove:
light clay sections fade into the bark, with shorter medium-brown accents.
It breaks the continuous dark outlines while retaining the broad brushwork.
Material settings remain unchanged. Both previous soft versions are preserved.

Current prompt (built-in OpenAI image generation, 2026-10-16):

> Edit the supplied low-detail painterly bark texture. Keep the warm tan broad painted planes, organic grain layout, few knots, matte gouache style and thicker readable grooves. The current grooves are too uniformly dark and continuous. Vary their COLOR AND STRENGTH along each stroke: most groove lengths should be light dusty clay or warm taupe only slightly darker than adjacent bark; occasional short medium brown accents, never long dark outlines. Let broad strokes fade gently into the bark, disappear for stretches, then resume; vary their width from broad soft patches to narrow tapered ends. Break up the continuous dark network, especially at the forks where the lines merge into dark wedges; use light painted interruptions there. Several subtle tones within the groove itself, irregular painterly edges, no regular alternating pattern. Keep enough contrast to see the grain at gameplay distance but substantially reduce total dark-line coverage. Preserve low detail: no fine scratches, hatching, pores or speckles. Do not alter overall bark brightness, add strong highlights, or introduce more grooves. Flat square edge-to-edge albedo texture, no objects, no shadows, no text. Design seamless repeat boundaries in both axes. 1024 square.

Previous revision:

This second soft version slightly deepens and widens the grooves for readability,
preserving the irregular shapes and low-detail paint. Normal strength, roughness
and colour multiplier are unchanged. The first soft version remains available
locally as `painted-root-soft-base.png` / `.webp`.

Revision prompt (built-in OpenAI image generation, 2026-10-16):

> Edit the supplied painterly root bark albedo texture with ONLY a restrained readability adjustment. Preserve the exact overall composition, irregular grain paths, off-centre knots, broken grooves, broad bark planes, matte brushwork, warm tan palette, low detail level, flat edge-to-edge square format and overall brightness. Make existing groove lines about 35 percent wider on average, keeping their irregular taper and interrupted endings; do not add extra lines. Increase the contrast of these grooves modestly: make the dusty clay/taupe groove colour a little darker, about 15 percent darker than it currently is. Keep them medium warm clay brown, never dark umber or black. Give broad painted planes just a touch more tonal separation. Maintain the gentle stylized painterly treatment, no scratches, hatching, speckling or tiny detail, no hard bevel highlights. It should clearly be the same texture with slightly thicker, more legible grain, not a redesign or a return to deeply fissured bark. Keep seamless tiling intent on both axes. Single 1024 square albedo texture, no text, border, objects, lighting gradients or shadows.

First soft version:

Created with the built-in OpenAI image-generation tool on 2026-10-16 as an edit
of the lower-detail variant. It uses lighter clay grooves and uneven plate
widths, broken furrows and a few knots, with no fine hatching. Normal strength
is 0.45 and roughness is uniformly 0.91; linear colour multiplier remains 0.58.
The original detailed painting below is preserved. This new file is currently
local; publish the pinned asset with `bun run assets:publish-stored` before
pushing a commit with this manifest pin.

Prompt:

> Edit this low-detail painterly bark texture for game roots. Preserve the muted warm tan palette, flat square edge-to-edge albedo format, vertical organic grain, broad matte gouache brush shapes, and low fine-detail level. Make the grooves MUCH lighter: soft dusty clay/taupe, only slightly darker than the adjacent bark, no dark brown outlines. Increase ORGANIC UNEVENNESS: radically varied plate widths and lengths, asymmetric swollen grain islands, irregular interrupted furrows which taper and disappear, off-center subtle knots, occasional curved fork grain. Avoid the current evenly spaced long sinuous parallel stripe effect. Some broad quiet areas, some clustered smaller bark planes, varied rhythm with no repeating Y pattern. Paint broad irregular color facets, softly chipped edges and layered brush patches; no fine scratches, no hatching, no noise. Keep the overall palette the same brightness as the input; lighten the grooves specifically. Remain recognizably woody, hand-painted and natural. Texture only, not a trunk or root object. Uniform diffuse illumination, no directional shading, no bevel highlights, no text or border. Design seamless left-right and top-bottom matching repeat edges. Single 1024 square texture.

## Original detailed version

Created with the built-in OpenAI image-generation tool on 2026-10-16 using the
user's bark reference. Original preserved in `assets-src/painted-root/painted-root-base.png`;
the runtime map is `public/textures/painted-root-base.webp` (1024 square, WebP quality 92).
Binary files use the repository's release asset store; publish the pinned map
with `bun run assets:publish-stored` before pushing this change.
It was first hosted in the `assets` release of `karin-lu/website` (a `storeRepo`
pin, since that contributor cannot publish upstream) and copied into this
repository's own release on 2026-10-16.

Prompt:

> Create a seamless tileable flat 2D hand-painted tree-root bark ALBEDO TEXTURE for a 3D game, using the attached reference strictly as the texture/style reference. Fill the entire square image edge-to-edge with bark. No cylinder, no trunk silhouette, no border, no background, no perspective, no cast shadows, no text. Orthographic unwrapped surface. Long irregular longitudinal bark plates running vertically, wandering and splitting naturally, narrow deep dark umber crevices, broad warm ochre/clay/tan raised faces, selectively painted pale warm edge highlights, visibly layered gouache brush strokes and fine dry-brush hatching exactly like the reference. Strong readable separation of broad ridges and fissures even at game scale. Muted earthy colors, no orange saturation. About 12-16 substantial elongated bark plates across the full image width, with irregular length and width. The texture must wrap seamlessly left/right and top/bottom. Surface color painted into the texture rather than photographic lighting. Output a high-quality square game texture.

The renderer derives a tangent normal map once from the painted luminance, so
raised edges and relief follow the same strokes. The procedural maps remain a
headless-safe fallback while loading or if the stored image is unavailable.
