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
       go build -trimpath -ldflags="-s -w" -o /out/go-api ./cmd/gateway

FROM alpine:3.22 AS runtime
RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app app
COPY --from=builder --chown=10001:10001 /out/go-api /usr/local/bin/go-api
USER 10001:10001
EXPOSE 8200
ENTRYPOINT ["/usr/local/bin/go-api"]
