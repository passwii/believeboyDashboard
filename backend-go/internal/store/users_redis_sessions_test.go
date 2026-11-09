package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestRedisSessionRevokerScansExactUserSessionPattern(t *testing.T) {
	client := &stage10CSessionRedisClient{
		pages: []stage10CSessionScanPage{
			{keys: []string{"bb:session:user-123:one"}, next: 9},
			{keys: []string{"bb:session:user-123:two"}, next: 0},
		},
	}
	revoker := NewRedisSessionRevoker(client, "bb")

	revoked, err := revoker.DeleteUserSessions(context.Background(), "user-*")
	if err != nil {
		t.Fatalf("DeleteUserSessions() error = %v", err)
	}
	if revoked != 2 {
		t.Errorf("revoked = %d, want 2", revoked)
	}
	if len(client.patterns) != 2 {
		t.Fatalf("patterns = %#v, want two scan calls", client.patterns)
	}
	for _, pattern := range client.patterns {
		if pattern != `bb:session:user-\*:*` {
			t.Errorf("pattern = %q, want escaped exact user prefix", pattern)
		}
	}
	if len(client.deletedPages) != 2 {
		t.Errorf("deleted pages = %#v, want keys deleted per scan page", client.deletedPages)
	}
}

func TestRedisSessionValidatorRefreshesExactSessionKey(t *testing.T) {
	client := &stage10CSessionValidatorClient{value: int64(1)}
	validator := NewRedisSessionValidator(client, "bb", 8*time.Hour)

	valid, err := validator.ValidateSession(
		context.Background(),
		" user-123 ",
		" session-456 ",
	)
	if err != nil {
		t.Fatalf("ValidateSession() error = %v", err)
	}
	if !valid {
		t.Fatal("ValidateSession() = false, want true")
	}
	if len(client.keys) != 1 || client.keys[0] != "bb:session:user-123:session-456" {
		t.Fatalf("keys = %#v, want exact session key", client.keys)
	}
	if len(client.args) != 1 || client.args[0] != int64(8*60*60) {
		t.Fatalf("args = %#v, want session TTL", client.args)
	}
}

func TestRedisSessionValidatorFailsClosed(t *testing.T) {
	client := &stage10CSessionValidatorClient{err: errors.New("redis unavailable")}
	validator := NewRedisSessionValidator(client, "bb", 8*time.Hour)

	valid, err := validator.ValidateSession(
		context.Background(),
		"user-123",
		"session-456",
	)
	if err == nil {
		t.Fatal("ValidateSession() error = nil, want Redis error")
	}
	if valid {
		t.Fatal("ValidateSession() = true on Redis error, want false")
	}
}

type stage10CSessionScanPage struct {
	keys []string
	next uint64
}

type stage10CSessionRedisClient struct {
	pages        []stage10CSessionScanPage
	patterns     []string
	deletedPages [][]string
}

type stage10CSessionValidatorClient struct {
	value int64
	err   error
	keys  []string
	args  []any
}

func (client *stage10CSessionValidatorClient) Eval(
	_ context.Context,
	_ string,
	keys []string,
	args ...any,
) *redis.Cmd {
	client.keys = append([]string(nil), keys...)
	client.args = append([]any(nil), args...)
	return redis.NewCmdResult(client.value, client.err)
}

func (client *stage10CSessionRedisClient) Scan(
	_ context.Context,
	_ uint64,
	match string,
	_ int64,
) *redis.ScanCmd {
	client.patterns = append(client.patterns, match)
	if len(client.pages) == 0 {
		return redis.NewScanCmdResult(nil, 0, nil)
	}
	page := client.pages[0]
	client.pages = client.pages[1:]
	return redis.NewScanCmdResult(page.keys, page.next, nil)
}

func (client *stage10CSessionRedisClient) Del(
	_ context.Context,
	keys ...string,
) *redis.IntCmd {
	client.deletedPages = append(client.deletedPages, append([]string(nil), keys...))
	command := redis.NewIntCmd(context.Background())
	command.SetVal(int64(len(keys)))
	return command
}
