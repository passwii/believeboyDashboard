package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	ErrNoSession               = errors.New("auth: no saved session")
	ErrInvalidSession          = errors.New("auth: invalid saved session")
	ErrGatewayMismatch         = errors.New("auth: saved session belongs to another gateway")
	ErrInvalidHeaderCredential = errors.New("auth: invalid header credential")
	ErrSessionTooLarge         = errors.New("auth: session credentials exceed Keychain size limit")
)

const (
	MaxUserIDRunes    = 64
	MaxSessionIDRunes = 256
	MaxAPIKeyBytes    = 512
	MaxEmailRunes     = 320
	MaxNameRunes      = 255
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
	UserID        string    `json:"user_id"`
	Email         string    `json:"email"`
	Name          string    `json:"name"`
	FullName      *string   `json:"full_name"`
	RoleType      string    `json:"role_type"`
	SessionID     string    `json:"session_id"`
	IsAdmin       bool      `json:"is_admin"`
	IsActive      bool      `json:"is_active"`
	GatewayOrigin string    `json:"gateway_origin"`
	SavedAt       time.Time `json:"saved_at"`
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

// BelongsToGateway reports whether the saved credentials were issued by the
// expected canonical Gateway origin.
func (s Session) BelongsToGateway(origin string) bool {
	origin = strings.TrimSpace(origin)
	return origin != "" && strings.TrimSpace(s.GatewayOrigin) == origin
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
	if err := ValidateSessionCredentials(session, apiKey); err != nil {
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
		return session, apiKey, nil
	}
	if !errors.Is(err, ErrSecretNotFound) {
		return Session{}, "", err
	}
	return Session{}, "", ErrNoSession
}

// LoadForGateway returns credentials only when they were saved for the same
// Gateway origin. A mismatch is cleared before any authenticated request can
// use it, forcing the user to sign in again on the new Gateway.
func (s *Store) LoadForGateway(ctx context.Context, gatewayOrigin string) (Session, string, error) {
	session, apiKey, err := s.Load(ctx)
	if err != nil {
		return Session{}, "", err
	}
	if session.BelongsToGateway(gatewayOrigin) {
		return session, apiKey, nil
	}
	if clearErr := s.Clear(ctx); clearErr != nil {
		return Session{}, "", fmt.Errorf("%w: clear rejected credentials: %w", ErrGatewayMismatch, clearErr)
	}
	return Session{}, "", ErrGatewayMismatch
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

	envelopeErr := s.keychain.Delete(ctx, CredentialSecretName)
	// Legacy items can only exist from unreleased development builds and are
	// never read, but logout should still remove those leftovers.
	_ = s.keychain.Delete(ctx, APIKeySecretName)
	_ = s.keychain.Delete(ctx, SessionSecretName)
	return envelopeErr
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
	if err := ValidateSessionCredentials(envelope.Session, envelope.APIKey); err != nil {
		return Session{}, "", err
	}
	return envelope.Session, envelope.APIKey, nil
}

// ValidateSessionCredentials is the single validation source for values that
// become HTTP headers. It never includes the offending value in errors.
func ValidateSessionCredentials(session Session, apiKey string) error {
	if err := ValidateHeaderText("user id", session.UserID, MaxUserIDRunes, false, false); err != nil {
		return err
	}
	if err := validateVisibleASCII("session id", session.SessionID, MaxSessionIDRunes); err != nil {
		return err
	}
	if err := validateVisibleASCII("api key", apiKey, MaxAPIKeyBytes); err != nil {
		return err
	}
	if err := ValidateHeaderText("email", session.Email, MaxEmailRunes, false, true); err != nil {
		return err
	}
	if err := ValidateHeaderText("name", session.Name, MaxNameRunes, false, false); err != nil {
		return err
	}
	if session.FullName != nil {
		if err := ValidateHeaderText("full name", *session.FullName, MaxNameRunes, false, false); err != nil {
			return err
		}
	}
	return nil
}

// ValidateHeaderText validates Unicode header text before encoding.
func ValidateHeaderText(
	field string,
	value string,
	maxRunes int,
	allowEmpty bool,
	forbidWhitespace bool,
) error {
	if !utf8.ValidString(value) {
		return &headerCredentialError{field: field, reason: "invalid UTF-8"}
	}
	if !allowEmpty && strings.TrimSpace(value) == "" {
		return &headerCredentialError{field: field, reason: "must not be empty"}
	}
	if strings.TrimSpace(value) != value {
		return &headerCredentialError{field: field, reason: "leading or trailing whitespace"}
	}
	if maxRunes > 0 && utf8.RuneCountInString(value) > maxRunes {
		return &headerCredentialError{field: field, reason: fmt.Sprintf("exceeds %d runes", maxRunes)}
	}
	for _, char := range value {
		if unicode.IsControl(char) || unicode.Is(unicode.Zl, char) || unicode.Is(unicode.Zp, char) {
			return &headerCredentialError{field: field, reason: "control or line-separator character"}
		}
		if forbidWhitespace && unicode.IsSpace(char) {
			return &headerCredentialError{field: field, reason: "whitespace is not allowed"}
		}
	}
	return nil
}

func validateVisibleASCII(field, value string, maxBytes int) error {
	if value == "" {
		return &headerCredentialError{field: field, reason: "must not be empty"}
	}
	if len(value) > maxBytes {
		return &headerCredentialError{field: field, reason: fmt.Sprintf("exceeds %d bytes", maxBytes)}
	}
	for _, char := range value {
		if char < '!' || char > '~' {
			return &headerCredentialError{field: field, reason: "must be visible ASCII"}
		}
	}
	return nil
}

type headerCredentialError struct {
	field  string
	reason string
}

func (e *headerCredentialError) Error() string {
	return fmt.Sprintf("auth: invalid %s: %s", e.field, e.reason)
}

func (e *headerCredentialError) Is(target error) bool {
	return target == ErrInvalidSession || target == ErrInvalidHeaderCredential
}
