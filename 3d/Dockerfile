FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY vite.config.ts tsconfig.json ./
COPY orthographic/ ./orthographic/
RUN bun run build

FROM oven/bun:1-slim AS runner
# Chromium renders the editor for the /api/render endpoints; the fonts draw its labels.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server.ts ./
COPY api/ ./api/
COPY orthographic/llms.txt ./orthographic/llms.txt
COPY orthographic/src/core/ ./orthographic/src/core/
COPY --from=builder /app/dist ./dist
# Stored scenes (api/scenes.ts); compose mounts the host's copy here.
RUN mkdir -p /data && chown bun:bun /data
ENV PORT=8080 CHROMIUM_PATH=/usr/bin/chromium DATA_DIR=/data
EXPOSE 8080
USER bun
CMD ["bun", "run", "server.ts"]
