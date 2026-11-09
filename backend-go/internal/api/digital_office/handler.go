package digital_office

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	"github.com/redis/go-redis/v9"
)

const (
	officeSnapshotKeySuffix = "office:wall_snapshot"
	officeChatterKeySuffix  = "office:chatter_events"
	defaultTickInterval     = 3 * time.Second
	defaultRedisPrefix      = "bb"
)

type Cache interface {
	Get(ctx context.Context, key string) (string, error)
	LRange(ctx context.Context, key string, start, stop int64) ([]string, error)
}

type RedisCache struct {
	client redis.Cmdable
}

func NewRedisCache(client redis.Cmdable) Cache {
	return &RedisCache{client: client}
}

func (cache *RedisCache) Get(ctx context.Context, key string) (string, error) {
	if cache == nil || cache.client == nil {
		return "", errors.New("redis cache is not configured")
	}
	value, err := cache.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	return value, err
}

func (cache *RedisCache) LRange(
	ctx context.Context,
	key string,
	start, stop int64,
) ([]string, error) {
	if cache == nil || cache.client == nil {
		return nil, errors.New("redis cache is not configured")
	}
	return cache.client.LRange(ctx, key, start, stop).Result()
}

type Handler struct {
	store        Store
	cache        Cache
	redisPrefix  string
	tickInterval time.Duration
	now          func() time.Time
}

type Option func(*Handler)

func WithCache(cache Cache) Option {
	return func(handler *Handler) {
		handler.cache = cache
	}
}

func WithRedisPrefix(prefix string) Option {
	return func(handler *Handler) {
		handler.redisPrefix = prefix
	}
}

func WithTickInterval(interval time.Duration) Option {
	return func(handler *Handler) {
		if interval > 0 {
			handler.tickInterval = interval
		}
	}
}

func WithNow(now func() time.Time) Option {
	return func(handler *Handler) {
		if now != nil {
			handler.now = now
		}
	}
}

func NewHandler(store Store, options ...Option) *Handler {
	handler := &Handler{
		store:        store,
		redisPrefix:  defaultRedisPrefix,
		tickInterval: defaultTickInterval,
		now:          time.Now,
	}
	for _, option := range options {
		option(handler)
	}
	return handler
}

func (h *Handler) OfficeStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	if r.Context().Err() != nil {
		return
	}
	if !h.writeTick(w, r.Context(), flusher) {
		return
	}
	ticker := time.NewTicker(h.tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !h.writeTick(w, r.Context(), flusher) {
				return
			}
		}
	}
}

func (h *Handler) writeTick(
	w http.ResponseWriter,
	ctx context.Context,
	flusher http.Flusher,
) bool {
	snapshotJSON, chatterJSON, err := h.buildTick(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return false
		}
		if _, writeErr := fmt.Fprint(w, ": tick-error\n\n"); writeErr != nil {
			return false
		}
	} else {
		if _, writeErr := fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", snapshotJSON); writeErr != nil {
			return false
		}
		for _, event := range chatterJSON {
			if _, writeErr := fmt.Fprintf(w, "event: chatter\ndata: %s\n\n", event); writeErr != nil {
				return false
			}
		}
	}
	if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

func (h *Handler) buildTick(ctx context.Context) (string, []string, error) {
	now := h.now().UTC()
	if h.cache != nil {
		snapshotKey := h.redisKey(officeSnapshotKeySuffix)
		snapshot, err := h.cache.Get(ctx, snapshotKey)
		if err == nil && snapshot != "" {
			chatter, chatterErr := h.cache.LRange(
				ctx,
				h.redisKey(officeChatterKeySuffix),
				0,
				9,
			)
			if chatterErr == nil {
				return snapshot, chatter, nil
			}
		}
	}
	if h.store == nil {
		return "", nil, errors.New("digital office store is not configured")
	}
	employees, chatter, err := h.store.BuildWallSnapshot(ctx, now)
	if err != nil {
		return "", nil, err
	}
	if employees == nil {
		employees = []EmployeeSnapshot{}
	}
	snapshot, err := json.Marshal(WallSnapshot{
		ServerTime: PythonISO(now),
		Employees:  employees,
	})
	if err != nil {
		return "", nil, err
	}
	chatterJSON := make([]string, 0, len(chatter))
	for _, event := range chatter {
		payload, err := json.Marshal(event)
		if err != nil {
			return "", nil, err
		}
		chatterJSON = append(chatterJSON, string(payload))
	}
	return string(snapshot), chatterJSON, nil
}

func (h *Handler) redisKey(suffix string) string {
	return h.redisPrefix + ":" + suffix
}
