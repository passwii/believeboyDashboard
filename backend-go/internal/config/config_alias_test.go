package config

import "testing"

func TestLoadReadsDatabaseReadURLAndAppEnv(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("DATABASE_READ_URL", "postgres://replica/db")
	t.Setenv("APP_ENV", "production")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.DatabaseReadURL != "postgres://replica/db" {
		t.Errorf("DatabaseReadURL = %q, want DATABASE_READ_URL", got.DatabaseReadURL)
	}
	if got.AppEnv != "production" {
		t.Errorf("AppEnv = %q, want production", got.AppEnv)
	}
}

func TestLoadDefaultsAppEnvToDevelopment(t *testing.T) {
	setRequiredEnv(t)
	unsetEnv(t, "APP_ENV")

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got.AppEnv != "development" {
		t.Errorf("AppEnv = %q, want development", got.AppEnv)
	}
}

func TestLoadValidatesDatabaseReadURL(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("DATABASE_READ_URL", "not-a-url")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() error = nil, want invalid DATABASE_READ_URL error")
	}
}
