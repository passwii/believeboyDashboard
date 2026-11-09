package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	agent_review_tracking "github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_review_tracking"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type AgentReviewTrackingStore struct {
	db FullDB
}

func NewAgentReviewTrackingStore(db FullDB) *AgentReviewTrackingStore {
	return &AgentReviewTrackingStore{db: db}
}

func (store *AgentReviewTrackingStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, agent_review_tracking.Store) error,
) error {
	if store == nil || store.db == nil {
		return agent_review_tracking.ErrDependencyUnavailable
	}
	return RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txStore := &AgentReviewTrackingStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func (store *AgentReviewTrackingStore) ListTargets(
	ctx context.Context,
	filter agent_review_tracking.TargetListFilter,
) (agent_review_tracking.TargetPage, error) {
	if store == nil || store.db == nil {
		return agent_review_tracking.TargetPage{}, agent_review_tracking.ErrDependencyUnavailable
	}
	args := make([]any, 0, 8)
	where := []string{"t.is_active = true"}
	if !filter.ScopeAll {
		if len(filter.ProjectIDs) == 0 {
			where = append(where, "t.kind = 'external_asin'")
		} else {
			args = append(args, filter.ProjectIDs)
			where = append(where, fmt.Sprintf(
				"(t.kind = 'external_asin' or t.project_id = any($%d::bigint[]))",
				len(args),
			))
		}
	}
	if filter.ProjectID != nil {
		args = append(args, *filter.ProjectID)
		where = append(where, fmt.Sprintf("t.project_id = $%d", len(args)))
	}
	if filter.Marketplace != nil {
		args = append(args, strings.ToUpper(strings.TrimSpace(*filter.Marketplace)))
		where = append(where, fmt.Sprintf("t.marketplace = $%d", len(args)))
	}
	if filter.Kind != nil {
		args = append(args, *filter.Kind)
		where = append(where, fmt.Sprintf("t.kind = $%d", len(args)))
	}

	condition := strings.Join(where, " and ")
	var total int64
	if err := store.db.QueryRow(
		ctx,
		`select count(*) from public.amazon_review_targets t where `+condition,
		args...,
	).Scan(&total); err != nil {
		return agent_review_tracking.TargetPage{}, err
	}

	listArgs := append([]any(nil), args...)
	listArgs = append(listArgs, filter.Limit, filter.Offset)
	query := fmt.Sprintf(
		`select t.id, t.kind, t.group_id, t.project_id, t.marketplace,
		        t.asin, t.display_name
		   from public.amazon_review_targets t
		  where %s
		  order by t.id asc
		  limit $%d offset $%d`,
		condition,
		len(listArgs)-1,
		len(listArgs),
	)
	rows, err := store.db.Query(ctx, query, listArgs...)
	if err != nil {
		return agent_review_tracking.TargetPage{}, err
	}
	defer rows.Close()

	items := make([]agent_review_tracking.TargetItem, 0)
	targetIDs := make([]int64, 0)
	for rows.Next() {
		item, scanErr := scanAgentReviewTargetItem(rows)
		if scanErr != nil {
			return agent_review_tracking.TargetPage{}, scanErr
		}
		items = append(items, item)
		targetIDs = append(targetIDs, item.TargetID)
	}
	if err := rows.Err(); err != nil {
		return agent_review_tracking.TargetPage{}, err
	}
	if len(items) == 0 {
		return agent_review_tracking.TargetPage{
			Items: []agent_review_tracking.TargetItem{},
			Total: total,
		}, nil
	}

	externalIDs := make([]int64, 0)
	for _, item := range items {
		item.ExternalShopIDs = []int64{}
		if item.Kind == "external_asin" {
			externalIDs = append(externalIDs, item.TargetID)
		}
	}
	if len(externalIDs) > 0 {
		linkRows, linkErr := store.db.Query(
			ctx,
			`select target_id, shop_id
			   from public.amazon_review_external_links
			  where target_id = any($1::int[])
			    and is_active = true
			  order by target_id asc, shop_id asc`,
			externalIDs,
		)
		if linkErr != nil {
			return agent_review_tracking.TargetPage{}, linkErr
		}
		shopIDs := map[int64][]int64{}
		for linkRows.Next() {
			var targetID int64
			var shopID int64
			if scanErr := linkRows.Scan(&targetID, &shopID); scanErr != nil {
				linkRows.Close()
				return agent_review_tracking.TargetPage{}, scanErr
			}
			shopIDs[targetID] = append(shopIDs[targetID], shopID)
		}
		if rowsErr := linkRows.Err(); rowsErr != nil {
			linkRows.Close()
			return agent_review_tracking.TargetPage{}, rowsErr
		}
		linkRows.Close()
		for index := range items {
			if ids := shopIDs[items[index].TargetID]; len(ids) > 0 {
				items[index].ExternalShopIDs = ids
			}
		}
	}

	runRows, runErr := store.db.Query(
		ctx,
		`select ranked.target_id, ranked.run_id, ranked.status, ranked.started_at
		   from (
		     select target_id, id as run_id, status, started_at,
		            row_number() over (
		              partition by target_id
		              order by started_at desc, id desc
		            ) as rn
		       from public.amazon_review_crawl_runs
		      where target_id = any($1::int[])
		   ) ranked
		  where ranked.rn = 1`,
		targetIDs,
	)
	if runErr != nil {
		return agent_review_tracking.TargetPage{}, runErr
	}
	defer runRows.Close()
	lastRuns := map[int64]*agent_review_tracking.LastRun{}
	for runRows.Next() {
		var targetID int64
		var runID int64
		var status string
		var startedAt time.Time
		if scanErr := runRows.Scan(&targetID, &runID, &status, &startedAt); scanErr != nil {
			return agent_review_tracking.TargetPage{}, scanErr
		}
		lastRuns[targetID] = &agent_review_tracking.LastRun{
			RunID:     runID,
			Status:    status,
			StartedAt: httpapi.Timestamp(startedAt),
		}
	}
	if rowsErr := runRows.Err(); rowsErr != nil {
		return agent_review_tracking.TargetPage{}, rowsErr
	}
	for index := range items {
		items[index].LastRun = lastRuns[items[index].TargetID]
	}
	return agent_review_tracking.TargetPage{Items: items, Total: total}, nil
}

func (store *AgentReviewTrackingStore) GetTargetForUpdate(
	ctx context.Context,
	targetID int64,
) (*agent_review_tracking.Target, error) {
	if store == nil || store.db == nil {
		return nil, agent_review_tracking.ErrDependencyUnavailable
	}
	var (
		groupID   pgtype.Int4
		projectID pgtype.Int8
		asin      pgtype.Text
		display   pgtype.Text
	)
	target := &agent_review_tracking.Target{}
	err := store.db.QueryRow(
		ctx,
		`select id, kind, group_id, project_id, marketplace,
		        asin, display_name, is_active
		   from public.amazon_review_targets
		  where id = $1
		    for update`,
		targetID,
	).Scan(
		&target.ID,
		&target.Kind,
		&groupID,
		&projectID,
		&target.Marketplace,
		&asin,
		&display,
		&target.IsActive,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if groupID.Valid {
		target.GroupID = agentReviewInt64Ptr(int64(groupID.Int32))
	}
	if projectID.Valid {
		target.ProjectID = agentReviewInt64Ptr(projectID.Int64)
	}
	if asin.Valid {
		target.ASIN = agentReviewStringPtr(asin.String)
	}
	if display.Valid {
		target.DisplayName = agentReviewStringPtr(display.String)
	}
	return target, nil
}

func (store *AgentReviewTrackingStore) FindRunByIdempotency(
	ctx context.Context,
	targetID int64,
	idempotencyKey *string,
) (*agent_review_tracking.CrawlRun, error) {
	if idempotencyKey == nil {
		return nil, nil
	}
	if store == nil || store.db == nil {
		return nil, agent_review_tracking.ErrDependencyUnavailable
	}
	var (
		run       agent_review_tracking.CrawlRun
		key       pgtype.Text
		startedAt pgtype.Timestamptz
	)
	err := store.db.QueryRow(
		ctx,
		`select id, target_id, idempotency_key, status, started_at
		   from public.amazon_review_crawl_runs
		  where target_id = $1 and idempotency_key = $2
		  limit 1`,
		targetID,
		*idempotencyKey,
	).Scan(&run.ID, &run.TargetID, &key, &run.Status, &startedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if key.Valid {
		run.IdempotencyKey = agentReviewStringPtr(key.String)
	}
	if startedAt.Valid {
		run.StartedAt = startedAt.Time
	}
	return &run, nil
}

func (store *AgentReviewTrackingStore) LatestStartedAt(
	ctx context.Context,
	targetID int64,
	cutoff time.Time,
) (*time.Time, error) {
	if store == nil || store.db == nil {
		return nil, agent_review_tracking.ErrDependencyUnavailable
	}
	var latest pgtype.Timestamptz
	err := store.db.QueryRow(
		ctx,
		`select max(started_at)
		   from public.amazon_review_crawl_runs
		  where target_id = $1
		    and status <> 'failed'
		    and started_at <= $2`,
		targetID,
		cutoff,
	).Scan(&latest)
	if err != nil {
		return nil, err
	}
	if !latest.Valid {
		return nil, nil
	}
	value := latest.Time
	return &value, nil
}

func (store *AgentReviewTrackingStore) InsertCrawlResult(
	ctx context.Context,
	input agent_review_tracking.CrawlResultInput,
) (agent_review_tracking.CrawlResult, error) {
	if store == nil || store.db == nil {
		return agent_review_tracking.CrawlResult{}, agent_review_tracking.ErrDependencyUnavailable
	}
	var runID int64
	err := RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		return tx.QueryRow(
			ctx,
			`insert into public.amazon_review_crawl_runs (
			   target_id, idempotency_key, started_at, finished_at, status,
			   is_complete_list, reviews_seen, ratings_captured,
			   asin_scraped, error_message
			 ) values (
			   $1, $2, $3, $3, $4, $5, $6, $7, $8, $9
			 )
			 returning id`,
			input.TargetID,
			agentReviewNullableString(input.IdempotencyKey),
			input.CapturedAt,
			input.Status,
			input.IsCompleteList,
			reviewsSeenValue(input.Reviews),
			input.Rating != nil,
			agentReviewNullableString(input.ASINScraped),
			agentReviewNullableString(input.ErrorMessage),
		).Scan(&runID)
	})
	if err != nil {
		if input.IdempotencyKey != nil && isReviewTrackingIdempotencyConflict(err) {
			existing, findErr := store.FindRunByIdempotency(
				ctx, input.TargetID, input.IdempotencyKey,
			)
			if findErr != nil {
				return agent_review_tracking.CrawlResult{}, findErr
			}
			if existing != nil {
				return agent_review_tracking.CrawlResult{
					TargetID:  input.TargetID,
					RunID:     existing.ID,
					Status:    existing.Status,
					StartedAt: existing.StartedAt,
					Replayed:  true,
				}, nil
			}
			return agent_review_tracking.CrawlResult{},
				agent_review_tracking.ErrIdempotencyKeyConflict
		}
		return agent_review_tracking.CrawlResult{}, err
	}

	result := agent_review_tracking.CrawlResult{
		TargetID:  input.TargetID,
		RunID:     runID,
		Status:    input.Status,
		StartedAt: input.CapturedAt,
	}
	if input.Status == "failed" {
		return result, nil
	}
	captureDate := agent_review_tracking.BusinessDate(input.CapturedAt).Format("2006-01-02")
	if input.Rating != nil {
		if err := store.upsertRatingSnapshot(
			ctx, input, captureDate,
		); err != nil {
			return agent_review_tracking.CrawlResult{}, err
		}
		result.SnapshotUpdated = true
	}
	if input.Reviews != nil {
		upserted, err := store.upsertReviews(ctx, input.TargetID, *input.Reviews, input.CapturedAt)
		if err != nil {
			return agent_review_tracking.CrawlResult{}, err
		}
		result.ReviewsUpserted = upserted
		if input.IsCompleteList && input.Status == "success" {
			suspected, err := store.applyMissing(
				ctx, input.TargetID, reviewKeys(*input.Reviews),
			)
			if err != nil {
				return agent_review_tracking.CrawlResult{}, err
			}
			result.ReviewsSuspectedRemoved = suspected
		}
	}
	return result, nil
}

func (store *AgentReviewTrackingStore) upsertRatingSnapshot(
	ctx context.Context,
	input agent_review_tracking.CrawlResultInput,
	captureDate string,
) error {
	percentages := [5]any{}
	counts := [5]any{}
	if input.Rating.StarPercentages != nil {
		for index := 0; index < 5; index++ {
			percentages[index] = input.Rating.StarPercentages[index]
		}
	}
	if input.Rating.StarCounts != nil {
		for index := 0; index < 5; index++ {
			counts[index] = input.Rating.StarCounts[index]
		}
	}
	_, err := store.db.Exec(
		ctx,
		`insert into public.amazon_review_rating_snapshots (
		   target_id, capture_date, captured_at, average_rating, rating_count,
		   review_count, star_1_percentage, star_2_percentage,
		   star_3_percentage, star_4_percentage, star_5_percentage,
		   star_1_count, star_2_count, star_3_count, star_4_count,
		   star_5_count, star_count_quality, capture_status, source
		 ) values (
		   $1, $2::date, $3, $4, $5, $6,
		   $7, $8, $9, $10, $11,
		   $12, $13, $14, $15, $16,
		   $17, $18, $19
		 )
		 on conflict (target_id, capture_date) do update set
		   captured_at = excluded.captured_at,
		   average_rating = excluded.average_rating,
		   rating_count = excluded.rating_count,
		   review_count = excluded.review_count,
		   star_1_percentage = excluded.star_1_percentage,
		   star_2_percentage = excluded.star_2_percentage,
		   star_3_percentage = excluded.star_3_percentage,
		   star_4_percentage = excluded.star_4_percentage,
		   star_5_percentage = excluded.star_5_percentage,
		   star_1_count = excluded.star_1_count,
		   star_2_count = excluded.star_2_count,
		   star_3_count = excluded.star_3_count,
		   star_4_count = excluded.star_4_count,
		   star_5_count = excluded.star_5_count,
		   star_count_quality = excluded.star_count_quality,
		   capture_status = excluded.capture_status,
		   source = excluded.source,
		   updated_at = now()`,
		input.TargetID,
		captureDate,
		input.CapturedAt,
		agentReviewNullableFloat64(input.Rating.AverageRating),
		agentReviewNullableInt64(input.Rating.RatingCount),
		agentReviewNullableInt64(input.Rating.ReviewCount),
		percentages[0], percentages[1], percentages[2], percentages[3], percentages[4],
		counts[0], counts[1], counts[2], counts[3], counts[4],
		input.Rating.StarCountQuality,
		input.Status,
		agentReviewNullableString(input.Source),
	)
	return err
}

func (store *AgentReviewTrackingStore) upsertReviews(
	ctx context.Context,
	targetID int64,
	reviews []agent_review_tracking.ReviewCapture,
	seenAt time.Time,
) (int, error) {
	deduped, order := dedupeReviews(reviews)
	for _, key := range order {
		review := deduped[key]
		reviewDate := any(nil)
		if review.ReviewDate != nil {
			reviewDate = review.ReviewDate.Format("2006-01-02")
		}
		_, err := store.db.Exec(
			ctx,
			`insert into public.amazon_review_reviews (
			   target_id, review_key, id_confidence, reviewer_id,
			   reviewer_name, rating, title, body, review_date,
			   verified_purchase, helpful_count, first_seen_at,
			   last_seen_at, visibility_status, missing_streak
			 ) values (
			   $1, $2, $3, $4, $5, $6, $7, $8, $9::date,
			   $10, $11, $12, $12, 'visible', 0
			 )
			 on conflict (target_id, review_key) do update set
			   id_confidence = excluded.id_confidence,
			   reviewer_id = excluded.reviewer_id,
			   reviewer_name = excluded.reviewer_name,
			   rating = excluded.rating,
			   title = excluded.title,
			   body = excluded.body,
			   review_date = excluded.review_date,
			   verified_purchase = excluded.verified_purchase,
			   helpful_count = excluded.helpful_count,
			   last_seen_at = excluded.last_seen_at,
			   visibility_status = 'visible',
			   missing_streak = 0,
			   updated_at = now()`,
			targetID,
			review.ReviewKey,
			review.IDConfidence,
			agentReviewNullableString(review.ReviewerID),
			agentReviewNullableString(review.ReviewerName),
			agentReviewNullableInt(review.Rating),
			agentReviewNullableString(review.Title),
			agentReviewNullableString(review.Body),
			reviewDate,
			agentReviewNullableBool(review.VerifiedPurchase),
			agentReviewNullableInt64(review.HelpfulCount),
			seenAt,
		)
		if err != nil {
			return 0, err
		}
	}
	return len(deduped), nil
}

func (store *AgentReviewTrackingStore) applyMissing(
	ctx context.Context,
	targetID int64,
	seenKeys []string,
) (int, error) {
	var suspected int
	err := store.db.QueryRow(
		ctx,
		`with updated as (
		   update public.amazon_review_reviews
		      set missing_streak = missing_streak + 1,
		          visibility_status = case
		            when missing_streak + 1 >= 2 then 'suspected_removed'
		            else visibility_status
		          end,
		          updated_at = now()
		    where target_id = $1
		      and visibility_status = 'visible'
		      and not (review_key = any($2::text[]))
		  returning visibility_status
		 )
		 select count(*) from updated
		  where visibility_status = 'suspected_removed'`,
		targetID,
		seenKeys,
	).Scan(&suspected)
	return suspected, err
}

func (store *AgentReviewTrackingStore) LogAudit(
	ctx context.Context,
	tx pgx.Tx,
	entry agent_review_tracking.AuditEntry,
) error {
	var execer Execer
	if tx != nil {
		execer = tx
	} else if store != nil && store.db != nil {
		execer = store.db
	} else {
		return agent_review_tracking.ErrDependencyUnavailable
	}
	after, err := reviewTrackingAuditJSON(entry.AfterJSON)
	if err != nil {
		return err
	}
	_, err = execer.Exec(
		ctx,
		`insert into public.operation_audit_logs (
		   operator, action, target_type, target_id, result, trace_id,
		   request_method, request_path, ip_address, user_agent,
		   before_json, after_json, agent_id, agent_name, idempotency_key,
		   error_message, created_at
		 ) values (
		   $1, $2, $3, $4, 'success', $5, $6, $7, $8, $9,
		   $10, $11, $12, $13, $14, null, now()
		 )`,
		nil,
		clipReviewTracking(entry.Action, 128, "unknown"),
		clipReviewTracking(entry.TargetType, 64, "unknown"),
		clipReviewTrackingPointer(entry.TargetID, 128),
		clipReviewTrackingPointer(entry.TraceID, 64),
		clipReviewTrackingPointer(entry.RequestMethod, 16),
		clipReviewTrackingPointer(entry.RequestPath, 255),
		clipReviewTrackingPointer(entry.IPAddress, 64),
		clipReviewTrackingPointer(entry.UserAgent, 512),
		nil,
		after,
		clipReviewTrackingPointer(entry.AgentID, 128),
		clipReviewTrackingPointer(entry.AgentName, 128),
		clipReviewTrackingPointer(entry.IdempotencyKey, 64),
	)
	if err != nil {
		return fmt.Errorf("insert agent review tracking audit: %w", err)
	}
	return nil
}

func scanAgentReviewTargetItem(rows Rows) (agent_review_tracking.TargetItem, error) {
	var (
		item      agent_review_tracking.TargetItem
		groupID   pgtype.Int4
		projectID pgtype.Int8
		asin      pgtype.Text
		display   pgtype.Text
	)
	if err := rows.Scan(
		&item.TargetID,
		&item.Kind,
		&groupID,
		&projectID,
		&item.Marketplace,
		&asin,
		&display,
	); err != nil {
		return item, err
	}
	if groupID.Valid {
		item.GroupID = agentReviewInt64Ptr(int64(groupID.Int32))
	}
	if projectID.Valid {
		item.ProjectID = agentReviewInt64Ptr(projectID.Int64)
	}
	if asin.Valid {
		item.ASIN = agentReviewStringPtr(asin.String)
	}
	if display.Valid {
		item.DisplayName = agentReviewStringPtr(display.String)
	}
	item.ExternalShopIDs = []int64{}
	return item, nil
}

func dedupeReviews(
	reviews []agent_review_tracking.ReviewCapture,
) (map[string]agent_review_tracking.ReviewCapture, []string) {
	deduped := make(map[string]agent_review_tracking.ReviewCapture, len(reviews))
	order := make([]string, 0, len(reviews))
	for _, review := range reviews {
		if _, exists := deduped[review.ReviewKey]; !exists {
			order = append(order, review.ReviewKey)
		}
		deduped[review.ReviewKey] = review
	}
	return deduped, order
}

func reviewKeys(reviews []agent_review_tracking.ReviewCapture) []string {
	deduped, _ := dedupeReviews(reviews)
	keys := make([]string, 0, len(deduped))
	for key := range deduped {
		keys = append(keys, key)
	}
	return keys
}

func reviewsSeenValue(reviews *[]agent_review_tracking.ReviewCapture) any {
	if reviews == nil {
		return nil
	}
	return len(*reviews)
}

func agentReviewNullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func agentReviewNullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func agentReviewNullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func agentReviewNullableFloat64(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func agentReviewNullableBool(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}

func isReviewTrackingIdempotencyConflict(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return false
	}
	return pgErr.ConstraintName == "uq_amazon_review_crawl_runs_target_idem" ||
		strings.Contains(pgErr.ConstraintName, "target_idem")
}

func reviewTrackingAuditJSON(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return payload, nil
}

func clipReviewTracking(value string, limit int, fallback string) string {
	if value == "" {
		value = fallback
	}
	if len(value) > limit {
		return value[:limit]
	}
	return value
}

func agentReviewStringPtr(value string) *string {
	return &value
}

func agentReviewInt64Ptr(value int64) *int64 {
	return &value
}

func clipReviewTrackingPointer(value *string, limit int) *string {
	if value == nil {
		return nil
	}
	clipped := *value
	if len(clipped) > limit {
		clipped = clipped[:limit]
	}
	return &clipped
}
