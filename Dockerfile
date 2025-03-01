FROM golang:1.23.6
WORKDIR /app
COPY server.go /app/server.go
COPY static /app/static
CMD ["go", "run", "server.go"]
