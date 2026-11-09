package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

var ErrStreamUnavailable = errors.New("ai stream backend unavailable")

type StreamEntry struct {
	ID        string
	Kind      string
	Data      []byte
	EventType string
}

type StreamSubscription interface {
	Next(context.Context) (StreamEntry, bool, error)
	Close() error
}

type StreamBackend interface {
	Begin(context.Context, int64) error
	Append(context.Context, int64, string, any) (string, error)
	End(context.Context, int64) error
	Subscribe(context.Context, int64, string) (StreamSubscription, error)
	Cancel(context.Context, int64) (bool, error)
	IsLive(context.Context, int64) (bool, error)
	Close() error
}

type MemoryStreamBackend struct {
	mu      sync.Mutex
	streams map[int64]*memoryStream
	closed  bool
}

type memoryStream struct {
	mu      sync.Mutex
	entries []StreamEntry
	live    bool
	nextID  int64
	notify  chan struct{}
}

func NewMemoryStreamBackend() *MemoryStreamBackend {
	return &MemoryStreamBackend{streams: make(map[int64]*memoryStream)}
}

func (backend *MemoryStreamBackend) Begin(_ context.Context, conversationID int64) error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.closed {
		return ErrStreamUnavailable
	}
	stream := &memoryStream{live: true, notify: make(chan struct{})}
	backend.streams[conversationID] = stream
	backend.appendLocked(stream, "begin", map[string]any{"type": "begin"})
	return nil
}

func (backend *MemoryStreamBackend) Append(
	_ context.Context,
	conversationID int64,
	kind string,
	payload any,
) (string, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	stream := backend.streams[conversationID]
	if stream == nil {
		return "", ErrStreamUnavailable
	}
	return backend.appendLocked(stream, kind, payload), nil
}

func (backend *MemoryStreamBackend) End(_ context.Context, conversationID int64) error {
	backend.mu.Lock()
	stream := backend.streams[conversationID]
	backend.mu.Unlock()
	if stream == nil {
		return nil
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.live {
		stream.live = false
	}
	backend.appendStreamLocked(stream, "end", map[string]any{"type": "end"})
	return nil
}

func (backend *MemoryStreamBackend) Subscribe(
	_ context.Context,
	conversationID int64,
	fromID string,
) (StreamSubscription, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	stream := backend.streams[conversationID]
	if stream == nil {
		return nil, ErrStreamUnavailable
	}
	return &memorySubscription{backend: backend, conversationID: conversationID, lastID: fromID}, nil
}

func (backend *MemoryStreamBackend) Cancel(_ context.Context, conversationID int64) (bool, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	stream := backend.streams[conversationID]
	if stream == nil {
		return false, nil
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if !stream.live {
		return false, nil
	}
	stream.live = false
	backend.signalLocked(stream)
	return true, nil
}

func (backend *MemoryStreamBackend) IsLive(_ context.Context, conversationID int64) (bool, error) {
	backend.mu.Lock()
	stream := backend.streams[conversationID]
	backend.mu.Unlock()
	if stream == nil {
		return false, nil
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	return stream.live, nil
}

func (backend *MemoryStreamBackend) Close() error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.closed = true
	for _, stream := range backend.streams {
		stream.mu.Lock()
		stream.live = false
		backend.signalLocked(stream)
		stream.mu.Unlock()
	}
	return nil
}

func (backend *MemoryStreamBackend) appendLocked(
	stream *memoryStream,
	kind string,
	payload any,
) string {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	return backend.appendStreamLocked(stream, kind, payload)
}

func (backend *MemoryStreamBackend) appendStreamLocked(
	stream *memoryStream,
	kind string,
	payload any,
) string {
	data, err := json.Marshal(payload)
	if err != nil {
		data = []byte("{}")
	}
	stream.nextID++
	id := fmt.Sprintf("%d-0", stream.nextID)
	eventType := kind
	var envelope struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &envelope) == nil && envelope.Type != "" {
		eventType = envelope.Type
	}
	stream.entries = append(stream.entries, StreamEntry{
		ID: id, Kind: kind, Data: data, EventType: eventType,
	})
	backend.signalLocked(stream)
	return id
}

func (backend *MemoryStreamBackend) signalLocked(stream *memoryStream) {
	close(stream.notify)
	stream.notify = make(chan struct{})
}

type memorySubscription struct {
	backend        *MemoryStreamBackend
	conversationID int64
	lastID         string
	closed         atomic.Bool
}

func (subscription *memorySubscription) Next(ctx context.Context) (StreamEntry, bool, error) {
	if subscription.closed.Load() {
		return StreamEntry{}, false, nil
	}
scan:
	for {
		subscription.backend.mu.Lock()
		stream := subscription.backend.streams[subscription.conversationID]
		closed := subscription.backend.closed
		subscription.backend.mu.Unlock()
		if stream == nil || closed {
			return StreamEntry{}, false, nil
		}
		stream.mu.Lock()
		for _, entry := range stream.entries {
			if compareStreamIDs(entry.ID, subscription.lastID) > 0 {
				subscription.lastID = entry.ID
				isEnd := entry.Kind == "end"
				stream.mu.Unlock()
				if isEnd {
					return StreamEntry{}, false, nil
				}
				if entry.Kind == "begin" {
					continue scan
				}
				return entry, true, nil
			}
		}
		notify := stream.notify
		stream.mu.Unlock()
		select {
		case <-ctx.Done():
			return StreamEntry{}, false, ctx.Err()
		case <-notify:
		}
	}
}

func (subscription *memorySubscription) Close() error {
	subscription.closed.Store(true)
	return nil
}

type RedisStreamBackend struct {
	client     *redis.Client
	prefix     string
	ttl        time.Duration
	maxLength  int64
	blockDelay time.Duration
}

func NewRedisStreamBackend(
	client *redis.Client,
	prefix string,
	ttlSeconds int,
	maxLength int,
) *RedisStreamBackend {
	if strings.TrimSpace(prefix) == "" {
		prefix = "ai:chat"
	}
	if ttlSeconds <= 0 {
		ttlSeconds = 86400
	}
	if maxLength <= 0 {
		maxLength = 10000
	}
	return &RedisStreamBackend{
		client:     client,
		prefix:     prefix,
		ttl:        time.Duration(ttlSeconds) * time.Second,
		maxLength:  int64(maxLength),
		blockDelay: 500 * time.Millisecond,
	}
}

func (backend *RedisStreamBackend) Begin(ctx context.Context, conversationID int64) error {
	if backend == nil || backend.client == nil {
		return ErrStreamUnavailable
	}
	key := backend.streamKey(conversationID)
	liveKey := backend.liveKey(conversationID)
	pipe := backend.client.TxPipeline()
	pipe.Del(ctx, key)
	pipe.Set(ctx, liveKey, "1", 0)
	pipe.XAdd(ctx, &redis.XAddArgs{
		Stream: key,
		MaxLen: backend.maxLength,
		Approx: true,
		Values: map[string]any{"type": "begin", "data": `{"type":"begin"}`},
	})
	_, err := pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrStreamUnavailable, err)
	}
	return nil
}

func (backend *RedisStreamBackend) Append(
	ctx context.Context,
	conversationID int64,
	kind string,
	payload any,
) (string, error) {
	if backend == nil || backend.client == nil {
		return "", ErrStreamUnavailable
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	id, err := backend.client.XAdd(ctx, &redis.XAddArgs{
		Stream: backend.streamKey(conversationID),
		MaxLen: backend.maxLength,
		Approx: true,
		Values: map[string]any{"type": kind, "data": string(data)},
	}).Result()
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrStreamUnavailable, err)
	}
	return id, nil
}

func (backend *RedisStreamBackend) End(ctx context.Context, conversationID int64) error {
	if backend == nil || backend.client == nil {
		return ErrStreamUnavailable
	}
	key := backend.streamKey(conversationID)
	pipe := backend.client.TxPipeline()
	pipe.XAdd(ctx, &redis.XAddArgs{
		Stream: key,
		MaxLen: backend.maxLength,
		Approx: true,
		Values: map[string]any{"type": "end", "data": `{"type":"end"}`},
	})
	pipe.Del(ctx, backend.liveKey(conversationID))
	pipe.Expire(ctx, key, backend.ttl)
	_, err := pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrStreamUnavailable, err)
	}
	return nil
}

func (backend *RedisStreamBackend) Subscribe(
	ctx context.Context,
	conversationID int64,
	fromID string,
) (StreamSubscription, error) {
	if backend == nil || backend.client == nil {
		return nil, ErrStreamUnavailable
	}
	if fromID == "" {
		fromID = "0"
	}
	if err := backend.client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStreamUnavailable, err)
	}
	return &redisSubscription{
		backend:        backend,
		conversationID: conversationID,
		lastID:         fromID,
	}, nil
}

func (backend *RedisStreamBackend) Cancel(ctx context.Context, conversationID int64) (bool, error) {
	if backend == nil || backend.client == nil {
		return false, ErrStreamUnavailable
	}
	result, err := backend.client.GetDel(ctx, backend.liveKey(conversationID)).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrStreamUnavailable, err)
	}
	return result != "", nil
}

func (backend *RedisStreamBackend) IsLive(ctx context.Context, conversationID int64) (bool, error) {
	if backend == nil || backend.client == nil {
		return false, ErrStreamUnavailable
	}
	count, err := backend.client.Exists(ctx, backend.liveKey(conversationID)).Result()
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrStreamUnavailable, err)
	}
	return count > 0, nil
}

func (backend *RedisStreamBackend) Close() error {
	if backend == nil || backend.client == nil {
		return nil
	}
	return backend.client.Close()
}

func (backend *RedisStreamBackend) streamKey(conversationID int64) string {
	return backend.prefix + ":" + strconv.FormatInt(conversationID, 10)
}

func (backend *RedisStreamBackend) liveKey(conversationID int64) string {
	return backend.streamKey(conversationID) + ":live"
}

type redisSubscription struct {
	backend        *RedisStreamBackend
	conversationID int64
	lastID         string
	draining       bool
	drainDeadline  time.Time
	closed         atomic.Bool
}

func (subscription *redisSubscription) Next(ctx context.Context) (StreamEntry, bool, error) {
	if subscription.closed.Load() {
		return StreamEntry{}, false, nil
	}
	for {
		result, err := subscription.backend.client.XRead(ctx, &redis.XReadArgs{
			Streams: []string{subscription.backend.streamKey(subscription.conversationID), subscription.lastID},
			Block:   subscription.backend.blockDelay,
			Count:   10,
		}).Result()
		if err != nil && !errors.Is(err, redis.Nil) {
			return StreamEntry{}, false, err
		}
		if len(result) > 0 {
			for _, stream := range result {
				for _, message := range stream.Messages {
					if compareStreamIDs(message.ID, subscription.lastID) <= 0 {
						continue
					}
					subscription.lastID = message.ID
					entry, stop, err := decodeRedisMessage(message)
					if err != nil {
						return StreamEntry{}, false, err
					}
					if stop {
						return StreamEntry{}, false, nil
					}
					if entry.Kind == "begin" {
						continue
					}
					return entry, true, nil
				}
			}
		}
		live, err := subscription.backend.IsLive(ctx, subscription.conversationID)
		if err != nil {
			return StreamEntry{}, false, err
		}
		if !live {
			if subscription.draining && time.Now().After(subscription.drainDeadline) {
				return StreamEntry{}, false, nil
			}
			if !subscription.draining {
				subscription.draining = true
				subscription.drainDeadline = time.Now().Add(2 * time.Second)
			}
			messages, err := subscription.backend.client.XRange(
				ctx,
				subscription.backend.streamKey(subscription.conversationID),
				subscription.lastID,
				"+",
			).Result()
			if err != nil && !errors.Is(err, redis.Nil) {
				return StreamEntry{}, false, err
			}
			for _, message := range messages {
				if compareStreamIDs(message.ID, subscription.lastID) <= 0 {
					continue
				}
				subscription.lastID = message.ID
				entry, stop, err := decodeRedisMessage(message)
				if err != nil {
					return StreamEntry{}, false, err
				}
				if stop {
					return StreamEntry{}, false, nil
				}
				if entry.Kind == "begin" {
					continue
				}
				return entry, true, nil
			}
			continue
		}
		select {
		case <-ctx.Done():
			return StreamEntry{}, false, ctx.Err()
		default:
		}
	}
}

func (subscription *redisSubscription) Close() error {
	subscription.closed.Store(true)
	return nil
}

func decodeRedisMessage(message redis.XMessage) (StreamEntry, bool, error) {
	kind := fmt.Sprint(message.Values["type"])
	data := fmt.Sprint(message.Values["data"])
	if kind == "<nil>" {
		kind = ""
	}
	if data == "<nil>" {
		data = ""
	}
	if kind == "end" {
		return StreamEntry{}, true, nil
	}
	eventType := kind
	var envelope struct {
		Type string `json:"type"`
	}
	if json.Unmarshal([]byte(data), &envelope) == nil && envelope.Type != "" {
		eventType = envelope.Type
	}
	return StreamEntry{
		ID: message.ID, Kind: kind, Data: []byte(data), EventType: eventType,
	}, false, nil
}

func compareStreamIDs(left, right string) int {
	leftMajor, leftMinor, leftOK := parseStreamID(left)
	rightMajor, rightMinor, rightOK := parseStreamID(right)
	if !leftOK || !rightOK {
		return strings.Compare(left, right)
	}
	if leftMajor < rightMajor || (leftMajor == rightMajor && leftMinor < rightMinor) {
		return -1
	}
	if leftMajor == rightMajor && leftMinor == rightMinor {
		return 0
	}
	return 1
}

func parseStreamID(value string) (int64, int64, bool) {
	majorText, minorText, found := strings.Cut(value, "-")
	if !found {
		minorText = "0"
	}
	major, err := strconv.ParseInt(majorText, 10, 64)
	if err != nil {
		return 0, 0, false
	}
	minor, err := strconv.ParseInt(minorText, 10, 64)
	if err != nil {
		return 0, 0, false
	}
	return major, minor, true
}
