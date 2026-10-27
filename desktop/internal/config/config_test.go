package config

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"regexp"
	"testing"
)

func TestLoadCreatesAndPersistsStableClientID(t *testing.T) {
	files := newMemoryFS()
	store := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, files)

	first, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !isUUIDv4(first.ClientID) {
		t.Errorf("client_id = %q, want UUID v4", first.ClientID)
	}
	if first.APIBaseURL != DefaultAPIBaseURL {
		t.Errorf("api_base_url = %q, want %q", first.APIBaseURL, DefaultAPIBaseURL)
	}
	if first.LastRoute != "" {
		t.Errorf("last_route = %q, want empty", first.LastRoute)
	}

	reloaded, err := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, files).
		Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.ClientID != first.ClientID {
		t.Errorf("reloaded client_id = %q, want stable %q", reloaded.ClientID, first.ClientID)
	}
}

func TestLoadPreservesConfiguredBaseURLAndLastRoute(t *testing.T) {
	files := newMemoryFS()
	path := "/virtual/config/BelieveBoy/config.json"
	files.files[path] = []byte(`{
  "client_id": "039f5f62-7e79-4de0-aae8-8fb29bbf2f9b",
  "api_base_url": "https://gateway.example.test",
  "last_route": "/projects"
}`)
	store := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, files)

	cfg, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIBaseURL != "https://gateway.example.test" || cfg.LastRoute != "/projects" {
		t.Errorf("config = %#v, want persisted values", cfg)
	}

	updated, err := store.UpdateLastRoute(context.Background(), "/home")
	if err != nil {
		t.Fatal(err)
	}
	if updated.LastRoute != "/home" {
		t.Errorf("last_route = %q, want /home", updated.LastRoute)
	}
}

func TestConfigJSONContainsOnlyNonSecretFields(t *testing.T) {
	cfg := Config{
		ClientID:   "039f5f62-7e79-4de0-aae8-8fb29bbf2f9b",
		APIBaseURL: DefaultAPIBaseURL,
		LastRoute:  "/home",
	}
	payload, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payload, &raw); err != nil {
		t.Fatal(err)
	}
	for key := range raw {
		switch key {
		case "client_id", "api_base_url", "last_route":
		default:
			t.Errorf("config.json contains unexpected secret-capable field %q", key)
		}
	}
}

func TestLoadRejectsCorruptConfigWithoutReplacingIt(t *testing.T) {
	files := newMemoryFS()
	path := "/virtual/config/BelieveBoy/config.json"
	files.files[path] = []byte(`{"client_id":`)
	store := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, files)

	_, err := store.Load(context.Background())
	if !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("Load() error = %v, want ErrInvalidConfig", err)
	}
	if got := string(files.files[path]); got != `{"client_id":` {
		t.Errorf("corrupt config was replaced: %q", got)
	}
}

func TestLoadHonorsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, newMemoryFS()).Load(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Load() error = %v, want context.Canceled", err)
	}
}

func isUUIDv4(value string) bool {
	return regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
	).MatchString(value)
}

type fakeDirProvider struct {
	dir string
	err error
}

func (p fakeDirProvider) UserConfigDir() (string, error) {
	return p.dir, p.err
}

type memoryFS struct {
	files map[string][]byte
}

func newMemoryFS() *memoryFS {
	return &memoryFS{files: make(map[string][]byte)}
}

func (m *memoryFS) MkdirAll(string, fs.FileMode) error {
	return nil
}

func (m *memoryFS) ReadFile(name string) ([]byte, error) {
	data, ok := m.files[name]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}

func (m *memoryFS) WriteFile(name string, data []byte, _ fs.FileMode) error {
	m.files[name] = append([]byte(nil), data...)
	return nil
}

func (m *memoryFS) Rename(oldPath, newPath string) error {
	data, ok := m.files[oldPath]
	if !ok {
		return fs.ErrNotExist
	}
	m.files[newPath] = data
	delete(m.files, oldPath)
	return nil
}

func (m *memoryFS) Remove(name string) error {
	delete(m.files, name)
	return nil
}
