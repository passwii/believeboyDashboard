package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

const (
	defaultAddr          = "127.0.0.1:8200"
	defaultFastAPIOrigin = "http://127.0.0.1:8100"
)

type Config struct {
	Addr          string
	FastAPIOrigin string
	APIKey        string
	DatabaseURL   string
	RedisURL      string
	OwnedModules  map[string]bool
}

func Load() (Config, error) {
	return load(os.LookupEnv)
}

func load(lookup func(string) (string, bool)) (Config, error) {
	cfg := Config{
		Addr:          valueOrDefault(lookup, "GO_API_ADDR", defaultAddr),
		FastAPIOrigin: valueOrDefault(lookup, "FASTAPI_ORIGIN", defaultFastAPIOrigin),
		OwnedModules:  parseOwnedModules(valueOrDefault(lookup, "GO_API_OWNED", "")),
	}

	for _, required := range []struct {
		key    string
		target *string
	}{
		{key: "API_KEY", target: &cfg.APIKey},
		{key: "DATABASE_URL", target: &cfg.DatabaseURL},
		{key: "REDIS_URL", target: &cfg.RedisURL},
	} {
		value, ok := lookup(required.key)
		value = strings.TrimSpace(value)
		if !ok || value == "" {
			return Config{}, fmt.Errorf("%s is required", required.key)
		}
		*required.target = value
	}

	origin, err := url.Parse(cfg.FastAPIOrigin)
	if err != nil || origin.Scheme == "" || origin.Host == "" {
		return Config{}, fmt.Errorf("FASTAPI_ORIGIN must be an absolute HTTP URL")
	}
	if origin.Scheme != "http" && origin.Scheme != "https" {
		return Config{}, fmt.Errorf("FASTAPI_ORIGIN must use http or https")
	}

	return cfg, nil
}

func valueOrDefault(lookup func(string) (string, bool), key, fallback string) string {
	value, ok := lookup(key)
	value = strings.TrimSpace(value)
	if !ok || value == "" {
		return fallback
	}
	return value
}

func parseOwnedModules(raw string) map[string]bool {
	owned := make(map[string]bool)
	for _, module := range strings.Split(raw, ",") {
		module = strings.TrimSpace(module)
		if module != "" {
			owned[module] = true
		}
	}
	return owned
}
