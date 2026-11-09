package scheduler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	defaultRedisLockPrefix = "scheduler:lock:"
	redisUnlockTimeout     = 5 * time.Second
)

var (
	// ErrInvalidLockKey is returned when a lock has no key.
	ErrInvalidLockKey = errors.New("lock key is required")
	// ErrInvalidLockTTL is returned when a lock has no positive TTL.
	ErrInvalidLockTTL = errors.New("lock ttl must be positive")
	// ErrRedisLockerClientNil is returned when RedisLocker has no client.
	ErrRedisLockerClientNil = errors.New("redis locker client is nil")
)

// Locker provides a single-owner lock with an idempotent release function.
type Locker interface {
	TryLock(ctx context.Context, key string, ttl time.Duration) (bool, func(), error)
}

// RedisLocker implements distributed locking with Redis SET NX.
type RedisLocker struct {
	client *redis.Client
	prefix string
	token  func() (string, error)
}

// NewRedisLocker creates a Redis-backed locker. An optional prefix overrides
// the default "scheduler:lock:" namespace.
func NewRedisLocker(client *redis.Client, prefixes ...string) *RedisLocker {
	prefix := defaultRedisLockPrefix
	if len(prefixes) > 0 && strings.TrimSpace(prefixes[0]) != "" {
		prefix = strings.TrimRight(strings.TrimSpace(prefixes[0]), ":") + ":"
	}
	return &RedisLocker{
		client: client,
		prefix: prefix,
		token:  newRedisLockToken,
	}
}

// TryLock attempts to acquire key for ttl.
func (l *RedisLocker) TryLock(ctx context.Context, key string, ttl time.Duration) (bool, func(), error) {
	if l == nil || l.client == nil {
		return false, nil, ErrRedisLockerClientNil
	}
	if ctx == nil {
		return false, nil, errors.New("lock context is nil")
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return false, nil, ErrInvalidLockKey
	}
	if ttl <= 0 {
		return false, nil, ErrInvalidLockTTL
	}

	token, err := l.token()
	if err != nil {
		return false, nil, fmt.Errorf("generate redis lock token: %w", err)
	}
	fullKey := l.prefix + key
	acquired, err := l.client.SetArgs(ctx, fullKey, token, redis.SetArgs{
		Mode: "NX",
		TTL:  ttl,
	}).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, fmt.Errorf("acquire redis lock %s: %w", fullKey, err)
	}
	if acquired != "OK" {
		return false, nil, nil
	}

	var once sync.Once
	release := func() {
		once.Do(func() {
			unlockCtx, cancel := context.WithTimeout(context.Background(), redisUnlockTimeout)
			defer cancel()
			_ = redisUnlockScript.Run(unlockCtx, l.client, []string{fullKey}, token).Err()
		})
	}
	return true, release, nil
}

var redisUnlockScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("del", KEYS[1])
end
return 0
`)

func newRedisLockToken() (string, error) {
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return "sl_" + base64.RawURLEncoding.EncodeToString(random), nil
}

type memoryLockEntry struct {
	token     uint64
	expiresAt time.Time
}

// MemoryLocker is an in-process Locker for tests and single-instance mode.
type MemoryLocker struct {
	mu     sync.Mutex
	locks  map[string]memoryLockEntry
	nextID uint64
	now    func() time.Time
}

// NewMemoryLocker creates an empty in-process locker.
func NewMemoryLocker() *MemoryLocker {
	return &MemoryLocker{
		locks: make(map[string]memoryLockEntry),
		now:   time.Now,
	}
}

// TryLock attempts to acquire key for ttl.
func (l *MemoryLocker) TryLock(ctx context.Context, key string, ttl time.Duration) (bool, func(), error) {
	if ctx == nil {
		return false, nil, errors.New("lock context is nil")
	}
	if err := ctx.Err(); err != nil {
		return false, nil, err
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return false, nil, ErrInvalidLockKey
	}
	if ttl <= 0 {
		return false, nil, ErrInvalidLockTTL
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.locks == nil {
		l.locks = make(map[string]memoryLockEntry)
	}
	if l.now == nil {
		l.now = time.Now
	}
	now := l.now()
	if entry, exists := l.locks[key]; exists && entry.expiresAt.After(now) {
		return false, nil, nil
	}

	l.nextID++
	token := l.nextID
	l.locks[key] = memoryLockEntry{
		token:     token,
		expiresAt: now.Add(ttl),
	}

	var once sync.Once
	release := func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			entry, exists := l.locks[key]
			if exists && entry.token == token {
				delete(l.locks, key)
			}
		})
	}
	return true, release, nil
}
