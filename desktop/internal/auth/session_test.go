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
		Email:     "yawei@example.com",
		Name:      "yawei",
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

func TestSessionStoreLoadForGatewayAcceptsOnlyMatchingCredentials(t *testing.T) {
	t.Run("matching", func(t *testing.T) {
		secrets := newMemorySecrets()
		store := NewStore(NewKeychain(secrets), fixedClock{})
		if err := store.Save(context.Background(), Session{
			UserID:        "42",
			SessionID:     "session-1",
			Email:         "yawei@example.com",
			Name:          "yawei",
			GatewayOrigin: "https://gateway.example.test",
		}, "secret-api-key"); err != nil {
			t.Fatal(err)
		}

		session, apiKey, err := store.LoadForGateway(context.Background(), "https://gateway.example.test")
		if err != nil {
			t.Fatal(err)
		}
		if session.UserID != "42" || apiKey != "secret-api-key" {
			t.Errorf("session = %#v key=%q", session, apiKey)
		}
	})

	for _, test := range []struct {
		name          string
		gatewayOrigin string
	}{
		{name: "different origin", gatewayOrigin: "https://old.example.test"},
		{name: "legacy unbound session", gatewayOrigin: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			secrets := newMemorySecrets()
			store := NewStore(NewKeychain(secrets), fixedClock{})
			if err := store.Save(context.Background(), Session{
				UserID:        "42",
				SessionID:     "session-1",
				Email:         "yawei@example.com",
				Name:          "yawei",
				GatewayOrigin: test.gatewayOrigin,
			}, "secret-api-key"); err != nil {
				t.Fatal(err)
			}

			_, _, err := store.LoadForGateway(context.Background(), "https://new.example.test")
			if !errors.Is(err, ErrGatewayMismatch) {
				t.Fatalf("LoadForGateway() error = %v, want ErrGatewayMismatch", err)
			}
			if len(secrets.values) != 0 {
				t.Errorf("mismatched credentials were not cleared: %#v", secrets.values)
			}
			if _, _, err := store.Load(context.Background()); !errors.Is(err, ErrNoSession) {
				t.Errorf("Load() after mismatch = %v, want ErrNoSession", err)
			}
		})
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

func TestSessionStoreDoesNotAuthenticateLegacyItems(t *testing.T) {
	secrets := newMemorySecrets()
	session := Session{UserID: "42", SessionID: "session-1", IsActive: true}
	payload, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	secrets.values[SessionSecretName] = payload
	secrets.values[APIKeySecretName] = []byte("legacy-key")
	store := NewStore(NewKeychain(secrets), fixedClock{})

	if _, _, err := store.Load(context.Background()); !errors.Is(err, ErrNoSession) {
		t.Errorf("Load() error = %v, want ErrNoSession", err)
	}
	if _, ok := secrets.values[CredentialSecretName]; ok {
		t.Error("Load() wrote a credential envelope from legacy items")
	}
}

func TestSessionStoreClearRemovesEnvelopeAndLegacyLeftovers(t *testing.T) {
	secrets := newMemorySecrets()
	store := NewStore(NewKeychain(secrets), fixedClock{})
	if err := store.Save(context.Background(), Session{
		UserID:    "42",
		SessionID: "session-1",
		Email:     "yawei@example.com",
		Name:      "yawei",
	}, "secret-api-key"); err != nil {
		t.Fatal(err)
	}
	secrets.values[APIKeySecretName] = []byte("legacy-key")
	secrets.values[SessionSecretName] = []byte(`{"user_id":"old"}`)

	if err := store.Clear(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(secrets.values) != 0 {
		t.Errorf("remaining secrets = %#v, want none", secrets.values)
	}
}

func TestSessionStoreRejectsOversizedEnvelope(t *testing.T) {
	secrets := newMemorySecrets()
	store := NewStore(NewKeychain(secrets), fixedClock{})
	session := Session{
		UserID:    "42",
		Email:     "yawei@example.com",
		SessionID: "session-1",
		Name:      "yawei",
		RoleType:  strings.Repeat("r", MaxCredentialSecretSize),
	}
	payload, err := json.Marshal(credentialEnvelope{Version: 1, APIKey: "key", Session: session})
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) <= MaxCredentialSecretSize {
		t.Fatalf("test envelope = %d bytes, want over limit %d", len(payload), MaxCredentialSecretSize)
	}
	err = store.Save(context.Background(), session, "key")
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

	err := store.Save(ctx, Session{
		UserID: "42", SessionID: "session-1", Email: "yawei@example.com", Name: "yawei",
	}, "key")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Save() error = %v, want context.Canceled", err)
	}
	if len(secrets.values) != 0 {
		t.Errorf("secrets written after cancellation: %#v", secrets.values)
	}
}

func TestSessionStoreValidatesCredentialsOnSaveAndLoad(t *testing.T) {
	t.Run("save", func(t *testing.T) {
		tests := []struct {
			name    string
			session Session
			apiKey  string
		}{
			{name: "missing user id", session: Session{SessionID: "session-1", Email: "yawei@example.com", Name: "yawei"}, apiKey: "key"},
			{name: "missing session id", session: Session{UserID: "42", Email: "yawei@example.com", Name: "yawei"}, apiKey: "key"},
			{name: "missing api key", session: Session{UserID: "42", SessionID: "session-1", Email: "yawei@example.com", Name: "yawei"}},
		}
		for _, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				store := NewStore(NewKeychain(newMemorySecrets()), fixedClock{})
				if err := store.Save(context.Background(), test.session, test.apiKey); !errors.Is(err, ErrInvalidSession) {
					t.Errorf("Save() error = %v, want ErrInvalidSession", err)
				}
			})
		}
	})

	t.Run("load", func(t *testing.T) {
		tests := []struct {
			name     string
			envelope credentialEnvelope
			wantErr  error
		}{
			{
				name: "missing user id",
				envelope: credentialEnvelope{Version: 1, APIKey: "key", Session: Session{
					SessionID: "session-1", Email: "yawei@example.com", Name: "yawei",
				}},
				wantErr: ErrInvalidSession,
			},
			{
				name: "missing session id",
				envelope: credentialEnvelope{Version: 1, APIKey: "key", Session: Session{
					UserID: "42", Email: "yawei@example.com", Name: "yawei",
				}},
				wantErr: ErrInvalidSession,
			},
			{
				name: "missing api key secret",
				envelope: credentialEnvelope{Version: 1, Session: Session{
					UserID: "42", SessionID: "session-1", Email: "yawei@example.com", Name: "yawei",
				}},
				wantErr: ErrNoSession,
			},
			{
				name: "empty api key",
				envelope: credentialEnvelope{Version: 1, Session: Session{
					UserID: "42", SessionID: "session-1", Email: "yawei@example.com", Name: "yawei",
				}},
				wantErr: ErrInvalidSession,
			},
		}
		for _, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				secrets := newMemorySecrets()
				if test.wantErr == ErrNoSession {
					store := NewStore(NewKeychain(secrets), fixedClock{})
					if _, _, err := store.Load(context.Background()); !errors.Is(err, ErrNoSession) {
						t.Errorf("Load() error = %v, want ErrNoSession", err)
					}
					return
				}
				payload, err := json.Marshal(test.envelope)
				if err != nil {
					t.Fatal(err)
				}
				secrets.values[CredentialSecretName] = payload
				store := NewStore(NewKeychain(secrets), fixedClock{})
				if _, _, err := store.Load(context.Background()); !errors.Is(err, test.wantErr) {
					t.Errorf("Load() error = %v, want %v", err, test.wantErr)
				}
			})
		}
	})
}

func TestSessionStoreRejectsHeaderBoundCredentialValues(t *testing.T) {
	tests := []struct {
		name    string
		session Session
		apiKey  string
	}{
		{
			name:    "user id newline",
			session: Session{UserID: "4\n2", SessionID: "session-1", Email: "yawei@example.com"},
			apiKey:  "key",
		},
		{
			name:    "user id over 64 runes",
			session: Session{UserID: strings.Repeat("用", 65), SessionID: "session-1", Email: "yawei@example.com"},
			apiKey:  "key",
		},
		{
			name:    "session id space",
			session: Session{UserID: "42", SessionID: "session 1", Email: "yawei@example.com"},
			apiKey:  "key",
		},
		{
			name:    "session id control",
			session: Session{UserID: "42", SessionID: "session\x001", Email: "yawei@example.com"},
			apiKey:  "key",
		},
		{
			name:    "session id over 256 runes",
			session: Session{UserID: "42", SessionID: strings.Repeat("s", 257), Email: "yawei@example.com"},
			apiKey:  "key",
		},
		{
			name:    "api key whitespace",
			session: Session{UserID: "42", SessionID: "session-1", Email: "yawei@example.com"},
			apiKey:  "secret key",
		},
		{
			name:    "api key non-ascii",
			session: Session{UserID: "42", SessionID: "session-1", Email: "yawei@example.com"},
			apiKey:  "密钥",
		},
		{
			name:    "api key over 512 bytes",
			session: Session{UserID: "42", SessionID: "session-1", Email: "yawei@example.com"},
			apiKey:  strings.Repeat("k", 513),
		},
		{
			name:    "email over 320 bytes",
			session: Session{UserID: "42", SessionID: "session-1", Email: strings.Repeat("e", 321)},
			apiKey:  "key",
		},
		{
			name:    "name over 255 runes",
			session: Session{UserID: "42", SessionID: "session-1", Email: "yawei@example.com", Name: strings.Repeat("营", 256)},
			apiKey:  "key",
		},
		{
			name: "invalid utf8 email",
			session: Session{
				UserID:    "42",
				SessionID: "session-1",
				Email:     string([]byte{0xff}),
			},
			apiKey: "key",
		},
		{
			name: "invalid utf8 name",
			session: Session{
				UserID:    "42",
				SessionID: "session-1",
				Email:     "yawei@example.com",
				Name:      string([]byte{0xff}),
			},
			apiKey: "key",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			secrets := newMemorySecrets()
			store := NewStore(NewKeychain(secrets), fixedClock{})
			if err := store.Save(context.Background(), test.session, test.apiKey); !errors.Is(err, ErrInvalidSession) {
				t.Errorf("Save() error = %v, want ErrInvalidSession", err)
			}
			if len(secrets.values) != 0 {
				t.Errorf("invalid credentials wrote secrets: %#v", secrets.values)
			}
		})
	}
}

func TestSessionStoreLoadRejectsHeaderBoundCredentialValues(t *testing.T) {
	secrets := newMemorySecrets()
	envelope := credentialEnvelope{
		Version: 1,
		APIKey:  "secret key",
		Session: Session{
			UserID:    "42",
			SessionID: "session-1",
			Email:     "yawei@example.com",
		},
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	secrets.values[CredentialSecretName] = payload
	store := NewStore(NewKeychain(secrets), fixedClock{})

	if _, _, err := store.Load(context.Background()); !errors.Is(err, ErrInvalidSession) {
		t.Errorf("Load() error = %v, want ErrInvalidSession", err)
	}
}

func TestSessionStoreFailedEnvelopeWriteLeavesPreviousEnvelope(t *testing.T) {
	secrets := newMemorySecrets()
	store := NewStore(NewKeychain(secrets), fixedClock{})
	old := Session{UserID: "old-user", SessionID: "old-session", Email: "old@example.com", Name: "old", IsActive: true}
	if err := store.Save(context.Background(), old, "old-key"); err != nil {
		t.Fatal(err)
	}

	secrets.failSet[CredentialSecretName] = errors.New("envelope write failed")
	newSession := Session{UserID: "new-user", SessionID: "new-session", Email: "new@example.com", Name: "new", IsActive: true}
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
				Email:     "user" + id + "@example.com",
				Name:      "user" + id,
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
					Email:     "yawei@example.com",
					Name:      "yawei",
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
