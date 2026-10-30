package config

import (
	"context"
	"errors"
	"testing"
)

func TestNormalizeAPIBaseURL(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    string
		wantErr error
	}{
		{name: "http", raw: "http://127.0.0.1:8200/", want: "http://127.0.0.1:8200"},
		{name: "https whitespace and path", raw: "  https://gateway.example.test/control///  ", want: "https://gateway.example.test/control"},
		{name: "empty", raw: "  ", wantErr: ErrInvalidAPIBaseURL},
		{name: "unsupported scheme", raw: "ftp://gateway.example.test", wantErr: ErrUnsupportedAPIBaseURLScheme},
		{name: "missing host", raw: "https:///control", wantErr: ErrInvalidAPIBaseURL},
		{name: "query", raw: "https://gateway.example.test?tenant=one", wantErr: ErrInvalidAPIBaseURL},
		{name: "fragment", raw: "https://gateway.example.test/#settings", wantErr: ErrInvalidAPIBaseURL},
		{name: "credentials", raw: "https://user:secret@gateway.example.test", wantErr: ErrInvalidAPIBaseURL},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := NormalizeAPIBaseURL(test.raw)
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("NormalizeAPIBaseURL(%q) error = %v, want %v", test.raw, err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Errorf("NormalizeAPIBaseURL(%q) = %q, want %q", test.raw, got, test.want)
			}
		})
	}
}

func TestUpdateAPIBaseURLPreservesClientIDAndLastRoute(t *testing.T) {
	files := newMemoryFS()
	path := "/virtual/config/BelieveBoy/config.json"
	files.files[path] = []byte(`{
  "client_id": "039f5f62-7e79-4de0-aae8-8fb29bbf2f9b",
  "api_base_url": "https://old.example.test",
  "last_route": "/projects"
}`)
	store := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, files)

	updated, err := store.UpdateAPIBaseURL(context.Background(), " https://new.example.test/ ")
	if err != nil {
		t.Fatal(err)
	}
	if updated.APIBaseURL != "https://new.example.test" {
		t.Errorf("api_base_url = %q", updated.APIBaseURL)
	}
	if updated.ClientID != "039f5f62-7e79-4de0-aae8-8fb29bbf2f9b" {
		t.Errorf("client_id = %q", updated.ClientID)
	}
	if updated.LastRoute != "/projects" {
		t.Errorf("last_route = %q, want /projects", updated.LastRoute)
	}

	reloaded, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if reloaded != updated {
		t.Errorf("reloaded config = %#v, want %#v", reloaded, updated)
	}
}

func TestUpdateAPIBaseURLRejectsInvalidURLWithoutWriting(t *testing.T) {
	files := newMemoryFS()
	path := "/virtual/config/BelieveBoy/config.json"
	original := []byte(`{
  "client_id": "039f5f62-7e79-4de0-aae8-8fb29bbf2f9b",
  "api_base_url": "https://old.example.test",
  "last_route": "/reports"
}`)
	files.files[path] = append([]byte(nil), original...)
	store := NewStoreWith(fakeDirProvider{dir: "/virtual/config"}, files)

	_, err := store.UpdateAPIBaseURL(context.Background(), "javascript:alert(1)")
	if !errors.Is(err, ErrUnsupportedAPIBaseURLScheme) {
		t.Fatalf("UpdateAPIBaseURL() error = %v", err)
	}
	if got := string(files.files[path]); got != string(original) {
		t.Errorf("invalid update changed config:\n%s", got)
	}
}
