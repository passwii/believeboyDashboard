package internal_jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store    Store
	runner   Runner
	auditor  audit.Service
	now      func() time.Time
	location *time.Location
}

func NewHandler(store Store, runner Runner, auditor audit.Service) *Handler {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		location = time.FixedZone("CST", 8*60*60)
	}
	if isNilDependency(store) {
		store = nil
	}
	if isNilDependency(runner) {
		runner = nil
	}
	if isNilDependency(auditor) {
		auditor = nil
	}
	return &Handler{
		store:    store,
		runner:   runner,
		auditor:  auditor,
		now:      time.Now,
		location: location,
	}
}

func isNilDependency(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}

func (handler *Handler) RefreshReturnAnalysis(w http.ResponseWriter, r *http.Request) {
	identity := authIdentity(r)
	if !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "需要管理员权限")
		return
	}
	if handler.store == nil || handler.runner == nil || handler.auditor == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, ErrRunnerNotConfigured.Error())
		return
	}

	var request ReturnAnalysisRefreshRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	targetDate, backfillDays, err := normalizeRefreshRequest(request, handler.now(), handler.location)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	key := idempotencyKeyFromRequest(r)
	fingerprint := requestFingerprint(map[string]any{
		"target_date":   targetDate,
		"backfill_days": backfillDays,
	})
	var replay ReturnAnalysisRefreshResponse
	if replayed, err := handler.replayIdempotent(
		r.Context(),
		"internal_jobs.return_analysis.refresh",
		key,
		fingerprint,
		&replay,
	); err != nil {
		handler.writeError(w, err)
		return
	} else if replayed {
		_ = httpapi.WriteJSON(w, http.StatusOK, replay)
		return
	}

	response := ReturnAnalysisRefreshResponse{
		TargetDate:   targetDate,
		BackfillDays: backfillDays,
		Note:         "snapshot 已被覆盖，endpoint 25h 内会读到最新",
	}
	var runnerErr, failureAuditErr error
	err = handler.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		if err := txStore.AcquireJobLock(ctx, RefreshLockKey(targetDate, backfillDays)); err != nil {
			return err
		}
		runnerCtx := WithRunnerExecution(ctx, tx, identity.Operator)
		result, err := handler.runner.RefreshReturnAnalysis(runnerCtx, targetDate, backfillDays)
		if err != nil {
			runnerErr = err
			message := err.Error()
			targetID := targetDate
			failureAuditErr = handler.logActionTx(ctx, tx, r, audit.Entry{
				Action:       "internal_jobs.return_analysis.refresh",
				TargetType:   "return_analysis_snapshot",
				TargetID:     &targetID,
				Operator:     optionalString(identity.Operator),
				Result:       "failure",
				BeforeJSON:   map[string]string{"fingerprint": fingerprint},
				ErrorMessage: &message,
			})
			// The runner records a failed job/job_run in this transaction.
			// Commit that state and the failure audit after the business SQL
			// was rolled back to its savepoint.
			return nil
		}
		response.RowsWritten = result.RowsWritten
		response.Projects = result.Projects
		targetID := targetDate
		return handler.logActionTx(ctx, tx, r, audit.Entry{
			Action:     "internal_jobs.return_analysis.refresh",
			TargetType: "return_analysis_snapshot",
			TargetID:   &targetID,
			Operator:   optionalString(identity.Operator),
			Result:     "success",
			BeforeJSON: map[string]string{"fingerprint": fingerprint},
			AfterJSON:  response,
		})
	})
	if err != nil {
		handler.auditFailure(r, "internal_jobs.return_analysis.refresh", "return_analysis_snapshot", targetDate, err)
		if runnerErr != nil {
			handler.writeRunnerError(w, runnerErr)
		} else {
			handler.writeError(w, err)
		}
		return
	}
	if runnerErr != nil {
		if failureAuditErr != nil {
			handler.auditFailure(
				r,
				"internal_jobs.return_analysis.refresh",
				"return_analysis_snapshot",
				targetDate,
				failureAuditErr,
			)
		}
		handler.writeRunnerError(w, runnerErr)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) RebuildReturnAnalysis(w http.ResponseWriter, r *http.Request) {
	identity := authIdentity(r)
	if !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "需要管理员权限")
		return
	}
	if handler.store == nil || handler.runner == nil || handler.auditor == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, ErrRunnerNotConfigured.Error())
		return
	}

	key := idempotencyKeyFromRequest(r)
	fingerprint := requestFingerprint(map[string]string{"job": "return-analysis-rebuild"})
	var replay ReturnAnalysisRebuildResponse
	if replayed, err := handler.replayIdempotent(
		r.Context(),
		"internal_jobs.return_analysis.rebuild",
		key,
		fingerprint,
		&replay,
	); err != nil {
		handler.writeError(w, err)
		return
	} else if replayed {
		_ = httpapi.WriteJSON(w, http.StatusOK, replay)
		return
	}

	response := ReturnAnalysisRebuildResponse{}
	var runnerErr, failureAuditErr error
	err := handler.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		if err := txStore.AcquireJobLock(ctx, RebuildLockKey()); err != nil {
			return err
		}
		runnerCtx := WithRunnerExecution(ctx, tx, identity.Operator)
		result, err := handler.runner.RebuildReturnAnalysis(runnerCtx)
		if err != nil {
			runnerErr = err
			message := err.Error()
			failureAuditErr = handler.logActionTx(ctx, tx, r, audit.Entry{
				Action:       "internal_jobs.return_analysis.rebuild",
				TargetType:   "return_analysis_snapshot",
				TargetID:     stringPointer("full-history"),
				Operator:     optionalString(identity.Operator),
				Result:       "failure",
				BeforeJSON:   map[string]string{"fingerprint": fingerprint},
				ErrorMessage: &message,
			})
			return nil
		}
		response = ReturnAnalysisRebuildResponse{
			RangeStart:      result.RangeStart,
			RangeEnd:        result.RangeEnd,
			RowsWritten:     result.RowsWritten,
			ProjectsTouched: result.ProjectsTouched,
		}
		return handler.logActionTx(ctx, tx, r, audit.Entry{
			Action:     "internal_jobs.return_analysis.rebuild",
			TargetType: "return_analysis_snapshot",
			TargetID:   stringPointer("full-history"),
			Operator:   optionalString(identity.Operator),
			Result:     "success",
			BeforeJSON: map[string]string{"fingerprint": fingerprint},
			AfterJSON:  response,
		})
	})
	if err != nil {
		handler.auditFailure(r, "internal_jobs.return_analysis.rebuild", "return_analysis_snapshot", "full-history", err)
		if runnerErr != nil {
			handler.writeRunnerError(w, runnerErr)
		} else {
			handler.writeError(w, err)
		}
		return
	}
	if runnerErr != nil {
		if failureAuditErr != nil {
			handler.auditFailure(
				r,
				"internal_jobs.return_analysis.rebuild",
				"return_analysis_snapshot",
				"full-history",
				failureAuditErr,
			)
		}
		handler.writeRunnerError(w, runnerErr)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) replayIdempotent(
	ctx context.Context,
	action string,
	key string,
	fingerprint string,
	destination any,
) (bool, error) {
	if key == "" || handler.store == nil {
		return false, nil
	}
	record, err := handler.store.FindIdempotencyRecord(ctx, action, key)
	if err != nil {
		return false, err
	}
	if record == nil {
		return false, nil
	}
	if record.Fingerprint != fingerprint {
		return false, ErrIdempotencyConflict
	}
	if err := json.Unmarshal(record.Response, destination); err != nil {
		return false, fmt.Errorf("decode idempotent response: %w", err)
	}
	return true, nil
}

func (handler *Handler) logActionTx(
	ctx context.Context,
	tx pgx.Tx,
	r *http.Request,
	entry audit.Entry,
) error {
	if handler.auditor == nil {
		return ErrAuditNotConfigured
	}
	entry.PopulateFromRequest(r)
	return handler.auditor.LogActionTx(ctx, tx, entry)
}

func (handler *Handler) auditFailure(
	r *http.Request,
	action string,
	targetType string,
	targetID string,
	err error,
) {
	if handler.auditor == nil {
		return
	}
	message := err.Error()
	entry := audit.Entry{
		Action:       action,
		TargetType:   targetType,
		TargetID:     &targetID,
		Operator:     optionalString(authIdentity(r).Operator),
		Result:       "failure",
		ErrorMessage: &message,
	}
	entry.PopulateFromRequest(r)
	_ = handler.auditor.LogAction(r.Context(), entry)
}

func (handler *Handler) writeError(w http.ResponseWriter, err error) {
	if status, detail, ok := ErrorStatus(err); ok {
		httpapi.WriteDetail(w, status, detail)
		return
	}
	httpapi.WriteInternalServerError(w)
}

func (handler *Handler) writeRunnerError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrDependencyNotConfigured) {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	httpapi.WriteInternalServerError(w)
}

func RefreshLockKey(targetDate string, backfillDays int) string {
	return "internal-job:return-analysis-refresh:" + targetDate + ":" + strconv.Itoa(backfillDays)
}

func RebuildLockKey() string {
	return "internal-job:return-analysis-rebuild"
}

func authIdentity(r *http.Request) auth.UserContext {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}
	return identity
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func stringPointer(value string) *string {
	return &value
}
