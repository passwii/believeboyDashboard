package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	amazon_review_tracking "github.com/passwii/believeboyDashboard/backend-go/internal/api/amazon_review_tracking"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type AmazonReviewTrackingStore struct {
	db FullDB
}

func NewAmazonReviewTrackingStore(db FullDB) *AmazonReviewTrackingStore {
	return &AmazonReviewTrackingStore{db: db}
}

func (s *AmazonReviewTrackingStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, amazon_review_tracking.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &AmazonReviewTrackingStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func (s *AmazonReviewTrackingStore) GetSessionAccount(
	ctx context.Context,
	userID string,
) (*amazon_review_tracking.SessionAccount, error) {
	var (
		isAdmin  bool
		isActive bool
		roleType pgtype.Text
	)
	err := s.db.QueryRow(
		ctx,
		`select is_admin, is_active, role_type
		 from public.user_accounts
		 where id::text = $1
		 limit 1`,
		strings.TrimSpace(userID),
	).Scan(&isAdmin, &isActive, &roleType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &amazon_review_tracking.SessionAccount{
		IsAdmin:  isAdmin,
		IsActive: isActive,
		RoleType: roleType.String,
	}, nil
}

func (s *AmazonReviewTrackingStore) ListGroups(
	ctx context.Context,
	filter amazon_review_tracking.GroupListFilter,
) ([]amazon_review_tracking.ReviewGroupItem, error) {
	args := make([]any, 0, 3)
	where := make([]string, 0, 3)
	if filter.ProjectID != nil {
		args = append(args, *filter.ProjectID)
		where = append(where, fmt.Sprintf("project_id = $%d", len(args)))
	}
	if filter.Marketplace != nil {
		args = append(args, strings.ToUpper(strings.TrimSpace(*filter.Marketplace)))
		where = append(where, fmt.Sprintf("marketplace = $%d", len(args)))
	}
	if filter.IsActive != nil {
		args = append(args, *filter.IsActive)
		where = append(where, fmt.Sprintf("is_active = $%d", len(args)))
	}

	query := `select id, project_id, marketplace, name, description,
	                 representative_sku_record_id, is_active
	          from public.amazon_review_groups`
	if len(where) > 0 {
		query += " where " + strings.Join(where, " and ")
	}
	query += " order by project_id asc, marketplace asc, id asc"

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := make([]amazon_review_tracking.ReviewGroupItem, 0)
	for rows.Next() {
		group, scanErr := scanAmazonReviewGroup(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		groups = append(groups, group)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(groups) == 0 {
		return []amazon_review_tracking.ReviewGroupItem{}, nil
	}

	groupIDs := make([]int64, 0, len(groups))
	for _, group := range groups {
		groupIDs = append(groupIDs, group.ID)
	}
	members, err := s.listGroupMembers(ctx, groupIDs)
	if err != nil {
		return nil, err
	}
	for i := range groups {
		groups[i].MemberIDs = members[groups[i].ID]
		if groups[i].MemberIDs == nil {
			groups[i].MemberIDs = []int64{}
		}
	}
	return groups, nil
}

func (s *AmazonReviewTrackingStore) CreateGroup(
	ctx context.Context,
	input amazon_review_tracking.ReviewGroupCreateInput,
) (*amazon_review_tracking.ReviewGroupItem, error) {
	marketplace, name, err := validateAmazonReviewGroupInput(
		input.ProjectID,
		input.Marketplace,
		input.Name,
		input.MemberIDs,
		input.RepresentativeID,
	)
	if err != nil {
		return nil, err
	}
	if err := s.validateAmazonReviewGroupSKUs(
		ctx, input.ProjectID, marketplace, input.MemberIDs,
	); err != nil {
		return nil, err
	}
	if !amazonReviewContainsInt64(input.MemberIDs, input.RepresentativeID) {
		return nil, amazon_review_tracking.NewError(
			422,
			"representative must be a member",
		)
	}
	if err := s.lockAmazonReviewGroupName(ctx, input.ProjectID, marketplace, name); err != nil {
		return nil, err
	}
	if duplicate, err := s.activeAmazonReviewGroupNameExists(
		ctx, input.ProjectID, marketplace, name, 0,
	); err != nil {
		return nil, err
	} else if duplicate {
		return nil, amazon_review_tracking.NewError(
			409,
			"active review group with this name already exists",
		)
	}

	var groupID int64
	err = s.db.QueryRow(
		ctx,
		`insert into public.amazon_review_groups (
		   project_id, marketplace, name, description,
		   representative_sku_record_id, is_active, created_at, updated_at
		 )
		 values ($1, $2, $3, $4, $5, true, now(), now())
		 returning id`,
		input.ProjectID,
		marketplace,
		name,
		input.Description,
		input.RepresentativeID,
	).Scan(&groupID)
	if err != nil {
		return nil, mapAmazonReviewConstraintError(err)
	}

	if err := s.insertGroupMembers(ctx, groupID, input.ProjectID, marketplace, input.MemberIDs); err != nil {
		return nil, mapAmazonReviewConstraintError(err)
	}
	asin, err := s.amazonReviewRepresentativeASIN(ctx, input.ProjectID, marketplace, input.RepresentativeID)
	if err != nil {
		return nil, err
	}
	_, err = s.db.Exec(
		ctx,
		`insert into public.amazon_review_targets (
		   kind, group_id, project_id, marketplace, asin, display_name,
		   is_active, created_at, updated_at
		 )
		 values ('internal_group', $1, $2, $3, $4, $5, true, now(), now())`,
		groupID,
		input.ProjectID,
		marketplace,
		asin,
		name,
	)
	if err != nil {
		return nil, mapAmazonReviewConstraintError(err)
	}

	memberIDs := append([]int64(nil), input.MemberIDs...)
	sort.Slice(memberIDs, func(i, j int) bool {
		return memberIDs[i] < memberIDs[j]
	})
	return &amazon_review_tracking.ReviewGroupItem{
		ID:               groupID,
		ProjectID:        input.ProjectID,
		Marketplace:      marketplace,
		Name:             name,
		Description:      input.Description,
		RepresentativeID: amazonReviewInt64Pointer(input.RepresentativeID),
		MemberIDs:        memberIDs,
		IsActive:         true,
	}, nil
}

func (s *AmazonReviewTrackingStore) PatchGroup(
	ctx context.Context,
	groupID int64,
	input amazon_review_tracking.ReviewGroupPatchInput,
) (*amazon_review_tracking.ReviewGroupMutation, error) {
	group, err := s.getAmazonReviewGroupForUpdate(ctx, groupID)
	if err != nil {
		return nil, err
	}
	if !group.IsActive {
		return nil, amazon_review_tracking.NewError(422, "cannot modify inactive review group")
	}
	before, err := s.amazonReviewGroupItem(ctx, *group)
	if err != nil {
		return nil, err
	}

	if input.Name != nil {
		name := strings.TrimSpace(*input.Name)
		if name == "" || utf8.RuneCountInString(name) > 255 {
			return nil, amazon_review_tracking.NewError(422, "invalid name")
		}
		if err := s.lockAmazonReviewGroupName(ctx, group.ProjectID, group.Marketplace, name); err != nil {
			return nil, err
		}
		duplicate, duplicateErr := s.activeAmazonReviewGroupNameExists(
			ctx, group.ProjectID, group.Marketplace, name, group.ID,
		)
		if duplicateErr != nil {
			return nil, duplicateErr
		}
		if duplicate {
			return nil, amazon_review_tracking.NewError(
				409,
				"active review group with this name already exists",
			)
		}
		if _, err := s.db.Exec(
			ctx,
			`update public.amazon_review_groups
			 set name = $2, updated_at = now()
			 where id = $1`,
			group.ID, name,
		); err != nil {
			return nil, mapAmazonReviewConstraintError(err)
		}
		if _, err := s.db.Exec(
			ctx,
			`update public.amazon_review_targets
			 set display_name = $2, updated_at = now()
			 where group_id = $1`,
			group.ID, name,
		); err != nil {
			return nil, mapAmazonReviewConstraintError(err)
		}
		group.Name = name
	}

	if input.DescriptionSet {
		if _, err := s.db.Exec(
			ctx,
			`update public.amazon_review_groups
			 set description = $2, updated_at = now()
			 where id = $1`,
			group.ID, input.Description,
		); err != nil {
			return nil, mapAmazonReviewConstraintError(err)
		}
		group.Description = input.Description
	}

	if input.MemberIDsSet {
		if len(input.MemberIDs) == 0 ||
			!amazonReviewContainsInt64(input.MemberIDs, ptrInt64Value(group.RepresentativeID)) {
			return nil, amazon_review_tracking.NewError(
				422,
				"representative must remain a group member; set representative first",
			)
		}
		if err := s.validateAmazonReviewGroupSKUs(
			ctx, group.ProjectID, group.Marketplace, input.MemberIDs,
		); err != nil {
			return nil, err
		}
		currentMembers, err := s.listGroupMembers(ctx, []int64{group.ID})
		if err != nil {
			return nil, err
		}
		current := currentMembers[group.ID]
		currentByID := make(map[int64]bool, len(current))
		for _, skuID := range current {
			currentByID[skuID] = true
		}
		if _, err := s.db.Exec(
			ctx,
			`update public.amazon_review_group_members
			 set removed_at = now()
			 where group_id = $1
			   and removed_at is null
			   and not (sku_record_id = any($2::bigint[]))`,
			group.ID, input.MemberIDs,
		); err != nil {
			return nil, mapAmazonReviewConstraintError(err)
		}
		for _, skuID := range input.MemberIDs {
			if currentByID[skuID] {
				continue
			}
			if _, err := s.db.Exec(
				ctx,
				`insert into public.amazon_review_group_members (
				   group_id, project_id, marketplace, sku_record_id,
				   added_at, created_at
				 )
				 values ($1, $2, $3, $4, now(), now())`,
				group.ID, group.ProjectID, group.Marketplace, skuID,
			); err != nil {
				return nil, mapAmazonReviewConstraintError(err)
			}
		}
	}

	if input.RepresentativeID != nil {
		asin, err := s.amazonReviewRepresentativeASIN(
			ctx, group.ProjectID, group.Marketplace, *input.RepresentativeID,
		)
		if err != nil {
			return nil, err
		}
		var activeMember bool
		err = s.db.QueryRow(
			ctx,
			`select exists (
			   select 1
			   from public.amazon_review_group_members
			   where group_id = $1
			     and sku_record_id = $2
			     and removed_at is null
			 )`,
			group.ID, *input.RepresentativeID,
		).Scan(&activeMember)
		if err != nil {
			return nil, err
		}
		if !activeMember {
			return nil, amazon_review_tracking.NewError(
				422,
				"representative must be an active group member",
			)
		}
		if _, err := s.db.Exec(
			ctx,
			`update public.amazon_review_groups
			 set representative_sku_record_id = $2, updated_at = now()
			 where id = $1`,
			group.ID, *input.RepresentativeID,
		); err != nil {
			return nil, mapAmazonReviewConstraintError(err)
		}
		if _, err := s.db.Exec(
			ctx,
			`update public.amazon_review_targets
			 set asin = $2, updated_at = now()
			 where group_id = $1`,
			group.ID, asin,
		); err != nil {
			return nil, mapAmazonReviewConstraintError(err)
		}
		group.RepresentativeID = input.RepresentativeID
	}

	updatedGroup, err := s.getAmazonReviewGroup(ctx, group.ID)
	if err != nil {
		return nil, err
	}
	after, err := s.amazonReviewGroupItem(ctx, *updatedGroup)
	if err != nil {
		return nil, err
	}
	return &amazon_review_tracking.ReviewGroupMutation{Before: &before, After: &after}, nil
}

func (s *AmazonReviewTrackingStore) DeactivateGroup(
	ctx context.Context,
	groupID int64,
) (*amazon_review_tracking.ReviewGroupMutation, error) {
	group, err := s.getAmazonReviewGroupForUpdate(ctx, groupID)
	if err != nil {
		return nil, err
	}
	before, err := s.amazonReviewGroupItem(ctx, *group)
	if err != nil {
		return nil, err
	}
	if !group.IsActive {
		return &amazon_review_tracking.ReviewGroupMutation{
			Before: &before,
			After:  &before,
		}, nil
	}

	if _, err := s.db.Exec(
		ctx,
		`update public.amazon_review_group_members
		 set removed_at = now()
		 where group_id = $1 and removed_at is null`,
		group.ID,
	); err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(
		ctx,
		`update public.amazon_review_groups
		 set is_active = false, updated_at = now()
		 where id = $1`,
		group.ID,
	); err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(
		ctx,
		`update public.amazon_review_targets
		 set is_active = false, display_name = $2, updated_at = now()
		 where group_id = $1`,
		group.ID, group.Name,
	); err != nil {
		return nil, err
	}
	updatedGroup, err := s.getAmazonReviewGroup(ctx, group.ID)
	if err != nil {
		return nil, err
	}
	after, err := s.amazonReviewGroupItem(ctx, *updatedGroup)
	if err != nil {
		return nil, err
	}
	return &amazon_review_tracking.ReviewGroupMutation{Before: &before, After: &after}, nil
}

func (s *AmazonReviewTrackingStore) ListTargets(
	ctx context.Context,
	filter amazon_review_tracking.TargetListFilter,
) ([]amazon_review_tracking.TargetItem, error) {
	args := make([]any, 0, 8)
	where := make([]string, 0, 5)
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
	if filter.IsActive != nil {
		args = append(args, *filter.IsActive)
		where = append(where, fmt.Sprintf("t.is_active = $%d", len(args)))
	}
	if !filter.IsAdmin {
		args = append(args, strings.TrimSpace(filter.Operator))
		where = append(where, amazonReviewTargetScopeCondition(len(args)))
	}
	args = append(args, filter.Limit, filter.Offset)

	query := `select t.id, t.kind, t.group_id, t.project_id, t.marketplace,
	                 t.asin, t.display_name, t.is_active
	          from public.amazon_review_targets t`
	if len(where) > 0 {
		query += " where " + strings.Join(where, " and ")
	}
	query += fmt.Sprintf(" order by t.id asc limit $%d offset $%d", len(args)-1, len(args))

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]amazon_review_tracking.TargetItem, 0)
	for rows.Next() {
		item, scanErr := scanAmazonReviewTarget(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *AmazonReviewTrackingStore) ListRatingSnapshots(
	ctx context.Context,
	filter amazon_review_tracking.RatingSnapshotFilter,
) ([]amazon_review_tracking.RatingSnapshotItem, error) {
	if _, err := s.amazonReviewTargetForAccess(ctx, filter.TargetID, filter.Operator, filter.IsAdmin); err != nil {
		return nil, err
	}
	args := []any{filter.TargetID}
	where := []string{"target_id = $1"}
	if filter.DateFrom != nil {
		args = append(args, *filter.DateFrom)
		where = append(where, fmt.Sprintf("capture_date >= $%d", len(args)))
	}
	if filter.DateTo != nil {
		args = append(args, *filter.DateTo)
		where = append(where, fmt.Sprintf("capture_date <= $%d", len(args)))
	}
	args = append(args, filter.Limit, filter.Offset)
	query := fmt.Sprintf(
		`select capture_date, captured_at, average_rating, rating_count, review_count,
		        star_1_percentage, star_2_percentage, star_3_percentage,
		        star_4_percentage, star_5_percentage,
		        star_1_count, star_2_count, star_3_count, star_4_count, star_5_count,
		        star_count_quality, capture_status
		 from public.amazon_review_rating_snapshots
		 where %s
		 order by capture_date asc, id asc
		 limit $%d offset $%d`,
		strings.Join(where, " and "),
		len(args)-1,
		len(args),
	)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]amazon_review_tracking.RatingSnapshotItem, 0)
	for rows.Next() {
		var (
			item            amazon_review_tracking.RatingSnapshotItem
			captureDate     pgtype.Date
			capturedAt      time.Time
			averageRating   pgtype.Numeric
			ratingCount     pgtype.Int4
			reviewCount     pgtype.Int4
			star1Percentage pgtype.Numeric
			star2Percentage pgtype.Numeric
			star3Percentage pgtype.Numeric
			star4Percentage pgtype.Numeric
			star5Percentage pgtype.Numeric
			star1Count      pgtype.Int4
			star2Count      pgtype.Int4
			star3Count      pgtype.Int4
			star4Count      pgtype.Int4
			star5Count      pgtype.Int4
		)
		if err := rows.Scan(
			&captureDate, &capturedAt, &averageRating, &ratingCount, &reviewCount,
			&star1Percentage, &star2Percentage, &star3Percentage,
			&star4Percentage, &star5Percentage,
			&star1Count, &star2Count, &star3Count, &star4Count, &star5Count,
			&item.StarCountQuality, &item.CaptureStatus,
		); err != nil {
			return nil, err
		}
		var numericErr error
		item.CaptureDate = amazonReviewDateString(captureDate)
		item.CapturedAt = httpapi.Timestamp(capturedAt)
		item.AverageRating, numericErr = amazonReviewNumericPointer(averageRating)
		if numericErr != nil {
			return nil, numericErr
		}
		item.RatingCount = amazonReviewInt4Pointer(ratingCount)
		item.ReviewCount = amazonReviewInt4Pointer(reviewCount)
		item.Star1Percentage, numericErr = amazonReviewNumericPointer(star1Percentage)
		if numericErr != nil {
			return nil, numericErr
		}
		item.Star2Percentage, numericErr = amazonReviewNumericPointer(star2Percentage)
		if numericErr != nil {
			return nil, numericErr
		}
		item.Star3Percentage, numericErr = amazonReviewNumericPointer(star3Percentage)
		if numericErr != nil {
			return nil, numericErr
		}
		item.Star4Percentage, numericErr = amazonReviewNumericPointer(star4Percentage)
		if numericErr != nil {
			return nil, numericErr
		}
		item.Star5Percentage, numericErr = amazonReviewNumericPointer(star5Percentage)
		if numericErr != nil {
			return nil, numericErr
		}
		item.Star1Count = amazonReviewInt4Pointer(star1Count)
		item.Star2Count = amazonReviewInt4Pointer(star2Count)
		item.Star3Count = amazonReviewInt4Pointer(star3Count)
		item.Star4Count = amazonReviewInt4Pointer(star4Count)
		item.Star5Count = amazonReviewInt4Pointer(star5Count)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *AmazonReviewTrackingStore) ListReviews(
	ctx context.Context,
	filter amazon_review_tracking.ReviewFilter,
) ([]amazon_review_tracking.ReviewItem, error) {
	if _, err := s.amazonReviewTargetForAccess(ctx, filter.TargetID, filter.Operator, filter.IsAdmin); err != nil {
		return nil, err
	}
	args := []any{filter.TargetID}
	where := []string{"target_id = $1"}
	if filter.VisibilityStatus != nil {
		args = append(args, *filter.VisibilityStatus)
		where = append(where, fmt.Sprintf("visibility_status = $%d", len(args)))
	}
	if filter.ReviewDateFrom != nil {
		args = append(args, *filter.ReviewDateFrom)
		where = append(where, fmt.Sprintf("review_date >= $%d", len(args)))
	}
	if filter.ReviewDateTo != nil {
		args = append(args, *filter.ReviewDateTo)
		where = append(where, fmt.Sprintf("review_date <= $%d", len(args)))
	}
	args = append(args, filter.Limit, filter.Offset)
	query := fmt.Sprintf(
		`select review_key, id_confidence, reviewer_id, reviewer_name, rating,
		        title, body, review_date, verified_purchase, helpful_count,
		        first_seen_at, last_seen_at, visibility_status
		 from public.amazon_review_reviews
		 where %s
		 order by review_date desc nulls last, id asc
		 limit $%d offset $%d`,
		strings.Join(where, " and "),
		len(args)-1,
		len(args),
	)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]amazon_review_tracking.ReviewItem, 0)
	for rows.Next() {
		var (
			item             amazon_review_tracking.ReviewItem
			reviewerID       pgtype.Text
			reviewerName     pgtype.Text
			rating           pgtype.Int4
			title            pgtype.Text
			body             pgtype.Text
			reviewDate       pgtype.Date
			verifiedPurchase pgtype.Bool
			helpfulCount     pgtype.Int4
			firstSeenAt      time.Time
			lastSeenAt       time.Time
		)
		if err := rows.Scan(
			&item.ReviewKey, &item.IDConfidence, &reviewerID, &reviewerName,
			&rating, &title, &body, &reviewDate, &verifiedPurchase, &helpfulCount,
			&firstSeenAt, &lastSeenAt, &item.VisibilityStatus,
		); err != nil {
			return nil, err
		}
		item.ReviewerID = amazonReviewTextPointer(reviewerID)
		item.ReviewerName = amazonReviewTextPointer(reviewerName)
		item.Rating = amazonReviewInt4Pointer(rating)
		item.Title = amazonReviewTextPointer(title)
		item.Body = amazonReviewTextPointer(body)
		if reviewDate.Valid {
			value := reviewDate.Time.Format("2006-01-02")
			item.ReviewDate = &value
		}
		item.VerifiedPurchase = amazonReviewBoolPointer(verifiedPurchase)
		item.HelpfulCount = amazonReviewInt4Pointer(helpfulCount)
		item.FirstSeenAt = httpapi.Timestamp(firstSeenAt)
		item.LastSeenAt = httpapi.Timestamp(lastSeenAt)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *AmazonReviewTrackingStore) ListRuns(
	ctx context.Context,
	filter amazon_review_tracking.CrawlRunFilter,
) ([]amazon_review_tracking.CrawlRunItem, error) {
	if _, err := s.amazonReviewTargetForAccess(ctx, filter.TargetID, filter.Operator, filter.IsAdmin); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(
		ctx,
		`select id, started_at, finished_at, status, is_complete_list,
		        reviews_seen, ratings_captured, asin_scraped, error_message
		 from public.amazon_review_crawl_runs
		 where target_id = $1
		 order by started_at desc, id desc
		 limit $2 offset $3`,
		filter.TargetID,
		filter.Limit,
		filter.Offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]amazon_review_tracking.CrawlRunItem, 0)
	for rows.Next() {
		var (
			item         amazon_review_tracking.CrawlRunItem
			startedAt    time.Time
			finishedAt   pgtype.Timestamptz
			reviewsSeen  pgtype.Int4
			asinScraped  pgtype.Text
			errorMessage pgtype.Text
		)
		if err := rows.Scan(
			&item.ID, &startedAt, &finishedAt, &item.Status, &item.IsCompleteList,
			&reviewsSeen, &item.RatingsCaptured, &asinScraped, &errorMessage,
		); err != nil {
			return nil, err
		}
		item.StartedAt = httpapi.Timestamp(startedAt)
		item.FinishedAt = amazonReviewTimestampPointer(finishedAt)
		item.ReviewsSeen = amazonReviewInt4Pointer(reviewsSeen)
		item.ASINScraped = amazonReviewTextPointer(asinScraped)
		item.ErrorMessage = amazonReviewTextPointer(errorMessage)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *AmazonReviewTrackingStore) ListExternalTargets(
	ctx context.Context,
	limit int64,
	offset int64,
) ([]amazon_review_tracking.ExternalTargetItem, error) {
	rows, err := s.db.Query(
		ctx,
		`select id, kind, group_id, project_id, marketplace, asin, display_name, is_active
		 from public.amazon_review_targets
		 where kind = 'external_asin'
		 order by id asc
		 limit $1 offset $2`,
		limit,
		offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	targets := make([]amazon_review_tracking.TargetItem, 0)
	for rows.Next() {
		target, scanErr := scanAmazonReviewTarget(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		targets = append(targets, target)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(targets) == 0 {
		return []amazon_review_tracking.ExternalTargetItem{}, nil
	}
	targetIDs := make([]int64, 0, len(targets))
	for _, target := range targets {
		targetIDs = append(targetIDs, target.ID)
	}
	links, err := s.amazonReviewLinksByTarget(ctx, targetIDs)
	if err != nil {
		return nil, err
	}
	items := make([]amazon_review_tracking.ExternalTargetItem, 0, len(targets))
	for _, target := range targets {
		targetLinks := links[target.ID]
		if targetLinks == nil {
			targetLinks = []amazon_review_tracking.ExternalLinkItem{}
		}
		items = append(items, amazon_review_tracking.ExternalTargetItem{
			TargetItem: target,
			Links:      targetLinks,
		})
	}
	return items, nil
}

func (s *AmazonReviewTrackingStore) CreateExternalTarget(
	ctx context.Context,
	input amazon_review_tracking.ExternalTargetCreateInput,
) (*amazon_review_tracking.ExternalTargetItem, error) {
	marketplace := strings.ToUpper(strings.TrimSpace(input.Marketplace))
	if !amazonReviewSupportedMarketplace(marketplace) {
		return nil, amazon_review_tracking.NewError(422, "invalid Marketplace")
	}
	asin := strings.ToUpper(strings.TrimSpace(input.ASIN))
	if !amazonReviewASINPattern.MatchString(asin) {
		return nil, amazon_review_tracking.NewError(422, "asin must be 10 alphanumeric characters")
	}
	displayName := amazonReviewNormalizeDisplayName(input.DisplayName)
	if displayName != nil && utf8.RuneCountInString(*displayName) > 255 {
		return nil, amazon_review_tracking.NewError(422, "display_name must be at most 255 characters")
	}

	target, err := s.findAmazonReviewExternalTarget(ctx, marketplace, asin)
	if err != nil {
		return nil, err
	}
	if target == nil {
		var targetID int64
		targetID, err = s.insertAmazonReviewExternalTargetWithSavepoint(
			ctx, marketplace, asin, displayName,
		)
		if err != nil {
			if amazonReviewIsUniqueViolation(err) {
				target, err = s.findAmazonReviewExternalTarget(ctx, marketplace, asin)
				if err == nil && target == nil {
					err = amazon_review_tracking.NewError(409, "external target conflict")
				}
			}
			if err != nil {
				return nil, mapAmazonReviewConstraintError(err)
			}
		}
		if target == nil {
			effectiveName := asin
			if displayName != nil {
				effectiveName = *displayName
			}
			target = &amazon_review_tracking.TargetItem{
				ID:          targetID,
				Kind:        "external_asin",
				Marketplace: marketplace,
				ASIN:        amazonReviewStringPointer(asin),
				DisplayName: amazonReviewStringPointer(effectiveName),
				IsActive:    true,
			}
		}
	}

	if _, err := s.db.Exec(
		ctx,
		`update public.amazon_review_targets
		 set is_active = true,
		     display_name = case when $1::text is not null then $1 else display_name end,
		     updated_at = now()
		 where id = $2`,
		displayName, target.ID,
	); err != nil {
		return nil, mapAmazonReviewConstraintError(err)
	}
	target.IsActive = true
	if displayName != nil {
		target.DisplayName = displayName
	}

	if input.ShopID != nil {
		if err := s.requireAmazonReviewShop(ctx, *input.ShopID); err != nil {
			return nil, err
		}
		if _, err := s.upsertAmazonReviewExternalLink(ctx, target.ID, *input.ShopID); err != nil {
			return nil, mapAmazonReviewConstraintError(err)
		}
	}
	links, err := s.amazonReviewLinksForTarget(ctx, target.ID)
	if err != nil {
		return nil, err
	}
	return &amazon_review_tracking.ExternalTargetItem{
		TargetItem: *target,
		Links:      links,
	}, nil
}

func (s *AmazonReviewTrackingStore) AddExternalLink(
	ctx context.Context,
	targetID int64,
	shopID int64,
) (*amazon_review_tracking.ExternalLinkItem, error) {
	target, err := s.getAmazonReviewTarget(ctx, targetID)
	if err != nil {
		return nil, err
	}
	if target.Kind != "external_asin" {
		return nil, amazon_review_tracking.NewError(422, "external target not found")
	}
	if err := s.requireAmazonReviewShop(ctx, shopID); err != nil {
		return nil, err
	}
	link, err := s.upsertAmazonReviewExternalLink(ctx, targetID, shopID)
	if err != nil {
		return nil, mapAmazonReviewConstraintError(err)
	}
	return link, nil
}

func (s *AmazonReviewTrackingStore) RemoveExternalLink(
	ctx context.Context,
	targetID int64,
	linkID int64,
) (*amazon_review_tracking.ExternalLinkItem, error) {
	if _, err := s.getAmazonReviewTarget(ctx, targetID); err != nil {
		return nil, err
	}
	var link amazon_review_tracking.ExternalLinkItem
	err := s.db.QueryRow(
		ctx,
		`select id, target_id, shop_id, is_active
		 from public.amazon_review_external_links
		 where id = $1 and target_id = $2
		 limit 1`,
		linkID,
		targetID,
	).Scan(&link.ID, &link.TargetID, &link.ShopID, &link.IsActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, amazon_review_tracking.NewError(404, "external link not found")
	}
	if err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(
		ctx,
		`update public.amazon_review_external_links
		 set is_active = false, removed_at = now()
		 where id = $1`,
		linkID,
	); err != nil {
		return nil, err
	}
	link.IsActive = false
	return &link, nil
}

func (s *AmazonReviewTrackingStore) listGroupMembers(
	ctx context.Context,
	groupIDs []int64,
) (map[int64][]int64, error) {
	members := make(map[int64][]int64, len(groupIDs))
	if len(groupIDs) == 0 {
		return members, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select group_id, sku_record_id
		 from public.amazon_review_group_members
		 where group_id = any($1::bigint[])
		   and removed_at is null
		 order by group_id asc, sku_record_id asc`,
		groupIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var groupID, skuID int64
		if err := rows.Scan(&groupID, &skuID); err != nil {
			return nil, err
		}
		members[groupID] = append(members[groupID], skuID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return members, nil
}

func (s *AmazonReviewTrackingStore) insertGroupMembers(
	ctx context.Context,
	groupID int64,
	projectID int64,
	marketplace string,
	skuIDs []int64,
) error {
	if len(skuIDs) == 0 {
		return nil
	}
	_, err := s.db.Exec(
		ctx,
		`insert into public.amazon_review_group_members (
		   group_id, project_id, marketplace, sku_record_id,
		   added_at, created_at
		 )
		 select $1, $2, $3, sku_id, now(), now()
		 from unnest($4::bigint[]) as ids(sku_id)`,
		groupID,
		projectID,
		marketplace,
		skuIDs,
	)
	return err
}

func (s *AmazonReviewTrackingStore) validateAmazonReviewGroupSKUs(
	ctx context.Context,
	projectID int64,
	marketplace string,
	skuIDs []int64,
) error {
	if len(skuIDs) == 0 {
		return amazon_review_tracking.NewError(422, "at least one member SKU is required")
	}
	rows, err := s.db.Query(
		ctx,
		`select id, project_id, country
		 from public.product_costs
		 where id = any($1::bigint[])`,
		skuIDs,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	found := make(map[int64]bool, len(skuIDs))
	for rows.Next() {
		var id, foundProjectID int64
		var country string
		if err := rows.Scan(&id, &foundProjectID, &country); err != nil {
			return err
		}
		found[id] = true
		if foundProjectID != projectID || country != marketplace {
			return amazon_review_tracking.NewError(
				422,
				"SKU must belong to the same Project and Marketplace",
			)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(found) != len(skuIDs) {
		return amazon_review_tracking.NewError(422, "unknown SKU record")
	}
	return nil
}

func (s *AmazonReviewTrackingStore) activeAmazonReviewGroupNameExists(
	ctx context.Context,
	projectID int64,
	marketplace string,
	name string,
	excludeID int64,
) (bool, error) {
	var exists bool
	err := s.db.QueryRow(
		ctx,
		`select exists (
		   select 1
		   from public.amazon_review_groups
		   where project_id = $1
		     and marketplace = $2
		     and name = $3
		     and is_active = true
		     and ($4 = 0 or id <> $4)
		 )`,
		projectID,
		marketplace,
		name,
		excludeID,
	).Scan(&exists)
	return exists, err
}

func (s *AmazonReviewTrackingStore) lockAmazonReviewGroupName(
	ctx context.Context,
	projectID int64,
	marketplace string,
	name string,
) error {
	key := fmt.Sprintf("%d:%s:%s", projectID, marketplace, name)
	// The active-name rule has no database unique constraint, so serialize the check.
	_, err := s.db.Exec(
		ctx,
		`select pg_advisory_xact_lock(hashtextextended($1, 0))`,
		key,
	)
	return err
}

func (s *AmazonReviewTrackingStore) amazonReviewRepresentativeASIN(
	ctx context.Context,
	projectID int64,
	marketplace string,
	skuID int64,
) (*string, error) {
	var asin pgtype.Text
	err := s.db.QueryRow(
		ctx,
		`select asin
		 from public.product_costs
		 where id = $1 and project_id = $2 and country = $3
		 limit 1`,
		skuID,
		projectID,
		marketplace,
	).Scan(&asin)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, amazon_review_tracking.NewError(422, "unknown SKU record")
	}
	if err != nil {
		return nil, err
	}
	return amazonReviewTextPointer(asin), nil
}

func (s *AmazonReviewTrackingStore) getAmazonReviewGroup(
	ctx context.Context,
	groupID int64,
) (*amazon_review_tracking.ReviewGroupItem, error) {
	row := s.db.QueryRow(
		ctx,
		`select id, project_id, marketplace, name, description,
		        representative_sku_record_id, is_active
		 from public.amazon_review_groups
		 where id = $1
		 limit 1`,
		groupID,
	)
	group, err := scanAmazonReviewGroup(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, amazon_review_tracking.NewError(404, "review group not found")
	}
	if err != nil {
		return nil, err
	}
	return &group, nil
}

func (s *AmazonReviewTrackingStore) getAmazonReviewGroupForUpdate(
	ctx context.Context,
	groupID int64,
) (*amazon_review_tracking.ReviewGroupItem, error) {
	row := s.db.QueryRow(
		ctx,
		`select id, project_id, marketplace, name, description,
		        representative_sku_record_id, is_active
		 from public.amazon_review_groups
		 where id = $1
		 for update`,
		groupID,
	)
	group, err := scanAmazonReviewGroup(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, amazon_review_tracking.NewError(404, "review group not found")
	}
	if err != nil {
		return nil, err
	}
	return &group, nil
}

func (s *AmazonReviewTrackingStore) amazonReviewGroupItem(
	ctx context.Context,
	group amazon_review_tracking.ReviewGroupItem,
) (amazon_review_tracking.ReviewGroupItem, error) {
	members, err := s.listGroupMembers(ctx, []int64{group.ID})
	if err != nil {
		return amazon_review_tracking.ReviewGroupItem{}, err
	}
	group.MemberIDs = members[group.ID]
	if group.MemberIDs == nil {
		group.MemberIDs = []int64{}
	}
	return group, nil
}

func (s *AmazonReviewTrackingStore) amazonReviewTargetForAccess(
	ctx context.Context,
	targetID int64,
	operator string,
	isAdmin bool,
) (*amazon_review_tracking.TargetItem, error) {
	query := `select t.id, t.kind, t.group_id, t.project_id, t.marketplace,
	                 t.asin, t.display_name, t.is_active
	          from public.amazon_review_targets t
	          where t.id = $1`
	args := []any{targetID}
	if !isAdmin {
		args = append(args, strings.TrimSpace(operator))
		query += " and " + amazonReviewTargetScopeCondition(len(args))
	}
	row := s.db.QueryRow(ctx, query, args...)
	target, err := scanAmazonReviewTarget(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, amazon_review_tracking.NewError(404, "review target not found")
	}
	if err != nil {
		return nil, err
	}
	return &target, nil
}

func (s *AmazonReviewTrackingStore) getAmazonReviewTarget(
	ctx context.Context,
	targetID int64,
) (*amazon_review_tracking.TargetItem, error) {
	row := s.db.QueryRow(
		ctx,
		`select id, kind, group_id, project_id, marketplace,
		        asin, display_name, is_active
		 from public.amazon_review_targets
		 where id = $1
		 limit 1`,
		targetID,
	)
	target, err := scanAmazonReviewTarget(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, amazon_review_tracking.NewError(404, "review target not found")
	}
	if err != nil {
		return nil, err
	}
	return &target, nil
}

func (s *AmazonReviewTrackingStore) findAmazonReviewExternalTarget(
	ctx context.Context,
	marketplace string,
	asin string,
) (*amazon_review_tracking.TargetItem, error) {
	row := s.db.QueryRow(
		ctx,
		`select id, kind, group_id, project_id, marketplace,
		        asin, display_name, is_active
		 from public.amazon_review_targets
		 where kind = 'external_asin'
		   and marketplace = $1
		   and asin = $2
		 limit 1`,
		marketplace,
		asin,
	)
	target, err := scanAmazonReviewTarget(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &target, nil
}

func (s *AmazonReviewTrackingStore) insertAmazonReviewExternalTargetWithSavepoint(
	ctx context.Context,
	marketplace string,
	asin string,
	displayName *string,
) (int64, error) {
	var targetID int64
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &AmazonReviewTrackingStore{db: NewTxDB(tx)}
		effectiveName := asin
		if displayName != nil {
			effectiveName = *displayName
		}
		return txStore.db.QueryRow(
			ctx,
			`insert into public.amazon_review_targets (
			   kind, group_id, project_id, marketplace, asin, display_name,
			   is_active, created_at, updated_at
			 )
			 values ('external_asin', null, null, $1, $2, $3, true, now(), now())
			 returning id`,
			marketplace,
			asin,
			effectiveName,
		).Scan(&targetID)
	})
	return targetID, err
}

func (s *AmazonReviewTrackingStore) requireAmazonReviewShop(
	ctx context.Context,
	shopID int64,
) error {
	var exists bool
	if err := s.db.QueryRow(
		ctx,
		`select exists (select 1 from public.project_shops where id = $1)`,
		shopID,
	).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return amazon_review_tracking.NewError(422, "shop not found")
	}
	return nil
}

func (s *AmazonReviewTrackingStore) upsertAmazonReviewExternalLink(
	ctx context.Context,
	targetID int64,
	shopID int64,
) (*amazon_review_tracking.ExternalLinkItem, error) {
	link, err := s.findAmazonReviewExternalLink(ctx, targetID, shopID)
	if err != nil {
		return nil, err
	}
	if link == nil {
		var linkID int64
		linkID, err = s.insertAmazonReviewExternalLinkWithSavepoint(ctx, targetID, shopID)
		if err != nil {
			if amazonReviewIsUniqueViolation(err) {
				link, err = s.findAmazonReviewExternalLink(ctx, targetID, shopID)
			}
			if err != nil {
				return nil, err
			}
			if link == nil {
				return nil, amazon_review_tracking.NewError(409, "external link conflict")
			}
		}
		if link == nil {
			link = &amazon_review_tracking.ExternalLinkItem{
				ID: linkID, TargetID: targetID, ShopID: shopID, IsActive: true,
			}
		}
	}
	if _, err := s.db.Exec(
		ctx,
		`update public.amazon_review_external_links
		 set is_active = true, removed_at = null, added_at = now()
		 where id = $1`,
		link.ID,
	); err != nil {
		return nil, err
	}
	link.IsActive = true
	return link, nil
}

func (s *AmazonReviewTrackingStore) findAmazonReviewExternalLink(
	ctx context.Context,
	targetID int64,
	shopID int64,
) (*amazon_review_tracking.ExternalLinkItem, error) {
	var link amazon_review_tracking.ExternalLinkItem
	err := s.db.QueryRow(
		ctx,
		`select id, target_id, shop_id, is_active
		 from public.amazon_review_external_links
		 where target_id = $1 and shop_id = $2
		 limit 1`,
		targetID,
		shopID,
	).Scan(&link.ID, &link.TargetID, &link.ShopID, &link.IsActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &link, nil
}

func (s *AmazonReviewTrackingStore) insertAmazonReviewExternalLinkWithSavepoint(
	ctx context.Context,
	targetID int64,
	shopID int64,
) (int64, error) {
	var linkID int64
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		return NewTxDB(tx).QueryRow(
			ctx,
			`insert into public.amazon_review_external_links (
			   target_id, shop_id, is_active, added_at, created_at
			 )
			 values ($1, $2, true, now(), now())
			 returning id`,
			targetID,
			shopID,
		).Scan(&linkID)
	})
	return linkID, err
}

func (s *AmazonReviewTrackingStore) amazonReviewLinksForTarget(
	ctx context.Context,
	targetID int64,
) ([]amazon_review_tracking.ExternalLinkItem, error) {
	links, err := s.amazonReviewLinksByTarget(ctx, []int64{targetID})
	if err != nil {
		return nil, err
	}
	if links[targetID] == nil {
		return []amazon_review_tracking.ExternalLinkItem{}, nil
	}
	return links[targetID], nil
}

func (s *AmazonReviewTrackingStore) amazonReviewLinksByTarget(
	ctx context.Context,
	targetIDs []int64,
) (map[int64][]amazon_review_tracking.ExternalLinkItem, error) {
	grouped := make(map[int64][]amazon_review_tracking.ExternalLinkItem, len(targetIDs))
	if len(targetIDs) == 0 {
		return grouped, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select id, target_id, shop_id, is_active
		 from public.amazon_review_external_links
		 where target_id = any($1::bigint[])
		 order by id asc`,
		targetIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var link amazon_review_tracking.ExternalLinkItem
		if err := rows.Scan(&link.ID, &link.TargetID, &link.ShopID, &link.IsActive); err != nil {
			return nil, err
		}
		grouped[link.TargetID] = append(grouped[link.TargetID], link)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return grouped, nil
}

type amazonReviewScanner interface {
	Scan(dest ...any) error
}

func scanAmazonReviewGroup(scanner amazonReviewScanner) (amazon_review_tracking.ReviewGroupItem, error) {
	var (
		item           amazon_review_tracking.ReviewGroupItem
		description    pgtype.Text
		representative pgtype.Int8
	)
	err := scanner.Scan(
		&item.ID,
		&item.ProjectID,
		&item.Marketplace,
		&item.Name,
		&description,
		&representative,
		&item.IsActive,
	)
	if err != nil {
		return amazon_review_tracking.ReviewGroupItem{}, err
	}
	item.Description = amazonReviewTextPointer(description)
	if representative.Valid {
		value := representative.Int64
		item.RepresentativeID = &value
	}
	item.MemberIDs = []int64{}
	return item, nil
}

func scanAmazonReviewTarget(scanner amazonReviewScanner) (amazon_review_tracking.TargetItem, error) {
	var (
		item        amazon_review_tracking.TargetItem
		groupID     pgtype.Int4
		projectID   pgtype.Int8
		asin        pgtype.Text
		displayName pgtype.Text
	)
	err := scanner.Scan(
		&item.ID,
		&item.Kind,
		&groupID,
		&projectID,
		&item.Marketplace,
		&asin,
		&displayName,
		&item.IsActive,
	)
	if err != nil {
		return amazon_review_tracking.TargetItem{}, err
	}
	if groupID.Valid {
		value := int64(groupID.Int32)
		item.GroupID = &value
	}
	if projectID.Valid {
		value := projectID.Int64
		item.ProjectID = &value
	}
	item.ASIN = amazonReviewTextPointer(asin)
	item.DisplayName = amazonReviewTextPointer(displayName)
	return item, nil
}

func validateAmazonReviewGroupInput(
	projectID int64,
	marketplaceValue string,
	nameValue string,
	memberIDs []int64,
	representativeID int64,
) (string, string, error) {
	marketplace := strings.ToUpper(strings.TrimSpace(marketplaceValue))
	if projectID <= 0 {
		return "", "", amazon_review_tracking.NewError(422, "project_id must be a positive integer")
	}
	if !amazonReviewSupportedMarketplace(marketplace) {
		return "", "", amazon_review_tracking.NewError(422, "invalid Marketplace")
	}
	name := strings.TrimSpace(nameValue)
	if name == "" || utf8.RuneCountInString(name) > 255 {
		return "", "", amazon_review_tracking.NewError(422, "invalid name")
	}
	if len(memberIDs) == 0 {
		return "", "", amazon_review_tracking.NewError(422, "at least one member SKU is required")
	}
	seen := make(map[int64]bool, len(memberIDs))
	for _, id := range memberIDs {
		if id <= 0 {
			return "", "", amazon_review_tracking.NewError(422, "member IDs must be positive")
		}
		if seen[id] {
			return "", "", amazon_review_tracking.NewError(422, "duplicate member IDs")
		}
		seen[id] = true
	}
	if representativeID <= 0 {
		return "", "", amazon_review_tracking.NewError(422, "representative_id must be a positive integer")
	}
	return marketplace, name, nil
}

func amazonReviewSupportedMarketplace(value string) bool {
	switch value {
	case "US", "CA", "UK", "DE", "FR", "IT", "ES", "JP", "AU", "MX",
		"BR", "NL", "SE", "PL", "BE", "IN", "SG", "AE", "SA", "TR", "EG":
		return true
	default:
		return false
	}
}

var amazonReviewASINPattern = regexp.MustCompile(`^[A-Z0-9]{10}$`)

func amazonReviewTargetScopeCondition(operatorArg int) string {
	return fmt.Sprintf(`(
	  t.kind = 'external_asin'
	  or (
	    t.project_id is not null
	    and exists (
	      select 1
	      from public.projects p
	      where p.id = t.project_id
	        and coalesce(p.is_active, true)
	        and $%d::text <> ''
	        and (
	          exists (
	            select 1
	            from unnest(regexp_split_to_array(
	              coalesce(p.project_operator, ''),
	              '[、,，;' || chr(10) || ']+'
	            )) as names(value)
	            where btrim(names.value) = $%d
	          )
	          or exists (
	            select 1
	            from unnest(regexp_split_to_array(
	              coalesce(p.assistant_operator, ''),
	              '[、,，;' || chr(10) || ']+'
	            )) as names(value)
	            where btrim(names.value) = $%d
	          )
	        )
	    )
	  )
	)`, operatorArg, operatorArg, operatorArg)
}

func amazonReviewNormalizeDisplayName(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	if normalized == "" {
		return nil
	}
	return &normalized
}

func amazonReviewTextPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func amazonReviewStringPointer(value string) *string {
	return &value
}

func amazonReviewInt64Pointer(value int64) *int64 {
	return &value
}

func ptrInt64Value(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func amazonReviewContainsInt64(items []int64, wanted int64) bool {
	if wanted <= 0 {
		return false
	}
	for _, item := range items {
		if item == wanted {
			return true
		}
	}
	return false
}

func amazonReviewInt4Pointer(value pgtype.Int4) *int64 {
	if !value.Valid {
		return nil
	}
	converted := int64(value.Int32)
	return &converted
}

func amazonReviewBoolPointer(value pgtype.Bool) *bool {
	if !value.Valid {
		return nil
	}
	converted := value.Bool
	return &converted
}

func amazonReviewNumericPointer(value pgtype.Numeric) (*float64, error) {
	if !value.Valid {
		return nil, nil
	}
	number, err := numericFloat64(value)
	if err != nil {
		return nil, err
	}
	return &number, nil
}

func amazonReviewDateString(value pgtype.Date) string {
	if !value.Valid {
		return ""
	}
	return value.Time.Format("2006-01-02")
}

func amazonReviewTimestampPointer(value pgtype.Timestamptz) *string {
	if !value.Valid {
		return nil
	}
	timestamp := httpapi.Timestamp(value.Time)
	return &timestamp
}

func amazonReviewIsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func mapAmazonReviewConstraintError(err error) error {
	if err == nil {
		return nil
	}
	var apiErr *amazon_review_tracking.Error
	if errors.As(err, &apiErr) {
		return err
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			detail := "resource conflicts with an existing record"
			switch pgErr.ConstraintName {
			case "uq_amazon_review_group_members_active_sku":
				detail = "SKU already belongs to an active review group or violates group ownership"
			case "uq_amazon_review_targets_external_key":
				detail = "external target conflicts with an existing record"
			case "uq_amazon_review_external_links_target_shop":
				detail = "external link conflicts with an existing record"
			}
			return amazon_review_tracking.NewError(
				409,
				detail,
			)
		case "23503", "23514":
			return amazon_review_tracking.NewError(
				422,
				"resource violates ownership or shape constraints",
			)
		}
	}
	return err
}
