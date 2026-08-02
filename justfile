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

# Optimise a 3D prop into rope/public/meshes/ (Git LFS). See "Prop assets" in rope/CLAUDE.md.
asset IN OUT:
    cd rope && bun run assets:optimize {{IN}} {{OUT}}
