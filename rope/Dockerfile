FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app
COPY package.json serve.ts ./
COPY --from=builder /app/dist ./dist
EXPOSE 8080
ENV PORT=8080
CMD ["bun", "run", "serve.ts"]
