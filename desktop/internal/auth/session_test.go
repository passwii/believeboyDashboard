package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

func TestSessionStorePersistsAPIKeyAndSessionSeparately(t *testing.T) {
	secrets := newMemorySecrets()
	now := time.Date(2026, 10, 27, 9, 30, 0, 0, time.UTC)
	store := NewStore(NewKeychain(secrets), fixedClock{now: now})
	fullName := "纪亚伟"
	session := Session{
		UserID:    "42",
		Email:     "yawei@example.com",
		Name:      "yawei",
		FullName:  &fullName,
		RoleType:  "operator",
		SessionID: "session-1",
		IsAdmin:   false,
		IsActive:  true,
	}

	if err := store.Save(context.Background(), session, "secret-api-key"); err != nil {
		t.Fatal(err)
	}

	if got := string(secrets.values[APIKeySecretName]); got != "secret-api-key" {
		t.Errorf("api key secret = %q", got)
	}
	if strings.Contains(string(secrets.values[SessionSecretName]), "secret-api-key") {
		t.Error("session JSON contains the API key")
	}
	var stored Session
	if err := json.Unmarshal(secrets.values[SessionSecretName], &stored); err != nil {
		t.Fatal(err)
	}
	if !stored.SavedAt.Equal(now) {
		t.Errorf("saved_at = %s, want %s", stored.SavedAt, now)
	}

	loaded, apiKey, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if apiKey != "secret-api-key" || loaded.UserID != "42" ||
		loaded.SessionID != "session-1" || loaded.DisplayName() != fullName {
		t.Errorf("loaded session = %#v, api key = %q", loaded, apiKey)
	}
}

func TestSessionStoreClearRemovesSecrets(t *testing.T) {
	secrets := newMemorySecrets()
	store := NewStore(NewKeychain(secrets), fixedClock{})
	if err := store.Save(context.Background(), Session{
		UserID:    "42",
		SessionID: "session-1",
	}, "secret-api-key"); err != nil {
		t.Fatal(err)
	}

	if err := store.Clear(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(secrets.values) != 0 {
		t.Errorf("remaining secrets = %#v, want none", secrets.values)
	}
	if _, _, err := store.Load(context.Background()); !errors.Is(err, ErrNoSession) {
		t.Errorf("Load() error = %v, want ErrNoSession", err)
	}
}

func TestSessionStoreRejectsIncompleteOrCorruptSession(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		store := NewStore(NewKeychain(newMemorySecrets()), fixedClock{})
		if _, _, err := store.Load(context.Background()); !errors.Is(err, ErrNoSession) {
			t.Errorf("Load() error = %v, want ErrNoSession", err)
		}
	})

	t.Run("corrupt", func(t *testing.T) {
		secrets := newMemorySecrets()
		secrets.values[SessionSecretName] = []byte(`{`)
		secrets.values[APIKeySecretName] = []byte("key")
		store := NewStore(NewKeychain(secrets), fixedClock{})
		if _, _, err := store.Load(context.Background()); !errors.Is(err, ErrInvalidSession) {
			t.Errorf("Load() error = %v, want ErrInvalidSession", err)
		}
	})
}

func TestSessionStoreHonorsContextCancellation(t *testing.T) {
	secrets := newMemorySecrets()
	store := NewStore(NewKeychain(secrets), fixedClock{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := store.Save(ctx, Session{UserID: "42", SessionID: "session-1"}, "key")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Save() error = %v, want context.Canceled", err)
	}
	if len(secrets.values) != 0 {
		t.Errorf("secrets written after cancellation: %#v", secrets.values)
	}
}

type fixedClock struct {
	now time.Time
}

func (c fixedClock) Now() time.Time {
	return c.now
}

type memorySecrets struct {
	values map[string][]byte
}

func newMemorySecrets() *memorySecrets {
	return &memorySecrets{values: make(map[string][]byte)}
}

func (m *memorySecrets) Set(key string, value []byte) error {
	m.values[key] = append([]byte(nil), value...)
	return nil
}

func (m *memorySecrets) Get(key string) ([]byte, error) {
	value, ok := m.values[key]
	if !ok {
		return nil, mygo.ErrSecretNotFound
	}
	return append([]byte(nil), value...), nil
}

func (m *memorySecrets) Delete(key string) error {
	delete(m.values, key)
	return nil
}
