package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/egoist/mygo"
)

const (
	CredentialSecretName = "session_credentials"

	// APIKeySecretName and SessionSecretName are the legacy two-item layout.
	// They remain readable only for one-time migration into the envelope.
	APIKeySecretName  = "api_key"
	SessionSecretName = "session"

	MaxCredentialSecretSize = mygo.MaxSecretSize
)

var (
	ErrSecretNotFound = errors.New("auth: secret not found")
	ErrInvalidSecret  = errors.New("auth: invalid secret")
)

// SecretStore is the small credential-store surface needed by the Keychain
// adapter. Tests inject an in-memory implementation.
type SecretStore interface {
	Set(key string, value []byte) error
	Get(key string) ([]byte, error)
	Delete(key string) error
}

// Keychain stores desktop secrets in the MyGo credential store. MyGo derives
// the Keychain service from the app identifier and appends ".dev" in dev mode,
// keeping development credentials isolated from signed builds.
type Keychain struct {
	store SecretStore
}

func NewKeychain(store SecretStore) *Keychain {
	return &Keychain{store: store}
}

func NewMyGoKeychain() *Keychain {
	return NewKeychain(mygo.Secrets)
}

func (k *Keychain) Save(ctx context.Context, key string, value []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if k == nil || k.store == nil {
		return ErrInvalidSecret
	}
	if err := k.store.Set(key, value); err != nil {
		return fmt.Errorf("auth: save Keychain item %q: %w", key, err)
	}
	return nil
}

func (k *Keychain) Load(ctx context.Context, key string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if k == nil || k.store == nil {
		return nil, ErrInvalidSecret
	}
	value, err := k.store.Get(key)
	if errors.Is(err, mygo.ErrSecretNotFound) {
		return nil, ErrSecretNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("auth: load Keychain item %q: %w", key, err)
	}
	return value, nil
}

func (k *Keychain) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if k == nil || k.store == nil {
		return ErrInvalidSecret
	}
	if err := k.store.Delete(key); err != nil {
		return fmt.Errorf("auth: delete Keychain item %q: %w", key, err)
	}
	return nil
}
