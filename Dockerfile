FROM node:22.14.0-alpine3.21 AS frontend
COPY client /app/client
WORKDIR /app/client
RUN npm install
RUN npm run build

FROM golang:1.23.6 AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
RUN mkdir /data
RUN mkdir /app/client

COPY server /app/server
COPY --from=frontend /app/client/dist /app/client/dist
COPY --from=frontend /app/client/bridge.go /app/client/bridge.go
RUN CGO_ENABLED=0 GOOS=linux go build /app/server/main.go

FROM scratch

COPY --from=builder /app/main /
COPY --from=builder /data /data

ENTRYPOINT ["/main"]
