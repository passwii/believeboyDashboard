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
	ErrNoSession       = errors.New("auth: no saved session")
	ErrInvalidSession  = errors.New("auth: invalid saved session")
	ErrSessionTooLarge = errors.New("auth: session credentials exceed Keychain size limit")
)

// Clock makes session timestamps deterministic in tests.
type Clock interface {
	Now() time.Time
}

type SystemClock struct{}

func (SystemClock) Now() time.Time {
	return time.Now()
}

// Session is the user context stored inside the credential envelope.
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

type credentialEnvelope struct {
	Version int     `json:"version"`
	APIKey  string  `json:"api_key"`
	Session Session `json:"session"`
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
	if err := s.saveEnvelope(ctx, session, apiKey); err != nil {
		return err
	}
	s.cleanupLegacy(ctx)
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

	envelopePayload, err := s.keychain.Load(ctx, CredentialSecretName)
	if err == nil {
		session, apiKey, err := decodeCredentialEnvelope(envelopePayload)
		if err != nil {
			return Session{}, "", err
		}
		s.cleanupLegacy(ctx)
		return session, apiKey, nil
	}
	if !errors.Is(err, ErrSecretNotFound) {
		return Session{}, "", err
	}

	// One-time migration from the previous two-item layout.
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
	if err := s.saveEnvelope(ctx, session, string(apiKey)); err != nil {
		return Session{}, "", fmt.Errorf("auth: migrate credential envelope: %w", err)
	}
	s.cleanupLegacy(ctx)
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

	// Keep the authoritative envelope if legacy cleanup cannot complete.
	legacyErr := errors.Join(
		s.keychain.Delete(ctx, APIKeySecretName),
		s.keychain.Delete(ctx, SessionSecretName),
	)
	if legacyErr != nil {
		return legacyErr
	}
	return s.keychain.Delete(ctx, CredentialSecretName)
}

func (s *Store) saveEnvelope(ctx context.Context, session Session, apiKey string) error {
	envelope := credentialEnvelope{
		Version: 1,
		APIKey:  apiKey,
		Session: session,
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("%w: encode: %v", ErrInvalidSession, err)
	}
	if len(payload) > MaxCredentialSecretSize {
		return fmt.Errorf("%w: %d bytes exceeds %d", ErrSessionTooLarge, len(payload), MaxCredentialSecretSize)
	}
	return s.keychain.Save(ctx, CredentialSecretName, payload)
}

func decodeCredentialEnvelope(payload []byte) (Session, string, error) {
	var envelope credentialEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return Session{}, "", fmt.Errorf("%w: decode envelope: %v", ErrInvalidSession, err)
	}
	if envelope.Version != 1 {
		return Session{}, "", fmt.Errorf("%w: unsupported envelope version %d", ErrInvalidSession, envelope.Version)
	}
	if err := validateCredentials(envelope.Session, envelope.APIKey); err != nil {
		return Session{}, "", err
	}
	return envelope.Session, envelope.APIKey, nil
}

func (s *Store) cleanupLegacy(ctx context.Context) {
	cleanupCtx := context.WithoutCancel(ctx)
	_ = s.keychain.Delete(cleanupCtx, APIKeySecretName)
	_ = s.keychain.Delete(cleanupCtx, SessionSecretName)
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
