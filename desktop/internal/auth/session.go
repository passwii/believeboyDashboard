package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

var (
	ErrNoSession      = errors.New("auth: no saved session")
	ErrInvalidSession = errors.New("auth: invalid saved session")
)

// Clock makes session timestamps deterministic in tests.
type Clock interface {
	Now() time.Time
}

type SystemClock struct{}

func (SystemClock) Now() time.Time {
	return time.Now()
}

// Session is the non-secret user context persisted as one Keychain item.
// APIKey is intentionally not part of this struct; it is stored under a
// separate Keychain key.
type Session struct {
	UserID    string    `json:"user_id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	FullName  *string   `json:"full_name"`
	RoleType  string    `json:"role_type"`
	SessionID string    `json:"session_id"`
	IsAdmin   bool      `json:"is_admin"`
	IsActive  bool      `json:"is_active"`
	SavedAt   time.Time `json:"saved_at"`
}

func (s Session) DisplayName() string {
	if s.FullName == nil {
		return ""
	}
	return strings.TrimSpace(*s.FullName)
}

// Store persists the API key and session JSON in the Keychain.
type Store struct {
	keychain *Keychain
	clock    Clock
	mu       sync.Mutex
}

func NewStore(keychain *Keychain, clock Clock) *Store {
	if clock == nil {
		clock = SystemClock{}
	}
	return &Store{keychain: keychain, clock: clock}
}

func (s *Store) Save(ctx context.Context, session Session, apiKey string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil || s.keychain == nil {
		return ErrInvalidSecret
	}
	if err := validateCredentials(session, apiKey); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return err
	}

	session.SavedAt = s.clock.Now().UTC()
	payload, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("%w: encode: %v", ErrInvalidSession, err)
	}

	previousKey, err := s.keychain.Load(ctx, APIKeySecretName)
	hadPreviousKey := err == nil
	if err != nil && !errors.Is(err, ErrSecretNotFound) {
		return err
	}

	// Write the key first so a crash can never expose session B with key A.
	if err := s.keychain.Save(ctx, APIKeySecretName, []byte(apiKey)); err != nil {
		return err
	}
	if err := s.keychain.Save(ctx, SessionSecretName, payload); err != nil {
		cleanupCtx := context.WithoutCancel(ctx)
		rollbackErr := s.restoreAPIKey(cleanupCtx, previousKey, hadPreviousKey)
		if rollbackErr != nil {
			// If the old key cannot be restored, make the pair unloadable.
			clearErr := s.keychain.Delete(cleanupCtx, SessionSecretName)
			return errors.Join(err, fmt.Errorf("auth: restore previous api key: %w", rollbackErr), clearErr)
		}
		return err
	}
	return nil
}

func (s *Store) Load(ctx context.Context) (Session, string, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, "", err
	}
	if s == nil || s.keychain == nil {
		return Session{}, "", ErrInvalidSecret
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return Session{}, "", err
	}

	sessionPayload, err := s.keychain.Load(ctx, SessionSecretName)
	if errors.Is(err, ErrSecretNotFound) {
		return Session{}, "", ErrNoSession
	}
	if err != nil {
		return Session{}, "", err
	}
	apiKey, err := s.keychain.Load(ctx, APIKeySecretName)
	if errors.Is(err, ErrSecretNotFound) {
		return Session{}, "", ErrNoSession
	}
	if err != nil {
		return Session{}, "", err
	}

	var session Session
	if err := json.Unmarshal(sessionPayload, &session); err != nil {
		return Session{}, "", fmt.Errorf("%w: decode: %v", ErrInvalidSession, err)
	}
	if err := validateCredentials(session, string(apiKey)); err != nil {
		return Session{}, "", err
	}
	return session, string(apiKey), nil
}

func (s *Store) Clear(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil || s.keychain == nil {
		return ErrInvalidSecret
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return err
	}

	// Removing the key first makes any surviving session unloadable.
	keyErr := s.keychain.Delete(ctx, APIKeySecretName)
	sessionErr := s.keychain.Delete(ctx, SessionSecretName)
	return errors.Join(keyErr, sessionErr)
}

func (s *Store) restoreAPIKey(ctx context.Context, previous []byte, hadPrevious bool) error {
	if hadPrevious {
		return s.keychain.Save(ctx, APIKeySecretName, previous)
	}
	return s.keychain.Delete(ctx, APIKeySecretName)
}

func validateCredentials(session Session, apiKey string) error {
	switch {
	case strings.TrimSpace(session.UserID) == "":
		return fmt.Errorf("%w: missing user id", ErrInvalidSession)
	case strings.TrimSpace(session.SessionID) == "":
		return fmt.Errorf("%w: missing session id", ErrInvalidSession)
	case strings.TrimSpace(apiKey) == "":
		return fmt.Errorf("%w: missing api key", ErrInvalidSession)
	default:
		return nil
	}
}
