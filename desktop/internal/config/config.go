package config

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

const (
	AppDirectoryName  = "BelieveBoy"
	FileName          = "config.json"
	DefaultAPIBaseURL = "http://127.0.0.1:8200"
)

var (
	ErrInvalidConfig = errors.New("config: invalid config")
	ErrNoConfigDir   = errors.New("config: user config directory is unavailable")
)

// Config contains non-secret desktop preferences only. Authentication secrets
// belong in the Keychain-backed auth store.
type Config struct {
	ClientID   string `json:"client_id"`
	APIBaseURL string `json:"api_base_url"`
	LastRoute  string `json:"last_route"`
}

// DirProvider resolves the user's platform config directory.
type DirProvider interface {
	UserConfigDir() (string, error)
}

// FileSystem is the small filesystem surface needed by the config store.
type FileSystem interface {
	MkdirAll(path string, perm fs.FileMode) error
	ReadFile(name string) ([]byte, error)
	WriteFile(name string, data []byte, perm fs.FileMode) error
	Rename(oldPath, newPath string) error
	Remove(name string) error
}

// Store creates and updates the per-user config file.
type Store struct {
	dirProvider DirProvider
	fileSystem  FileSystem
	mu          sync.Mutex
}

func NewStore() *Store {
	return NewStoreWith(osDirProvider{}, osFileSystem{})
}

func NewStoreWith(dirProvider DirProvider, fileSystem FileSystem) *Store {
	return &Store{dirProvider: dirProvider, fileSystem: fileSystem}
}

// Load returns the persisted config, creating it on first launch. An existing
// client_id is always preserved so the device keeps the same backend key slot.
func (s *Store) Load(ctx context.Context) (Config, error) {
	if err := ctx.Err(); err != nil {
		return Config{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.path()
	if err != nil {
		return Config{}, err
	}

	data, err := s.fileSystem.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		cfg, err := s.newConfig()
		if err != nil {
			return Config{}, err
		}
		if err := s.saveLocked(ctx, path, cfg); err != nil {
			return Config{}, err
		}
		return cfg, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("config: read %s: %w", path, err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("%w: decode %s: %v", ErrInvalidConfig, path, err)
	}

	changed := false
	if cfg.ClientID == "" {
		cfg.ClientID, err = newClientID()
		if err != nil {
			return Config{}, err
		}
		changed = true
	}
	if cfg.APIBaseURL == "" {
		cfg.APIBaseURL = DefaultAPIBaseURL
		changed = true
	}
	if changed {
		if err := s.saveLocked(ctx, path, cfg); err != nil {
			return Config{}, err
		}
	}
	return cfg, nil
}

func (s *Store) Save(ctx context.Context, cfg Config) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if cfg.ClientID == "" {
		return fmt.Errorf("%w: client_id is required", ErrInvalidConfig)
	}
	if cfg.APIBaseURL == "" {
		cfg.APIBaseURL = DefaultAPIBaseURL
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.path()
	if err != nil {
		return err
	}
	return s.saveLocked(ctx, path, cfg)
}

func (s *Store) UpdateLastRoute(ctx context.Context, route string) (Config, error) {
	cfg, err := s.Load(ctx)
	if err != nil {
		return Config{}, err
	}
	cfg.LastRoute = route
	if err := s.Save(ctx, cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (s *Store) Path() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.path()
}

func (s *Store) path() (string, error) {
	if s.dirProvider == nil {
		return "", ErrNoConfigDir
	}
	root, err := s.dirProvider.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrNoConfigDir, err)
	}
	if root == "" {
		return "", ErrNoConfigDir
	}
	return filepath.Join(root, AppDirectoryName, FileName), nil
}

func (s *Store) newConfig() (Config, error) {
	clientID, err := newClientID()
	if err != nil {
		return Config{}, err
	}
	return Config{
		ClientID:   clientID,
		APIBaseURL: DefaultAPIBaseURL,
	}, nil
}

func (s *Store) saveLocked(ctx context.Context, path string, cfg Config) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	payload = append(payload, '\n')

	dir := filepath.Dir(path)
	if err := s.fileSystem.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("config: create directory %s: %w", dir, err)
	}

	tempPath := path + ".tmp"
	if err := s.fileSystem.WriteFile(tempPath, payload, 0o600); err != nil {
		return fmt.Errorf("config: write temporary file: %w", err)
	}
	if err := s.fileSystem.Rename(tempPath, path); err != nil {
		_ = s.fileSystem.Remove(tempPath)
		return fmt.Errorf("config: replace %s: %w", path, err)
	}
	return nil
}

func newClientID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", fmt.Errorf("config: generate client_id: %w", err)
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%x-%x-%x-%x-%x",
		id[0:4],
		id[4:6],
		id[6:8],
		id[8:10],
		id[10:16],
	), nil
}

type osDirProvider struct{}

func (osDirProvider) UserConfigDir() (string, error) {
	return os.UserConfigDir()
}

type osFileSystem struct{}

func (osFileSystem) MkdirAll(path string, perm fs.FileMode) error {
	return os.MkdirAll(path, perm)
}

func (osFileSystem) ReadFile(name string) ([]byte, error) {
	return os.ReadFile(name)
}

func (osFileSystem) WriteFile(name string, data []byte, perm fs.FileMode) error {
	return os.WriteFile(name, data, perm)
}

func (osFileSystem) Rename(oldPath, newPath string) error {
	return os.Rename(oldPath, newPath)
}

func (osFileSystem) Remove(name string) error {
	return os.Remove(name)
}
