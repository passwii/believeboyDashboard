package agent_inspection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store Store
	blobs BlobStore
	now   func() time.Time
}

func NewHandler(
	store Store,
	blobs BlobStore,
	options Options,
) *Handler {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Handler{
		store: store,
		blobs: blobs,
		now:   now,
	}
}

type successEnvelope struct {
	OK             bool   `json:"ok"`
	Data           any    `json:"data"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

func writeSuccess(w http.ResponseWriter, data any, idempotencyKey *string) {
	payload := successEnvelope{OK: true, Data: data}
	if idempotencyKey != nil {
		payload.IdempotencyKey = *idempotencyKey
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeAPIError(w http.ResponseWriter, err error) {
	if err == nil {
		agentauth.WriteError(
			w,
			http.StatusInternalServerError,
			agentauth.ErrorCodeInternalError,
			agentauth.DetailInternalError,
		)
		return
	}
	var apiErr *agentauth.APIError
	if errors.As(err, &apiErr) {
		agentauth.WriteAPIError(w, apiErr)
		return
	}
	var validationErr *ValidationError
	if errors.As(err, &validationErr) {
		code := validationErr.Code
		if code == "" {
			code = agentauth.ErrorCodeValidationFailed
		}
		detail := validationErr.Detail
		if detail == "" {
			detail = agentauth.DetailValidationFailed
		}
		agentauth.WriteError(w, http.StatusUnprocessableEntity, code, detail)
		return
	}
	switch {
	case errors.Is(err, ErrPeriodNotFound):
		notFoundError(w, "周期不存在")
	case errors.Is(err, ErrProjectNotFound):
		notFoundError(w, "项目不存在")
	case errors.Is(err, ErrReportNotFound):
		notFoundError(w, "巡检报告不存在")
	case errors.Is(err, ErrScreenshotNotFound):
		notFoundError(w, "截图不存在")
	case errors.Is(err, ErrReportState):
		agentauth.WriteError(
			w,
			http.StatusConflict,
			agentauth.ErrorCodeValidationFailed,
			"巡检报告当前状态不允许该操作",
		)
	case errors.Is(err, ErrIdempotencyConflict):
		agentauth.WriteError(
			w,
			http.StatusConflict,
			"IDEMPOTENCY_KEY_CONFLICT",
			"Idempotency-Key 已被用于不同的请求",
		)
	case errors.Is(err, ErrDependencyUnavailable):
		writeAPIError(w, unavailable("required dependency unavailable"))
	default:
		slog.Error("agent inspection internal error", "error", err)
		agentauth.WriteError(
			w,
			http.StatusInternalServerError,
			agentauth.ErrorCodeInternalError,
			agentauth.DetailInternalError,
		)
	}
}

func notFoundError(w http.ResponseWriter, detail string) {
	agentauth.WriteError(
		w,
		http.StatusNotFound,
		"RESOURCE_NOT_FOUND",
		detail,
	)
}

func (h *Handler) runInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	if runner, ok := h.store.(TransactionRunner); ok {
		return runner.RunInTx(ctx, fn)
	}
	return fn(ctx, nil, h.store)
}

func (h *Handler) auditMutation(
	r *http.Request,
	tx pgx.Tx,
	auditStore Store,
	action string,
	targetType string,
	targetID string,
	before any,
	after any,
) error {
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		return &agentauth.APIError{
			Status: http.StatusUnauthorized,
			Code:   agentauth.ErrorCodeAgentAuthFailed,
			Detail: agentauth.DetailTokenInvalid,
		}
	}
	entry := AuditEntry{
		Action:     action,
		TargetType: targetType,
		TargetID:   &targetID,
		BeforeJSON: before,
		AfterJSON:  after,
		AgentID:    stringPointer(credential.AgentID),
		AgentName:  stringPointer(credential.Label),
	}
	if r != nil {
		method := r.Method
		path := r.URL.Path
		entry.RequestMethod = &method
		entry.RequestPath = &path
		if userAgent := strings.TrimSpace(r.UserAgent()); userAgent != "" {
			entry.UserAgent = &userAgent
		}
		if traceID := strings.TrimSpace(r.Header.Get("X-Request-ID")); traceID != "" {
			entry.TraceID = &traceID
		}
		if idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key")); idempotencyKey != "" {
			entry.IdempotencyKey = &idempotencyKey
		}
		if ipAddress := clientIPAddress(r); ipAddress != "" {
			entry.IPAddress = &ipAddress
		}
	}
	if auditStore == nil {
		return ErrDependencyUnavailable
	}
	return auditStore.LogAudit(r.Context(), tx, entry)
}

func clientIPAddress(r *http.Request) string {
	if r == nil {
		return ""
	}
	remoteAddress := strings.TrimSpace(r.RemoteAddr)
	if host, _, err := net.SplitHostPort(remoteAddress); err == nil {
		return host
	}
	return remoteAddress
}

func stringPointer(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func credentialProjectScope(r *http.Request) (all bool, ids []int64, err error) {
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		return false, nil, &agentauth.APIError{
			Status: http.StatusUnauthorized,
			Code:   agentauth.ErrorCodeAgentAuthFailed,
			Detail: agentauth.DetailTokenInvalid,
		}
	}
	scope := strings.TrimSpace(credential.ProjectScope)
	if scope == "" || scope == agentauth.ScopeAll {
		return true, nil, nil
	}
	for _, part := range strings.Split(scope, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, parseErr := strconv.ParseInt(part, 10, 64)
		if parseErr != nil || id < 1 {
			return false, nil, validationFailure("credential project_scope is invalid")
		}
		ids = append(ids, id)
	}
	return false, ids, nil
}

func projectInCredentialScope(r *http.Request, projectID int64) (bool, error) {
	all, ids, err := credentialProjectScope(r)
	if err != nil {
		return false, err
	}
	if all {
		return true, nil
	}
	for _, id := range ids {
		if id == projectID {
			return true, nil
		}
	}
	return false, nil
}

func requireProjectInCredentialScope(w http.ResponseWriter, r *http.Request, projectID int64) bool {
	allowed, err := projectInCredentialScope(r, projectID)
	if err != nil {
		writeAPIError(w, err)
		return false
	}
	if !allowed {
		agentauth.WriteError(
			w,
			http.StatusForbidden,
			agentauth.ErrorCodeAgentProjectOutOfScope,
			agentauth.DetailProjectNotInScope,
		)
		return false
	}
	return true
}

func parsePathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	id, err := parsePositiveID(chi.URLParam(r, name), name)
	if err != nil {
		writeAPIError(w, err)
		return 0, false
	}
	return id, true
}

func reportResponse(report *Report) map[string]any {
	if report == nil {
		return nil
	}
	health := report.HealthData
	compliance := report.ComplianceData
	return map[string]any{
		"report_id":        report.ID,
		"period_id":        report.PeriodID,
		"project_id":       report.ProjectID,
		"country":          report.Country,
		"status":           report.Status,
		"health_data":      exposeHealthData(health),
		"compliance_data":  exposeComplianceData(compliance),
		"compliance_total": complianceTotal(compliance),
		"status_summary":   report.StatusSummary,
		"submitted_by":     report.SubmittedBy,
		"submitted_at":     optionalTimestamp(report.SubmittedAt),
		"screenshot_count": report.ScreenshotCount,
		"created_at":       timestamp(report.CreatedAt),
		"updated_at":       timestamp(report.UpdatedAt),
	}
}

func screenshotResponse(screenshot *Screenshot) map[string]any {
	if screenshot == nil {
		return nil
	}
	return map[string]any{
		"screenshot_id": screenshot.ID,
		"filename":      screenshot.Filename,
		"content_type":  screenshot.ContentType,
		"file_size":     screenshot.FileSize,
		"caption":       screenshot.Caption,
		"sort_order":    screenshot.SortOrder,
		"created_at":    timestamp(screenshot.CreatedAt),
	}
}

func exposeHealthData(data map[string]any) map[string]any {
	result := make(map[string]any, len(healthFieldKeys))
	for _, key := range healthFieldKeys {
		result[key] = nil
		if data != nil {
			result[key] = data[key]
		}
	}
	return result
}

func exposeComplianceData(data map[string]any) map[string]any {
	result := make(map[string]any, len(complianceFieldKeys))
	for _, key := range complianceFieldKeys {
		result[key] = nil
		if data != nil {
			result[key] = data[key]
		}
	}
	return result
}

func accountHealthRow(
	period Period,
	project Project,
	report *Report,
) AccountHealthRow {
	row := AccountHealthRow{
		PeriodID:    period.ID,
		WeekStart:   period.WeekStart,
		WeekEnd:     period.WeekEnd,
		ProjectID:   project.ID,
		ProjectName: project.Name,
		Country:     project.Country,
	}
	if report == nil {
		return row
	}
	row.Status = report.Status
	row.SubmittedAt = optionalTimestamp(report.SubmittedAt)
	row.ScreenshotCount = report.ScreenshotCount
	row.ComplianceTotal = complianceTotal(report.ComplianceData)
	health := report.HealthData
	if health != nil {
		row.AccountHealthRating = stringValue(health["account_health_rating"])
		row.NegativeFeedback = intPointerValue(health["negative_feedback"])
		row.A2ZClaims = intPointerValue(health["a2z_claims"])
		row.ChargebackClaims = intPointerValue(health["chargeback_claims"])
		row.LateShipmentRate = floatPointerValue(health["late_shipment_rate"])
		row.PreFulfillmentCancelRate = floatPointerValue(health["pre_fulfillment_cancel_rate"])
		row.ValidTrackingRate = floatPointerValue(health["valid_tracking_rate"])
		row.OnTimeDeliveryRate = floatPointerValue(health["on_time_delivery_rate"])
	}
	compliance := report.ComplianceData
	if compliance != nil {
		row.IPInfringement = intPointerValue(compliance["ip_infringement"])
		row.IPComplaints = intPointerValue(compliance["ip_complaints"])
		row.ProductAuthenticityComplaints = intPointerValue(compliance["product_authenticity_complaints"])
		row.ProductConditionComplaints = intPointerValue(compliance["product_condition_complaints"])
		row.FoodProductSafety = intPointerValue(compliance["food_product_safety"])
		row.ListingPolicyViolations = intPointerValue(compliance["listing_policy_violations"])
		row.RestrictedProductViolations = intPointerValue(compliance["restricted_product_violations"])
		row.ReviewPolicyViolations = intPointerValue(compliance["review_policy_violations"])
		row.OtherPolicyViolations = intPointerValue(compliance["other_policy_violations"])
		row.RegulatoryCompliance = intPointerValue(compliance["regulatory_compliance"])
	}
	return row
}

func accountHealthMap(row AccountHealthRow) map[string]any {
	payload := map[string]any{
		"period_id":                       row.PeriodID,
		"week_start":                      row.WeekStart,
		"week_end":                        row.WeekEnd,
		"project_id":                      row.ProjectID,
		"project_name":                    row.ProjectName,
		"country":                         row.Country,
		"status":                          row.Status,
		"submitted_at":                    row.SubmittedAt,
		"account_health_rating":           row.AccountHealthRating,
		"negative_feedback":               row.NegativeFeedback,
		"a2z_claims":                      row.A2ZClaims,
		"chargeback_claims":               row.ChargebackClaims,
		"late_shipment_rate":              row.LateShipmentRate,
		"pre_fulfillment_cancel_rate":     row.PreFulfillmentCancelRate,
		"valid_tracking_rate":             row.ValidTrackingRate,
		"on_time_delivery_rate":           row.OnTimeDeliveryRate,
		"ip_infringement":                 row.IPInfringement,
		"ip_complaints":                   row.IPComplaints,
		"product_authenticity_complaints": row.ProductAuthenticityComplaints,
		"product_condition_complaints":    row.ProductConditionComplaints,
		"food_product_safety":             row.FoodProductSafety,
		"listing_policy_violations":       row.ListingPolicyViolations,
		"restricted_product_violations":   row.RestrictedProductViolations,
		"review_policy_violations":        row.ReviewPolicyViolations,
		"other_policy_violations":         row.OtherPolicyViolations,
		"regulatory_compliance":           row.RegulatoryCompliance,
		"compliance_total":                row.ComplianceTotal,
		"screenshot_count":                row.ScreenshotCount,
	}
	return payload
}

func complianceTotal(data map[string]any) *int {
	if len(data) == 0 {
		return nil
	}
	total := 0
	for _, key := range complianceFieldKeys {
		total += intValueAny(data[key])
	}
	return &total
}

func intValueAny(value any) int {
	switch typed := value.(type) {
	case nil:
		return 0
	case int:
		return typed
	case int64:
		return int(typed)
	case json.Number:
		number, _ := typed.Int64()
		return int(number)
	case float64:
		return int(typed)
	case float32:
		return int(typed)
	default:
		return 0
	}
}

func intPointerValue(value any) *int {
	if value == nil {
		return nil
	}
	result := intValueAny(value)
	return &result
}

func floatPointerValue(value any) *float64 {
	if value == nil {
		return nil
	}
	var result float64
	switch typed := value.(type) {
	case json.Number:
		result, _ = typed.Float64()
	case float64:
		result = typed
	case float32:
		result = float64(typed)
	case int:
		result = float64(typed)
	case int64:
		result = float64(typed)
	default:
		return nil
	}
	return &result
}

func stringValue(value any) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	return &text
}

func timestamp(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return httpapi.Timestamp(value)
}

func optionalTimestamp(value *time.Time) *string {
	if value == nil || value.IsZero() {
		return nil
	}
	formatted := timestamp(*value)
	return &formatted
}

func ThresholdWarnings(report *Report) []ThresholdWarning {
	warnings := make([]ThresholdWarning, 0)
	if report == nil {
		return warnings
	}
	appendThreshold := func(metric, key, direction string, warning, critical float64) {
		var source map[string]any
		for _, healthKey := range healthFieldKeys {
			if healthKey == key {
				source = report.HealthData
				break
			}
		}
		if source == nil {
			source = report.ComplianceData
		}
		value := source[key]
		number, ok := numericValue(value)
		if !ok {
			return
		}
		severity := ""
		threshold := 0.0
		if direction == "above" {
			if number >= critical {
				severity, threshold = "critical", critical
			} else if number >= warning {
				severity, threshold = "warning", warning
			}
		} else if number <= critical {
			severity, threshold = "critical", critical
		} else if number <= warning {
			severity, threshold = "warning", warning
		}
		if severity == "" {
			return
		}
		warnings = append(warnings, ThresholdWarning{
			Metric:    metric,
			Value:     value,
			Threshold: threshold,
			Severity:  severity,
			Message: fmt.Sprintf(
				"%s is %v (%s: threshold %v)",
				key, value, severity, threshold,
			),
		})
	}
	appendThreshold("inspection_negative_feedback", "negative_feedback", "above", 1, 3)
	appendThreshold("inspection_a2z_claims", "a2z_claims", "above", 1, 3)
	appendThreshold("inspection_chargeback_claims", "chargeback_claims", "above", 1, 3)
	appendThreshold("inspection_late_shipment", "late_shipment_rate", "above", 2, 4)
	appendThreshold("inspection_vtr", "valid_tracking_rate", "below", 97, 95)
	appendThreshold("inspection_on_time_delivery", "on_time_delivery_rate", "below", 97, 95)
	complianceMetrics := []struct {
		key    string
		metric string
	}{
		{"ip_infringement", "inspection_ip_infringement"},
		{"ip_complaints", "inspection_ip_complaints"},
		{"product_authenticity_complaints", "inspection_product_authenticity"},
		{"product_condition_complaints", "inspection_product_condition"},
		{"food_product_safety", "inspection_food_safety"},
		{"listing_policy_violations", "inspection_listing_violations"},
		{"restricted_product_violations", "inspection_restricted_product"},
		{"review_policy_violations", "inspection_review_violations"},
		{"other_policy_violations", "inspection_other_violations"},
		{"regulatory_compliance", "inspection_regulatory"},
	}
	for _, item := range complianceMetrics {
		appendThreshold(item.metric, item.key, "above", 1, 3)
	}
	return warnings
}

func numericValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	default:
		return 0, false
	}
}
