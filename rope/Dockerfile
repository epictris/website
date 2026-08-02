FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
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
COPY package.json serve.ts ./
COPY --from=builder /app/dist ./dist
EXPOSE 8080
ENV PORT=8080
CMD ["bun", "run", "serve.ts"]
