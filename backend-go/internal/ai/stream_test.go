package ai

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestMemoryStreamBackendSupportsReplayCancelAndEnd(t *testing.T) {
	backend := NewMemoryStreamBackend()
	defer backend.Close()
	ctx := context.Background()

	if err := backend.Begin(ctx, 7); err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	firstID, err := backend.Append(ctx, 7, "event", map[string]any{
		"type":  "message_start",
		"model": "model-a",
	})
	if err != nil {
		t.Fatalf("Append(first) error = %v", err)
	}
	secondID, err := backend.Append(ctx, 7, "event", map[string]any{
		"type": "content_block_delta",
	})
	if err != nil {
		t.Fatalf("Append(second) error = %v", err)
	}

	sub, err := backend.Subscribe(ctx, 7, "0")
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer sub.Close()

	entry, ok, err := sub.Next(ctx)
	if err != nil || !ok {
		t.Fatalf("Next(first) = (%#v, %t, %v)", entry, ok, err)
	}
	if entry.ID != firstID || entry.Kind != "event" {
		t.Errorf("first entry = %#v", entry)
	}
	var payload map[string]any
	if err := json.Unmarshal(entry.Data, &payload); err != nil {
		t.Fatalf("decode first payload: %v", err)
	}
	if payload["type"] != "message_start" {
		t.Errorf("payload = %#v", payload)
	}

	entry, ok, err = sub.Next(ctx)
	if err != nil || !ok {
		t.Fatalf("Next(second) = (%#v, %t, %v)", entry, ok, err)
	}
	if entry.ID != secondID {
		t.Errorf("second id = %q, want %q", entry.ID, secondID)
	}

	resume, err := backend.Subscribe(ctx, 7, firstID)
	if err != nil {
		t.Fatalf("resume Subscribe() error = %v", err)
	}
	defer resume.Close()
	entry, ok, err = resume.Next(ctx)
	if err != nil || !ok || entry.ID != secondID {
		t.Fatalf("resume first = (%#v, %t, %v), want %q", entry, ok, err, secondID)
	}

	cancelled, err := backend.Cancel(ctx, 7)
	if err != nil || !cancelled {
		t.Fatalf("Cancel() = (%t, %v), want true", cancelled, err)
	}
	live, err := backend.IsLive(ctx, 7)
	if err != nil || live {
		t.Fatalf("IsLive() = (%t, %v), want false", live, err)
	}
	_, _ = backend.Append(ctx, 7, "done", map[string]any{"type": "done"})
	if err := backend.End(ctx, 7); err != nil {
		t.Fatalf("End() error = %v", err)
	}
}

func TestRedisStreamBackendIntegration(t *testing.T) {
	redisURL := os.Getenv("AI_CHAT_TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("set AI_CHAT_TEST_REDIS_URL for Redis Stream integration coverage")
	}
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatalf("redis.ParseURL() error = %v", err)
	}
	client := redis.NewClient(options)
	defer client.Close()
	ctx := context.Background()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Skipf("Redis unavailable: %v", err)
	}
	prefix := "ai-chat-test:" + strconv.FormatInt(time.Now().UnixNano(), 10)
	const conversationID = int64(7)
	backend := NewRedisStreamBackend(client, prefix, 60, 100)
	t.Cleanup(func() {
		_ = client.Del(context.Background(), prefix+":7", prefix+":7:live").Err()
	})
	if err := backend.Begin(ctx, conversationID); err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	firstID, err := backend.Append(ctx, conversationID, "event", NewMessageStart("message-1", "model-a", 1))
	if err != nil {
		t.Fatalf("Append(first) error = %v", err)
	}
	_, _ = backend.Append(ctx, conversationID, "event", NewContentBlockDeltaText(0, "hello"))
	cancelled, err := backend.Cancel(ctx, conversationID)
	if err != nil || !cancelled {
		t.Fatalf("Cancel() = (%t, %v)", cancelled, err)
	}
	_, _ = backend.Append(ctx, conversationID, "event", NewMessageStop())
	if err := backend.End(ctx, conversationID); err != nil {
		t.Fatalf("End() error = %v", err)
	}

	subscription, err := backend.Subscribe(ctx, conversationID, "0")
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer subscription.Close()
	entry, ok, err := subscription.Next(ctx)
	if err != nil || !ok || entry.ID != firstID {
		t.Fatalf("first Next() = (%#v, %t, %v), want %s", entry, ok, err, firstID)
	}
	entry, ok, err = subscription.Next(ctx)
	if err != nil || !ok {
		t.Fatalf("second Next() = (%#v, %t, %v)", entry, ok, err)
	}
	var payload struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(entry.Data, &payload); err != nil || payload.Type != "content_block_delta" {
		t.Errorf("second payload = %s, %v", entry.Data, err)
	}
	entry, ok, err = subscription.Next(ctx)
	if err != nil || !ok || entry.EventType != "message_stop" {
		t.Fatalf("message_stop = (%#v, %t, %v)", entry, ok, err)
	}
	_, ok, err = subscription.Next(ctx)
	if err != nil || ok {
		t.Fatalf("Next(after end) = (%t, %v)", ok, err)
	}
}
