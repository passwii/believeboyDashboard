package store

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOpenPoolRejectsInvalidDatabaseURL(t *testing.T) {
	_, err := OpenPool(context.Background(), "not a connection string")
	if err == nil {
		t.Fatal("OpenPool() error = nil, want invalid DATABASE_URL error")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("OpenPool() error = %q, want it to mention DATABASE_URL", err)
	}
}

func TestNormalizeDatabaseURLConvertsSQLAlchemyDrivers(t *testing.T) {
	tests := map[string]string{
		"postgresql+psycopg://user:pass@db:5432/app":       "postgresql://user:pass@db:5432/app",
		"postgres+psycopg://user:pass@db:5432/app":         "postgres://user:pass@db:5432/app",
		"postgresql+psycopg2://user:pass@db:5432/app":      "postgresql://user:pass@db:5432/app",
		"postgres+psycopg2://user:pass@db:5432/app":        "postgres://user:pass@db:5432/app",
		"postgresql+asyncpg://user:pass@db:5432/app":       "postgresql://user:pass@db:5432/app",
		"postgres+asyncpg://user:pass@db:5432/app":         "postgres://user:pass@db:5432/app",
		"postgres://user:pass@db:5432/app?sslmode=require": "postgres://user:pass@db:5432/app?sslmode=require",
		"postgresql://user:pass@db:5432/app":               "postgresql://user:pass@db:5432/app",
	}
	for input, want := range tests {
		t.Run(input, func(t *testing.T) {
			if got := normalizeDatabaseURL(input); got != want {
				t.Errorf("normalizeDatabaseURL() = %q, want %q", got, want)
			}
		})
	}
}

func TestNormalizedSQLAlchemyURLIsAcceptedByPGXParseConfig(t *testing.T) {
	inputs := []string{
		"postgresql+psycopg://user:pass@db:5432/app?sslmode=require",
		"postgres+psycopg://user:pass@db:5432/app?sslmode=require",
		"postgresql+psycopg2://user:pass@db:5432/app?sslmode=require",
		"postgres+psycopg2://user:pass@db:5432/app?sslmode=require",
		"postgresql+asyncpg://user:pass@db:5432/app?sslmode=require",
		"postgres+asyncpg://user:pass@db:5432/app?sslmode=require",
	}
	for _, input := range inputs {
		t.Run(input, func(t *testing.T) {
			normalized := normalizeDatabaseURL(input)
			if _, err := pgxpool.ParseConfig(normalized); err != nil {
				t.Errorf("pgxpool.ParseConfig(%q) error = %v", normalized, err)
			}
		})
	}
}

func TestSQLAlchemyURLsAreRejectedBeforeNormalization(t *testing.T) {
	inputs := []string{
		"postgresql+psycopg://user:pass@db:5432/app",
		"postgres+psycopg://user:pass@db:5432/app",
		"postgresql+psycopg2://user:pass@db:5432/app",
		"postgres+psycopg2://user:pass@db:5432/app",
		"postgresql+asyncpg://user:pass@db:5432/app",
		"postgres+asyncpg://user:pass@db:5432/app",
	}
	for _, input := range inputs {
		t.Run(input, func(t *testing.T) {
			if _, err := pgxpool.ParseConfig(input); err == nil {
				t.Fatalf("pgxpool.ParseConfig(%q) error = nil, want SQLAlchemy scheme rejection", input)
			}
		})
	}
}

func TestOpenPoolErrorDoesNotLeakConnectionString(t *testing.T) {
	const secretURL = "not a connection string with password=super-secret"
	_, err := OpenPool(context.Background(), secretURL)
	if err == nil {
		t.Fatal("OpenPool() error = nil, want parse error")
	}
	if strings.Contains(err.Error(), "super-secret") {
		t.Errorf("OpenPool() error leaks connection string: %v", err)
	}
}
