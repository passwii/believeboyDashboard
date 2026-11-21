package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func TestProjectStoreListManageFiltersAndMapsNullableProjectFields(t *testing.T) {
	db := &fakeDB{rows: &fakeRows{batches: [][]any{projectScanValues()}}}
	store := NewProjectStore(projectTestDB{fakeDB: db})

	items, err := store.ListManage(context.Background(), "运营甲", false, true)
	if err != nil {
		t.Fatalf("ListManage() error = %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %#v, want one project", items)
	}
	item := items[0]
	if item.ID != 7 || item.Name != "北美" || item.ProjectOperator == nil ||
		*item.ProjectOperator != "运营甲" || item.CommissionRate == nil ||
		*item.CommissionRate != 0.05 || !item.HasContext || !item.IsActive {
		t.Fatalf("project item = %#v, want scanned row and computed context", item)
	}
	if item.ProjectCode == nil || *item.ProjectCode != "QUF" {
		t.Fatalf("project_code = %#v, want QUF", item.ProjectCode)
	}
	if item.Country != "US" || item.CountryName == nil || *item.CountryName != "美国站" {
		t.Errorf("country fields = %q %#v", item.Country, item.CountryName)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("Query() calls = %d, want one", len(db.queryCalls))
	}
	query := db.queryCalls[0]
	for _, fragment := range []string{"regexp_split_to_array", "coalesce(is_active, true) desc, sort_order asc, id asc"} {
		if !strings.Contains(query.sql, fragment) {
			t.Errorf("SQL is missing %q: %s", fragment, query.sql)
		}
	}
	assertArgs(t, query.args, []any{true, false, "运营甲"})
}

func TestProjectStoreListProjectShopsDecodesSellerAliases(t *testing.T) {
	db := &fakeDB{rows: &fakeRows{batches: [][]any{{
		int64(11), "US", "shop-1",
		pgtype.Text{String: "北美店", Valid: true},
		pgtype.Text{String: "seller", Valid: true},
		pgtype.Text{String: `["seller","seller 2"]`, Valid: true},
		pgtype.Text{String: "manual", Valid: true},
		true,
	}}}}

	items, err := NewProjectStore(projectTestDB{fakeDB: db}).ListProjectShops(context.Background(), 7)
	if err != nil {
		t.Fatalf("ListProjectShops() error = %v", err)
	}
	if len(items) != 1 || items[0].ID != 11 || items[0].ShopID != "shop-1" ||
		items[0].ShopName == nil || *items[0].ShopName != "北美店" ||
		len(items[0].SellerIdentityAliases) != 2 ||
		items[0].SellerIdentityAliases[1] != "seller 2" {
		t.Fatalf("shops = %#v, want decoded shop and aliases", items)
	}
	if len(db.queryCalls) != 1 ||
		!strings.Contains(db.queryCalls[0].sql, "order by country asc") {
		t.Errorf("shop query = %#v, want country ordering", db.queryCalls)
	}
	assertArgs(t, db.queryCalls[0].args, []any{int64(7)})
}

func TestMergeProjectContextRecursivelyMergesObjectsAndReplacesOtherValues(t *testing.T) {
	base := map[string]any{
		"brand":  "A",
		"market": map[string]any{"country": "US", "currency": "USD"},
	}
	patch := map[string]any{
		"market": map[string]any{"currency": "CAD"},
		"active": true,
	}
	got := mergeProjectContext(base, patch)
	if got["brand"] != "A" || got["active"] != true {
		t.Fatalf("merged context = %#v", got)
	}
	market, ok := got["market"].(map[string]any)
	if !ok || market["country"] != "US" || market["currency"] != "CAD" {
		t.Fatalf("merged market = %#v, want recursive merge", got["market"])
	}
}

func TestDecodeProjectContextTreatsEmptyObjectAsEmptyMap(t *testing.T) {
	got, err := decodeProjectContext([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("decodeProjectContext() = %#v, want non-nil empty map", got)
	}
}

func projectScanValues() []any {
	return []any{
		int64(7),
		"北美",
		pgtype.Text{String: "QUF", Valid: true},
		pgtype.Text{String: "Brand", Valid: true},
		pgtype.Text{},
		pgtype.Text{String: "运营甲", Valid: true},
		pgtype.Text{},
		pgtype.Text{String: "sales_amount", Valid: true},
		numericFromString("0.0500"),
		4,
		true,
		pgtype.Text{String: "manual_single_add", Valid: true},
		pgtype.Text{String: `{"brand":"A"}`, Valid: true},
		pgtype.Text{String: `{}`, Valid: true},
		pgtype.Text{String: "T1", Valid: true},
		"US",
		false,
	}
}

func TestProjectStoreCreatePersistsProjectCode(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: projectScanValues()},
	}}}
	code := "QUF"
	item, err := NewProjectStore(db).CreateProject(context.Background(), projects.CreateProjectInput{
		Name:        "铨富",
		ProjectCode: &code,
		Country:     "US",
	})
	if err != nil {
		t.Fatalf("CreateProject() error = %v", err)
	}
	if item.ProjectCode == nil || *item.ProjectCode != code {
		t.Fatalf("created project_code = %#v, want %q", item.ProjectCode, code)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want one", len(db.queryRowCalls))
	}
	call := db.queryRowCalls[0]
	if !strings.Contains(call.sql, "vat_enabled, project_code") || !strings.Contains(call.sql, "$10, $11") {
		t.Fatalf("create SQL does not persist project_code: %s", call.sql)
	}
	if len(call.args) != 11 {
		t.Fatalf("create args = %#v, want 11 values", call.args)
	}
	if got, ok := call.args[10].(*string); !ok || got == nil || *got != code {
		t.Fatalf("project_code arg = %#v, want pointer to %q", call.args[10], code)
	}
}

func TestProjectStoreUpdateWritesProjectCode(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: projectScanValues()},
	}}}
	code := "XNU"
	item, err := NewProjectStore(db).UpdateProject(context.Background(), 7, projects.UpdateProjectInput{
		Name:        "北美",
		ProjectCode: &code,
	})
	if err != nil {
		t.Fatalf("UpdateProject() error = %v", err)
	}
	if item.ProjectCode == nil || *item.ProjectCode != "QUF" {
		t.Fatalf("returned project_code = %#v, want scanned QUF", item.ProjectCode)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("QueryRow() calls = %d, want one", len(db.queryRowCalls))
	}
	call := db.queryRowCalls[0]
	if !strings.Contains(call.sql, "project_code = $3") ||
		len(call.args) != 3 || call.args[0] != int64(7) || call.args[1] != "北美" {
		t.Fatalf("update SQL/args = %s / %#v, want project_code at $3", call.sql, call.args)
	}
	if got, ok := call.args[2].(*string); !ok || got == nil || *got != code {
		t.Fatalf("project_code arg = %#v, want pointer to %q", call.args[2], code)
	}
}

func TestMapProjectCodeConstraintsToConflictAndValidationErrors(t *testing.T) {
	tests := []struct {
		name       string
		pgError    *pgconn.PgError
		wantStatus int
		wantDetail string
	}{
		{
			name:       "duplicate code",
			pgError:    &pgconn.PgError{Code: "23505", ConstraintName: "uq_projects_project_code"},
			wantStatus: http.StatusConflict,
			wantDetail: "project_code is already assigned",
		},
		{
			name:       "immutable code",
			pgError:    &pgconn.PgError{Code: "23514", ConstraintName: "projects_project_code_immutable"},
			wantStatus: http.StatusConflict,
			wantDetail: "project_code cannot be changed once assigned",
		},
		{
			name:       "format check",
			pgError:    &pgconn.PgError{Code: "23514", ConstraintName: "projects_project_code_format_check"},
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "project_code must match ^[A-Z]{3}$ and cannot be ALL",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, detail := projects.HTTPError(mapProjectConstraintError(test.pgError))
			if status != test.wantStatus || detail != test.wantDetail {
				t.Fatalf("HTTPError() = (%d, %q), want (%d, %q)", status, detail, test.wantStatus, test.wantDetail)
			}
		})
	}
}

type projectTestDB struct {
	*fakeDB
}

func (projectTestDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (projectTestDB) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("unexpected transaction")
}

func TestProjectContextMergeProducesValidJSON(t *testing.T) {
	merged := mergeProjectContext(
		map[string]any{"old": "value"},
		map[string]any{"new": "value"},
	)
	if _, err := json.Marshal(merged); err != nil {
		t.Fatalf("merged context is not JSON serializable: %v", err)
	}
}

func TestProjectStoreMoveAuditedCommitsReorderAndAuditAtomically(t *testing.T) {
	db := &stage10EProjectDB{
		fakeWriteDB: &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
			fakeRow{values: []any{4, true}},
			fakeRow{values: []any{int64(8), 3}},
			fakeRow{values: projectScanValues()},
		}}},
	}
	store := NewProjectStore(db)
	entry := audit.Entry{
		Action:     "projects.move_up",
		TargetType: "project",
		TargetID:   stringTestPointer("7"),
		Operator:   stringTestPointer("运营甲"),
		Result:     "success",
	}

	item, err := store.MoveProjectAudited(context.Background(), 7, "up", entry)
	if err != nil {
		t.Fatalf("MoveProjectAudited() error = %v", err)
	}
	if item.ID != 7 {
		t.Fatalf("item = %#v, want project 7", item)
	}
	if !db.committed || db.lastTx == nil {
		t.Fatalf("transaction committed = %v, tx = %#v", db.committed, db.lastTx)
	}
	if len(db.execCalls) != 2 {
		t.Fatalf("Exec calls = %d, want reorder + audit", len(db.execCalls))
	}
	if !strings.Contains(db.execCalls[1].sql, "operation_audit_logs") {
		t.Fatalf("second Exec = %s, want audit insert", db.execCalls[1].sql)
	}
}

func TestProjectStoreMoveAuditedRollsBackWhenAuditFails(t *testing.T) {
	db := &stage10EProjectDB{
		fakeWriteDB: &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
			fakeRow{values: []any{4, true}},
			fakeRow{values: []any{int64(8), 3}},
			fakeRow{values: projectScanValues()},
		}}},
	}
	store := NewProjectStore(db, stage10EFailingAudit{})
	_, err := store.MoveProjectAudited(context.Background(), 7, "up", audit.Entry{
		Action:     "projects.move_up",
		TargetType: "project",
	})
	if err == nil || !strings.Contains(err.Error(), "audit unavailable") {
		t.Fatalf("MoveProjectAudited() error = %v, want audit failure", err)
	}
	if !db.rolledBack {
		t.Fatal("transaction committed despite audit failure")
	}
}

type stage10EProjectDB struct {
	*fakeWriteDB
	lastTx     *stage10EProjectTx
	committed  bool
	rolledBack bool
}

func (db *stage10EProjectDB) Begin(ctx context.Context) (pgx.Tx, error) {
	tx := &fakeTx{fakeWriteDB: db.fakeWriteDB}
	projectTx := &stage10EProjectTx{fakeTx: tx, parent: db}
	db.lastTx = projectTx
	return projectTx, nil
}

type stage10EProjectTx struct {
	*fakeTx
	parent *stage10EProjectDB
}

func (tx *stage10EProjectTx) Commit(ctx context.Context) error {
	if err := tx.fakeTx.Commit(ctx); err != nil {
		return err
	}
	tx.parent.committed = true
	return nil
}

func (tx *stage10EProjectTx) Rollback(ctx context.Context) error {
	if err := tx.fakeTx.Rollback(ctx); err != nil {
		return err
	}
	tx.parent.rolledBack = true
	return nil
}

type stage10EFailingAudit struct{}

func (stage10EFailingAudit) LogAction(context.Context, audit.Entry) error {
	return errors.New("audit unavailable")
}

func (stage10EFailingAudit) LogActionTx(context.Context, pgx.Tx, audit.Entry) error {
	return errors.New("audit unavailable")
}

func (stage10EFailingAudit) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}

func stringTestPointer(value string) *string {
	return &value
}
