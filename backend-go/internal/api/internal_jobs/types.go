package internal_jobs

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

var (
	ErrRunnerNotConfigured     = errors.New("return analysis runner not configured")
	ErrDependencyNotConfigured = errors.New("dependency not configured")
	ErrAuditNotConfigured      = errors.New("internal job auditor not configured")
	ErrIdempotencyConflict     = errors.New("idempotency key reused with a different request")
)

type ReturnAnalysisRefreshRequest struct {
	TargetDate   *string `json:"target_date"`
	BackfillDays *int    `json:"backfill_days"`
}

type ReturnAnalysisRefreshResponse struct {
	TargetDate   string `json:"target_date"`
	BackfillDays int    `json:"backfill_days"`
	RowsWritten  int64  `json:"rows_written"`
	Projects     int    `json:"projects"`
	Note         string `json:"note"`
}

type ReturnAnalysisRebuildResponse struct {
	RangeStart      string `json:"range_start"`
	RangeEnd        string `json:"range_end"`
	RowsWritten     int64  `json:"rows_written"`
	ProjectsTouched int    `json:"projects_touched"`
}

type RefreshResult struct {
	RowsWritten int64
	Projects    int
}

type RebuildResult struct {
	RangeStart      string
	RangeEnd        string
	RowsWritten     int64
	ProjectsTouched int
}

type Runner interface {
	RefreshReturnAnalysis(ctx context.Context, targetDate string, backfillDays int) (RefreshResult, error)
	RebuildReturnAnalysis(ctx context.Context) (RebuildResult, error)
}

type IdempotencyRecord struct {
	Fingerprint string
	Response    json.RawMessage
}

type Store interface {
	RunInTx(ctx context.Context, fn func(context.Context, pgx.Tx, Store) error) error
	AcquireJobLock(ctx context.Context, lockKey string) error
	FindIdempotencyRecord(ctx context.Context, action, idempotencyKey string) (*IdempotencyRecord, error)
}

type APIError struct {
	Status int
	Detail string
}

func (apiError *APIError) Error() string {
	return apiError.Detail
}

func NewAPIError(status int, detail string) error {
	return &APIError{Status: status, Detail: detail}
}

func ErrorStatus(err error) (int, string, bool) {
	var apiError *APIError
	if errors.As(err, &apiError) {
		return apiError.Status, apiError.Detail, true
	}
	switch {
	case errors.Is(err, ErrIdempotencyConflict):
		return http.StatusConflict, ErrIdempotencyConflict.Error(), true
	case errors.Is(err, ErrRunnerNotConfigured),
		errors.Is(err, ErrDependencyNotConfigured),
		errors.Is(err, ErrAuditNotConfigured):
		return http.StatusServiceUnavailable, err.Error(), true
	default:
		return 0, "", false
	}
}
