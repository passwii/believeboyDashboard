package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

const gooseBody = `-- +goose Up
-- +goose StatementBegin
select 1;
-- +goose StatementEnd

-- +goose Down
select 1;`

func TestValidateMigrationsAcceptsValidSet(t *testing.T) {
	dir := t.TempDir()
	baseline := writeFile(t, dir, baselineFile, gooseBody)
	writeFile(t, dir, "20260101010101_add_table.sql", gooseBody)

	if err := validateMigrations(dir, sha256Hex([]byte(gooseBody))); err != nil {
		t.Fatalf("validateMigrations() error = %v", err)
	}
	if got := sha256Hex([]byte(gooseBody)); got == "" {
		t.Fatal("unexpected empty hash")
	}
	_ = baseline
}

func TestValidateMigrationsRejectsBaselineChange(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, baselineFile, gooseBody)
	err := validateMigrations(dir, strings.Repeat("0", 64))
	if err == nil || !strings.Contains(err.Error(), "baseline") {
		t.Fatalf("error = %v, want baseline error", err)
	}
}

func TestValidateMigrationsRejectsDuplicateVersion(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, baselineFile, gooseBody)
	writeFile(t, dir, "20260101010101_first.sql", gooseBody)
	writeFile(t, dir, "20260101010101_second.sql", gooseBody)

	err := validateMigrations(dir, sha256Hex([]byte(gooseBody)))
	if err == nil || !strings.Contains(err.Error(), "duplicate migration version") {
		t.Fatalf("error = %v, want duplicate version error", err)
	}
}

func TestValidateMigrationsRejectsMissingGooseMarkers(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, baselineFile, gooseBody)
	writeFile(t, dir, "20260101010101_bad.sql", "select 1;\n")

	err := validateMigrations(dir, sha256Hex([]byte(gooseBody)))
	if err == nil || !strings.Contains(err.Error(), "-- +goose Up") {
		t.Fatalf("error = %v, want goose marker error", err)
	}
}

func TestValidateAlembicFrozen(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "001_initial.py", "revision = '001'\n")
	writeFile(t, dir, "002_next.py", "revision = '002'\n")

	expected := alembicManifestDigest(t, dir)
	if err := validateAlembicFrozen(dir, expected, "285"); err != nil {
		t.Fatalf("validateAlembicFrozen() error = %v", err)
	}

	writeFile(t, dir, "002_next.py", "revision = '002-changed'\n")
	if err := validateAlembicFrozen(dir, expected, "285"); err == nil {
		t.Fatal("validateAlembicFrozen() error = nil, want manifest change error")
	}
}

func alembicManifestDigest(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var manifest strings.Builder
	for _, entry := range entries {
		payload, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		manifest.WriteString(entry.Name())
		manifest.WriteByte(0)
		manifest.WriteString(sha256Hex(payload))
		manifest.WriteByte('\n')
	}
	return sha256Hex([]byte(manifest.String()))
}
