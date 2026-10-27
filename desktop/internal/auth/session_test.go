package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

func TestSessionStorePersistsAPIKeyAndSessionInOneEnvelope(t *testing.T) {
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

	if len(secrets.values) != 1 {
		t.Errorf("secret count = %d, want one atomic envelope", len(secrets.values))
	}
	if _, ok := secrets.values[APIKeySecretName]; ok {
		t.Error("legacy api_key item still exists")
	}
	if _, ok := secrets.values[SessionSecretName]; ok {
		t.Error("legacy session item still exists")
	}
	var envelope credentialEnvelope
	if err := json.Unmarshal(secrets.values[CredentialSecretName], &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.APIKey != "secret-api-key" {
		t.Errorf("envelope api_key = %q", envelope.APIKey)
	}
	if !envelope.Session.SavedAt.Equal(now) {
		t.Errorf("saved_at = %s, want %s", envelope.Session.SavedAt, now)
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
		secrets.values[CredentialSecretName] = []byte(`{`)
		store := NewStore(NewKeychain(secrets), fixedClock{})
		if _, _, err := store.Load(context.Background()); !errors.Is(err, ErrInvalidSession) {
			t.Errorf("Load() error = %v, want ErrInvalidSession", err)
		}
	})
}

func TestSessionStoreMigratesLegacyTwoItemLayout(t *testing.T) {
	secrets := newMemorySecrets()
	session := Session{UserID: "42", SessionID: "session-1", IsActive: true}
	payload, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	secrets.values[SessionSecretName] = payload
	secrets.values[APIKeySecretName] = []byte("legacy-key")
	store := NewStore(NewKeychain(secrets), fixedClock{})

	loaded, apiKey, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if loaded.UserID != "42" || apiKey != "legacy-key" {
		t.Errorf("legacy load = %#v key=%q", loaded, apiKey)
	}
	if _, ok := secrets.values[CredentialSecretName]; !ok {
		t.Error("legacy load did not write the envelope")
	}
	if _, ok := secrets.values[SessionSecretName]; ok {
		t.Error("legacy session item was not removed")
	}
	if _, ok := secrets.values[APIKeySecretName]; ok {
		t.Error("legacy api_key item was not removed")
	}
}

func TestSessionStoreRejectsOversizedEnvelope(t *testing.T) {
	secrets := newMemorySecrets()
	store := NewStore(NewKeychain(secrets), fixedClock{})
	huge := strings.Repeat("x", MaxCredentialSecretSize)
	err := store.Save(context.Background(), Session{
		UserID:    "42",
		Email:     huge,
		SessionID: "session-1",
	}, "key")
	if !errors.Is(err, ErrSessionTooLarge) {
		t.Fatalf("Save() error = %v, want ErrSessionTooLarge", err)
	}
	if len(secrets.values) != 0 {
		t.Errorf("oversized save wrote secrets: %#v", secrets.values)
	}
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

func TestSessionStoreValidatesCredentialsOnSaveAndLoad(t *testing.T) {
	t.Run("save", func(t *testing.T) {
		store := NewStore(NewKeychain(newMemorySecrets()), fixedClock{})
		tests := []struct {
			name    string
			session Session
			apiKey  string
		}{
			{name: "missing user id", session: Session{SessionID: "session-1"}, apiKey: "key"},
			{name: "missing session id", session: Session{UserID: "42"}, apiKey: "key"},
			{name: "missing api key", session: Session{UserID: "42", SessionID: "session-1"}},
		}
		for _, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				if err := store.Save(context.Background(), test.session, test.apiKey); !errors.Is(err, ErrInvalidSession) {
					t.Errorf("Save() error = %v, want ErrInvalidSession", err)
				}
			})
		}
	})

	t.Run("load", func(t *testing.T) {
		tests := []struct {
			name    string
			session Session
			apiKey  []byte
			wantErr error
		}{
			{
				name:    "missing user id",
				session: Session{SessionID: "session-1"},
				apiKey:  []byte("key"),
				wantErr: ErrInvalidSession,
			},
			{
				name:    "missing session id",
				session: Session{UserID: "42"},
				apiKey:  []byte("key"),
				wantErr: ErrInvalidSession,
			},
			{
				name:    "missing api key secret",
				session: Session{UserID: "42", SessionID: "session-1"},
				wantErr: ErrNoSession,
			},
			{
				name:    "empty api key",
				session: Session{UserID: "42", SessionID: "session-1"},
				apiKey:  []byte{},
				wantErr: ErrInvalidSession,
			},
		}
		for _, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				secrets := newMemorySecrets()
				payload, err := json.Marshal(test.session)
				if err != nil {
					t.Fatal(err)
				}
				secrets.values[SessionSecretName] = payload
				if test.apiKey != nil {
					secrets.values[APIKeySecretName] = append([]byte(nil), test.apiKey...)
				}
				store := NewStore(NewKeychain(secrets), fixedClock{})
				if _, _, err := store.Load(context.Background()); !errors.Is(err, test.wantErr) {
					t.Errorf("Load() error = %v, want %v", err, test.wantErr)
				}
			})
		}
	})
}

func TestSessionStoreFailedEnvelopeWriteLeavesPreviousEnvelope(t *testing.T) {
	secrets := newMemorySecrets()
	store := NewStore(NewKeychain(secrets), fixedClock{})
	old := Session{UserID: "old-user", SessionID: "old-session", IsActive: true}
	if err := store.Save(context.Background(), old, "old-key"); err != nil {
		t.Fatal(err)
	}

	secrets.failSet[CredentialSecretName] = errors.New("envelope write failed")
	newSession := Session{UserID: "new-user", SessionID: "new-session", IsActive: true}
	if err := store.Save(context.Background(), newSession, "new-key"); err == nil {
		t.Fatal("Save() error = nil, want failure")
	}

	loaded, apiKey, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if loaded.UserID != old.UserID || loaded.SessionID != old.SessionID || apiKey != "old-key" {
		t.Errorf("rolled-back session = %#v key=%q, want old pair", loaded, apiKey)
	}
}

func TestSessionStoreConcurrentSavesKeepMatchingPair(t *testing.T) {
	secrets := newMemorySecrets()
	keychain := NewKeychain(secrets)
	stores := []*Store{
		NewStore(keychain, fixedClock{}),
		NewStore(keychain, fixedClock{}),
	}
	var wait sync.WaitGroup
	for i := 0; i < 32; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			id := strconv.Itoa(i)
			err := stores[i%len(stores)].Save(context.Background(), Session{
				UserID:    id,
				SessionID: "session-" + id,
				IsActive:  true,
			}, "key-"+id)
			if err != nil {
				t.Errorf("Save(%d) error = %v", i, err)
			}
		}(i)
	}
	wait.Wait()

	session, apiKey, err := stores[0].Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if apiKey != "key-"+session.UserID || session.SessionID != "session-"+session.UserID {
		t.Errorf("concurrent saves produced mismatched pair: session=%#v key=%q", session, apiKey)
	}
}

func TestSessionStoreConcurrentSaveAndClearLeavesNoPartialSession(t *testing.T) {
	for i := 0; i < 50; i++ {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			keychain := NewKeychain(newMemorySecrets())
			stores := []*Store{
				NewStore(keychain, fixedClock{}),
				NewStore(keychain, fixedClock{}),
			}
			var wait sync.WaitGroup
			wait.Add(2)
			go func() {
				defer wait.Done()
				err := stores[0].Save(context.Background(), Session{
					UserID:    "42",
					SessionID: "session-1",
					IsActive:  true,
				}, "secret-api-key")
				if err != nil {
					t.Errorf("Save() error = %v", err)
				}
			}()
			go func() {
				defer wait.Done()
				if err := stores[1].Clear(context.Background()); err != nil {
					t.Errorf("Clear() error = %v", err)
				}
			}()
			wait.Wait()

			session, apiKey, err := stores[0].Load(context.Background())
			if errors.Is(err, ErrNoSession) {
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if session.UserID != "42" || session.SessionID != "session-1" || apiKey != "secret-api-key" {
				t.Errorf("partial concurrent state: session=%#v key=%q", session, apiKey)
			}
		})
	}
}

func TestKeychainDeleteOfMissingSecretIsNoOp(t *testing.T) {
	keychain := NewKeychain(newMemorySecrets())
	if err := keychain.Delete(context.Background(), "missing"); err != nil {
		t.Errorf("Delete(missing) error = %v, want nil", err)
	}
}

type fixedClock struct {
	now time.Time
}

func (c fixedClock) Now() time.Time {
	return c.now
}

type memorySecrets struct {
	values  map[string][]byte
	failSet map[string]error
	mu      sync.Mutex
}

func newMemorySecrets() *memorySecrets {
	return &memorySecrets{
		values:  make(map[string][]byte),
		failSet: make(map[string]error),
	}
}

func (m *memorySecrets) Set(key string, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.failSet[key]; err != nil {
		return err
	}
	if err := m.failSet["*"]; err != nil {
		return err
	}
	m.values[key] = append([]byte(nil), value...)
	return nil
}

func (m *memorySecrets) Get(key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.values[key]
	if !ok {
		return nil, mygo.ErrSecretNotFound
	}
	return append([]byte(nil), value...), nil
}

func (m *memorySecrets) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.values, key)
	return nil
}
