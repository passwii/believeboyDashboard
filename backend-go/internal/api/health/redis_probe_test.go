package health

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestRedisStatusProbeReportsLatencyAndMemory(t *testing.T) {
	client := &fakeRedisClient{
		memory: map[string]any{
			"used_memory_human": "4.25M",
		},
	}
	times := []time.Time{
		time.Unix(0, 0),
		time.Unix(0, int64(2*time.Millisecond)),
	}
	probe := NewRedisProbe(client, func() time.Time {
		if len(times) == 0 {
			return time.Unix(0, 0)
		}
		next := times[0]
		times = times[1:]
		return next
	})

	status, memory := probe.Probe(context.Background())

	if err := probe.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if status != "ok (2.0ms)" {
		t.Errorf("status = %q, want ok (2.0ms)", status)
	}
	if memory == nil || *memory != "4.25M" {
		t.Errorf("memory = %#v, want 4.25M", memory)
	}
	if client.pingCalls != 1 || client.infoCalls != 1 {
		t.Errorf("calls = ping %d/info %d, want 1/1", client.pingCalls, client.infoCalls)
	}
}

func TestRedisStatusProbeReportsMemoryUnavailable(t *testing.T) {
	client := &fakeRedisClient{memoryErr: errors.New("INFO denied")}
	probe := NewRedisProbe(client, nil)

	status, memory := probe.Probe(context.Background())

	if status != "ok (0.0ms)" {
		t.Errorf("status = %q, want successful ping status", status)
	}
	if memory == nil || *memory != "unavailable" {
		t.Errorf("memory = %#v, want unavailable", memory)
	}
}

func TestRedisStatusProbeReturnsErrorTypeOnly(t *testing.T) {
	client := &fakeRedisClient{pingErr: errors.New("secret host detail: password=bad")}
	probe := NewRedisProbe(client, nil)

	status, memory := probe.Probe(context.Background())

	if status != "error: *errors.errorString" {
		t.Errorf("status = %q, want type-only error", status)
	}
	if memory != nil {
		t.Errorf("memory = %#v, want nil on ping failure", memory)
	}
}

func TestNewRedisProbeClientSetsShortTimeouts(t *testing.T) {
	client := NewRedisClient("redis://cache.example.com:6380/2")
	if client == nil {
		t.Fatal("NewRedisClient() = nil, want client")
	}
	if client.Options().DialTimeout > 2*time.Second ||
		client.Options().ReadTimeout > 2*time.Second ||
		client.Options().WriteTimeout > 2*time.Second {
		t.Errorf("timeouts = %#v, want <= 2s", client.Options())
	}
	_ = client.Close()
}

type fakeRedisClient struct {
	pingErr   error
	memoryErr error
	memory    map[string]any
	pingDelay time.Duration
	pingCalls int
	infoCalls int
}

func (c *fakeRedisClient) Ping(context.Context) *redis.StatusCmd {
	c.pingCalls++
	cmd := redis.NewStatusCmd(context.Background())
	if c.pingErr != nil {
		cmd.SetErr(c.pingErr)
	} else {
		cmd.SetVal("PONG")
	}
	return cmd
}

func (c *fakeRedisClient) Info(context.Context, ...string) *redis.StringCmd {
	c.infoCalls++
	cmd := redis.NewStringCmd(context.Background())
	if c.memoryErr != nil {
		cmd.SetErr(c.memoryErr)
		return cmd
	}
	cmd.SetVal("used_memory_human:" + c.memory["used_memory_human"].(string) + "\r\n")
	return cmd
}

func (c *fakeRedisClient) Close() error {
	return nil
}
