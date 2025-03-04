FROM golang:1.23.6 AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
RUN mkdir /data

COPY app /app/app
RUN CGO_ENABLED=0 GOOS=linux go build /app/app/backend/main.go

FROM scratch


COPY --from=builder /app/main /
COPY --from=builder /data /data
COPY --from=builder /app /


ENTRYPOINT ["/main"]
