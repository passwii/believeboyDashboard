package store

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
	"github.com/jackc/pgx/v5/pgtype"
	amazon_review_tracking "github.com/passwii/believeboyDashboard/backend-go/internal/api/amazon_review_tracking"
)

func TestAmazonReviewTrackingStoreReadsSessionAccount(t *testing.T) {
	db := &fakeDB{
		row: fakeRow{values: []any{
			true,
			true,
			pgtype.Text{String: "operator", Valid: true},
		}},
	}
	fullDB := &fakeWriteDB{fakeDB: db}
	store := NewAmazonReviewTrackingStore(fullDB)
	account, err := store.GetSessionAccount(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("GetSessionAccount() error = %v", err)
	}
	if account == nil || !account.IsAdmin || !account.IsActive || account.RoleType != "operator" {
		t.Fatalf("account = %#v", account)
	}
	if len(db.queryRowCalls) != 1 ||
		!strings.Contains(strings.ToLower(db.queryRowCalls[0].sql), "public.user_accounts") {
		t.Fatalf("query = %#v, want user_accounts lookup", db.queryRowCalls)
	}
	if !assertWriteArgsEqual(db.queryRowCalls[0].args, []any{"user-1"}) {
		t.Fatalf("args = %#v, want user-1", db.queryRowCalls[0].args)
	}
}

func TestAmazonReviewTrackingStoreMissingSessionAccountIsNil(t *testing.T) {
	db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store := NewAmazonReviewTrackingStore(&fakeWriteDB{fakeDB: db})
	account, err := store.GetSessionAccount(context.Background(), "missing")
	if err != nil {
		t.Fatalf("GetSessionAccount() error = %v", err)
	}
	if account != nil {
		t.Fatalf("account = %#v, want nil", account)
	}
}

func TestAmazonReviewTrackingStoreTargetListUsesProjectScope(t *testing.T) {
	db := &fakeDB{rowsQueueQuery: []Rows{&fakeRows{}}}
	store := NewAmazonReviewTrackingStore(&fakeWriteDB{fakeDB: db})
	projectID := int64(10)
	active := true
	_, err := store.ListTargets(context.Background(), amazon_review_tracking.TargetListFilter{
		ProjectID: &projectID,
		IsActive:  &active,
		Limit:     25,
		Offset:    5,
		Operator:  "operator-a",
		IsAdmin:   false,
	})
	if err != nil {
		t.Fatalf("ListTargets() error = %v", err)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.queryCalls))
	}
	sql := strings.ToLower(db.queryCalls[0].sql)
	for _, fragment := range []string{
		"amazon_review_targets",
		"project_operator",
		"assistant_operator",
		"coalesce(p.is_active, true)",
		"kind = 'external_asin'",
		"order by t.id asc",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("target query missing %q: %s", fragment, sql)
		}
	}
	wantArgs := []any{projectID, active, "operator-a", int64(25), int64(5)}
	if !assertWriteArgsEqual(db.queryCalls[0].args, wantArgs) {
		t.Fatalf("args = %#v, want %#v", db.queryCalls[0].args, wantArgs)
	}
}

func TestAmazonReviewTrackingStoreTargetListAdminBypassesProjectScope(t *testing.T) {
	db := &fakeDB{rowsQueueQuery: []Rows{&fakeRows{}}}
	store := NewAmazonReviewTrackingStore(&fakeWriteDB{fakeDB: db})
	_, err := store.ListTargets(context.Background(), amazon_review_tracking.TargetListFilter{
		Limit:    10,
		Offset:   0,
		Operator: "ignored",
		IsAdmin:  true,
	})
	if err != nil {
		t.Fatalf("ListTargets() error = %v", err)
	}
	sql := strings.ToLower(db.queryCalls[0].sql)
	if strings.Contains(sql, "project_operator") || strings.Contains(sql, "assistant_operator") {
		t.Fatalf("admin query unexpectedly contains project operator scope: %s", sql)
	}
	if !assertWriteArgsEqual(db.queryCalls[0].args, []any{int64(10), int64(0)}) {
		t.Fatalf("args = %#v", db.queryCalls[0].args)
	}
}

func TestAmazonReviewTrackingStoreSubresourceTargetScope(t *testing.T) {
	db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store := NewAmazonReviewTrackingStore(&fakeWriteDB{fakeDB: db})
	_, err := store.ListReviews(context.Background(), amazon_review_tracking.ReviewFilter{
		TargetID: 5,
		Limit:    100,
		Offset:   0,
		Operator: "operator-a",
		IsAdmin:  false,
	})
	if err == nil {
		t.Fatal("ListReviews() error = nil, want scoped target not found")
	}
	var apiErr *amazon_review_tracking.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 404 {
		t.Fatalf("ListReviews() error = %v, want 404", err)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("target access calls = %d, want 1", len(db.queryRowCalls))
	}
	sql := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(sql, "project_operator") || !strings.Contains(sql, "assistant_operator") {
		t.Fatalf("subresource target lookup missing project scope: %s", sql)
	}
	if !assertWriteArgsEqual(db.queryRowCalls[0].args, []any{int64(5), "operator-a"}) {
		t.Fatalf("args = %#v, want target id and operator", db.queryRowCalls[0].args)
	}
}

func TestAmazonReviewTrackingStoreTargetScopeSQLSupportsExternalTargets(t *testing.T) {
	condition := amazonReviewTargetScopeCondition(4)
	for _, fragment := range []string{
		"t.kind = 'external_asin'",
		"p.id = t.project_id",
		"coalesce(p.is_active, true)",
		"$4::text <> ''",
		"btrim(names.value) = $4",
		"project_operator",
		"assistant_operator",
	} {
		if !strings.Contains(condition, fragment) {
			t.Errorf("scope condition missing %q: %s", fragment, condition)
		}
	}
}

func TestAmazonReviewTrackingStoreMapsUniqueConflictsTo409(t *testing.T) {
	err := mapAmazonReviewConstraintError(&pgconn.PgError{
		Code:           "23505",
		ConstraintName: "uq_amazon_review_group_members_active_sku",
	})
	var apiErr *amazon_review_tracking.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 409 {
		t.Fatalf("unique conflict = %#v, want 409", err)
	}
}

func TestAmazonReviewTrackingStoreMapsForeignKeyAndCheckErrorsTo422(t *testing.T) {
	for _, code := range []string{"23503", "23514"} {
		err := mapAmazonReviewConstraintError(&pgconn.PgError{Code: code})
		var apiErr *amazon_review_tracking.Error
		if !errors.As(err, &apiErr) || apiErr.Status != 422 {
			t.Fatalf("constraint %s = %#v, want 422", code, err)
		}
	}
}

func TestAmazonReviewTrackingStoreQueriesRealModelTables(t *testing.T) {
	db := &fakeDB{
		rowsQueueQuery: []Rows{
			&fakeRows{},
		},
	}
	store := NewAmazonReviewTrackingStore(&fakeWriteDB{fakeDB: db})
	_, err := store.ListExternalTargets(context.Background(), 20, 0)
	if err != nil {
		t.Fatalf("ListExternalTargets() error = %v", err)
	}
	if len(db.queryCalls) != 1 {
		t.Fatalf("query calls = %d, want 1", len(db.queryCalls))
	}
	sql := strings.ToLower(db.queryCalls[0].sql)
	for _, table := range []string{
		"amazon_review_targets",
		"kind = 'external_asin'",
		"order by id asc",
	} {
		if !strings.Contains(sql, table) {
			t.Errorf("query missing %q: %s", table, sql)
		}
	}
}

func TestAmazonReviewTrackingStorePGXReadOnlyQueries(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatalf("BeginTx(read-only) error = %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	store := NewAmazonReviewTrackingStore(NewTxDB(tx))
	if _, err := store.ListGroups(ctx, amazon_review_tracking.GroupListFilter{}); err != nil {
		t.Fatalf("ListGroups() error = %v", err)
	}
	if _, err := store.ListTargets(ctx, amazon_review_tracking.TargetListFilter{
		Limit: 5, Offset: 0, IsAdmin: true,
	}); err != nil {
		t.Fatalf("ListTargets(admin) error = %v", err)
	}
	if _, err := store.ListExternalTargets(ctx, 5, 0); err != nil {
		t.Fatalf("ListExternalTargets() error = %v", err)
	}

	var targetID int64
	err = tx.QueryRow(ctx, `select id from public.amazon_review_targets order by id limit 1`).Scan(&targetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		t.Fatalf("select review target fixture: %v", err)
	}
	if _, err := store.ListRatingSnapshots(ctx, amazon_review_tracking.RatingSnapshotFilter{
		TargetID: targetID, Limit: 5, IsAdmin: true,
	}); err != nil {
		t.Fatalf("ListRatingSnapshots() error = %v", err)
	}
	if _, err := store.ListReviews(ctx, amazon_review_tracking.ReviewFilter{
		TargetID: targetID, Limit: 5, IsAdmin: true,
	}); err != nil {
		t.Fatalf("ListReviews() error = %v", err)
	}
	if _, err := store.ListRuns(ctx, amazon_review_tracking.CrawlRunFilter{
		TargetID: targetID, Limit: 5, IsAdmin: true,
	}); err != nil {
		t.Fatalf("ListRuns() error = %v", err)
	}
}

func TestAmazonReviewTrackingStorePGXWriteSQLRollsBack(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var skuID, projectID int64
	var marketplace string
	err = tx.QueryRow(ctx, `
		select pc.id, pc.project_id, pc.country
		from public.product_costs pc
		where coalesce(pc.is_active, true)
		  and not exists (
		    select 1
		    from public.amazon_review_group_members m
		    where m.sku_record_id = pc.id
		      and m.removed_at is null
		  )
		order by pc.id asc
		limit 1
	`).Scan(&skuID, &projectID, &marketplace)
	if errors.Is(err, pgx.ErrNoRows) {
		t.Skip("BLF_test has no free product_costs fixture")
	}
	if err != nil {
		t.Fatalf("select SKU fixture: %v", err)
	}
	if !amazonReviewSupportedMarketplace(strings.ToUpper(marketplace)) {
		t.Skipf("BLF_test SKU fixture marketplace %q is unsupported", marketplace)
	}

	store := NewAmazonReviewTrackingStore(NewTxDB(tx))
	suffix := time.Now().UTC().UnixNano()
	group, err := store.CreateGroup(ctx, amazon_review_tracking.ReviewGroupCreateInput{
		ProjectID:        projectID,
		Marketplace:      marketplace,
		Name:             fmt.Sprintf("CodexReview-%d", suffix),
		MemberIDs:        []int64{skuID},
		RepresentativeID: skuID,
	})
	if err != nil {
		t.Fatalf("CreateGroup() error = %v", err)
	}
	if group.ID <= 0 || len(group.MemberIDs) != 1 || group.MemberIDs[0] != skuID {
		t.Fatalf("created group = %#v", group)
	}

	mutation, err := store.DeactivateGroup(ctx, group.ID)
	if err != nil {
		t.Fatalf("DeactivateGroup() error = %v", err)
	}
	if mutation.After == nil || mutation.After.IsActive || len(mutation.After.MemberIDs) != 0 {
		t.Fatalf("deactivated group = %#v", mutation.After)
	}

	asin := fmt.Sprintf("B0%08d", suffix%100000000)
	external, err := store.CreateExternalTarget(ctx, amazon_review_tracking.ExternalTargetCreateInput{
		Marketplace: marketplace,
		ASIN:        asin,
		DisplayName: amazonReviewTestStringPointer("Codex Competitor"),
	})
	if err != nil {
		t.Fatalf("CreateExternalTarget() error = %v", err)
	}
	if external.ID <= 0 || external.ASIN == nil || *external.ASIN != asin {
		t.Fatalf("external target = %#v", external)
	}

	var shopID int64
	err = tx.QueryRow(ctx, `select id from public.project_shops order by id asc limit 1`).Scan(&shopID)
	if err == nil {
		link, linkErr := store.AddExternalLink(ctx, external.ID, shopID)
		if linkErr != nil {
			t.Fatalf("AddExternalLink() error = %v", linkErr)
		}
		if link.ID <= 0 || !link.IsActive {
			t.Fatalf("external link = %#v", link)
		}
		removed, removeErr := store.RemoveExternalLink(ctx, external.ID, link.ID)
		if removeErr != nil {
			t.Fatalf("RemoveExternalLink() error = %v", removeErr)
		}
		if removed.IsActive {
			t.Fatalf("removed external link = %#v", removed)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("select shop fixture: %v", err)
	}
}

func amazonReviewTestStringPointer(value string) *string {
	return &value
}
