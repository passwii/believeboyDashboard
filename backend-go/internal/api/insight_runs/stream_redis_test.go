package insight_runs

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRedisEventStoreDefaultsAndFailClosed(t *testing.T) {
	store := NewRedisEventStore(nil, "", 0, 0)
	if store.ttl != 24*time.Hour || store.maxLen != 10000 {
		t.Fatalf("defaults ttl=%v maxLen=%d", store.ttl, store.maxLen)
	}
	if store.streamKey("run-1") != "bb:insight:run:run-1:events" {
		t.Fatalf("stream key = %q", store.streamKey("run-1"))
	}
	if !errors.Is(store.Available(context.Background()), ErrStreamUnavailable) {
		t.Fatalf("Available() did not fail closed")
	}
	if _, err := store.Append(context.Background(), "run-1", Event{Type: "ping"}); !errors.Is(err, ErrStreamUnavailable) {
		t.Fatalf("Append() error = %v", err)
	}
	if _, err := store.ReadAfter(context.Background(), "run-1", nil); !errors.Is(err, ErrStreamUnavailable) {
		t.Fatalf("ReadAfter() error = %v", err)
	}
	if err := store.Reset(context.Background(), "run-1"); !errors.Is(err, ErrStreamUnavailable) {
		t.Fatalf("Reset() error = %v", err)
	}
}
