// Command newmigration creates a timestamped Goose SQL migration.
// It replaces backend-go/scripts/new_go_migration.py.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var slugPattern = regexp.MustCompile(`^[a-z0-9_]+$`)

const migrationTemplate = `-- +goose Up
-- +goose StatementBegin
-- TODO: write forward migration
-- +goose StatementEnd

-- +goose Down
-- TODO: write rollback, or document why this migration is irreversible
`

func main() {
	if len(os.Args) != 2 || !slugPattern.MatchString(os.Args[1]) {
		fmt.Fprintln(os.Stderr, "usage: newmigration <lower_snake_case_slug>")
		os.Exit(2)
	}
	root, err := findRepoRoot()
	if err != nil {
		fail(err)
	}
	path, err := createMigration(
		filepath.Join(root, "backend-go", "internal", "migrations", "sql"),
		os.Args[1],
		time.Now().UTC(),
	)
	if err != nil {
		fail(err)
	}
	relative, err := filepath.Rel(root, path)
	if err != nil {
		relative = path
	}
	fmt.Println(relative)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func createMigration(dir, slug string, now time.Time) (string, error) {
	if !slugPattern.MatchString(slug) {
		return "", fmt.Errorf("invalid slug %q: use lower snake_case", slug)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, now.Format("20060102150405")+"_"+slug+".sql")
	if _, err := os.Stat(path); err == nil {
		return "", fmt.Errorf("refusing to overwrite %s", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := os.WriteFile(path, []byte(migrationTemplate), 0o644); err != nil {
		return "", err
	}
	return path, nil
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
