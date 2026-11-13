package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	agent_review_tracking "github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_review_tracking"
)

func TestAgentReviewTrackingStoreRollbackOnlyIntegration(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("GO_API_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	defer pool.Close()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin rollback-only transaction: %v", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	store := &AgentReviewTrackingStore{db: NewTxDB(tx)}
	projectID, productID, country, asin := agentReviewTrackingFixture(t, ctx, tx)

	var groupID int64
	displayName := "review-tracking-integration-" + time.Now().Format("150405.000000")
	err = tx.QueryRow(
		ctx,
		`insert into public.amazon_review_groups (
		   project_id, marketplace, name, representative_sku_record_id,
		   is_active
		 ) values ($1, $2, $3, $4, true)
		 returning id`,
		projectID, country, displayName, productID,
	).Scan(&groupID)
	if err != nil {
		t.Fatalf("insert review group: %v", err)
	}
	var targetID int64
	err = tx.QueryRow(
		ctx,
		`insert into public.amazon_review_targets (
		   kind, group_id, project_id, marketplace, asin, display_name, is_active
		 ) values ('internal_group', $1, $2, $3, $4, $5, true)
		 returning id`,
		groupID, projectID, country, asin, displayName,
	).Scan(&targetID)
	if err != nil {
		t.Fatalf("insert review target: %v", err)
	}
	loadedTarget, err := store.GetTargetForUpdate(ctx, targetID)
	if err != nil {
		t.Fatalf("load target for update: %v", err)
	}
	if loadedTarget == nil || !loadedTarget.IsActive ||
		loadedTarget.ProjectID == nil || *loadedTarget.ProjectID != projectID {
		t.Fatalf("loaded target = %#v", loadedTarget)
	}

	page, err := store.ListTargets(ctx, agent_review_tracking.TargetListFilter{
		ScopeAll:  true,
		ProjectID: &projectID,
		Limit:     500,
		Offset:    0,
	})
	if err != nil {
		t.Fatalf("list targets: %v", err)
	}
	if page.Total < 1 {
		t.Fatalf("target page = %#v", page)
	}
	var found bool
	for _, item := range page.Items {
		if item.TargetID != targetID {
			continue
		}
		found = true
		if item.ProjectID == nil || *item.ProjectID != projectID {
			t.Fatalf("target item = %#v", item)
		}
	}
	if !found {
		t.Fatalf("target %d missing from page with total %d", targetID, page.Total)
	}

	externalASIN := fmt.Sprintf("B0%09d", time.Now().UnixNano()%1_000_000_000)
	var externalTargetID int64
	err = tx.QueryRow(
		ctx,
		`insert into public.amazon_review_targets (
		   kind, group_id, project_id, marketplace, asin, display_name, is_active
		 ) values ('external_asin', null, null, $1, $2, $3, true)
		 returning id`,
		country, externalASIN, "external-"+externalASIN,
	).Scan(&externalTargetID)
	if err != nil {
		t.Fatalf("insert external target: %v", err)
	}
	otherScope := projectID + 900_000
	scopedPage, err := store.ListTargets(ctx, agent_review_tracking.TargetListFilter{
		ProjectIDs: []int64{otherScope},
		Limit:      500,
		Offset:     0,
	})
	if err != nil {
		t.Fatalf("list scoped targets: %v", err)
	}
	var externalFound, internalFound bool
	for _, item := range scopedPage.Items {
		switch item.TargetID {
		case externalTargetID:
			externalFound = true
		case targetID:
			internalFound = true
		}
	}
	if !externalFound || internalFound {
		t.Fatalf(
			"scope visibility external=%v internal=%v page=%#v",
			externalFound,
			internalFound,
			scopedPage,
		)
	}

	// timestamptz keeps microsecond precision; truncate so round-trip equality
	// does not depend on nanosecond leftovers from time.Now().
	capturedAt := time.Now().UTC().Truncate(time.Microsecond).Add(-2 * time.Minute)
	average := 4.4
	ratingCount := int64(120)
	reviewCount := int64(90)
	percentages := []float64{5, 3, 7, 20, 65}
	reviews := []agent_review_tracking.ReviewCapture{{
		ReviewKey:    "R-INTEGRATION",
		IDConfidence: "original",
		Rating:       agentReviewTrackingIntPtr(5),
		Body:         agentReviewTrackingStringPtr("new body"),
	}}
	key := "integration-" + displayName
	first, err := store.InsertCrawlResult(ctx, agent_review_tracking.CrawlResultInput{
		TargetID:       targetID,
		CapturedAt:     capturedAt,
		Status:         "success",
		IsCompleteList: true,
		IdempotencyKey: &key,
		Source:         agentReviewTrackingStringPtr(agent_review_tracking.DefaultSource),
		Rating: &agent_review_tracking.RatingCapture{
			AverageRating:    &average,
			RatingCount:      &ratingCount,
			ReviewCount:      &reviewCount,
			StarPercentages:  percentages,
			StarCountQuality: "estimated",
		},
		Reviews: &reviews,
	})
	if err != nil {
		t.Fatalf("insert first crawl result: %v", err)
	}
	if first.Replayed || !first.SnapshotUpdated || first.ReviewsUpserted != 1 {
		t.Fatalf("first result = %#v", first)
	}

	replay, err := store.InsertCrawlResult(ctx, agent_review_tracking.CrawlResultInput{
		TargetID:       targetID,
		CapturedAt:     capturedAt,
		Status:         "success",
		IsCompleteList: true,
		IdempotencyKey: &key,
	})
	if err != nil {
		t.Fatalf("replay crawl result: %v", err)
	}
	if !replay.Replayed || replay.RunID != first.RunID {
		t.Fatalf("replay result = %#v, first = %#v", replay, first)
	}

	var (
		ratingValue float64
		star5       float64
		quality     string
	)
	err = tx.QueryRow(
		ctx,
		`select average_rating::float8, star_5_percentage::float8, star_count_quality
		   from public.amazon_review_rating_snapshots
		  where target_id = $1
		    and capture_date = $2::date`,
		targetID,
		agent_review_tracking.BusinessDate(capturedAt).Format("2006-01-02"),
	).Scan(&ratingValue, &star5, &quality)
	if err != nil {
		t.Fatalf("read rating snapshot: %v", err)
	}
	if ratingValue != average || star5 != 65 || quality != "estimated" {
		t.Fatalf("snapshot = rating %v, star5 %v, quality %q", ratingValue, star5, quality)
	}

	empty := []agent_review_tracking.ReviewCapture{}
	missOneAt := capturedAt.Add(time.Minute)
	key2 := key + "-miss-1"
	missOne, err := store.InsertCrawlResult(ctx, agent_review_tracking.CrawlResultInput{
		TargetID:       targetID,
		CapturedAt:     missOneAt,
		Status:         "success",
		IsCompleteList: true,
		IdempotencyKey: &key2,
		Reviews:        &empty,
	})
	if err != nil {
		t.Fatalf("first missing crawl: %v", err)
	}
	if missOne.ReviewsSuspectedRemoved != 0 {
		t.Fatalf("first missing suspected removed = %d", missOne.ReviewsSuspectedRemoved)
	}
	missTwoAt := missOneAt.Add(time.Minute)
	key3 := key + "-miss-2"
	missTwo, err := store.InsertCrawlResult(ctx, agent_review_tracking.CrawlResultInput{
		TargetID:       targetID,
		CapturedAt:     missTwoAt,
		Status:         "success",
		IsCompleteList: true,
		IdempotencyKey: &key3,
		Reviews:        &empty,
	})
	if err != nil {
		t.Fatalf("second missing crawl: %v", err)
	}
	if missTwo.ReviewsSuspectedRemoved != 1 {
		t.Fatalf("second missing suspected removed = %d", missTwo.ReviewsSuspectedRemoved)
	}
	var (
		visibility string
		streak     int
		body       string
	)
	err = tx.QueryRow(
		ctx,
		`select visibility_status, missing_streak, coalesce(body, '')
		   from public.amazon_review_reviews
		  where target_id = $1
		    and review_key = 'R-INTEGRATION'`,
		targetID,
	).Scan(&visibility, &streak, &body)
	if err != nil {
		t.Fatalf("read review row: %v", err)
	}
	if visibility != "suspected_removed" || streak != 2 || body != "new body" {
		t.Fatalf("review = visibility %q, streak %d, body %q", visibility, streak, body)
	}
	latest, err := store.LatestStartedAt(ctx, targetID, capturedAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("latest started at: %v", err)
	}
	if latest == nil || !latest.Equal(missTwoAt) {
		t.Fatalf("latest started at = %#v, want %s", latest, missTwoAt)
	}
	failedAt := missTwoAt.Add(time.Minute)
	key4 := key + "-failed"
	failed, err := store.InsertCrawlResult(ctx, agent_review_tracking.CrawlResultInput{
		TargetID:       targetID,
		CapturedAt:     failedAt,
		Status:         "failed",
		IsCompleteList: true,
		IdempotencyKey: &key4,
		Rating: &agent_review_tracking.RatingCapture{
			AverageRating:    &average,
			StarCountQuality: "estimated",
		},
		Reviews: &reviews,
	})
	if err != nil {
		t.Fatalf("failed crawl: %v", err)
	}
	if failed.SnapshotUpdated || failed.ReviewsUpserted != 0 {
		t.Fatalf("failed crawl wrote current state: %#v", failed)
	}
	latest, err = store.LatestStartedAt(ctx, targetID, capturedAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("latest started at after failed run: %v", err)
	}
	if latest == nil || !latest.Equal(missTwoAt) {
		t.Fatalf("failed run raised watermark: %#v", latest)
	}
	page, err = store.ListTargets(ctx, agent_review_tracking.TargetListFilter{
		ScopeAll:  true,
		ProjectID: &projectID,
		Limit:     500,
		Offset:    0,
	})
	if err != nil {
		t.Fatalf("list targets after runs: %v", err)
	}
	for _, item := range page.Items {
		if item.TargetID != targetID {
			continue
		}
		if item.LastRun == nil || item.LastRun.RunID != failed.RunID ||
			item.LastRun.Status != "failed" {
			t.Fatalf("last run = %#v", item.LastRun)
		}
		parsedStartedAt, parseErr := time.Parse(time.RFC3339Nano, item.LastRun.StartedAt)
		if parseErr != nil || !parsedStartedAt.Equal(failedAt.Truncate(time.Microsecond)) {
			t.Fatalf("last run started_at = %q, parse err=%v", item.LastRun.StartedAt, parseErr)
		}
	}

	targetIDText := "run-" + displayName
	err = store.LogAudit(ctx, tx, agent_review_tracking.AuditEntry{
		Action:         "review_tracking.crawl_run",
		TargetType:     "amazon_review_crawl_run",
		TargetID:       &targetIDText,
		AgentID:        agentReviewTrackingStringPtr("integration-agent"),
		AgentName:      agentReviewTrackingStringPtr("Integration Agent"),
		IdempotencyKey: &key,
		AfterJSON: map[string]any{
			"target_id":    targetID,
			"capture_date": agent_review_tracking.BusinessDateString(capturedAt),
		},
	})
	if err != nil {
		t.Fatalf("insert audit: %v", err)
	}
	var auditCount int
	err = tx.QueryRow(
		ctx,
		`select count(*)
		   from public.operation_audit_logs
		  where target_type = 'amazon_review_crawl_run'
		    and target_id = $1
		    and agent_id = 'integration-agent'
		    and idempotency_key = $2`,
		targetIDText,
		key,
	).Scan(&auditCount)
	if err != nil {
		t.Fatalf("count audit: %v", err)
	}
	if auditCount != 1 {
		t.Fatalf("audit count = %d", auditCount)
	}
}

func agentReviewTrackingFixture(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
) (projectID int64, productID int64, country string, asin string) {
	t.Helper()
	// Self-seeding fixture: the rollback-only transaction creates its own
	// project + product cost so the test does not depend on production data.
	name := fmt.Sprintf("review-fixture-%d", time.Now().UnixNano())
	if err := tx.QueryRow(
		ctx,
		`insert into public.projects (project_name, sort_order, country, is_active)
		 values ($1, 0, 'US', true)
		 returning id`,
		name,
	).Scan(&projectID); err != nil {
		t.Fatalf("insert review tracking project: %v", err)
	}
	sku := "FIXTURE-SKU"
	asin = "FIXTURE-ASIN"
	if err := tx.QueryRow(
		ctx,
		`insert into public.product_costs
		   (project_name, project_id, sku, asin, fob_unit_cost, country, is_active)
		 values ($1, $2, $3, $4, 0, 'US', true)
		 returning id`,
		name, projectID, sku, asin,
	).Scan(&productID); err != nil {
		t.Fatalf("insert review tracking product cost: %v", err)
	}
	return projectID, productID, "US", asin
}

func agentReviewTrackingStringPtr(value string) *string {
	return &value
}

func agentReviewTrackingIntPtr(value int) *int {
	return &value
}
