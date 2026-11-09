package system_management

import (
	"context"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
)

type redisCacheClient interface {
	Scan(ctx context.Context, cursor uint64, match string, count int64) *redis.ScanCmd
	Del(ctx context.Context, keys ...string) *redis.IntCmd
}

type RedisCacheClearer struct {
	client redisCacheClient
	prefix string
}

func NewRedisCacheClearer(client redisCacheClient, keyPrefix string) CacheClearer {
	if client == nil {
		return nil
	}
	prefix := strings.TrimSpace(keyPrefix)
	if prefix == "" {
		prefix = "bb"
	}
	return &RedisCacheClearer{client: client, prefix: prefix}
}

func (c *RedisCacheClearer) ClearAll(ctx context.Context) (int, error) {
	if c == nil || c.client == nil {
		return 0, fmt.Errorf("redis cache client is nil")
	}
	// Keep this aligned with the FastAPI cache registry. Never fall back to a
	// global FLUSHDB/KEYS operation or an unbounded pattern.
	prefixes := []string{
		"cache",
		"shipment-schedules",
		"data_management",
		"product_analysis",
		"presence",
		"session",
		"ratelimit",
		"semaphore",
		"office",
	}
	total := 0
	for _, suffix := range prefixes {
		fullPrefix := c.prefix + ":" + suffix
		deleted, err := c.deletePattern(ctx, fullPrefix+":*")
		if err != nil {
			return total, err
		}
		total += deleted
	}
	return total, nil
}

func (c *RedisCacheClearer) deletePattern(ctx context.Context, pattern string) (int, error) {
	var cursor uint64
	deleted := 0
	for {
		keys, next, err := c.client.Scan(ctx, cursor, pattern, 1000).Result()
		if err != nil {
			return deleted, err
		}
		if len(keys) > 0 {
			count, err := c.client.Del(ctx, keys...).Result()
			if err != nil {
				return deleted, err
			}
			deleted += int(count)
		}
		cursor = next
		if cursor == 0 {
			return deleted, nil
		}
	}
}
