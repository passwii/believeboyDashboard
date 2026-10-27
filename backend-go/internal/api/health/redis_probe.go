package health

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type redisClient interface {
	Ping(ctx context.Context) *redis.StatusCmd
	Info(ctx context.Context, sections ...string) *redis.StringCmd
	Close() error
}

type RedisProbe struct {
	client redisClient
	now    func() time.Time
}

func NewRedisProbe(client redisClient, now func() time.Time) *RedisProbe {
	if now == nil {
		now = time.Now
	}
	return &RedisProbe{client: client, now: now}
}

// NewRedisClient configures a fail-fast, non-shared client for health checks.
func NewRedisClient(redisURL string) *redis.Client {
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil
	}
	options.DialTimeout = 2 * time.Second
	options.ReadTimeout = 2 * time.Second
	options.WriteTimeout = 2 * time.Second
	options.MaxRetries = 0
	return redis.NewClient(options)
}

func (p *RedisProbe) Probe(ctx context.Context) (string, *string) {
	startedAt := p.now()
	if err := p.client.Ping(ctx).Err(); err != nil {
		return "error: " + fmt.Sprintf("%T", err), nil
	}
	latency := p.now().Sub(startedAt)
	status := fmt.Sprintf("ok (%.1fms)", float64(latency)/float64(time.Millisecond))

	memoryInfo, err := p.client.Info(ctx, "memory").Result()
	if err != nil {
		unavailable := "unavailable"
		return status, &unavailable
	}
	memory := "unknown"
	for _, line := range splitLines(memoryInfo) {
		line = trimWhitespace(line)
		if key, value, ok := splitInfoLine(line); ok && key == "used_memory_human" {
			memory = value
			break
		}
	}
	return status, &memory
}

func (p *RedisProbe) Close() error {
	return p.client.Close()
}

func splitLines(value string) []string {
	lines := make([]string, 0)
	start := 0
	for i, char := range value {
		if char == '\n' {
			lines = append(lines, value[start:i])
			start = i + 1
		}
	}
	lines = append(lines, value[start:])
	return lines
}

func splitInfoLine(line string) (string, string, bool) {
	for i, char := range line {
		if char == ':' {
			return line[:i], line[i+1:], true
		}
	}
	return "", "", false
}

func trimWhitespace(value string) string {
	start := 0
	end := len(value)
	for start < end && isWhitespace(value[start]) {
		start++
	}
	for end > start && isWhitespace(value[end-1]) {
		end--
	}
	return value[start:end]
}

func isWhitespace(char byte) bool {
	return char == ' ' || char == '\t' || char == '\r' || char == '\n'
}
