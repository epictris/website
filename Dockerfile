FROM oven/bun:1 AS builder
WORKDIR /app
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile
COPY app/ .
RUN bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app
COPY --from=builder /app/.output ./.output
EXPOSE 3000
ENV PORT=3000
CMD ["bun", ".output/server/index.mjs"]
