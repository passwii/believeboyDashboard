package scheduler

import (
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestRedisLockerIntegration(t *testing.T) {
	redisURL := os.Getenv("SCHEDULER_REDIS_TEST_URL")
	if redisURL == "" {
		t.Skip("SCHEDULER_REDIS_TEST_URL is not set")
	}
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatalf("parse redis URL: %v", err)
	}
	client := redis.NewClient(options)
	t.Cleanup(func() {
		_ = client.Close()
	})

	prefix := "scheduler:test:" + t.Name() + ":"
	locker := NewRedisLocker(client, prefix)
	key := "dedupe"

	acquired, releaseFirst, err := locker.TryLock(t.Context(), key, time.Second)
	if err != nil {
		t.Fatalf("first TryLock() error = %v", err)
	}
	if !acquired {
		t.Fatal("first TryLock() = false, want true")
	}

	acquired, _, err = locker.TryLock(t.Context(), key, time.Second)
	if err != nil {
		t.Fatalf("contended TryLock() error = %v", err)
	}
	if acquired {
		t.Fatal("contended TryLock() = true, want false")
	}
	releaseFirst()

	acquired, releaseSecond, err := locker.TryLock(t.Context(), key, time.Second)
	if err != nil {
		t.Fatalf("TryLock() after release error = %v", err)
	}
	if !acquired {
		t.Fatal("TryLock() after release = false, want true")
	}
	releaseFirst()

	acquired, _, err = locker.TryLock(t.Context(), key, time.Second)
	if err != nil {
		t.Fatalf("TryLock() after stale release error = %v", err)
	}
	if acquired {
		t.Fatal("stale release removed the new Redis lock")
	}
	releaseSecond()
}
