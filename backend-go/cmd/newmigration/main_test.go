package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCreateMigration(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 11, 9, 8, 7, 0, time.UTC)
	path, err := createMigration(dir, "add_customer_tag", now)
	if err != nil {
		t.Fatalf("createMigration() error = %v", err)
	}
	if filepath.Base(path) != "20261111090807_add_customer_tag.sql" {
		t.Fatalf("filename = %q", filepath.Base(path))
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	if !strings.Contains(text, "-- +goose Up") || !strings.Contains(text, "-- +goose Down") {
		t.Fatalf("template missing goose markers: %s", text)
	}

	if _, err := createMigration(dir, "add_customer_tag", now); err == nil {
		t.Fatal("second createMigration() error = nil, want overwrite refusal")
	}
}

func TestCreateMigrationRejectsInvalidSlug(t *testing.T) {
	if _, err := createMigration(t.TempDir(), "Bad-Slug", time.Now()); err == nil {
		t.Fatal("createMigration() error = nil, want invalid slug error")
	}
}
