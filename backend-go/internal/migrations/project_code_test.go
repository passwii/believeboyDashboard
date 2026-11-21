package migrations

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var projectCodeSeed = []struct {
	code string
	name string
}{
	{code: "QUF", name: "铨富"},
	{code: "XNU", name: "犀牛"},
	{code: "YHS", name: "玥涵"},
	{code: "CKU", name: "创酷"},
	{code: "BLM", name: "博朗姆"},
	{code: "CSM", name: "卡斯摩"},
	{code: "LVW", name: "吕沃"},
	{code: "RDT", name: "瑞迪特"},
	{code: "RVJ", name: "睿见"},
	{code: "JCN", name: "骏成"},
	{code: "XMJ", name: "鑫敏佳"},
	{code: "HYF", name: "华洋泛航"},
}

func TestProjectCodeMigrationBackfillsAndEnforcesConstraints(t *testing.T) {
	conn := openBLFTestConnection(t)
	ctx := context.Background()
	tx, schema := beginProjectCodeFixture(t, conn, false)
	seedProjectCodeProjects(t, tx, schema, nil, false)

	if err := runProjectCodeMigration(ctx, tx, schema); err != nil {
		t.Fatalf("apply project code migration: %v", err)
	}
	assertProjectCodeMappings(t, ctx, tx, schema)

	if _, err := tx.Exec(ctx, fmt.Sprintf(
		`update %s.projects set is_active = false where project_name = '犀牛'`,
		schema,
	)); err != nil {
		t.Fatalf("deactivate 犀牛: %v", err)
	}
	var inactiveCode *string
	if err := tx.QueryRow(ctx, fmt.Sprintf(
		`select project_code from %s.projects where project_name = '犀牛' and not is_active`,
		schema,
	)).Scan(&inactiveCode); err != nil {
		t.Fatalf("read inactive project code: %v", err)
	}
	if inactiveCode == nil || *inactiveCode != "XNU" {
		t.Fatalf("inactive project_code = %#v, want XNU", inactiveCode)
	}

	assertProjectCodeConstraintError(
		t, ctx, tx,
		fmt.Sprintf(`update %s.projects set project_code = 'XNU' where project_name = '诗澜瑞'`, schema),
		"23505", "uq_projects_project_code",
	)
	assertProjectCodeConstraintError(
		t, ctx, tx,
		fmt.Sprintf(`update %s.projects set project_code = 'quf' where project_name = '诗澜瑞'`, schema),
		"23514", "projects_project_code_format_check",
	)
	assertProjectCodeConstraintError(
		t, ctx, tx,
		fmt.Sprintf(`update %s.projects set project_code = 'ALL' where project_name = '诗澜瑞'`, schema),
		"23514", "projects_project_code_format_check",
	)
	assertProjectCodeConstraintError(
		t, ctx, tx,
		fmt.Sprintf(`update %s.projects set project_code = NULL where project_name = '铨富'`, schema),
		"23514", "projects_project_code_immutable",
	)
	assertProjectCodeConstraintError(
		t, ctx, tx,
		fmt.Sprintf(`update %s.projects set project_code = 'QXX' where project_name = '铨富'`, schema),
		"23514", "projects_project_code_immutable",
	)

	if _, err := tx.Exec(ctx, fmt.Sprintf(
		`update %s.projects set project_code = 'SLR' where project_name = '诗澜瑞'`,
		schema,
	)); err != nil {
		t.Fatalf("assign code to previously unassigned project: %v", err)
	}
}

func TestProjectCodeMigrationPreservesMatchingAndUnrelatedCodes(t *testing.T) {
	conn := openBLFTestConnection(t)
	ctx := context.Background()
	tx, schema := beginProjectCodeFixture(t, conn, true)
	existing := map[string]*string{
		"卡斯摩": projectCodeTestPointer("CSM"),
		"弥森":  projectCodeTestPointer("ZZZ"),
	}
	seedProjectCodeProjects(t, tx, schema, existing, true)

	if err := runProjectCodeMigration(ctx, tx, schema); err != nil {
		t.Fatalf("apply project code migration with existing codes: %v", err)
	}
	assertProjectCodeMappings(t, ctx, tx, schema)

	var unrelatedCode string
	if err := tx.QueryRow(ctx, fmt.Sprintf(
		`select project_code from %s.projects where project_name = '弥森'`,
		schema,
	)).Scan(&unrelatedCode); err != nil {
		t.Fatalf("read unrelated project code: %v", err)
	}
	if unrelatedCode != "ZZZ" {
		t.Fatalf("unrelated project_code = %q, want preserved ZZZ", unrelatedCode)
	}
}

func TestProjectCodeMigrationRejectsMissingDuplicateAndMismatchedNames(t *testing.T) {
	conn := openBLFTestConnection(t)
	ctx := context.Background()
	tests := []struct {
		name    string
		prepare func(*testing.T, pgx.Tx, string)
		want    string
	}{
		{
			name: "missing name",
			prepare: func(t *testing.T, tx pgx.Tx, schema string) {
				seedProjectCodeProjects(t, tx, schema, nil, true)
				if _, err := tx.Exec(ctx, fmt.Sprintf(
					`delete from %s.projects where project_name = '铨富'`,
					schema,
				)); err != nil {
					t.Fatal(err)
				}
			},
			want: `project_name "铨富" exactly once; found 0 rows`,
		},
		{
			name: "duplicate name",
			prepare: func(t *testing.T, tx pgx.Tx, schema string) {
				if _, err := tx.Exec(ctx, fmt.Sprintf(
					`insert into %s.projects (project_name) values ('铨富'), ('铨富')`,
					schema,
				)); err != nil {
					t.Fatal(err)
				}
			},
			want: `project_name "铨富" exactly once; found 2 rows`,
		},
		{
			name: "missing unassigned project",
			prepare: func(t *testing.T, tx pgx.Tx, schema string) {
				seedProjectCodeProjects(t, tx, schema, nil, true)
				if _, err := tx.Exec(ctx, fmt.Sprintf(
					`delete from %s.projects where project_name = '诗澜瑞'`,
					schema,
				)); err != nil {
					t.Fatal(err)
				}
			},
			want: `project_name "诗澜瑞" exactly once; found 0 rows`,
		},
		{
			name: "unassigned project already has a code",
			prepare: func(t *testing.T, tx pgx.Tx, schema string) {
				seedProjectCodeProjects(t, tx, schema, nil, true)
				if _, err := tx.Exec(ctx, fmt.Sprintf(
					`update %s.projects set project_code = 'SLR' where project_name = '诗澜瑞'`,
					schema,
				)); err != nil {
					t.Fatal(err)
				}
			},
			want: `project_code for project_name "诗澜瑞" must remain NULL; found SLR`,
		},
		{
			name: "mismatched existing code",
			prepare: func(t *testing.T, tx pgx.Tx, schema string) {
				seedProjectCodeProjects(t, tx, schema, map[string]*string{
					"铨富": projectCodeTestPointer("ABC"),
				}, true)
			},
			want: `project_code mismatch for project_name "铨富": expected QUF, found ABC`,
		},
		{
			name: "mapped code assigned elsewhere",
			prepare: func(t *testing.T, tx pgx.Tx, schema string) {
				existing := map[string]*string{
					"弥森": projectCodeTestPointer("QUF"),
				}
				seedProjectCodeProjects(t, tx, schema, existing, true)
			},
			want: `project_code "QUF" belongs to project_name "弥森", expected "铨富"`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx, schema := beginProjectCodeFixture(t, conn, true)
			test.prepare(t, tx, schema)
			err := runProjectCodeMigration(ctx, tx, schema)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("migration error = %v, want message containing %q", err, test.want)
			}
		})
	}
}

func openBLFTestConnection(t *testing.T) *pgx.Conn {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to the local BLF_test database")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse GO_API_TEST_DATABASE_URL: %v", err)
	}
	if config.Database != "BLF_test" {
		t.Skipf("project code migration integration test only runs against BLF_test (got %q)", config.Database)
	}
	conn, err := pgx.ConnectConfig(context.Background(), config)
	if err != nil {
		t.Fatalf("connect to BLF_test: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func beginProjectCodeFixture(t *testing.T, conn *pgx.Conn, hasCodeColumn bool) (pgx.Tx, string) {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin BLF_test fixture transaction: %v", err)
	}
	schema := fmt.Sprintf("project_code_test_%d", time.Now().UnixNano())
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	if _, err := tx.Exec(ctx, "create schema "+schema); err != nil {
		t.Fatalf("create fixture schema: %v", err)
	}
	column := ""
	if hasCodeColumn {
		column = ", project_code varchar(3)"
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(
		`create table %s.projects (
			id bigint generated by default as identity primary key,
			project_name text not null,
			is_active boolean not null default true%s
		)`,
		schema,
		column,
	)); err != nil {
		t.Fatalf("create fixture projects table: %v", err)
	}
	return tx, schema
}

func seedProjectCodeProjects(
	t *testing.T,
	tx pgx.Tx,
	schema string,
	existing map[string]*string,
	hasCodeColumn bool,
) {
	t.Helper()
	ctx := context.Background()
	for _, expected := range projectCodeSeed {
		var code *string
		if existing != nil {
			code = existing[expected.name]
		}
		if hasCodeColumn {
			if _, err := tx.Exec(ctx,
				fmt.Sprintf(`insert into %s.projects (project_name, project_code) values ($1, $2)`, schema),
				expected.name,
				code,
			); err != nil {
				t.Fatalf("seed %q: %v", expected.name, err)
			}
			continue
		}
		if _, err := tx.Exec(ctx,
			fmt.Sprintf(`insert into %s.projects (project_name) values ($1)`, schema),
			expected.name,
		); err != nil {
			t.Fatalf("seed %q: %v", expected.name, err)
		}
	}

	if hasCodeColumn {
		if _, err := tx.Exec(ctx,
			fmt.Sprintf(`insert into %s.projects (project_name, project_code) values ('诗澜瑞', NULL)`, schema),
		); err != nil {
			t.Fatalf("seed 诗澜瑞: %v", err)
		}
		if existing != nil {
			if code := existing["弥森"]; code != nil {
				if _, err := tx.Exec(ctx,
					fmt.Sprintf(`insert into %s.projects (project_name, project_code) values ('弥森', $1)`, schema),
					*code,
				); err != nil {
					t.Fatalf("seed unrelated issued code: %v", err)
				}
			}
		}
		return
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(
		`insert into %s.projects (project_name) values ('诗澜瑞')`,
		schema,
	)); err != nil {
		t.Fatalf("seed 诗澜瑞: %v", err)
	}
}

func runProjectCodeMigration(ctx context.Context, tx pgx.Tx, schema string) error {
	source, err := FS.ReadFile("sql/20261120163907_add_project_code.sql")
	if err != nil {
		return err
	}
	var up strings.Builder
	inUp := false
	for _, line := range strings.Split(string(source), "\n") {
		switch strings.TrimSpace(line) {
		case "-- +goose Up":
			inUp = true
			continue
		case "-- +goose Down":
			inUp = false
		}
		if !inUp || strings.HasPrefix(strings.TrimSpace(line), "-- +goose Statement") {
			continue
		}
		up.WriteString(line)
		up.WriteByte('\n')
	}
	sql := strings.ReplaceAll(up.String(), "public.", schema+".")
	sql = strings.ReplaceAll(sql, "table_schema = 'public'", "table_schema = '"+schema+"'")
	_, err = tx.Exec(ctx, sql, pgx.QueryExecModeSimpleProtocol)
	return err
}

func assertProjectCodeMappings(t *testing.T, ctx context.Context, tx pgx.Tx, schema string) {
	t.Helper()
	for _, expected := range projectCodeSeed {
		var got string
		if err := tx.QueryRow(ctx, fmt.Sprintf(
			`select project_code from %s.projects where project_name = $1`,
			schema,
		), expected.name).Scan(&got); err != nil {
			t.Fatalf("read code for %q: %v", expected.name, err)
		}
		if got != expected.code {
			t.Errorf("project_code for %q = %q, want %q", expected.name, got, expected.code)
		}
	}
	var unassigned *string
	if err := tx.QueryRow(ctx, fmt.Sprintf(
		`select project_code from %s.projects where project_name = '诗澜瑞'`,
		schema,
	)).Scan(&unassigned); err != nil {
		t.Fatalf("read unassigned project code: %v", err)
	}
	if unassigned != nil {
		t.Errorf("诗澜瑞 project_code = %q, want NULL", *unassigned)
	}
}

func assertProjectCodeConstraintError(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	statement string,
	wantCode string,
	wantConstraint string,
) {
	t.Helper()
	nested, err := tx.Begin(ctx)
	if err != nil {
		t.Fatalf("begin constraint savepoint: %v", err)
	}
	_, err = nested.Exec(ctx, statement)
	if err == nil {
		_ = nested.Rollback(ctx)
		t.Fatalf("statement succeeded, want SQLSTATE %s / constraint %s", wantCode, wantConstraint)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != wantCode || pgErr.ConstraintName != wantConstraint {
		_ = nested.Rollback(ctx)
		t.Fatalf("statement error = %#v, want SQLSTATE %s / constraint %s", err, wantCode, wantConstraint)
	}
	if err := nested.Rollback(ctx); err != nil {
		t.Fatalf("rollback constraint savepoint: %v", err)
	}
}

func projectCodeTestPointer(value string) *string { return &value }
