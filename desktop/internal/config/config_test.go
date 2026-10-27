package config

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"regexp"
	"strings"
	"sync"
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

func TestConcurrentFirstRunConvergesOnOneClientID(t *testing.T) {
	files := newMemoryFS()
	const stores = 16
	results := make(chan Config, stores)
	errs := make(chan error, stores)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for i := 0; i < stores; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			cfg, err := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, files).
				Load(context.Background())
			if err != nil {
				errs <- err
				return
			}
			results <- cfg
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	var want string
	for cfg := range results {
		if want == "" {
			want = cfg.ClientID
		}
		if cfg.ClientID != want {
			t.Errorf("concurrent client_id = %q, want converged %q", cfg.ClientID, want)
		}
	}
	persisted, err := files.ReadFile("/virtual/config/BelieveBoy/config.json")
	if err != nil {
		t.Fatal(err)
	}
	var stored Config
	if err := json.Unmarshal(persisted, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.ClientID != want {
		t.Errorf("persisted client_id = %q, want %q", stored.ClientID, want)
	}
}

func TestLoadCorrectsExistingFileAndDirectoryPermissions(t *testing.T) {
	files := newMemoryFS()
	dir := "/virtual/config/BelieveBoy"
	path := dir + "/config.json"
	files.files[path] = []byte(`{
  "client_id": "039f5f62-7e79-4de0-aae8-8fb29bbf2f9b",
  "api_base_url": "http://127.0.0.1:8200",
  "last_route": ""
}`)
	files.modes[dir] = 0o755
	files.modes[path] = 0o644

	if _, err := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, files).
		Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := files.modes[dir]; got != 0o700 {
		t.Errorf("config directory mode = %#o, want 0700", got)
	}
	if got := files.modes[path]; got != 0o600 {
		t.Errorf("config file mode = %#o, want 0600", got)
	}
}

func TestSaveUsesUniqueTemporaryFiles(t *testing.T) {
	files := newMemoryFS()
	store := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, files)
	cfg := Config{
		ClientID:   "039f5f62-7e79-4de0-aae8-8fb29bbf2f9b",
		APIBaseURL: DefaultAPIBaseURL,
	}
	if err := store.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}

	var tempNames []string
	for _, name := range files.writes {
		if strings.Contains(name, ".tmp-") {
			tempNames = append(tempNames, name)
		}
	}
	if len(tempNames) != 2 {
		t.Fatalf("temporary writes = %v, want two unique temp files", tempNames)
	}
	if tempNames[0] == tempNames[1] {
		t.Errorf("temporary filenames are not unique: %q", tempNames[0])
	}
	for name := range files.files {
		if strings.Contains(name, ".tmp-") {
			t.Errorf("temporary file was not renamed/removed: %q", name)
		}
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
	files  map[string][]byte
	modes  map[string]fs.FileMode
	writes []string
}

func newMemoryFS() *memoryFS {
	return &memoryFS{
		files: make(map[string][]byte),
		modes: make(map[string]fs.FileMode),
	}
}

func (m *memoryFS) MkdirAll(name string, mode fs.FileMode) error {
	m.modes[name] = mode
	return nil
}

func (m *memoryFS) ReadFile(name string) ([]byte, error) {
	data, ok := m.files[name]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}

func (m *memoryFS) WriteFile(name string, data []byte, mode fs.FileMode) error {
	m.writes = append(m.writes, name)
	m.files[name] = append([]byte(nil), data...)
	m.modes[name] = mode
	return nil
}

func (m *memoryFS) Rename(oldPath, newPath string) error {
	data, ok := m.files[oldPath]
	if !ok {
		return fs.ErrNotExist
	}
	m.files[newPath] = data
	if mode, ok := m.modes[oldPath]; ok {
		m.modes[newPath] = mode
	}
	delete(m.files, oldPath)
	delete(m.modes, oldPath)
	return nil
}

func (m *memoryFS) Remove(name string) error {
	delete(m.files, name)
	delete(m.modes, name)
	return nil
}

func (m *memoryFS) Chmod(name string, mode fs.FileMode) error {
	if _, ok := m.files[name]; !ok {
		if _, ok := m.modes[name]; !ok {
			return fs.ErrNotExist
		}
	}
	m.modes[name] = mode
	return nil
}
