# Third-party notices

The [LICENSE](LICENSE) at the root of this repository applies to original work only.
Everything listed here is third-party material that arrives under its own licence, and it keeps that licence.
Nothing in `LICENSE` adds to, removes from, or otherwise restricts the rights those licences grant you.

## Fonts

`app/fonts/` and `app/public/fonts/` contain **Fantasque Sans Mono Nerd Font** (Bold and Regular, as `.ttf` and `.woff2`).

- Upstream typeface: [Fantasque Sans Mono](https://github.com/belluzj/fantasque-sans) by Jany Belluz.
- Glyph-patched build: [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) by Ryan L McIntyre and contributors.
- Licence: [SIL Open Font License 1.1](https://openfontlicense.org/).

The OFL is a copyleft licence for fonts.
It permits commercial use and bundling, and it requires that the font files stay under the OFL wherever they are redistributed.
It does not restrict the software they are used to render.

## 3D and texture assets (`rope/`)

The rope project's meshes, PBR texture maps, HDRIs and baked raw maps are **not committed to this repository**.
They are fetched at build time from a GitHub Release by `bun run assets:fetch`, and `rope/.gitignore` keeps `public/meshes/`, `public/textures/`, `public/water/` and `public/hdri/` out of version control.
That release is a redistribution of those assets, so the notices below apply to it as much as to a local checkout.

Provenance is recorded per asset in the manifests in `rope/src/render3d/assets.ts`, which require a `source`, `author` and `license` for every entry, and `bun run src/tools/cli.ts assets` fails the build if any are missing.
[`rope/CREDITS.md`](rope/CREDITS.md) is generated from those manifests by `bun run assets:credits` and is the authoritative attribution list.
Do not edit it by hand.

Licences currently in use across those assets:

| Licence | Where |
|---------|-------|
| [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 3D models, sourced from Sketchfab |
| [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Surface textures and environment maps, from Poly Haven and ambientCG |
| Pixel-Furnace free licence | `water-normal-flip` raw map |

CC BY 4.0 requires attribution, which `rope/CREDITS.md` provides.
It also forbids imposing terms that restrict what the licence permits, which is precisely why the noncommercial licence in `LICENSE` is scoped to original work and stops short of these files.
Commercial use of the CC BY and CC0 assets is permitted by their own licences and is not affected by anything in this repository.

## Dependencies

Packages resolved from npm (`app/`, `pool/`, `rope/`) and modules resolved from the Go module proxy (`clipboard/`) are not vendored into this repository and are not distributed by it.
Each carries its own licence, recorded in its own package metadata.
