package agent_credentials

import (
	"context"
	"sync"
	"time"
)

type IdempotencyStore interface {
	Reserve(
		ctx context.Context,
		key string,
		fingerprint string,
		ttl time.Duration,
	) (cached []byte, hit bool, err error)
	Complete(
		ctx context.Context,
		key string,
		fingerprint string,
		response []byte,
		ttl time.Duration,
	) error
	Release(ctx context.Context, key string, fingerprint string) error
}

type memoryIdempotencyEntry struct {
	fingerprint string
	response    []byte
	expiresAt   time.Time
	pending     bool
}

type MemoryIdempotencyStore struct {
	mu      sync.Mutex
	entries map[string]memoryIdempotencyEntry
	now     func() time.Time
}

func NewMemoryIdempotencyStore(now func() time.Time) *MemoryIdempotencyStore {
	if now == nil {
		now = time.Now
	}
	return &MemoryIdempotencyStore{
		entries: make(map[string]memoryIdempotencyEntry),
		now:     now,
	}
}

func (store *MemoryIdempotencyStore) Reserve(
	_ context.Context,
	key string,
	fingerprint string,
	ttl time.Duration,
) ([]byte, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.expire()
	entry, exists := store.entries[key]
	if exists && entry.fingerprint != fingerprint {
		return nil, false, ErrIdempotencyConflict
	}
	if exists {
		if entry.pending {
			return nil, false, ErrIdempotencyConflict
		}
		cached := append([]byte(nil), entry.response...)
		return cached, true, nil
	}
	store.entries[key] = memoryIdempotencyEntry{
		fingerprint: fingerprint,
		expiresAt:   store.now().Add(normalizeIdempotencyTTL(ttl)),
		pending:     true,
	}
	return nil, false, nil
}

func (store *MemoryIdempotencyStore) Complete(
	_ context.Context,
	key string,
	fingerprint string,
	response []byte,
	ttl time.Duration,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	entry, exists := store.entries[key]
	if !exists || entry.fingerprint != fingerprint {
		return ErrIdempotencyConflict
	}
	entry.pending = false
	entry.response = append([]byte(nil), response...)
	entry.expiresAt = store.now().Add(normalizeIdempotencyTTL(ttl))
	store.entries[key] = entry
	return nil
}

func (store *MemoryIdempotencyStore) Release(
	_ context.Context,
	key string,
	fingerprint string,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	entry, exists := store.entries[key]
	if exists && entry.pending && entry.fingerprint == fingerprint {
		delete(store.entries, key)
	}
	return nil
}

func (store *MemoryIdempotencyStore) expire() {
	now := store.now()
	for key, entry := range store.entries {
		if !entry.expiresAt.After(now) {
			delete(store.entries, key)
		}
	}
}

func normalizeIdempotencyTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return 24 * time.Hour
	}
	return ttl
}
