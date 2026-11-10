package health

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Pinger interface {
	Ping(ctx context.Context) error
}

type Probe interface {
	Probe(ctx context.Context) string
}

type RedisHealthProbe interface {
	Probe(ctx context.Context) (string, *string)
}

type HandlerConfig struct {
	Database   Pinger
	Replica    Probe
	Redis      RedisHealthProbe
	Version    string
	ReplicaURL string
	Now        func() time.Time
}

type Handler struct {
	config HandlerConfig
}

type healthResponse struct {
	Status          string  `json:"status"`
	Timestamp       float64 `json:"timestamp"`
	Database        string  `json:"database"`
	DatabaseReplica string  `json:"database_replica"`
	Redis           string  `json:"redis"`
	RedisMemory     *string `json:"redis_memory"`
	Version         *string `json:"version"`
}

type probeResponse struct {
	Status    string  `json:"status"`
	Timestamp float64 `json:"timestamp"`
}

func NewHandler(config HandlerConfig) *Handler {
	if config.Now == nil {
		config.Now = time.Now
	}
	return &Handler{config: config}
}

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	now := h.now()
	database := h.probeDatabase(r.Context())
	replica := h.probeReplica(r.Context())
	redisStatus, redisMemory := h.probeRedis(r.Context())

	status := "ok"
	if database != "ok" ||
		hasPrefix(replica, "degraded") ||
		hasPrefix(replica, "error") {
		status = "degraded"
	}

	response := healthResponse{
		Status:          status,
		Timestamp:       timestamp(now),
		Database:        database,
		DatabaseReplica: replica,
		Redis:           redisStatus,
		RedisMemory:     redisMemory,
		Version:         versionValue(h.config.Version),
	}
	if err := httpapi.WriteJSON(w, http.StatusOK, response); err != nil {
		writeInternalError(w)
	}
}

func (h *Handler) HealthLive(w http.ResponseWriter, r *http.Request) {
	_ = httpapi.WriteJSON(w, http.StatusOK, probeResponse{
		Status:    "ok",
		Timestamp: timestamp(h.now()),
	})
}

func (h *Handler) HealthReady(w http.ResponseWriter, r *http.Request) {
	if h.config.Database == nil || h.config.Database.Ping(r.Context()) != nil {
		_ = httpapi.WriteJSON(w, http.StatusServiceUnavailable, probeResponse{
			Status:    "unavailable",
			Timestamp: timestamp(h.now()),
		})
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, probeResponse{
		Status:    "ok",
		Timestamp: timestamp(h.now()),
	})
}

func (h *Handler) probeDatabase(ctx context.Context) string {
	if h.config.Database == nil {
		return "error: DatabaseNotConfigured"
	}
	if err := h.config.Database.Ping(ctx); err != nil {
		// Keep the HTTP body free of driver details (contract test pins the
		// typed form) but make the cause visible in container logs: the
		// 2026-11-10 incident only exposed "error: *fmt.wrapError" and the
		// real message ("load PostgreSQL TimeZone ...") was unobservable.
		slog.WarnContext(ctx, "health: database probe failed", slog.Any("error", err))
		return "error: " + fmt.Sprintf("%T", err)
	}
	return "ok"
}

func (h *Handler) probeReplica(ctx context.Context) string {
	if h.config.ReplicaURL == "" {
		return "not configured"
	}
	if h.config.Replica == nil {
		return "error: ProbeNotConfigured"
	}
	return h.config.Replica.Probe(ctx)
}

func (h *Handler) probeRedis(ctx context.Context) (string, *string) {
	if h.config.Redis == nil {
		return "not configured", nil
	}
	return h.config.Redis.Probe(ctx)
}

func (h *Handler) now() time.Time {
	return h.config.Now()
}

func timestamp(value time.Time) float64 {
	return float64(value.UnixNano()) / float64(time.Second)
}

func versionValue(value string) *string {
	if value == "" {
		return nil
	}
	version := value
	return &version
}

func hasPrefix(value, prefix string) bool {
	return len(value) >= len(prefix) && value[:len(prefix)] == prefix
}

func writeInternalError(w http.ResponseWriter) {
	httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
}
