package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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

	session.SavedAt = s.clock.Now().UTC()
	payload, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("%w: encode: %v", ErrInvalidSession, err)
	}

	if err := s.keychain.Save(ctx, SessionSecretName, payload); err != nil {
		return err
	}
	if err := s.keychain.Save(ctx, APIKeySecretName, []byte(apiKey)); err != nil {
		_ = s.keychain.Delete(context.WithoutCancel(ctx), SessionSecretName)
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
	if session.UserID == "" {
		return Session{}, "", fmt.Errorf("%w: missing user id", ErrInvalidSession)
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
	return errors.Join(
		s.keychain.Delete(ctx, APIKeySecretName),
		s.keychain.Delete(ctx, SessionSecretName),
	)
}
