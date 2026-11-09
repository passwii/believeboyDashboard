package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm"
)

func TestCRMFilterBuilderRejectsUnknownFieldsAndOperators(t *testing.T) {
	_, _, err := buildCRMFilterSQL("c", []crm.FilterCondition{{
		Field: "evil; drop table", Op: "eq", Value: "x",
	}}, 1, crmCustomerFilterFields)
	if err == nil {
		t.Fatal("expected unknown filter field to fail")
	}
	_, _, err = buildCRMFilterSQL("c", []crm.FilterCondition{{
		Field: "status", Op: "raw_sql", Value: "x",
	}}, 1, crmCustomerFilterFields)
	if err == nil {
		t.Fatal("expected unknown operator to fail")
	}
}

func TestCRMFilterBuilderParameterizesContainsAndBetween(t *testing.T) {
	clause, args, err := buildCRMFilterSQL("c", []crm.FilterCondition{
		{Field: "status", Op: "eq", Value: "active"},
		{Field: "industry", Op: "contains", Value: "100%_match"},
		{Field: "annualRevenue", Op: "between", Value: []any{float64(10), float64(20)}},
	}, 1, crmCustomerFilterFields)
	if err != nil {
		t.Fatalf("buildCRMFilterSQL() error = %v", err)
	}
	if clause == "" || len(args) != 4 {
		t.Fatalf("clause = %q, args = %#v", clause, args)
	}
	if args[1] != "%100\\%\\_match%" {
		t.Fatalf("contains arg = %#v, want escaped literal wildcard pattern", args[1])
	}
}

func TestComputeCRMValueRating(t *testing.T) {
	allA := crmCustomerScores{Scale: ptr("A"), Pay: ptr("A"), Fit: ptr("A"), Coop: ptr("A")}
	if got := computeCRMValueRating(allA); got == nil || *got != "A" {
		t.Fatalf("all A rating = %#v, want A", got)
	}
	mixed := crmCustomerScores{Scale: ptr("B"), Pay: ptr("C"), Fit: ptr("C"), Coop: ptr("C")}
	if got := computeCRMValueRating(mixed); got == nil || *got != "C" {
		t.Fatalf("mixed rating = %#v, want C", got)
	}
	incomplete := crmCustomerScores{Scale: ptr("A")}
	if got := computeCRMValueRating(incomplete); got != nil {
		t.Fatalf("incomplete rating = %#v, want nil", got)
	}
}

func TestCRMDaysUntilSunday(t *testing.T) {
	tests := []struct {
		weekday time.Weekday
		want    int
	}{
		{time.Monday, 6},
		{time.Tuesday, 5},
		{time.Wednesday, 4},
		{time.Thursday, 3},
		{time.Friday, 2},
		{time.Saturday, 1},
		{time.Sunday, 0},
	}
	for _, test := range tests {
		if got := crmDaysUntilSunday(test.weekday); got != test.want {
			t.Fatalf("crmDaysUntilSunday(%s) = %d, want %d", test.weekday, got, test.want)
		}
	}
}

func TestValidateRuleConditionsRejectsUnsupportedValues(t *testing.T) {
	err := validateCRMStoreRuleConditions([]crm.RuleConditionInput{{
		Field: "days_since_created", Operator: "gte", Value: ptr("seven"),
	}})
	if err == nil {
		t.Fatal("expected non-numeric gte value to fail")
	}
	err = validateCRMStoreRuleConditions([]crm.RuleConditionInput{{
		Field: "unknown", Operator: "eq", Value: ptr("x"),
	}})
	if err == nil {
		t.Fatal("expected unsupported field to fail")
	}
}

func TestCRMStoreWriteUsesSingleTransactionAndWritesAudit(t *testing.T) {
	db := &crmTestDB{row: crmTestRow{values: []any{int64(7)}}}
	store := NewCRMStore(db)
	id, err := store.createAuditedRow(
		context.Background(),
		"insert into public.crm_categories (name, sort_order) values ($1, $2) returning id",
		[]any{"家居", 1},
		"category",
		"create",
		"admin",
		"新建产品类目「家居」",
	)
	if err != nil {
		t.Fatalf("createAuditedRow() error = %v", err)
	}
	if id != 7 {
		t.Fatalf("id = %d, want 7", id)
	}
	if !db.tx.committed {
		t.Fatal("transaction was not committed")
	}
	foundAudit := false
	for _, call := range db.tx.execCalls {
		if len(call.args) >= 5 && call.args[0] == "category" && call.args[1] == int64(7) {
			foundAudit = true
		}
	}
	if !foundAudit {
		t.Fatalf("audit exec calls = %#v, want crm audit row", db.tx.execCalls)
	}
}

func TestCRMStoreWriteRollsBackWhenAuditFails(t *testing.T) {
	db := &crmTestDB{row: crmTestRow{values: []any{int64(7)}}}
	db.tx = &crmTestTx{execErr: errors.New("audit unavailable")}
	store := NewCRMStore(db)
	_, err := store.createAuditedRow(
		context.Background(),
		"insert into public.crm_categories (name, sort_order) values ($1, $2) returning id",
		[]any{"家居", 1},
		"category",
		"create",
		"admin",
		"新建产品类目「家居」",
	)
	if err == nil {
		t.Fatal("expected audit failure")
	}
	if db.tx.committed {
		t.Fatal("transaction committed despite audit failure")
	}
	if !db.tx.rolledBack {
		t.Fatal("transaction was not rolled back")
	}
}

func ptr[T any](value T) *T {
	return &value
}

type crmTestDB struct {
	row pgx.Row
	tx  *crmTestTx
}

func (db *crmTestDB) Query(context.Context, string, ...any) (Rows, error) {
	return nil, nil
}
func (db *crmTestDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return db.row
}
func (db *crmTestDB) Ping(context.Context) error { return nil }
func (db *crmTestDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
func (db *crmTestDB) Begin(context.Context) (pgx.Tx, error) {
	if db.tx == nil {
		db.tx = &crmTestTx{}
	}
	return db.tx, nil
}

type crmTestTx struct {
	committed  bool
	rolledBack bool
	execCalls  []crmExecCall
	execErr    error
}

type crmExecCall struct {
	sql  string
	args []any
}

func (tx *crmTestTx) Commit(context.Context) error {
	tx.committed = true
	return nil
}
func (tx *crmTestTx) Rollback(context.Context) error {
	tx.rolledBack = true
	return nil
}
func (tx *crmTestTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.execCalls = append(tx.execCalls, crmExecCall{sql: sql, args: args})
	if tx.execErr != nil {
		return pgconn.CommandTag{}, tx.execErr
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}
func (tx *crmTestTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, nil
}
func (tx *crmTestTx) QueryRow(context.Context, string, ...any) pgx.Row {
	return crmTestRow{values: []any{int64(7)}}
}
func (tx *crmTestTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (tx *crmTestTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	return nil
}
func (tx *crmTestTx) LargeObjects() pgx.LargeObjects { return pgx.LargeObjects{} }
func (tx *crmTestTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}
func (tx *crmTestTx) Conn() *pgx.Conn { return nil }
func (tx *crmTestTx) Begin(context.Context) (pgx.Tx, error) {
	return tx, nil
}

type crmTestRow struct {
	values []any
	err    error
}

func (row crmTestRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(dest) != len(row.values) {
		return errors.New("scan destination count mismatch")
	}
	for index, value := range row.values {
		target := reflect.ValueOf(dest[index])
		source := reflect.ValueOf(value)
		if target.Kind() != reflect.Pointer {
			return errors.New("scan destination is not pointer")
		}
		if source.Type().AssignableTo(target.Elem().Type()) {
			target.Elem().Set(source)
			continue
		}
		return errors.New("scan value type mismatch")
	}
	return nil
}
