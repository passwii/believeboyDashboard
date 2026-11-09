package amazon_review_tracking

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type ReviewGroupItem struct {
	ID               int64   `json:"id"`
	ProjectID        int64   `json:"project_id"`
	Marketplace      string  `json:"marketplace"`
	Name             string  `json:"name"`
	Description      *string `json:"description"`
	RepresentativeID *int64  `json:"representative_id"`
	MemberIDs        []int64 `json:"member_ids"`
	IsActive         bool    `json:"is_active"`
}

type ReviewGroupCreateInput struct {
	ProjectID        int64   `json:"project_id"`
	Marketplace      string  `json:"marketplace"`
	Name             string  `json:"name"`
	Description      *string `json:"description"`
	MemberIDs        []int64 `json:"member_ids"`
	RepresentativeID int64   `json:"representative_id"`
}

type ReviewGroupPatchInput struct {
	Name             *string
	Description      *string
	DescriptionSet   bool
	MemberIDs        []int64
	MemberIDsSet     bool
	RepresentativeID *int64
}

type ReviewGroupMutation struct {
	Before *ReviewGroupItem
	After  *ReviewGroupItem
}

type GroupListFilter struct {
	ProjectID   *int64
	Marketplace *string
	IsActive    *bool
}

type TargetItem struct {
	ID          int64   `json:"id"`
	Kind        string  `json:"kind"`
	GroupID     *int64  `json:"group_id"`
	ProjectID   *int64  `json:"project_id"`
	Marketplace string  `json:"marketplace"`
	ASIN        *string `json:"asin"`
	DisplayName *string `json:"display_name"`
	IsActive    bool    `json:"is_active"`
}

type ExternalLinkItem struct {
	ID       int64 `json:"id"`
	TargetID int64 `json:"target_id"`
	ShopID   int64 `json:"shop_id"`
	IsActive bool  `json:"is_active"`
}

type ExternalTargetItem struct {
	TargetItem
	Links []ExternalLinkItem `json:"links"`
}

type ExternalTargetCreateInput struct {
	Marketplace string  `json:"marketplace"`
	ASIN        string  `json:"asin"`
	ShopID      *int64  `json:"shop_id"`
	DisplayName *string `json:"display_name"`
}

type RatingSnapshotItem struct {
	CaptureDate      string   `json:"capture_date"`
	CapturedAt       string   `json:"captured_at"`
	AverageRating    *float64 `json:"average_rating"`
	RatingCount      *int64   `json:"rating_count"`
	ReviewCount      *int64   `json:"review_count"`
	Star1Percentage  *float64 `json:"star_1_percentage"`
	Star2Percentage  *float64 `json:"star_2_percentage"`
	Star3Percentage  *float64 `json:"star_3_percentage"`
	Star4Percentage  *float64 `json:"star_4_percentage"`
	Star5Percentage  *float64 `json:"star_5_percentage"`
	Star1Count       *int64   `json:"star_1_count"`
	Star2Count       *int64   `json:"star_2_count"`
	Star3Count       *int64   `json:"star_3_count"`
	Star4Count       *int64   `json:"star_4_count"`
	Star5Count       *int64   `json:"star_5_count"`
	StarCountQuality string   `json:"star_count_quality"`
	CaptureStatus    string   `json:"capture_status"`
}

type ReviewItem struct {
	ReviewKey        string  `json:"review_key"`
	IDConfidence     string  `json:"id_confidence"`
	ReviewerID       *string `json:"reviewer_id"`
	ReviewerName     *string `json:"reviewer_name"`
	Rating           *int64  `json:"rating"`
	Title            *string `json:"title"`
	Body             *string `json:"body"`
	ReviewDate       *string `json:"review_date"`
	VerifiedPurchase *bool   `json:"verified_purchase"`
	HelpfulCount     *int64  `json:"helpful_count"`
	FirstSeenAt      string  `json:"first_seen_at"`
	LastSeenAt       string  `json:"last_seen_at"`
	VisibilityStatus string  `json:"visibility_status"`
}

type CrawlRunItem struct {
	ID              int64   `json:"id"`
	StartedAt       string  `json:"started_at"`
	FinishedAt      *string `json:"finished_at"`
	Status          string  `json:"status"`
	IsCompleteList  bool    `json:"is_complete_list"`
	ReviewsSeen     *int64  `json:"reviews_seen"`
	RatingsCaptured bool    `json:"ratings_captured"`
	ASINScraped     *string `json:"asin_scraped"`
	ErrorMessage    *string `json:"error_message"`
}

type TargetListFilter struct {
	ProjectID   *int64
	Marketplace *string
	Kind        *string
	IsActive    *bool
	Limit       int64
	Offset      int64
	Operator    string
	IsAdmin     bool
}

type RatingSnapshotFilter struct {
	TargetID int64
	DateFrom *time.Time
	DateTo   *time.Time
	Limit    int64
	Offset   int64
	Operator string
	IsAdmin  bool
}

type ReviewFilter struct {
	TargetID         int64
	VisibilityStatus *string
	ReviewDateFrom   *time.Time
	ReviewDateTo     *time.Time
	Limit            int64
	Offset           int64
	Operator         string
	IsAdmin          bool
}

type CrawlRunFilter struct {
	TargetID int64
	Limit    int64
	Offset   int64
	Operator string
	IsAdmin  bool
}

type SessionAccount struct {
	IsAdmin  bool
	IsActive bool
	RoleType string
}

// SessionValidator closes the gap between the trusted account lookup and the
// Redis-backed session revocation check used by the FastAPI implementation.
// Wiring remains optional so the gateway can inject the shared Redis client
// without making this domain depend on a specific cache implementation.
type SessionValidator interface {
	ValidateSession(ctx context.Context, userID, sessionID string) (bool, error)
}

type Store interface {
	GetSessionAccount(ctx context.Context, userID string) (*SessionAccount, error)

	ListGroups(ctx context.Context, filter GroupListFilter) ([]ReviewGroupItem, error)
	CreateGroup(ctx context.Context, input ReviewGroupCreateInput) (*ReviewGroupItem, error)
	PatchGroup(ctx context.Context, groupID int64, input ReviewGroupPatchInput) (*ReviewGroupMutation, error)
	DeactivateGroup(ctx context.Context, groupID int64) (*ReviewGroupMutation, error)

	ListTargets(ctx context.Context, filter TargetListFilter) ([]TargetItem, error)
	ListRatingSnapshots(ctx context.Context, filter RatingSnapshotFilter) ([]RatingSnapshotItem, error)
	ListReviews(ctx context.Context, filter ReviewFilter) ([]ReviewItem, error)
	ListRuns(ctx context.Context, filter CrawlRunFilter) ([]CrawlRunItem, error)

	ListExternalTargets(ctx context.Context, limit, offset int64) ([]ExternalTargetItem, error)
	CreateExternalTarget(ctx context.Context, input ExternalTargetCreateInput) (*ExternalTargetItem, error)
	AddExternalLink(ctx context.Context, targetID, shopID int64) (*ExternalLinkItem, error)
	RemoveExternalLink(ctx context.Context, targetID, linkID int64) (*ExternalLinkItem, error)

	RunInTx(ctx context.Context, fn func(context.Context, pgx.Tx, Store) error) error
}

type Error struct {
	Status int
	Detail string
}

func (err *Error) Error() string {
	return err.Detail
}

func NewError(status int, detail string) error {
	return &Error{Status: status, Detail: detail}
}

func WriteError(w http.ResponseWriter, err error) {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		httpapi.WriteDetail(w, apiErr.Status, apiErr.Detail)
		return
	}
	httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
}
