package config

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestLoadUsesDefaultsAndParsesOwnedModules(t *testing.T) {
	unsetEnv(t, "GO_API_ADDR")
	unsetEnv(t, "FASTAPI_ORIGIN")
	setRequiredEnv(t)
	t.Setenv("GO_API_OWNED", "health, exchange_rates,, alerts ")
	t.Setenv("GO_API_TRUSTED_PROXY_SECRET", "proxy-secret")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.Addr != "127.0.0.1:8200" {
		t.Errorf("Addr = %q, want %q", got.Addr, "127.0.0.1:8200")
	}
	if got.FastAPIOrigin != "http://127.0.0.1:8100" {
		t.Errorf("FastAPIOrigin = %q, want %q", got.FastAPIOrigin, "http://127.0.0.1:8100")
	}
	if got.TrustedProxySecret != "proxy-secret" {
		t.Errorf("TrustedProxySecret = %q, want proxy-secret", got.TrustedProxySecret)
	}
	wantOwned := map[string]bool{
		"health":         true,
		"exchange_rates": true,
		"alerts":         true,
	}
	if !reflect.DeepEqual(got.OwnedModules, wantOwned) {
		t.Errorf("OwnedModules = %#v, want %#v", got.OwnedModules, wantOwned)
	}
}

func TestLoadDefaultsOwnedModulesToEmpty(t *testing.T) {
	unsetEnv(t, "GO_API_OWNED")
	setRequiredEnv(t)

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got.OwnedModules) != 0 {
		t.Errorf("OwnedModules = %#v, want empty map", got.OwnedModules)
	}
}

func TestLoadRequiresCoreSettings(t *testing.T) {
	tests := []string{"API_KEY", "DATABASE_URL"}

	for _, key := range tests {
		t.Run(key, func(t *testing.T) {
			setRequiredEnv(t)
			unsetEnv(t, key)

			_, err := Load()
			if err == nil {
				t.Fatalf("Load() error = nil, want missing %s error", key)
			}
			if !strings.Contains(err.Error(), key) {
				t.Errorf("Load() error = %q, want it to mention %s", err, key)
			}
		})
	}
}

func TestLoadRejectsInvalidFastAPIOrigin(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("FASTAPI_ORIGIN", "localhost:8100")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() error = nil, want invalid FASTAPI_ORIGIN error")
	}
	if !strings.Contains(err.Error(), "FASTAPI_ORIGIN") {
		t.Errorf("Load() error = %q, want it to mention FASTAPI_ORIGIN", err)
	}
}

func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("API_KEY", "test-api-key")
	t.Setenv("DATABASE_URL", "postgres://localhost/believeboy")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
}

func unsetEnv(t *testing.T, key string) {
	t.Helper()

	oldValue, existed := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("os.Unsetenv(%q) error = %v", key, err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(key, oldValue)
			return
		}
		_ = os.Unsetenv(key)
	})
}
