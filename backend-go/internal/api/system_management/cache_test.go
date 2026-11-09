package system_management

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

type stage8BCacheClient struct {
	patterns []string
}

func TestSystemTimestampUsesSecondPrecisionAndOffset(t *testing.T) {
	location := time.FixedZone("CST", 8*60*60)
	value := time.Date(2026, 11, 8, 12, 13, 14, 987654321, location)
	previous := time.Local
	time.Local = location
	t.Cleanup(func() { time.Local = previous })
	if got := systemTimestamp(value); got != "2026-11-08T12:13:14+08:00" {
		t.Fatalf("systemTimestamp() = %q", got)
	}
}

func (c *stage8BCacheClient) Scan(
	_ context.Context,
	cursor uint64,
	match string,
	_ int64,
) *redis.ScanCmd {
	c.patterns = append(c.patterns, match)
	if match == "bb:cache:*" {
		return redis.NewScanCmdResult([]string{"bb:cache:one"}, 0, nil)
	}
	return redis.NewScanCmdResult(nil, 0, nil)
}

func (c *stage8BCacheClient) Del(_ context.Context, keys ...string) *redis.IntCmd {
	command := redis.NewIntCmd(context.Background())
	command.SetVal(int64(len(keys)))
	return command
}

func TestRedisCacheClearerUsesOnlyKnownPrefixes(t *testing.T) {
	client := &stage8BCacheClient{}
	clearer := NewRedisCacheClearer(client, "bb")
	deleted, err := clearer.ClearAll(context.Background())
	if err != nil {
		t.Fatalf("ClearAll() error = %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}
	if len(client.patterns) != 9 {
		t.Fatalf("patterns = %#v, want nine whitelisted prefixes", client.patterns)
	}
	for _, pattern := range client.patterns {
		if pattern == "*" || pattern == "bb:*" {
			t.Fatalf("global cache deletion pattern %q is forbidden", pattern)
		}
	}
}
