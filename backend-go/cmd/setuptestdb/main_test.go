package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestToLibpqURLStripsDriverSuffix(t *testing.T) {
	cases := map[string]string{
		"postgresql+psycopg://u:p@h:5432/db":       "postgresql://u:p@h:5432/db",
		"postgresql+asyncpg://u:p@h:5432/db":       "postgresql://u:p@h:5432/db",
		"postgres+psycopg://u:p@h:5432/db":         "postgres://u:p@h:5432/db",
		"postgresql://u:p@h:5432/db":               "postgresql://u:p@h:5432/db",
		"postgres://u:p@h:5432/db?sslmode=require": "postgres://u:p@h:5432/db?sslmode=require",
	}
	for input, want := range cases {
		if got := toLibpqURL(input); got != want {
			t.Errorf("toLibpqURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestQuoteIdentifierEscapesQuotes(t *testing.T) {
	if got := quoteIdentifier("BLF_test"); got != "\"BLF_test\"" {
		t.Fatalf("quoteIdentifier = %s", got)
	}
	if got := quoteIdentifier("we\"ird"); got != "\"we\"\"ird\"" {
		t.Fatalf("quoteIdentifier = %s", got)
	}
}

func TestLoadEnvLetsTestFileOverride(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "base.env"), []byte("A=1\nB=2\n# comment\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "test.env"), []byte("B=3\nC='quoted'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	env, err := loadEnv(dir, "base.env", "test.env")
	if err != nil {
		t.Fatalf("loadEnv: %v", err)
	}
	if env["A"] != "1" || env["B"] != "3" || env["C"] != "quoted" {
		t.Fatalf("env = %#v", env)
	}
}

func TestLoadEnvSkipsMissingFiles(t *testing.T) {
	dir := t.TempDir()
	env, err := loadEnv(dir, "missing.env", "also-missing.env")
	if err != nil {
		t.Fatalf("loadEnv: %v", err)
	}
	if len(env) != 0 {
		t.Fatalf("env = %#v, want empty", env)
	}
}
