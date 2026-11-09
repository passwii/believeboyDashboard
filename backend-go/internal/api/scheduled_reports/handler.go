package scheduled_reports

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

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
)

type Handler struct {
	store    Store
	enqueuer Enqueuer
	runner   Runner
	mailer   Mailer
	auditor  audit.Service
	now      func() time.Time
}

func NewHandler(
	store Store,
	enqueuer Enqueuer,
	runner Runner,
	mailer Mailer,
	auditor audit.Service,
) *Handler {
	if isNilDependency(store) {
		store = nil
	}
	if isNilDependency(enqueuer) {
		enqueuer = nil
	}
	if isNilDependency(runner) {
		runner = nil
	}
	if isNilDependency(mailer) {
		mailer = nil
	}
	if isNilDependency(auditor) {
		auditor = nil
	}
	return &Handler{
		store:    store,
		enqueuer: enqueuer,
		runner:   runner,
		mailer:   mailer,
		auditor:  auditor,
		now:      time.Now,
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

func (handler *Handler) ListSubscriptions(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, false, true)
	if !ok {
		return
	}
	if handler.store == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "scheduled report store not configured")
		return
	}

	var frequency *string
	if raw := strings.TrimSpace(r.URL.Query().Get("frequency")); raw != "" {
		if err := validateFrequency(raw); err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		frequency = &raw
	}

	subscriptions, err := handler.store.ListSubscriptions(r.Context(), scope, frequency)
	if err != nil {
		handler.writeError(w, err)
		return
	}
	if subscriptions == nil {
		subscriptions = []Subscription{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, SubscriptionListResponse{
		Items: subscriptions,
		Total: len(subscriptions),
	})
}

func (handler *Handler) CreateSubscription(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, false, true)
	if !ok {
		return
	}
	if handler.store == nil || handler.auditor == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "scheduled report store not configured")
		return
	}

	var request SubscriptionCreateRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	input, err := normalizeCreateRequest(request)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	input.UserID = scope.UserID

	var created *Subscription
	var createErr error
	err = handler.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		if err := handler.verifyProjectIDs(ctx, txStore, scope, input.ProjectIDs); err != nil {
			return err
		}
		created, createErr = txStore.CreateSubscription(ctx, input)
		if createErr != nil {
			return createErr
		}
		entry := audit.Entry{
			Action:     "scheduled_reports.subscription.create",
			TargetType: "scheduled_report_subscription",
			Result:     "success",
			AfterJSON:  created,
			Operator:   optionalString(scope.Operator),
		}
		targetID := strconv.FormatInt(created.ID, 10)
		entry.TargetID = &targetID
		return handler.logActionTx(ctx, tx, r, entry)
	})
	if err != nil {
		handler.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, created)
}

func (handler *Handler) UpdateSubscription(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, false, true)
	if !ok {
		return
	}
	if handler.store == nil || handler.auditor == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "scheduled report store not configured")
		return
	}
	subscriptionID, ok := handler.pathInt64(w, r, "subscription_id")
	if !ok {
		return
	}

	var request SubscriptionUpdateRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}

	var updated *Subscription
	err := handler.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		existing, err := txStore.GetSubscription(ctx, subscriptionID)
		if err != nil {
			return err
		}
		if !canManageSubscription(existing, scope) {
			return ErrSubscriptionNotFound
		}
		patch, err := normalizeUpdateRequest(request, existing)
		if err != nil {
			return NewAPIError(http.StatusUnprocessableEntity, err.Error())
		}
		if patch.ProjectIDs.Set && patch.ProjectIDs.Value != nil {
			if err := handler.verifyProjectIDs(ctx, txStore, scope, *patch.ProjectIDs.Value); err != nil {
				return err
			}
		}
		updated, err = txStore.UpdateSubscription(ctx, subscriptionID, patch)
		if err != nil {
			return err
		}
		if updated == nil {
			return ErrSubscriptionNotFound
		}
		targetID := strconv.FormatInt(subscriptionID, 10)
		return handler.logActionTx(ctx, tx, r, audit.Entry{
			Action:     "scheduled_reports.subscription.update",
			TargetType: "scheduled_report_subscription",
			TargetID:   &targetID,
			Operator:   optionalString(scope.Operator),
			Result:     "success",
			BeforeJSON: existing,
			AfterJSON:  updated,
		})
	})
	if err != nil {
		handler.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, updated)
}

func (handler *Handler) DeleteSubscription(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, false, true)
	if !ok {
		return
	}
	if handler.store == nil || handler.auditor == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "scheduled report store not configured")
		return
	}
	subscriptionID, ok := handler.pathInt64(w, r, "subscription_id")
	if !ok {
		return
	}

	err := handler.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		existing, err := txStore.GetSubscription(ctx, subscriptionID)
		if err != nil {
			return err
		}
		if !canManageSubscription(existing, scope) {
			return ErrSubscriptionNotFound
		}
		deleted, err := txStore.DeleteSubscription(ctx, subscriptionID)
		if err != nil {
			return err
		}
		if !deleted {
			return ErrSubscriptionNotFound
		}
		targetID := strconv.FormatInt(subscriptionID, 10)
		return handler.logActionTx(ctx, tx, r, audit.Entry{
			Action:     "scheduled_reports.subscription.delete",
			TargetType: "scheduled_report_subscription",
			TargetID:   &targetID,
			Operator:   optionalString(scope.Operator),
			Result:     "success",
			BeforeJSON: existing,
		})
	})
	if err != nil {
		handler.writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) ListDeliveryLogs(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, false, true)
	if !ok {
		return
	}
	if handler.store == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "scheduled report store not configured")
		return
	}

	limit, offset, ok := handler.limitOffset(w, r, 50)
	if !ok {
		return
	}
	var status *string
	if raw := strings.TrimSpace(r.URL.Query().Get("status")); raw != "" {
		status = &raw
	}
	response, err := handler.store.ListDeliveryLogs(r.Context(), scope, status, limit, offset)
	if err != nil {
		handler.writeError(w, err)
		return
	}
	if response.Items == nil {
		response.Items = []DeliveryLog{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) SendTestEmail(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, false, true)
	if !ok {
		return
	}
	if handler.store == nil || handler.mailer == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, ErrMailerNotConfigured.Error())
		return
	}

	var request TestEmailRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	message, projectIDs, err := normalizeTestEmailRequest(request)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	for _, projectID := range projectIDs {
		if err := handler.store.VerifyProjectAccess(r.Context(), projectID, scope.Operator, scope.IsAdmin); err != nil {
			handler.writeError(w, err)
			return
		}
	}

	resendID, err := handler.mailer.SendTestReport(r.Context(), message)
	if err != nil {
		if errors.Is(err, ErrMailerNotConfigured) {
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, ErrMailerNotConfigured.Error())
			return
		}
		_ = httpapi.WriteJSON(w, http.StatusOK, TestEmailResponse{
			Success: false,
			Message: "发送失败: " + err.Error(),
		})
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, TestEmailResponse{
		Success:  true,
		Message:  fmt.Sprintf("测试报告已发送到 %s（含真实数据）", message.Email),
		ResendID: resendID,
	})
}

func (handler *Handler) GetLedger(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, false, true)
	if !ok {
		return
	}
	if handler.store == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "scheduled report store not configured")
		return
	}

	startDate := strings.TrimSpace(r.URL.Query().Get("start_date"))
	endDate := strings.TrimSpace(r.URL.Query().Get("end_date"))
	if startDate == "" || endDate == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "start_date and end_date are required")
		return
	}
	start, err := time.Parse("2006-01-02", startDate)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "start_date must be YYYY-MM-DD")
		return
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "end_date must be YYYY-MM-DD")
		return
	}
	if end.Before(start) {
		httpapi.WriteDetail(w, http.StatusBadRequest, "end_date must be greater than or equal to start_date")
		return
	}

	frequency := strings.TrimSpace(r.URL.Query().Get("frequency"))
	if frequency == "" {
		frequency = "all"
	}
	if frequency != "all" {
		if err := validateFrequency(frequency); err != nil {
			httpapi.WriteDetail(w, http.StatusBadRequest, "frequency 参数无效")
			return
		}
	}
	status := strings.TrimSpace(r.URL.Query().Get("status_filter"))
	if status == "" {
		status = "all"
	}
	if status != "all" && status != StatusSent && status != StatusFailed && status != StatusMissing {
		httpapi.WriteDetail(w, http.StatusBadRequest, "status_filter 参数无效")
		return
	}

	var projectID *int64
	if raw := strings.TrimSpace(r.URL.Query().Get("project_id")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a valid integer")
			return
		}
		if parsed <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be greater than 0")
			return
		}
		projectID = &parsed
		if err := handler.store.VerifyProjectAccess(r.Context(), parsed, scope.Operator, scope.IsAdmin); err != nil {
			handler.writeError(w, err)
			return
		}
	}
	var email *string
	if raw := strings.TrimSpace(r.URL.Query().Get("email")); raw != "" {
		email = &raw
	}

	limit, offset, ok := handler.limitOffset(w, r, 100)
	if !ok {
		return
	}
	if limit < 1 || limit > 500 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "limit 必须在 1-500 之间")
		return
	}
	response, err := handler.store.RefreshLedger(r.Context(), LedgerQuery{
		StartDate: startDate,
		EndDate:   endDate,
		Frequency: frequency,
		Status:    status,
		ProjectID: projectID,
		Email:     email,
		Limit:     limit,
		Offset:    offset,
		Scope:     scope,
	})
	if err != nil {
		handler.writeError(w, err)
		return
	}
	if response.Items == nil {
		response.Items = []LedgerItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) ResendLedgerEntry(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, true, false)
	if !ok {
		return
	}
	if handler.store == nil || handler.runner == nil || handler.auditor == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, ErrEnqueuerNotConfigured.Error())
		return
	}
	ledgerKey := strings.TrimSpace(chi.URLParam(r, "ledger_key"))
	if ledgerKey == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "ledger_key is required")
		return
	}
	force := false
	if parsed, validation := httpapi.ParseOptionalBoolQuery(r, "force"); validation != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validation})
		return
	} else if parsed != nil {
		force = *parsed
	}
	override := trimOptional(optionalString(r.URL.Query().Get("ai_model")))
	key := idempotencyKeyFromRequest(r)
	fingerprint := requestFingerprint(map[string]any{
		"ledger_key": ledgerKey,
		"force":      force,
		"ai_model":   override,
	})
	var replay LedgerResendResponse
	if replayed, err := handler.replayIdempotent(
		r.Context(),
		"scheduled_reports.ledger.resend",
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

	var response LedgerResendResponse
	enqueueFailed := false
	err := handler.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		result, err := txStore.PrepareResend(ctx, ResendRequest{
			LedgerKey:   ledgerKey,
			Force:       force,
			OverrideAI:  override,
			Idempotency: key,
		})
		if err != nil {
			return err
		}
		if !result.Reused {
			if result.Email == nil || strings.TrimSpace(*result.Email) == "" {
				return NewAPIError(http.StatusConflict, "订阅未配置邮箱，无法补发")
			}
			payload := dispatchOnePayload(result)
			_, err = handler.runner.Run(ctx, EnqueueRequest{
				TaskType:       queue.TypeDispatchOne,
				Payload:        payload,
				IdempotencyKey: resendTaskKey(key, ledgerKey, result.DeliveryLogID),
			})
			if err != nil {
				enqueueFailed = true
				return fmt.Errorf("enqueue scheduled report resend: %w", err)
			}
		}
		response = LedgerResendResponse{
			Success:       true,
			LedgerKey:     ledgerKey,
			DeliveryLogID: result.DeliveryLogID,
			Status:        result.Status,
			Message:       result.Message,
		}
		targetID := ledgerKey
		return handler.logActionTx(ctx, tx, r, audit.Entry{
			Action:     "scheduled_reports.ledger.resend",
			TargetType: "scheduled_report_ledger",
			TargetID:   &targetID,
			Operator:   optionalString(scope.Operator),
			Result:     "success",
			BeforeJSON: map[string]string{"fingerprint": fingerprint},
			AfterJSON:  response,
		})
	})
	if err != nil {
		if enqueueFailed {
			handler.auditFailure(r, "scheduled_reports.ledger.resend", "scheduled_report_ledger", ledgerKey, err)
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "scheduled report queue unavailable")
			return
		}
		handler.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) RegenerateAISummary(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, true, false)
	if !ok {
		return
	}
	if handler.store == nil || handler.runner == nil || handler.auditor == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, ErrEnqueuerNotConfigured.Error())
		return
	}
	ledgerKey := strings.TrimSpace(chi.URLParam(r, "ledger_key"))
	if ledgerKey == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "ledger_key is required")
		return
	}
	override := trimOptional(optionalString(r.URL.Query().Get("ai_model")))
	key := idempotencyKeyFromRequest(r)
	fingerprint := requestFingerprint(map[string]any{
		"ledger_key": ledgerKey,
		"ai_model":   override,
	})
	var replay LedgerRegenerateSummaryResponse
	if replayed, err := handler.replayIdempotent(
		r.Context(),
		"scheduled_reports.ledger.ai_summary.regenerate",
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

	var response LedgerRegenerateSummaryResponse
	enqueueFailed := false
	err := handler.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		result, err := txStore.PrepareAISummaryRegeneration(ctx, RegenerateRequest{
			LedgerKey:   ledgerKey,
			OverrideAI:  override,
			Idempotency: key,
		})
		if err != nil {
			return err
		}
		if !result.Reused {
			payload := map[string]any{
				"log_id":            result.DeliveryLogID,
				"ledger_key":        ledgerKey,
				"override_ai_model": override,
			}
			_, err = handler.runner.Run(ctx, EnqueueRequest{
				TaskType:       queue.TypeGenerateDeliverySummary,
				Payload:        payload,
				IdempotencyKey: summaryTaskKey(key, ledgerKey, result.DeliveryLogID, handler.now().UnixNano()),
			})
			if err != nil {
				enqueueFailed = true
				return fmt.Errorf("enqueue scheduled report ai summary: %w", err)
			}
		}
		response = LedgerRegenerateSummaryResponse{
			Success:       true,
			LedgerKey:     ledgerKey,
			DeliveryLogID: result.DeliveryLogID,
			Status:        result.Status,
			InsightRunID:  result.InsightRunID,
			Message:       result.Message,
		}
		targetID := ledgerKey
		return handler.logActionTx(ctx, tx, r, audit.Entry{
			Action:     "scheduled_reports.ledger.ai_summary.regenerate",
			TargetType: "scheduled_report_ledger",
			TargetID:   &targetID,
			Operator:   optionalString(scope.Operator),
			Result:     "success",
			BeforeJSON: map[string]string{"fingerprint": fingerprint},
			AfterJSON:  response,
		})
	})
	if err != nil {
		if enqueueFailed {
			handler.auditFailure(r, "scheduled_reports.ledger.ai_summary.regenerate", "scheduled_report_ledger", ledgerKey, err)
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "scheduled report queue unavailable")
			return
		}
		handler.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) TriggerReportDispatch(w http.ResponseWriter, r *http.Request) {
	scope, ok := handler.scope(w, r, true, false)
	if !ok {
		return
	}
	if handler.store == nil || handler.enqueuer == nil || handler.auditor == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, ErrEnqueuerNotConfigured.Error())
		return
	}
	frequency := strings.TrimSpace(r.URL.Query().Get("frequency"))
	if frequency == "" {
		frequency = FrequencyDaily
	}
	if err := validateFrequency(frequency); err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "frequency 必须为 daily/weekly/monthly")
		return
	}
	key := idempotencyKeyFromRequest(r)
	fingerprint := requestFingerprint(map[string]string{"frequency": frequency})
	var replay TriggerReportResponse
	if replayed, err := handler.replayIdempotent(
		r.Context(),
		"scheduled_reports.trigger",
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

	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		location = time.FixedZone("CST", 8*60*60)
	}
	reportDate := handler.now().In(location).Format("2006-01-02")
	response := TriggerReportResponse{
		Success:   true,
		Frequency: frequency,
		Message:   fmt.Sprintf("%s 报告调度已启动（后台执行中），请查看日志或推送记录确认结果。", frequency),
	}
	enqueueFailed := false
	err = handler.store.RunInTx(r.Context(), func(
		ctx context.Context,
		tx pgx.Tx,
		txStore Store,
	) error {
		if err := txStore.AcquireTriggerLock(ctx, frequency); err != nil {
			return err
		}
		subscriptions, err := txStore.ListActiveSubscriptions(ctx, frequency)
		if err != nil {
			return err
		}
		for _, subscription := range subscriptions {
			if subscription.Email == nil || strings.TrimSpace(*subscription.Email) == "" {
				response.Skipped++
				continue
			}
			payload := triggerDispatchPayload(subscription, reportDate)
			_, err := handler.enqueuer.Enqueue(ctx, EnqueueRequest{
				TaskType:       queue.TypeDispatchOne,
				Payload:        payload,
				IdempotencyKey: fmt.Sprintf("scheduled-report-trigger:%d:%s", subscription.ID, reportDate),
			})
			if err != nil {
				enqueueFailed = true
				return fmt.Errorf("enqueue scheduled report trigger: %w", err)
			}
			response.SubscriptionsAffected++
		}
		targetID := frequency
		return handler.logActionTx(ctx, tx, r, audit.Entry{
			Action:     "scheduled_reports.trigger",
			TargetType: "scheduled_report_frequency",
			TargetID:   &targetID,
			Operator:   optionalString(scope.Operator),
			Result:     "success",
			BeforeJSON: map[string]string{"fingerprint": fingerprint},
			AfterJSON:  response,
		})
	})
	if err != nil {
		if enqueueFailed {
			handler.auditFailure(r, "scheduled_reports.trigger", "scheduled_report_frequency", frequency, err)
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "scheduled report queue unavailable")
			return
		}
		handler.writeError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (handler *Handler) scope(
	w http.ResponseWriter,
	r *http.Request,
	requireAdmin bool,
	requireUser bool,
) (Scope, bool) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}
	if requireAdmin && !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "需要管理员权限")
		return Scope{}, false
	}
	userID, err := parseOptionalIntHeader(identity.UserID)
	if err != nil {
		if requireUser && !identity.IsAdmin {
			httpapi.WriteDetail(w, http.StatusForbidden, "缺少有效的 X-User-Id")
			return Scope{}, false
		}
		userID = nil
	}
	if userID != nil && *userID <= 0 {
		userID = nil
	}
	if requireUser && !identity.IsAdmin && userID == nil {
		httpapi.WriteDetail(w, http.StatusForbidden, "缺少有效的 X-User-Id")
		return Scope{}, false
	}
	return Scope{
		UserID:   userID,
		Operator: strings.TrimSpace(identity.Operator),
		IsAdmin:  identity.IsAdmin,
	}, true
}

func canManageSubscription(subscription *Subscription, scope Scope) bool {
	if subscription == nil {
		return false
	}
	if scope.IsAdmin {
		return true
	}
	return scope.UserID != nil && subscription.UserID != nil && *scope.UserID == *subscription.UserID
}

func (handler *Handler) verifyProjectIDs(
	ctx context.Context,
	store Store,
	scope Scope,
	projectIDs string,
) error {
	for _, projectID := range projectIDsFromString(projectIDs) {
		if err := store.VerifyProjectAccess(ctx, projectID, scope.Operator, scope.IsAdmin); err != nil {
			return err
		}
	}
	return nil
}

func (handler *Handler) pathInt64(
	w http.ResponseWriter,
	r *http.Request,
	name string,
) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be a positive integer")
		return 0, false
	}
	return value, true
}

func (handler *Handler) limitOffset(
	w http.ResponseWriter,
	r *http.Request,
	defaultLimit int,
) (int, int, bool) {
	limit := defaultLimit
	offset := 0
	if parsed, validation := httpapi.ParseIntegerQuery(r, "limit"); validation != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validation})
		return 0, 0, false
	} else if parsed.Present {
		limit = parsed.IntSaturated()
	}
	if parsed, validation := httpapi.ParseIntegerQuery(r, "offset"); validation != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validation})
		return 0, 0, false
	} else if parsed.Present {
		offset = parsed.IntSaturated()
	}
	if offset < 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "offset must be greater than or equal to 0")
		return 0, 0, false
	}
	return limit, offset, true
}

func (handler *Handler) writeError(w http.ResponseWriter, err error) {
	if status, detail, ok := ErrorStatus(err); ok {
		httpapi.WriteDetail(w, status, detail)
		return
	}
	if status, detail, ok := apiErrorFromError(err); ok {
		httpapi.WriteDetail(w, status, detail)
		return
	}
	httpapi.WriteInternalServerError(w)
}

func apiErrorFromError(err error) (int, string, bool) {
	var apiError *APIError
	if errors.As(err, &apiError) {
		return apiError.Status, apiError.Detail, true
	}
	return 0, "", false
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
		Operator:     optionalString(authUserOperator(r)),
		Result:       "failure",
		ErrorMessage: &message,
	}
	entry.PopulateFromRequest(r)
	_ = handler.auditor.LogAction(r.Context(), entry)
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
		return false, ErrIDempotencyConflict
	}
	if err := json.Unmarshal(record.Response, destination); err != nil {
		return false, fmt.Errorf("decode idempotent response: %w", err)
	}
	return true, nil
}

func idempotencyKeyFromRequest(r *http.Request) string {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		key = strings.TrimSpace(r.Header.Get("X-Idempotency-Key"))
	}
	runes := []rune(key)
	if len(runes) > 64 {
		return string(runes[:64])
	}
	return key
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func authUserOperator(r *http.Request) string {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}
	return identity.Operator
}

func dispatchOnePayload(result ResendResult) map[string]any {
	payload := map[string]any{
		"subscription_id":     result.SubscriptionID,
		"email":               result.Email,
		"country":             result.Country,
		"frequency":           result.Frequency,
		"ai_model":            result.AIModel,
		"use_cache":           false,
		"triggered_by":        "manual",
		"report_date":         result.ReportDate,
		"pre_existing_log_id": result.DeliveryLogID,
		"old_log_id":          result.OldLogID,
	}
	if ids := projectIDsFromString(result.ProjectIDs); len(ids) > 0 {
		payload["project_ids"] = ids
	}
	return payload
}

func triggerDispatchPayload(subscription Subscription, reportDate string) map[string]any {
	payload := map[string]any{
		"subscription_id": subscription.ID,
		"email":           subscription.Email,
		"country":         subscription.Country,
		"frequency":       subscription.Frequency,
		"ai_model":        subscription.AIModel,
		"use_cache":       false,
		"triggered_by":    "manual",
		"report_date":     reportDate,
	}
	if ids := projectIDsFromString(subscription.ProjectIDs); len(ids) > 0 {
		payload["project_ids"] = ids
	}
	return payload
}

func resendTaskKey(idempotencyKey, ledgerKey string, deliveryLogID *int64) string {
	if idempotencyKey == "" {
		if deliveryLogID != nil {
			return fmt.Sprintf("scheduled-report-resend:%s:%d", ledgerKey, *deliveryLogID)
		}
		return "scheduled-report-resend:" + ledgerKey
	}
	return "scheduled-report-resend:" + idempotencyKey
}

func summaryTaskKey(
	idempotencyKey string,
	ledgerKey string,
	deliveryLogID *int64,
	nonce int64,
) string {
	if idempotencyKey == "" {
		if deliveryLogID != nil {
			return fmt.Sprintf("scheduled-report-summary:%s:%d:%d", ledgerKey, *deliveryLogID, nonce)
		}
		return fmt.Sprintf("scheduled-report-summary:%s:%d", ledgerKey, nonce)
	}
	return "scheduled-report-summary:" + idempotencyKey
}

// TriggerLockKey is shared by the HTTP trigger and the beat scheduler. Both
// must use the same PostgreSQL advisory transaction lock key.
func TriggerLockKey(frequency string) string {
	return "scheduled-report-trigger:" + strings.TrimSpace(frequency)
}
