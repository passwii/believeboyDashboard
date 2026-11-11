// Command checkmigrations validates the Goose migration set and the frozen
// Alembic cutover archive. It is the Go replacement for
// backend-go/scripts/check_go_migrations.py.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	baselineFile                = "00001_baseline.sql"
	baselineSHA256              = "86740bf5cda4a67757370e919a6d65fea608934cfc3bb8d066cea07cea2430e9"
	frozenAlembicRevision       = "285"
	frozenAlembicManifestSHA256 = "82150ebc66d4da4cc6e6e6a9855449c346a7bc3ceaff246d629e149b9e03d33b"
)

var futureNamePattern = regexp.MustCompile(`^(\d{14})_[a-z0-9_]+\.sql$`)

func main() {
	root, err := findRepoRoot()
	if err != nil {
		fail(err)
	}
	if err := validateMigrations(
		filepath.Join(root, "backend-go", "internal", "migrations", "sql"),
		baselineSHA256,
	); err != nil {
		fail(err)
	}
	if err := validateAlembicFrozen(
		filepath.Join(root, "backend", "alembic", "versions"),
		frozenAlembicManifestSHA256,
		frozenAlembicRevision,
	); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "ERROR:", err)
	os.Exit(1)
}

func validateMigrations(dir, expectedBaselineHash string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("migration directory missing: %s", dir)
		}
		return err
	}

	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	if len(files) == 0 {
		return errors.New("no Goose migrations found")
	}

	baselineBytes, err := os.ReadFile(filepath.Join(dir, baselineFile))
	if err != nil {
		return fmt.Errorf("baseline migration missing: %s", baselineFile)
	}
	if digest := sha256Hex(baselineBytes); digest != expectedBaselineHash {
		return fmt.Errorf("%s was modified; the cutover baseline is frozen. Add a new Go migration instead", baselineFile)
	}

	seen := make(map[int]string, len(files))
	latest := 0
	for _, name := range files {
		versionText, _, _ := strings.Cut(name, "_")
		version, err := strconv.Atoi(versionText)
		if err != nil {
			return fmt.Errorf("invalid migration filename (missing numeric prefix): %s", name)
		}
		if name == baselineFile {
			if version != 1 {
				return errors.New("baseline must be version 1")
			}
		} else if !futureNamePattern.MatchString(name) || version <= 1 {
			return fmt.Errorf("future migration must be named YYYYMMDDHHMMSS_slug.sql and use version > 1: %s", name)
		}
		if previous, ok := seen[version]; ok {
			return fmt.Errorf("duplicate migration version %d: %s and %s", version, previous, name)
		}
		seen[version] = name
		if version > latest {
			latest = version
		}

		payload, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		text := string(payload)
		if !strings.Contains(text, "-- +goose Up") {
			return fmt.Errorf("%s is missing '-- +goose Up'", name)
		}
		if !strings.Contains(text, "-- +goose Down") {
			return fmt.Errorf("%s is missing '-- +goose Down'", name)
		}
	}

	fmt.Printf("OK: %d Goose migration(s), baseline version 1, latest version %d\n", len(files), latest)
	return nil
}

func validateAlembicFrozen(dir, expectedManifestHash, revision string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("Alembic archive missing: %s", dir)
		}
		return err
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".py") {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	if len(files) == 0 {
		return errors.New("Alembic archive is empty")
	}

	var manifest strings.Builder
	for _, name := range files {
		payload, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		manifest.WriteString(name)
		manifest.WriteByte(0)
		manifest.WriteString(sha256Hex(payload))
		manifest.WriteByte('\n')
	}
	digest := sha256Hex([]byte(manifest.String()))
	if digest != expectedManifestHash {
		return fmt.Errorf(
			"backend/alembic/versions changed after the Goose cutover. Expected manifest %s, got %s. Alembic is frozen at revision %s; create a Goose migration instead",
			expectedManifestHash, digest, revision,
		)
	}
	fmt.Printf("OK: Alembic archive frozen at revision %s (%d files)\n", revision, len(files))
	return nil
}

func sha256Hex(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("could not find repo root (go.work)")
		}
		dir = parent
	}
}
