// Command migrate applies Goose migrations to the dashboard database.
//
// Cutover model (Alembic -> Goose):
//   - 00001_baseline.sql is the frozen schema at Alembic revision 285.
//   - Existing databases at revision 285 contain alembic_version but no
//     goose_db_version: "up" stamps baseline as applied and then runs newer
//     migrations.
//   - Fresh/empty databases run the baseline SQL normally.
//   - Databases with a non-empty schema and no alembic_version are refused to
//     avoid accidentally replaying the baseline over an unknown schema.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/passwii/believeboyDashboard/backend-go/internal/migrations"
)

const (
	baselineVersion        int64 = 1
	cutoverAlembicRevision       = "285"
	gooseVersionTable            = "goose_db_version"
	alembicVersionTable          = "alembic_version"
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	command := ""
	if len(os.Args) > 1 {
		command = strings.TrimSpace(os.Args[1])
	}
	if command == "" {
		usage()
		os.Exit(2)
	}

	dsn := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	dsn, err := normalizeDSN(dsn)
	if err != nil {
		log.Fatalf("invalid DATABASE_URL: %v", err)
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		log.Fatalf("ping database: %v", err)
	}

	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		log.Fatalf("set goose dialect: %v", err)
	}

	switch command {
	case "up":
		if err := autoBaseline(ctx, db); err != nil {
			log.Fatalf("prepare baseline: %v", err)
		}
		if err := goose.UpContext(ctx, db, migrations.Dir); err != nil {
			log.Fatalf("goose up: %v", err)
		}
	case "baseline":
		if err := stampBaseline(ctx, db); err != nil {
			log.Fatalf("baseline stamp: %v", err)
		}
	case "up-to":
		if len(os.Args) < 3 {
			log.Fatal("usage: migrate up-to <version>")
		}
		var version int64
		if _, err := fmt.Sscanf(strings.TrimSpace(os.Args[2]), "%d", &version); err != nil {
			log.Fatalf("invalid version: %v", err)
		}
		if err := autoBaseline(ctx, db); err != nil {
			log.Fatalf("prepare baseline: %v", err)
		}
		if err := goose.UpToContext(ctx, db, migrations.Dir, version); err != nil {
			log.Fatalf("goose up-to: %v", err)
		}
	case "status":
		if err := goose.StatusContext(ctx, db, migrations.Dir); err != nil {
			log.Fatalf("goose status: %v", err)
		}
	case "version":
		version, err := goose.GetDBVersionContext(ctx, db)
		if err != nil {
			log.Fatalf("goose version: %v", err)
		}
		fmt.Println(version)
	default:
		usage()
		os.Exit(2)
	}

}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: migrate <up|baseline|up-to <version>|status|version>")
}

// normalizeDSN converts the SQLAlchemy URL used by the Python backend into a
// pgx URL and forces the simple protocol so the baseline dump (a single
// multi-statement block) can be applied through goose.
func normalizeDSN(dsn string) (string, error) {
	dsn = strings.Replace(dsn, "postgresql+psycopg://", "postgresql://", 1)
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" {
		// libpq keyword/value DSN: append the pgx runtime parameter.
		if strings.Contains(dsn, "default_query_exec_mode") {
			return dsn, nil
		}
		return dsn + " default_query_exec_mode=simple_protocol", nil
	}
	query := parsed.Query()
	if query.Get("default_query_exec_mode") == "" {
		query.Set("default_query_exec_mode", "simple_protocol")
		parsed.RawQuery = query.Encode()
	}
	return parsed.String(), nil
}

func autoBaseline(ctx context.Context, db *sql.DB) error {
	gooseExists, err := tableExists(ctx, db, gooseVersionTable)
	if err != nil {
		return err
	}
	alembicExists, err := tableExists(ctx, db, alembicVersionTable)
	if err != nil {
		return err
	}
	if gooseExists {
		current, err := goose.GetDBVersionContext(ctx, db)
		if err != nil {
			return fmt.Errorf("read goose version: %w", err)
		}
		if current >= baselineVersion {
			if alembicExists {
				revision, err := readAlembicRevision(ctx, db)
				if err != nil {
					return err
				}
				if revision != cutoverAlembicRevision {
					return fmt.Errorf("goose is at version %d but alembic revision is %q; cutover expects %q", current, revision, cutoverAlembicRevision)
				}
			}
			return nil
		}
	}
	if !alembicExists {
		empty, err := publicSchemaEmpty(ctx, db)
		if err != nil {
			return err
		}
		if empty {
			return nil
		}
		return errors.New("public schema is not empty and has no alembic_version; refusing to run baseline over an unknown schema")
	}
	return stampBaseline(ctx, db)
}

func readAlembicRevision(ctx context.Context, db *sql.DB) (string, error) {
	var revision string
	if err := db.QueryRowContext(ctx, "select version_num from alembic_version limit 1").Scan(&revision); err != nil {
		return "", fmt.Errorf("read alembic_version: %w", err)
	}
	return strings.TrimSpace(revision), nil
}

func stampBaseline(ctx context.Context, db *sql.DB) error {
	alembicExists, err := tableExists(ctx, db, alembicVersionTable)
	if err != nil {
		return err
	}
	if !alembicExists {
		return fmt.Errorf("alembic_version table not found; run alembic upgrade head before cutover")
	}
	revision, err := readAlembicRevision(ctx, db)
	if err != nil {
		return err
	}
	if revision != cutoverAlembicRevision {
		return fmt.Errorf("alembic revision is %q, cutover baseline expects %q; run deploy/prepare-goose-cutover.sh once to apply the frozen Alembic head", revision, cutoverAlembicRevision)
	}

	current, err := goose.EnsureDBVersionContext(ctx, db)
	if err != nil {
		return fmt.Errorf("ensure goose version table: %w", err)
	}
	if current >= baselineVersion {
		log.Printf("baseline already stamped (goose version %d)", current)
		return nil
	}
	if _, err := db.ExecContext(ctx,
		"insert into "+gooseVersionTable+" (version_id, is_applied) values ($1, true)",
		baselineVersion,
	); err != nil {
		return fmt.Errorf("stamp baseline: %w", err)
	}
	log.Printf("stamped baseline version %d for alembic revision %s", baselineVersion, revision)
	return nil
}

func tableExists(ctx context.Context, db *sql.DB, name string) (bool, error) {
	var exists bool
	if err := db.QueryRowContext(ctx,
		"select to_regclass('public.' || $1) is not null", name,
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("check table %s: %w", name, err)
	}
	return exists, nil
}

func publicSchemaEmpty(ctx context.Context, db *sql.DB) (bool, error) {
	var count int
	if err := db.QueryRowContext(ctx,
		"select count(*) from information_schema.tables where table_schema = 'public' and table_name <> $1",
		gooseVersionTable,
	).Scan(&count); err != nil {
		return false, fmt.Errorf("count public tables: %w", err)
	}
	return count == 0, nil
}
