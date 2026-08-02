setup:
    cd app && bun install

run:
    bun run --cwd app dev

check:
    cd app && bun run typecheck && bun run lint

fmt:
    cd app && bun run format

check-all:
    cd app && bun run format && bun run typecheck && bun run lint

# Optimise a 3D prop, then upload it to the asset release. Paths are relative to
# rope/, since that is where the recipe runs. See "The asset store" in rope/CLAUDE.md.
#   just asset assets-src/rock.glb public/meshes/rock.glb
asset IN OUT:
    cd rope && bun run assets:optimize {{IN}} {{OUT}} && bun run assets:publish {{OUT}}

# The same for one map of a PBR texture set. MAP is base|normal|roughness|metallic|ao,
# and it picks the encoding as well as the slot - an albedo is a picture and is
# encoded lossily, the other four are data and are not.
#   just texture assets-src/stone_col.png public/textures/quarry-stone-base.webp base
texture IN OUT MAP:
    cd rope && bun run assets:optimize-texture {{IN}} {{OUT}} --map {{MAP}} && bun run assets:publish {{OUT}}

# Pull the props and textures this checkout's manifests name into rope/public/.
assets:
    cd rope && bun run assets:fetch
