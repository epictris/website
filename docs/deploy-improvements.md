# Deploy pipeline improvements

Changes made to `.github/workflows/deploy.yml` (and a lockfile cleanup) to cut
build/deploy times and reduce surface area.

## 1. Native ARM runner instead of QEMU emulation

The image targets `linux/arm64` (the OCI Ampere A1 host). Previously the build
ran on an x86 `ubuntu-latest` runner with `docker/setup-qemu-action`, so
`bun install` and `bun run build` executed under emulation — typically 5–10×
slower than native.

- `runs-on: ubuntu-latest` → `runs-on: ubuntu-24.04-arm`
- Removed the `docker/setup-qemu-action` step
- Removed `platforms: linux/arm64` (the build now matches the runner's arch)

**Caveat:** free ARM runners are free for public repos. On private repos they
are billed (paid plans only). If the repo is private and ARM-runner billing is
unwanted, the fallback is to keep QEMU but rely on the build cache below.

## 2. GitHub Actions build cache

Added layer caching to the `docker/build-push-action` step:

```yaml
cache-from: type=gha
cache-to: type=gha,mode=max
```

Combined with the Dockerfile's `COPY package.json bun.lock` → `bun install`
layer split, dependency installs are skipped when only source changes.

## 3. Path-scoped trigger

The workflow previously ran on every push to `main`, so doc- or
terraform-only changes triggered a full image rebuild and redeploy. It now
only fires when deploy-relevant files change:

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'app/**'
      - 'Dockerfile'
      - 'compose.yml'
      - 'Caddyfile'
      - '.github/workflows/deploy.yml'
  workflow_dispatch:
```

## 4. Removed stale `app/pnpm-lock.yaml`

The project is bun-only (`bun.lock` is the source of truth). The tracked
`pnpm-lock.yaml` was stale and contradicted the toolchain, so it was deleted.
