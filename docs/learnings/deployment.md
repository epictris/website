# Deployment Learnings

Takeaways from getting the SolidStart site deployed to OCI behind Caddy. Most of the time sink came from a handful of distinct problems stacked on top of each other, each masking the next.

## 1. Terraform state must be shared between local and CI

The original setup used **local state** (`terraform.tfstate` on one machine, gitignored). The GitHub Actions runner starts with empty state every run, so CI couldn't see existing resources and tried to recreate everything from scratch.

- Fix: a **remote backend** so local and CI read/write the same state.
- We used OCI's **native `oci` backend** (Terraform ≥ 1.12), not the S3-compatible one. The S3 backend kept failing against OCI: AWS account-ID lookups, then `AWS chunked encoding not supported` on `PutObject` — and the `AWS_REQUEST_CHECKSUM_CALCULATION` workaround wasn't honored. The native backend authenticates with the same OCI API key as the provider, so no Customer Secret Key and none of the S3 quirks.
- Migrating existing local state into the bucket is a one-time `terraform init -migrate-state`.

## 2. The state bucket is a bootstrap/chicken-and-egg resource

The bucket that stores state can't store the state describing its own creation. Options: create it by hand (one click), or a separate bootstrap config with local state. There's no fully self-contained "codify everything" answer — pick where the bootstrap seam lives. We left the bucket as a manually-owned resource.

## 3. Reserved IPs survive instance replacement — by design

An OCI `RESERVED` public IP keeps its address across instance rebuilds because `private_ip_id` is updated in-place (re-associated), not destroyed. The IP only changes if the `oci_core_public_ip` resource itself is recreated. Add `prevent_destroy` if you want a hard guarantee.

## 4. Local/CI input divergence silently triggered destructive rebuilds

`ssh_authorized_keys` lives in instance `metadata`, which **forces replacement** on change. Local apply computed `{personal key, deploy key}`; CI pointed both key-path vars at the *same* deploy key. The two environments fought, each replacing the instance to install its own view of the keys — wiping the boot volume each time (the reserved IP survived, but the box didn't).

- Fix: make both environments compute identical keys (we chose deploy-key-only), plus `lifecycle { ignore_changes = [metadata["ssh_authorized_keys"]] }` so key drift never rebuilds the box again.
- General lesson: any environment-specific input to a force-replacement attribute is a latent footgun.

## 5. Build images for the target CPU architecture

The OCI instance is **Ampere ARM64**, but `docker/build-push-action` on `ubuntu-latest` defaults to amd64. The container crash-looped with `exec format error`. Fix: add `setup-qemu-action` + `setup-buildx-action` and set `platforms: linux/arm64`.

## 6. Match Docker COPY globs to actual lockfile names

`COPY app/package.json app/bun.lockb* ./` never matched `bun.lock` (the newer text-format lockfile, not the old binary `bun.lockb`), so `bun install --frozen-lockfile` resolved deps fresh and non-deterministically. Copy the real lockfile.

## 7. The big one: the SolidStart 2.0-alpha production server was broken upstream

Every request 500'd with `Cannot find package 'srvx'` then `"/" cannot be parsed as a URL`. The root cause: the alpha's bundled **h3 feeds srvx's `FastURL` a relative path** (`/`), and `new URL("/")` throws. This was independent of:

- runtime (Node **and** bun),
- Nitro preset (`node-server` **and** `bun`),
- srvx version (0.9.8 **and** latest 0.11.16, via overrides),
- nitro-2 plugin version (0.1.0 **and** 0.2.0),
- SolidStart alpha version (alpha.1 **and** alpha.2).

No local config or version pin could fix it because the broken glue is inside SolidStart's own bundle.

- Fix: **migrate to stable SolidStart 1.3.2** (vinxi + `app.config.ts`), which uses the mature Nitro/h3 v1 stack (no srvx) and renders SSR correctly. The `src/` files were already 1.x-compatible. Bun works fully here: `server: { preset: "bun" }` + `bun .output/server/index.mjs`.
- Lesson: alpha framework versions can have unfixable-by-you production bugs. When debugging points squarely at a dependency's internals, check whether a stable line exists before sinking more time into workarounds.

## Cross-cutting lessons

- **Verify the runtime locally before deploying.** Once we built and ran the server locally (`bun .output/server/index.mjs` + `curl`), we found the srvx/URL bug in seconds and ruled out node-vs-bun and four version permutations *without* burning slow CI/deploy cycles. Earlier, several deploy round-trips were spent confirming things a local run would have shown immediately.
- **A misleading error often masks the real one.** "Cannot find package 'srvx'" was actually an export-condition mismatch (bun adapter not bundled); the eventual "Invalid URL" was the true bug. Reproduce and read the actual stack rather than trusting the top-line message.
- **Errors stacked.** Fixing the arch error revealed the lockfile/resolution issue, which revealed the srvx resolution issue, which revealed the URL bug. Expect the next layer after each fix; confirm end-to-end, not just "container is Up."
