setup:
    cd app && bun install

run:
    bun run --cwd app dev

check:
    cd app && bun run typecheck && bun run lint
