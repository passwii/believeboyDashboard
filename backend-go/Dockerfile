# syntax=docker/dockerfile:1.7
ARG GO_VERSION=1.27.3
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS builder
ARG TARGETOS
ARG TARGETARCH
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOWORK=off \
    GOPROXY=${GOPROXY}
WORKDIR /src

COPY backend-go/go.mod backend-go/go.sum ./
RUN --mount=type=cache,id=believeboy-go-mod-cache,target=/go/pkg/mod,sharing=locked \
    go mod download

COPY backend-go/ ./
RUN --mount=type=cache,id=believeboy-go-build-cache,target=/root/.cache/go-build,sharing=locked \
    mkdir -p /out \
    && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
       go build -trimpath -ldflags="-s -w" -o /out/go-api ./cmd/gateway \
    && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
       go build -trimpath -ldflags="-s -w" -o /out/go-migrate ./cmd/migrate \
    && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
       go build -trimpath -ldflags="-s -w" -o /out/go-worker ./cmd/worker \
    && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
       go build -trimpath -ldflags="-s -w" -o /out/go-scheduler ./cmd/scheduler

FROM alpine:3.22 AS runtime
# tzdata is required at runtime, not only at build time: store.OpenPool's
# AfterConnect hook resolves the PostgreSQL TimeZone via time.LoadLocation and
# fails every DB connection when the zoneinfo database is missing. The binaries
# also embed time/tzdata (internal/tzcheck) as a second line of defence.
RUN apk add --no-cache ca-certificates tzdata chromium font-noto-cjk \
    && addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app app
ENV CHROME_BIN=/usr/bin/chromium-browser
COPY --from=builder --chown=10001:10001 /out/go-api /usr/local/bin/go-api
COPY --from=builder --chown=10001:10001 /out/go-migrate /usr/local/bin/go-migrate
COPY --from=builder --chown=10001:10001 /out/go-worker /usr/local/bin/go-worker
COPY --from=builder --chown=10001:10001 /out/go-scheduler /usr/local/bin/go-scheduler
COPY --from=builder --chown=10001:10001 /src/resources/project_launch_documents /app/resources/project_launch_documents
USER 10001:10001
EXPOSE 8200
ENTRYPOINT ["/usr/local/bin/go-api"]
