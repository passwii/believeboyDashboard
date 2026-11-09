package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	redis "github.com/redis/go-redis/v9"
)

const (
	defaultConfirmTTL  = 5 * time.Minute
	confirmTokenPrefix = "cf_"
)

type memoryConfirmRow struct {
	record    ConfirmRecord
	expiresAt time.Time
}

type MemoryConfirmStore struct {
	mu   sync.Mutex
	rows map[string]memoryConfirmRow
	now  func() time.Time
}

func NewMemoryConfirmStore(now func() time.Time) *MemoryConfirmStore {
	if now == nil {
		now = time.Now
	}
	return &MemoryConfirmStore{
		rows: make(map[string]memoryConfirmRow),
		now:  now,
	}
}

func (s *MemoryConfirmStore) Put(
	_ context.Context,
	record ConfirmRecord,
	ttl time.Duration,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ttl <= 0 {
		ttl = defaultConfirmTTL
	}
	s.rows[record.Token] = memoryConfirmRow{
		record:    record,
		expiresAt: s.now().Add(ttl),
	}
	return nil
}

func (s *MemoryConfirmStore) Pop(
	_ context.Context,
	token string,
) (*ConfirmRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.rows[token]
	if !ok {
		return nil, ErrConfirmTokenInvalid
	}
	delete(s.rows, token)
	if !row.expiresAt.IsZero() && !s.now().Before(row.expiresAt) {
		return nil, ErrConfirmTokenExpired
	}
	record := row.record
	return &record, nil
}

type RedisConfirmClient interface {
	Set(
		ctx context.Context,
		key string,
		value any,
		expiration time.Duration,
	) *redis.StatusCmd
	GetDel(ctx context.Context, key string) *redis.StringCmd
}

type RedisConfirmStore struct {
	client    RedisConfirmClient
	keyPrefix string
}

func NewRedisConfirmStore(
	client RedisConfirmClient,
	keyPrefix string,
) *RedisConfirmStore {
	return &RedisConfirmStore{client: client, keyPrefix: keyPrefix}
}

func (s *RedisConfirmStore) Put(
	ctx context.Context,
	record ConfirmRecord,
	ttl time.Duration,
) error {
	if s == nil || s.client == nil {
		return errors.New("redis confirm client is nil")
	}
	if ttl <= 0 {
		ttl = defaultConfirmTTL
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return s.client.Set(ctx, s.key(record.Token), payload, ttl*2).Err()
}

func (s *RedisConfirmStore) Pop(
	ctx context.Context,
	token string,
) (*ConfirmRecord, error) {
	if s == nil || s.client == nil {
		return nil, ErrConfirmTokenInvalid
	}
	payload, err := s.client.GetDel(ctx, s.key(token)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrConfirmTokenInvalid
	}
	if err != nil {
		return nil, err
	}
	var record ConfirmRecord
	if err := json.Unmarshal(payload, &record); err != nil {
		return nil, ErrConfirmTokenInvalid
	}
	return &record, nil
}

func (s *RedisConfirmStore) key(token string) string {
	prefix := s.keyPrefix
	if prefix == "" {
		prefix = "agent:confirm:"
	}
	return prefix + token
}

func HashConfirmBody(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func newConfirmToken() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return confirmTokenPrefix + base64.RawURLEncoding.EncodeToString(raw), nil
}
