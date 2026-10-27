package api

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
	"testing"

	"github.com/passwii/believeboyDashboard/desktop/internal/config"
)

func TestLoginAndLogoutNeverWriteSecretsToConfig(t *testing.T) {
	files := &configMemoryFS{files: make(map[string][]byte)}
	configStore := config.NewStoreWith(configDirProvider{dir: "/virtual/config"}, files)
	cfg, err := configStore.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	path, err := configStore.Path()
	if err != nil {
		t.Fatal(err)
	}

	client, err := NewClient(ClientConfig{
		BaseURL:  cfg.APIBaseURL,
		ClientID: cfg.ClientID,
		HTTPClient: stubHTTPClient{fn: func(req *http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusOK, `{
				"id":"42",
				"name":"yawei",
				"email":"yawei@example.com",
				"full_name":"纪亚伟",
				"is_admin":false,
				"is_active":true,
				"role_type":"operator",
				"session_id":"session-1",
				"api_key":"secret-api-key"
			}`), nil
		}},
		Sessions: newTestSessionStore(),
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := client.Login(context.Background(), "yawei@example.com", "password"); err != nil {
		t.Fatal(err)
	}
	if err := client.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}

	payload := string(files.files[path])
	for _, secret := range []string{"secret-api-key", "session-1", "yawei@example.com"} {
		if strings.Contains(payload, secret) {
			t.Errorf("config.json leaked %q: %s", secret, payload)
		}
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(files.files[path], &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 3 {
		t.Errorf("config keys = %v, want only client_id/api_base_url/last_route", raw)
	}
	var persisted config.Config
	if err := json.Unmarshal(files.files[path], &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.ClientID != cfg.ClientID {
		t.Errorf("client_id changed after logout: got %q want %q", persisted.ClientID, cfg.ClientID)
	}
}

type configDirProvider struct {
	dir string
}

func (p configDirProvider) UserConfigDir() (string, error) {
	return p.dir, nil
}

type configMemoryFS struct {
	files map[string][]byte
}

func (m *configMemoryFS) MkdirAll(string, fs.FileMode) error {
	return nil
}

func (m *configMemoryFS) ReadFile(name string) ([]byte, error) {
	data, ok := m.files[name]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}

func (m *configMemoryFS) WriteFile(name string, data []byte, _ fs.FileMode) error {
	m.files[name] = append([]byte(nil), data...)
	return nil
}

func (m *configMemoryFS) Rename(oldPath, newPath string) error {
	data, ok := m.files[oldPath]
	if !ok {
		return fs.ErrNotExist
	}
	m.files[newPath] = data
	delete(m.files, oldPath)
	return nil
}

func (m *configMemoryFS) Remove(name string) error {
	delete(m.files, name)
	return nil
}
