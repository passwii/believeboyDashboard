package insight_runs

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisEventStore struct {
	client *redis.Client
	prefix string
	ttl    time.Duration
	maxLen int64
}

func NewRedisEventStore(client *redis.Client, prefix string, ttl time.Duration, maxLen int64) *RedisEventStore {
	if strings.TrimSpace(prefix) == "" {
		prefix = "bb:insight"
	}
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	if maxLen <= 0 {
		maxLen = 10000
	}
	return &RedisEventStore{client: client, prefix: prefix, ttl: ttl, maxLen: maxLen}
}

func (store *RedisEventStore) streamKey(runID string) string {
	return store.prefix + ":run:" + runID + ":events"
}

func (store *RedisEventStore) seqKey(runID string) string {
	return store.prefix + ":run:" + runID + ":seq"
}

func (store *RedisEventStore) Available(ctx context.Context) error {
	if store == nil || store.client == nil {
		return ErrStreamUnavailable
	}
	if err := store.client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("%w: %v", ErrStreamUnavailable, err)
	}
	return nil
}

func (store *RedisEventStore) Append(ctx context.Context, runID string, event Event) (Event, error) {
	if store == nil || store.client == nil {
		return Event{}, ErrStreamUnavailable
	}
	seq, err := store.client.Incr(ctx, store.seqKey(runID)).Result()
	if err != nil {
		return Event{}, fmt.Errorf("%w: allocate sequence: %v", ErrStreamUnavailable, err)
	}
	event.SchemaVersion = 1
	event.RunID = runID
	event.Seq = int(seq)
	raw, err := json.Marshal(event)
	if err != nil {
		return Event{}, fmt.Errorf("marshal insight event: %w", err)
	}
	args := &redis.XAddArgs{
		Stream: store.streamKey(runID),
		MaxLen: store.maxLen,
		Approx: true,
		Values: []string{
			"event", string(raw),
			"attempt", fmt.Sprint(event.Attempt),
			"seq", fmt.Sprint(event.Seq),
		},
	}
	if err := store.client.XAdd(ctx, args).Err(); err != nil {
		return Event{}, fmt.Errorf("%w: append event: %v", ErrStreamUnavailable, err)
	}
	pipe := store.client.Pipeline()
	pipe.Expire(ctx, store.streamKey(runID), store.ttl)
	pipe.Expire(ctx, store.seqKey(runID), store.ttl)
	_, _ = pipe.Exec(ctx)
	return event, nil
}

func (store *RedisEventStore) ReadAfter(ctx context.Context, runID string, cursor *Cursor) ([]Event, error) {
	if store == nil || store.client == nil {
		return nil, ErrStreamUnavailable
	}
	entries, err := store.client.XRange(ctx, store.streamKey(runID), "-", "+").Result()
	if err != nil {
		return nil, fmt.Errorf("%w: read events: %v", ErrStreamUnavailable, err)
	}
	events := make([]Event, 0, len(entries))
	for _, entry := range entries {
		raw, ok := entry.Values["event"]
		if !ok {
			continue
		}
		var event Event
		if err := json.Unmarshal([]byte(fmt.Sprint(raw)), &event); err != nil {
			continue
		}
		if cursor != nil {
			if event.RunID != cursor.RunID {
				continue
			}
			if event.Attempt < cursor.Attempt {
				continue
			}
			if event.Attempt == cursor.Attempt && event.Seq <= cursor.Seq {
				continue
			}
		}
		events = append(events, event)
	}
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].Attempt == events[j].Attempt {
			return events[i].Seq < events[j].Seq
		}
		return events[i].Attempt < events[j].Attempt
	})
	return events, nil
}

func (store *RedisEventStore) Reset(ctx context.Context, runID string) error {
	if store == nil || store.client == nil {
		return ErrStreamUnavailable
	}
	if err := store.client.Del(ctx, store.streamKey(runID), store.seqKey(runID)).Err(); err != nil {
		return fmt.Errorf("reset insight stream: %w", err)
	}
	return nil
}
