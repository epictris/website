FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# The commit this image is built from, passed in by the deploy workflow because
# `.dockerignore` keeps `.git` out of the context. The tree stamp (see
# src/sim/treeStamp.ts) reads it when `git rev-parse` has nothing to say, so a
# production recording names the commit it was played on.
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
# 3D props live in a GitHub Release rather than in git (see scripts/assetStore.ts),
# so they are pulled in here - before the build, since vite copies `public/` into
# `dist/`. Verified against the manifest's sha256, so a replaced or truncated
# asset fails the build rather than shipping a game nobody tested. No-ops while
# the manifest is empty.
#
# No credentials: the release is public and the download URL is public, so
# nothing here needs a token - which also keeps one out of the image's build
# history, where an ARG would be readable by anyone who pulls it.
RUN bun run assets:fetch
RUN bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
COPY package.json serve.ts ./
# The server imports the sim (src/server/verify.ts replays sealed runs) and the
# store recomputes the tree's source hash from these same files, so the source
# ships with the runner. The sim has no dependency outside the standard library,
# which is why there is no node_modules here.
COPY src ./src
COPY levels ./levels
COPY --from=builder /app/dist ./dist
# Where sealed runs live; compose bind-mounts the host directory over it.
ENV PLAYTEST_DIR=/data/playtests
RUN mkdir -p /data/playtests && chown -R bun:bun /data/playtests
USER bun
EXPOSE 8080
ENV PORT=8080
CMD ["bun", "run", "serve.ts"]
