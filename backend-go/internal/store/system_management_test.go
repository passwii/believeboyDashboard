package store

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/system_management"
)

type smStage8BQuery struct {
	sql  string
	args []any
}

type smStage8BDB struct {
	queryResults  []Rows
	queryRow      []pgx.Row
	queryCalls    []smStage8BQuery
	queryRowCalls []smStage8BQuery
	execCalls     []smStage8BQuery
	queryErr      error
	execErr       error
	tx            *smStage8BTx
}

func (d *smStage8BDB) Query(_ context.Context, sql string, args ...any) (Rows, error) {
	d.queryCalls = append(d.queryCalls, smStage8BQuery{sql: sql, args: args})
	if d.queryErr != nil {
		return nil, d.queryErr
	}
	if len(d.queryResults) == 0 {
		return &smStage8BRows{}, nil
	}
	next := d.queryResults[0]
	d.queryResults = d.queryResults[1:]
	return next, nil
}

func (d *smStage8BDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	d.queryRowCalls = append(d.queryRowCalls, smStage8BQuery{sql: sql, args: args})
	if len(d.queryRow) == 0 {
		return smStage8BRow{}
	}
	next := d.queryRow[0]
	d.queryRow = d.queryRow[1:]
	return next
}

func (d *smStage8BDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	d.execCalls = append(d.execCalls, smStage8BQuery{sql: sql, args: args})
	return pgconn.NewCommandTag("UPDATE 1"), d.execErr
}

func (d *smStage8BDB) Ping(context.Context) error { return nil }

func (d *smStage8BDB) Begin(context.Context) (pgx.Tx, error) {
	tx := &smStage8BTx{db: d}
	d.tx = tx
	return tx, nil
}

type smStage8BTx struct {
	db         *smStage8BDB
	committed  bool
	rolledBack bool
}

func (t *smStage8BTx) Begin(context.Context) (pgx.Tx, error) { return t, nil }
func (t *smStage8BTx) Commit(context.Context) error {
	t.committed = true
	return nil
}
func (t *smStage8BTx) Rollback(context.Context) error {
	if !t.committed {
		t.rolledBack = true
	}
	return nil
}
func (t *smStage8BTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return t.db.Exec(ctx, sql, args...)
}
func (t *smStage8BTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	rows, err := t.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return smStage8BPGXRows{Rows: rows}, nil
}
func (t *smStage8BTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return t.db.QueryRow(ctx, sql, args...)
}
func (t *smStage8BTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (t *smStage8BTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (t *smStage8BTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (t *smStage8BTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}
func (t *smStage8BTx) Conn() *pgx.Conn { return nil }

type smStage8BPGXRows struct{ Rows }

func (r smStage8BPGXRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }
func (r smStage8BPGXRows) FieldDescriptions() []pgconn.FieldDescription {
	return nil
}
func (r smStage8BPGXRows) Values() ([]any, error) { return nil, nil }
func (r smStage8BPGXRows) RawValues() [][]byte    { return nil }
func (r smStage8BPGXRows) Conn() *pgx.Conn        { return nil }
func (r smStage8BPGXRows) TypeMap() *pgtype.Map   { return pgtype.NewMap() }

type smStage8BRows struct {
	values [][]any
	index  int
}

func (r *smStage8BRows) Next() bool {
	if r.index >= len(r.values) {
		return false
	}
	r.index++
	return true
}
func (r *smStage8BRows) Scan(dest ...any) error {
	return scanValues(dest, r.values[r.index-1])
}
func (r *smStage8BRows) Err() error { return nil }
func (r *smStage8BRows) Close()     {}

type smStage8BRow struct {
	values []any
	err    error
}

func (r smStage8BRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	return scanValues(dest, r.values)
}

func TestStage8BCommissionAlgorithmIsExplicitAndRoundHalfUp(t *testing.T) {
	income := big.NewRat(1000, 1)
	payback := big.NewRat(500, 1)
	cashBasis := "cash_received"
	rate, commission := resolveFactoryCommission(&cashBasis, nil, income, payback)
	if rate.Cmp(big.NewRat(10, 100)) != 0 || commission.Cmp(big.NewRat(50, 1)) != 0 {
		t.Fatalf("cash_received rate=%s commission=%s", formatRat(rate, 6), formatRat(commission, 2))
	}
	salesBasis := "sales_amount"
	configured := 0.15
	rate, commission = resolveFactoryCommission(&salesBasis, &configured, income, payback)
	if rate.Cmp(big.NewRat(15, 100)) != 0 || commission.Cmp(big.NewRat(150, 1)) != 0 {
		t.Fatalf("sales_amount rate=%s commission=%s", formatRat(rate, 6), formatRat(commission, 2))
	}
	if rounded := roundDecimalRat(big.NewRat(1, 200), 2); rounded.Cmp(big.NewRat(1, 100)) != 0 {
		t.Fatalf("0.005 rounded = %s, want 0.01", formatRat(rounded, 2))
	}
}

func TestStage8BDefaultBonusRatiosSplitDeduplicatedRoles(t *testing.T) {
	ratios := buildDefaultBonusRatios(
		big.NewRat(10000, 1),
		[]string{"alice", "bob"},
		[]string{"carol"},
	)
	if got := formatRat(ratios[bonusRoleKey{personName: "alice", incomeCategory: "operator"}], 6); got != "0.060000" {
		t.Fatalf("alice ratio = %s, want 0.060000", got)
	}
	if got := formatRat(ratios[bonusRoleKey{personName: "carol", incomeCategory: "assistant"}], 6); got != "0.020000" {
		t.Fatalf("assistant ratio = %s, want 0.020000", got)
	}
	if got := dedupeNames([]string{" alice ", "alice", "", "bob"}); len(got) != 2 {
		t.Fatalf("dedupeNames() = %#v", got)
	}
}

func TestStage8BAuditListParameterizesAllValues(t *testing.T) {
	createdAt := time.Date(2026, 11, 8, 2, 3, 4, 0, time.UTC)
	db := &smStage8BDB{
		queryRow: []pgx.Row{smStage8BRow{values: []any{1}}},
		queryResults: []Rows{&smStage8BRows{values: [][]any{{
			int64(7),
			createdAt,
			pgtype.Text{String: "admin", Valid: true},
			"commission.bonus.recompute",
			"commission_bonus_record",
			pgtype.Text{String: "2026-10", Valid: true},
			"success",
			pgtype.Text{},
			pgtype.Text{String: "POST", Valid: true},
			pgtype.Text{String: "/recompute", Valid: true},
			pgtype.Text{},
			pgtype.Text{},
			[]byte(`{"before":true}`),
			[]byte(`{"record_count":2}`),
			pgtype.Text{},
		}}}},
	}
	store := NewSystemManagementStore(db)
	malicious := "x'; drop table users;--"
	page, err := store.ListAuditLogs(context.Background(), system_management.AuditLogFilter{
		Page:     1,
		PageSize: 20,
		Operator: "adm",
		Keyword:  malicious,
	})
	if err != nil {
		t.Fatalf("ListAuditLogs() error = %v", err)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != 7 {
		t.Fatalf("ListAuditLogs() = %#v", page)
	}
	if len(db.queryCalls) != 1 || len(db.queryRowCalls) != 1 {
		t.Fatalf("queries = %#v / %#v", db.queryCalls, db.queryRowCalls)
	}
	query := db.queryCalls[0]
	if strings.Contains(query.sql, malicious) {
		t.Fatalf("user value was interpolated into SQL: %s", query.sql)
	}
	if !strings.Contains(query.sql, "$1") || !strings.Contains(query.sql, "limit $3") {
		t.Fatalf("query placeholders missing: %s", query.sql)
	}
	found := false
	for _, arg := range query.args {
		if value, ok := arg.(string); ok && value == "%"+malicious+"%" {
			found = true
		}
	}
	if !found {
		t.Fatalf("keyword arg not parameterized: %#v", query.args)
	}
}

func TestStage8BAgentOperationDerivations(t *testing.T) {
	path := "/api/v1/agent/projects/42/shipments/SH-2026-01"
	before := map[string]any{"project_id": float64(43), "shipment_no": "SH-OLD"}
	after := map[string]any{"project_id": "44"}
	if got := deriveAgentProjectID(&path, before, after); got == nil || *got != 42 {
		t.Fatalf("project_id = %#v, want path-derived 42", got)
	}
	if got := deriveAgentTargetLabel(&path, before, after); got == nil || *got != "SH-OLD" {
		t.Fatalf("target label = %#v, want payload-derived SH-OLD", got)
	}
	if got := deriveAgentOperationType("shipment.status.transition"); got == nil || *got != "shipments" {
		t.Fatalf("operation type = %#v", got)
	}
}

func TestStage8BDataManagementQuotesCatalogTableNames(t *testing.T) {
	checkedAt := time.Date(2026, 11, 8, 4, 5, 6, 0, time.UTC)
	weirdTable := `evil"; drop table projects;--`
	db := &smStage8BDB{
		queryRow: []pgx.Row{
			smStage8BRow{values: []any{1}},
			smStage8BRow{err: pgx.ErrNoRows},
			smStage8BRow{values: []any{int64(3)}},
			smStage8BRow{values: []any{&checkedAt}},
			smStage8BRow{values: []any{0}},
		},
		queryResults: []Rows{
			&smStage8BRows{values: [][]any{{weirdTable}}},
			&smStage8BRows{values: [][]any{{weirdTable, "updated_at"}}},
		},
	}
	store := NewSystemManagementStore(db)
	store.now = func() time.Time { return checkedAt }
	snapshot, err := store.InspectDataManagement(context.Background())
	if err != nil {
		t.Fatalf("InspectDataManagement() error = %v", err)
	}
	if snapshot.Summary.TotalTables != 1 || snapshot.Summary.TotalRows != 3 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if len(db.queryRowCalls) < 3 {
		t.Fatalf("queryRow calls = %#v", db.queryRowCalls)
	}
	quoted := pgx.Identifier{weirdTable}.Sanitize()
	if !strings.Contains(db.queryRowCalls[2].sql, quoted) {
		t.Fatalf("count SQL does not quote catalog table name %q: %s", quoted, db.queryRowCalls[2].sql)
	}
	if !strings.Contains(db.queryRowCalls[3].sql, quoted) ||
		!strings.Contains(db.queryRowCalls[3].sql, pgx.Identifier{"updated_at"}.Sanitize()) {
		t.Fatalf("max SQL does not quote identifiers: %s", db.queryRowCalls[3].sql)
	}
}

func TestStage8BCommissionUpsertAndRecomputeUseTransactions(t *testing.T) {
	now := time.Date(2026, 11, 8, 3, 4, 5, 0, time.UTC)
	db := &smStage8BDB{
		queryResults: []Rows{
			&smStage8BRows{},
			&smStage8BRows{},
			&smStage8BRows{},
		},
		queryRow: []pgx.Row{
			smStage8BRow{values: []any{int64(11)}},
			smStage8BRow{values: []any{int64(12)}},
		},
	}
	store := NewSystemManagementStore(db)
	_, err := store.UpsertCommissionRecords(
		context.Background(),
		"2026-10",
		"US",
		[]system_management.CommissionRecordUpsertItem{{
			ProjectID:             1,
			ProjectName:           "project'); drop table commission_records;--",
			PersonName:            "alice",
			IncomeCategory:        "operator",
			IncomeTotalUSD:        1000,
			FactoryCommissionRate: 0.15,
			OperatorBonusRatio:    0.1,
			BonusAmountUSD:        15,
			USDToRMBRate:          7,
			BonusAmountRMB:        105,
			BonusRatioSource:      "rule",
		}},
		now,
	)
	if err != nil {
		t.Fatalf("UpsertCommissionRecords() error = %v", err)
	}
	if db.tx == nil || !db.tx.committed {
		t.Fatalf("transaction committed=%v rolled_back=%v", db.tx != nil && db.tx.committed, db.tx != nil && db.tx.rolledBack)
	}
	if len(db.queryRowCalls) != 2 ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "returning id") ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[1].sql), "returning id") {
		t.Fatalf("project-month insert calls = %#v", db.queryRowCalls)
	}
	if strings.Contains(db.queryRowCalls[1].sql, "drop table") {
		t.Fatalf("record value interpolated into SQL: %s", db.queryRowCalls[1].sql)
	}

	recomputeDB := &smStage8BDB{queryResults: []Rows{&smStage8BRows{}}}
	recomputeStore := NewSystemManagementStore(recomputeDB)
	country := "US"
	result, err := recomputeStore.RecomputeCommission(context.Background(), system_management.RecomputeCommissionInput{
		ReportMonth: "2026-10",
		Country:     &country,
		Now:         now,
	})
	if err != nil {
		t.Fatalf("RecomputeCommission() error = %v", err)
	}
	if result.ProjectMonthCount != 0 || result.RecordCount != 0 {
		t.Fatalf("RecomputeCommission() = %#v", result)
	}
	if recomputeDB.tx == nil || !recomputeDB.tx.committed {
		t.Fatalf("recompute transaction committed=%v rolled_back=%v",
			recomputeDB.tx != nil && recomputeDB.tx.committed,
			recomputeDB.tx != nil && recomputeDB.tx.rolledBack,
		)
	}

	rollbackDB := &smStage8BDB{queryErr: errors.New("database down")}
	rollbackStore := NewSystemManagementStore(rollbackDB)
	if _, err := rollbackStore.RecomputeCommission(context.Background(), system_management.RecomputeCommissionInput{
		ReportMonth: "2026-10",
		Country:     &country,
		Now:         now,
	}); err == nil {
		t.Fatal("RecomputeCommission() error = nil, want rollback error")
	}
	if rollbackDB.tx == nil || rollbackDB.tx.committed || !rollbackDB.tx.rolledBack {
		t.Fatalf("rollback transaction committed=%v rolled_back=%v",
			rollbackDB.tx != nil && rollbackDB.tx.committed,
			rollbackDB.tx != nil && rollbackDB.tx.rolledBack,
		)
	}
}
