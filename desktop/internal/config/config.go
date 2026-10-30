package config

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

const (
	AppDirectoryName  = "BelieveBoy"
	FileName          = "config.json"
	DefaultAPIBaseURL = "http://127.0.0.1:8200"
)

var (
	ErrInvalidConfig               = errors.New("config: invalid config")
	ErrNoConfigDir                 = errors.New("config: user config directory is unavailable")
	ErrInvalidAPIBaseURL           = errors.New("config: invalid API base URL")
	ErrUnsupportedAPIBaseURLScheme = errors.New("config: API base URL must use http or https")
	canonicalUUIDv4Pattern         = regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
	)
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
	Chmod(name string, mode fs.FileMode) error
}

type ProcessLocker interface {
	Lock(ctx context.Context, path string) (unlock func() error, err error)
}

// Store creates and updates the per-user config file.
type Store struct {
	dirProvider DirProvider
	fileSystem  FileSystem
	locker      ProcessLocker
	mu          sync.Mutex
}

func NewStore() *Store {
	return NewStoreWithLocker(osDirProvider{}, osFileSystem{}, NewFileLocker())
}

func NewStoreWith(dirProvider DirProvider, fileSystem FileSystem) *Store {
	return NewStoreWithLocker(dirProvider, fileSystem, noopLocker{})
}

func NewStoreWithLocker(
	dirProvider DirProvider,
	fileSystem FileSystem,
	locker ProcessLocker,
) *Store {
	if locker == nil {
		locker = noopLocker{}
	}
	return &Store{dirProvider: dirProvider, fileSystem: fileSystem, locker: locker}
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
	unlock, err := s.acquireLock(ctx, path)
	if err != nil {
		return Config{}, err
	}
	defer unlock()
	return s.loadLocked(ctx, path)
}

func (s *Store) loadLocked(ctx context.Context, path string) (Config, error) {
	data, err := s.fileSystem.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		cfg, err := s.newConfig()
		if err != nil {
			return Config{}, err
		}
		if err := s.saveLocked(ctx, path, cfg); err != nil {
			return Config{}, err
		}
		// Converge on the value that won the final atomic rename.
		return s.readLocked(path)
	}
	if err != nil {
		return Config{}, fmt.Errorf("config: read %s: %w", path, err)
	}
	if err := s.ensurePermissions(path); err != nil {
		return Config{}, err
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("%w: decode %s: %v", ErrInvalidConfig, path, err)
	}

	changed := false
	if !canonicalUUIDv4Pattern.MatchString(cfg.ClientID) {
		cfg.ClientID, err = newClientID()
		if err != nil {
			return Config{}, err
		}
		changed = true
	}
	if cfg.APIBaseURL == "" {
		cfg.APIBaseURL = DefaultAPIBaseURL
		changed = true
	} else {
		normalized, normalizeErr := NormalizeAPIBaseURL(cfg.APIBaseURL)
		if normalizeErr != nil {
			return Config{}, fmt.Errorf("%w: %v", ErrInvalidConfig, normalizeErr)
		}
		if normalized != cfg.APIBaseURL {
			cfg.APIBaseURL = normalized
			changed = true
		}
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
	normalized, err := NormalizeAPIBaseURL(cfg.APIBaseURL)
	if err != nil {
		return err
	}
	cfg.APIBaseURL = normalized

	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.path()
	if err != nil {
		return err
	}
	unlock, err := s.acquireLock(ctx, path)
	if err != nil {
		return err
	}
	defer unlock()
	return s.saveLocked(ctx, path, cfg)
}

// UpdateAPIBaseURL validates and persists a new gateway address without
// changing the device identity or the last known workspace route.
func (s *Store) UpdateAPIBaseURL(ctx context.Context, raw string) (Config, error) {
	if err := ctx.Err(); err != nil {
		return Config{}, err
	}
	normalized, err := NormalizeAPIBaseURL(raw)
	if err != nil {
		return Config{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.path()
	if err != nil {
		return Config{}, err
	}
	unlock, err := s.acquireLock(ctx, path)
	if err != nil {
		return Config{}, err
	}
	defer unlock()

	cfg, err := s.loadLocked(ctx, path)
	if err != nil {
		return Config{}, err
	}
	cfg.APIBaseURL = normalized
	if err := s.saveLocked(ctx, path, cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (s *Store) UpdateLastRoute(ctx context.Context, route string) (Config, error) {
	cfg, _, err := s.updateLastRoute(ctx, route)
	return cfg, err
}

func (s *Store) updateLastRoute(ctx context.Context, route string) (Config, string, error) {
	if err := ctx.Err(); err != nil {
		return Config{}, "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.path()
	if err != nil {
		return Config{}, "", err
	}
	unlock, err := s.acquireLock(ctx, path)
	if err != nil {
		return Config{}, "", err
	}
	defer unlock()

	cfg, err := s.loadLocked(ctx, path)
	if err != nil {
		return Config{}, "", err
	}
	previousRoute := cfg.LastRoute
	cfg.LastRoute = route
	if err := s.saveLocked(ctx, path, cfg); err != nil {
		return Config{}, "", err
	}
	return cfg, previousRoute, nil
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

func (s *Store) acquireLock(ctx context.Context, path string) (func(), error) {
	unlockPath := lockConfigPath(path)
	unlockProcess, err := s.locker.Lock(ctx, path)
	if err != nil {
		unlockPath()
		return nil, fmt.Errorf("config: acquire process lock: %w", err)
	}
	return func() {
		if err := unlockProcess(); err != nil {
			// Unlock errors cannot be acted on after the critical section.
			_ = err
		}
		unlockPath()
	}, nil
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
	if err := s.fileSystem.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("config: secure directory %s: %w", dir, err)
	}

	tempPath, err := uniqueTempPath(path)
	if err != nil {
		return err
	}
	if err := s.fileSystem.WriteFile(tempPath, payload, 0o600); err != nil {
		return fmt.Errorf("config: write temporary file: %w", err)
	}
	if err := s.fileSystem.Rename(tempPath, path); err != nil {
		_ = s.fileSystem.Remove(tempPath)
		return fmt.Errorf("config: replace %s: %w", path, err)
	}
	if err := s.fileSystem.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("config: secure file %s: %w", path, err)
	}
	return nil
}

func (s *Store) ensurePermissions(path string) error {
	dir := filepath.Dir(path)
	if err := s.fileSystem.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("config: create directory %s: %w", dir, err)
	}
	if err := s.fileSystem.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("config: secure directory %s: %w", dir, err)
	}
	if err := s.fileSystem.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("config: secure file %s: %w", path, err)
	}
	return nil
}

func (s *Store) readLocked(path string) (Config, error) {
	data, err := s.fileSystem.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("config: reread %s: %w", path, err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("%w: decode %s: %v", ErrInvalidConfig, path, err)
	}
	return cfg, nil
}

func uniqueTempPath(path string) (string, error) {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", fmt.Errorf("config: create temporary filename: %w", err)
	}
	return fmt.Sprintf("%s.tmp-%x", path, suffix[:]), nil
}

var configPathLocks = struct {
	sync.Mutex
	locks map[string]*sync.Mutex
}{
	locks: make(map[string]*sync.Mutex),
}

func lockConfigPath(path string) func() {
	configPathLocks.Lock()
	lock := configPathLocks.locks[path]
	if lock == nil {
		lock = &sync.Mutex{}
		configPathLocks.locks[path] = lock
	}
	configPathLocks.Unlock()

	lock.Lock()
	return lock.Unlock
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

// NormalizeAPIBaseURL accepts only HTTP(S) gateway roots, strips surrounding
// whitespace and trailing slashes, and rejects URL components that would make
// request construction ambiguous.
func NormalizeAPIBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("%w: address is required", ErrInvalidAPIBaseURL)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidAPIBaseURL, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("%w: %q", ErrUnsupportedAPIBaseURLScheme, parsed.Scheme)
	}
	if parsed.Opaque != "" || parsed.Hostname() == "" {
		return "", fmt.Errorf("%w: host is required", ErrInvalidAPIBaseURL)
	}
	if parsed.User != nil {
		return "", fmt.Errorf("%w: credentials are not allowed", ErrInvalidAPIBaseURL)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("%w: query and fragment are not allowed", ErrInvalidAPIBaseURL)
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

// APIOrigin returns the canonical scheme, host, and non-default port used to
// bind saved credentials to one Gateway deployment.
func APIOrigin(raw string) (string, error) {
	normalized, err := NormalizeAPIBaseURL(raw)
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(normalized)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidAPIBaseURL, err)
	}
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	authority := host
	if port != "" {
		authority = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		authority = "[" + host + "]"
	}
	return scheme + "://" + authority, nil
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

func (osFileSystem) Chmod(name string, mode fs.FileMode) error {
	return os.Chmod(name, mode)
}

type noopLocker struct{}

func (noopLocker) Lock(context.Context, string) (func() error, error) {
	return func() error { return nil }, nil
}
