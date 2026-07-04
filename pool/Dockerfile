FROM oven/bun:1 AS builder
WORKDIR /app/client
COPY client/package.json client/bun.lock* ./
RUN bun install
COPY client/ .
RUN bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app
COPY package.json server.ts ./
COPY --from=builder /app/client/dist ./client/dist
EXPOSE 8080
ENV PORT=8080
CMD ["bun", "run", "server.ts"]
