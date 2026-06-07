FROM node:22-alpine AS frontend
COPY client /app/client
WORKDIR /app/client
RUN npm install
RUN NODE_ENV=production npm run build

FROM golang:1.24-alpine AS builder
WORKDIR /app
RUN mkdir /data
RUN mkdir /app/client

COPY go.mod ./
COPY server /app/server
COPY --from=frontend /app/client/bridge.go /app/client/bridge.go
RUN go mod tidy

COPY --from=frontend /app/client/dist /app/client/dist
RUN CGO_ENABLED=0 GOOS=linux go build -o main /app/server/main.go

FROM scratch
COPY --from=builder /app/main /
COPY --from=builder /data /data
EXPOSE 8080
ENTRYPOINT ["/main"]
