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
# rope/, since that is where the recipe runs. See "Prop assets" in rope/CLAUDE.md.
#   just asset assets-src/rock.glb public/meshes/rock.glb
asset IN OUT:
    cd rope && bun run assets:optimize {{IN}} {{OUT}} && bun run assets:publish {{OUT}}

# Pull the props this checkout's manifest names into rope/public/meshes/.
assets:
    cd rope && bun run assets:fetch
