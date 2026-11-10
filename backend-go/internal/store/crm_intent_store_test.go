package store

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm_intent"
)

func crmIntentTestDatabaseURL() string {
	if value := strings.TrimSpace(os.Getenv("CRM_INTENT_TEST_DATABASE_URL")); value != "" {
		return value
	}
	return strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
}

func TestDupFilterConditionSQLShape(t *testing.T) {
	builder := &argsBuilder{}
	condition := dupFilterCondition(builder, crm_intent.Scope{Name: crm_intent.ScopeAll})
	for _, want := range []string{
		"phone_normalized in (",
		"having count(distinct p2.company_id) >= 2",
	} {
		if !strings.Contains(condition, want) {
			t.Fatalf("dup condition missing %q: %s", want, condition)
		}
	}

	mineBuilder := &argsBuilder{}
	mineCondition := dupFilterCondition(mineBuilder, crm_intent.Scope{
		Name: crm_intent.ScopeMine, UserID: "user-1",
	})
	if !strings.Contains(mineCondition, "$1") {
		t.Fatalf("mine dup condition missing bound owner: %s", mineCondition)
	}
	if len(mineBuilder.args) != 1 || mineBuilder.args[0] != "user-1" {
		t.Fatalf("mine dup args = %+v", mineBuilder.args)
	}

	seaBuilder := &argsBuilder{}
	seaCondition := dupFilterCondition(seaBuilder, crm_intent.Scope{Name: crm_intent.ScopeSea})
	if !strings.Contains(seaCondition, "c2.owner_id is null") {
		t.Fatalf("sea dup condition missing owner filter: %s", seaCondition)
	}
}

// TestDupFilterConditionPostgres verifies the dup filter against a real
// PostgreSQL instance. Set CRM_INTENT_TEST_DATABASE_URL (or TEST_DATABASE_URL)
// to run it; it uses temporary tables only.
func TestDupFilterConditionPostgres(t *testing.T) {
	url := crmIntentTestDatabaseURL()
	if url == "" {
		t.Skip("CRM_INTENT_TEST_DATABASE_URL / TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	statements := []string{
		`create temp table dup_companies (id integer primary key, owner_id text) on commit drop`,
		`create temp table dup_phones (id serial primary key, company_id integer, phone_normalized text) on commit drop`,
		`insert into dup_companies (id, owner_id) values
			(1, 'user-1'), (2, 'user-1'), (3, null), (4, 'user-2'), (5, null)`,
		`insert into dup_phones (company_id, phone_normalized) values
			(1, '13800000001'), (2, '13800000001'), (3, '13800000001'),
			(4, '13900000002'), (5, '13800000001')`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			t.Fatalf("exec %q: %v", statement, err)
		}
	}

	queryIDs := func(scope crm_intent.Scope) []int64 {
		builder := &argsBuilder{}
		scopeCondition(builder, "c", scope)
		condition := dupFilterConditionForTables(
			builder, scope, "dup_phones", "dup_companies",
		)
		conditions := append([]string{}, builder.conditions...)
		conditions = append(conditions, condition)
		query := "select c.id from dup_companies c where " +
			strings.Join(conditions, " and ") + " order by c.id"
		rows, err := tx.Query(ctx, query, builder.args...)
		if err != nil {
			t.Fatalf("dup query (%s): %v", scope.Name, err)
		}
		defer rows.Close()
		ids := make([]int64, 0)
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				t.Fatalf("scan dup id: %v", err)
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("dup rows: %v", err)
		}
		return ids
	}

	allIDs := queryIDs(crm_intent.Scope{Name: crm_intent.ScopeAll})
	if len(allIDs) != 4 || allIDs[0] != 1 || allIDs[1] != 2 || allIDs[2] != 3 || allIDs[3] != 5 {
		t.Fatalf("all scope dup ids = %v, want [1 2 3 5]", allIDs)
	}
	mineIDs := queryIDs(crm_intent.Scope{Name: crm_intent.ScopeMine, UserID: "user-1"})
	if len(mineIDs) != 2 || mineIDs[0] != 1 || mineIDs[1] != 2 {
		t.Fatalf("mine scope dup ids = %v, want [1 2]", mineIDs)
	}
	seaIDs := queryIDs(crm_intent.Scope{Name: crm_intent.ScopeSea})
	if len(seaIDs) != 2 || seaIDs[0] != 3 || seaIDs[1] != 5 {
		t.Fatalf("sea scope dup ids = %v, want [3 5]", seaIDs)
	}
}

// TestRunRowSavepointIsolatesRowErrors verifies that an ingest row failure can
// be rolled back to its savepoint without losing earlier rows in the batch.
func TestRunRowSavepointIsolatesRowErrors(t *testing.T) {
	url := crmIntentTestDatabaseURL()
	if url == "" {
		t.Skip("CRM_INTENT_TEST_DATABASE_URL / TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `create temp table savepoint_rows (id integer primary key) on commit drop`); err != nil {
		t.Fatalf("create temp table: %v", err)
	}
	store := &CRMIntentStore{}
	db := NewTxDB(tx)

	if _, _, err := store.runRowSavepoint(ctx, db, func() (int64, upsertOutcome, error) {
		_, execErr := db.Exec(ctx, "insert into savepoint_rows (id) values (10)")
		return 10, upsertCreated, execErr
	}); err != nil {
		t.Fatalf("first row savepoint: %v", err)
	}

	_, _, rowErr := store.runRowSavepoint(ctx, db, func() (int64, upsertOutcome, error) {
		if _, execErr := db.Exec(ctx, "insert into savepoint_rows (id) values (11)"); execErr != nil {
			return 0, upsertCreated, execErr
		}
		// Simulate a data/constraint failure after partial writes.
		_, execErr := db.Exec(ctx, "insert into savepoint_rows (id) values (10)")
		return 11, upsertCreated, execErr
	})
	if rowErr == nil {
		t.Fatalf("duplicate row should fail")
	}
	if reason := rowRejectionReason(rowErr); reason == "" {
		t.Fatalf("constraint error should be row-rejected, got %v", rowErr)
	}

	if _, _, err := store.runRowSavepoint(ctx, db, func() (int64, upsertOutcome, error) {
		_, execErr := db.Exec(ctx, "insert into savepoint_rows (id) values (12)")
		return 12, upsertCreated, execErr
	}); err != nil {
		t.Fatalf("third row savepoint: %v", err)
	}

	rows, err := tx.Query(ctx, "select id from savepoint_rows order by id")
	if err != nil {
		t.Fatalf("select rows: %v", err)
	}
	defer rows.Close()
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan id: %v", err)
		}
		ids = append(ids, id)
	}
	if len(ids) != 2 || ids[0] != 10 || ids[1] != 12 {
		t.Fatalf("savepoint rows = %v, want [10 12]", ids)
	}
}

func TestEffectiveConvertOwner(t *testing.T) {
	existing := "user-9"
	if got := effectiveConvertOwner(&existing, crm_intent.Actor{
		Kind: crm_intent.ActorKindUser, ID: "user-1",
	}); got == nil || *got != "user-9" {
		t.Fatalf("existing owner should win, got %v", got)
	}
	if got := effectiveConvertOwner(nil, crm_intent.Actor{
		Kind: crm_intent.ActorKindUser, ID: " user-1 ",
	}); got == nil || *got != "user-1" {
		t.Fatalf("sea convert should fall back to actor, got %v", got)
	}
	if got := effectiveConvertOwner(nil, crm_intent.Actor{Kind: crm_intent.ActorKindAgent}); got != nil {
		t.Fatalf("empty actor should stay nil, got %v", got)
	}
}

func TestNormalizePhoneListDeduplicates(t *testing.T) {
	values, err := normalizePhoneList([]string{
		"13800000001", "138-0000-0001", "13900000002",
	})
	if err != nil {
		t.Fatalf("normalize phones: %v", err)
	}
	if len(values) != 2 || values[0] != "13800000001" || values[1] != "13900000002" {
		t.Fatalf("deduped phones = %v", values)
	}
	if _, err := normalizePhoneList([]string{"123"}); err == nil {
		t.Fatalf("short phone should fail")
	}
}

func TestSearchFiltersIncludePhones(t *testing.T) {
	query := "138"
	companyBuilder := &argsBuilder{}
	applyCompanyFilters(companyBuilder, crm_intent.CompanyFilter{
		Scope: crm_intent.Scope{Name: crm_intent.ScopeAll}, Query: &query,
	})
	companyFilter := strings.Join(companyBuilder.conditions, " and ")
	for _, want := range []string{
		"crm_intent_phones", "phone_raw ilike", "phone_normalized ilike",
	} {
		if !strings.Contains(companyFilter, want) {
			t.Fatalf("company q filter missing %q: %s", want, companyFilter)
		}
	}

	poolBuilder := &argsBuilder{}
	applyPoolFilters(poolBuilder, crm_intent.PoolFilter{Query: &query})
	poolFilter := strings.Join(poolBuilder.conditions, " and ")
	for _, want := range []string{"p.pool_id = pl.id", "phone_normalized ilike"} {
		if !strings.Contains(poolFilter, want) {
			t.Fatalf("pool q filter missing %q: %s", want, poolFilter)
		}
	}
}

func TestDupFilterConditionIsApplied(t *testing.T) {
	dup := true
	builder := &argsBuilder{}
	applyCompanyFilters(builder, crm_intent.CompanyFilter{
		Scope: crm_intent.Scope{Name: crm_intent.ScopeMine, UserID: "user-1"},
		Dup:   &dup,
	})
	joined := strings.Join(builder.conditions, " and ")
	if !strings.Contains(joined, "phone_normalized in (") {
		t.Fatalf("dup=true did not add the duplicate-phone condition: %s", joined)
	}
	// outer scope owner + dup subquery owner (same value, two placeholders).
	if len(builder.args) != 2 {
		t.Fatalf("dup filter args = %+v", builder.args)
	}
}

func TestFacetPoolScopeCondition(t *testing.T) {
	mineBuilder := &argsBuilder{}
	facetPoolScopeCondition(mineBuilder, crm_intent.Scope{
		Name: crm_intent.ScopeMine, UserID: "user-1",
	})
	if len(mineBuilder.conditions) != 1 ||
		!strings.Contains(mineBuilder.conditions[0], "pc.owner_id = $1") {
		t.Fatalf("mine facet pool condition = %+v", mineBuilder.conditions)
	}
	if len(mineBuilder.args) != 1 || mineBuilder.args[0] != "user-1" {
		t.Fatalf("mine facet pool args = %+v", mineBuilder.args)
	}

	seaBuilder := &argsBuilder{}
	facetPoolScopeCondition(seaBuilder, crm_intent.Scope{Name: crm_intent.ScopeSea})
	if len(seaBuilder.conditions) != 1 ||
		seaBuilder.conditions[0] != "pl.status = 'pending'" {
		t.Fatalf("sea facet pool condition = %+v", seaBuilder.conditions)
	}

	allBuilder := &argsBuilder{}
	facetPoolScopeCondition(allBuilder, crm_intent.Scope{Name: crm_intent.ScopeAll})
	if len(allBuilder.conditions) != 0 || len(allBuilder.args) != 0 {
		t.Fatalf("all facet pool condition should be empty: %+v", allBuilder.conditions)
	}
}

func TestBuildProfileUpdateSQLIncludesChannels(t *testing.T) {
	channel := "展会"
	channels := []string{"展会", "官网"}
	channelSource := "展会-2026-11-10.csv"
	input := crm_intent.ProfileUpdateInput{
		Channel:       crm_intent.Optional[string]{Set: true, Value: &channel},
		Channels:      crm_intent.Optional[[]string]{Set: true, Value: &channels},
		ChannelSource: crm_intent.Optional[string]{Set: true, Value: &channelSource},
	}
	query, args, err := buildProfileUpdateSQL(42, input, crm_intent.Actor{
		Kind: crm_intent.ActorKindUser, ID: "user-1",
	})
	if err != nil {
		t.Fatalf("build profile sql: %v", err)
	}
	for _, want := range []string{
		"channel = ", "channels = ", "channel_source = ",
		"human_touched_at = now()", "human_touched_by = ",
	} {
		if !strings.Contains(query, want) {
			t.Fatalf("profile SQL missing %q: %s", want, query)
		}
	}
	if len(args) != 5 {
		t.Fatalf("profile args = %+v, want 5", args)
	}
	if args[0] != "展会" || args[2] != "展会-2026-11-10.csv" ||
		args[3] != "user-1" || args[4] != int64(42) {
		t.Fatalf("profile args = %+v", args)
	}
	values, ok := args[1].([]string)
	if !ok || len(values) != 2 || values[0] != "展会" {
		t.Fatalf("profile channels arg = %+v", args[1])
	}
}
