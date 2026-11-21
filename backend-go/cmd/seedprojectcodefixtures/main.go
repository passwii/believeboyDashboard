package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

var projectCodeFixtureNames = []string{
	"铨富",
	"犀牛",
	"玥涵",
	"创酷",
	"博朗姆",
	"卡斯摩",
	"吕沃",
	"瑞迪特",
	"睿见",
	"骏成",
	"鑫敏佳",
	"华洋泛航",
	"诗澜瑞",
}

func main() {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		fmt.Fprintln(os.Stderr, "seedprojectcodefixtures: DATABASE_URL is required")
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open database:", err)
		os.Exit(1)
	}
	defer pool.Close()

	var databaseName string
	if err := pool.QueryRow(ctx, "select current_database()").Scan(&databaseName); err != nil {
		fmt.Fprintln(os.Stderr, "read database name:", err)
		os.Exit(1)
	}
	if databaseName != "blf_ci" {
		fmt.Fprintf(os.Stderr, "seedprojectcodefixtures: refusing database %q; only blf_ci is allowed\n", databaseName)
		os.Exit(1)
	}

	var hasProjectCode bool
	if err := pool.QueryRow(ctx, `
		select exists (
			select 1
			from information_schema.columns
			where table_schema = 'public'
			  and table_name = 'projects'
			  and column_name = 'project_code'
		)
	`).Scan(&hasProjectCode); err != nil {
		fmt.Fprintln(os.Stderr, "check project_code column:", err)
		os.Exit(1)
	}
	if hasProjectCode {
		fmt.Fprintln(os.Stderr, "seedprojectcodefixtures: run before the project-code migration")
		os.Exit(1)
	}

	if err := seed(ctx, store.NewPGXDB(pool)); err != nil {
		fmt.Fprintln(os.Stderr, "seed project-code migration fixtures:", err)
		os.Exit(1)
	}
	fmt.Printf("Seeded %d project-code migration fixtures in %s.\n", len(projectCodeFixtureNames), databaseName)
}

func seed(ctx context.Context, db store.FullDB) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for sortOrder, name := range projectCodeFixtureNames {
		var count int
		if err := tx.QueryRow(ctx,
			"select count(*) from public.projects where project_name = $1",
			name,
		).Scan(&count); err != nil {
			return err
		}
		if count > 1 {
			return fmt.Errorf("project_name %q must be unique; found %d rows", name, count)
		}
		if count == 1 {
			continue
		}
		if _, err := tx.Exec(ctx,
			"insert into public.projects (project_name, sort_order, is_active) values ($1, $2, false)",
			name, sortOrder,
		); err != nil {
			return err
		}
	}

	for _, name := range projectCodeFixtureNames {
		var count int
		if err := tx.QueryRow(ctx,
			"select count(*) from public.projects where project_name = $1",
			name,
		).Scan(&count); err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("project_name %q must exist exactly once; found %d rows", name, count)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}
