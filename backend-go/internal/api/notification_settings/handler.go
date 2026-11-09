package notification_settings

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	"github.com/passwii/believeboyDashboard/backend-go/internal/mailer"
)

type Store interface {
	GetProject(context.Context, string) (*Project, error)
	ListSettings(context.Context, string) ([]Setting, error)
	GetSetting(context.Context, int64) (*Setting, error)
	CreateSetting(context.Context, Setting) (*Setting, error)
	UpdateSetting(context.Context, int64, Setting) (*Setting, error)
	DeleteSetting(context.Context, int64) (bool, error)
}

type TestEmailStore interface {
	FindTestEmailAttempt(context.Context, string) (*TestEmailAttempt, error)
	RecordTestEmailAudit(context.Context, TestEmailAudit) error
}

type Mailer interface {
	Configured() bool
	Send(context.Context, mailer.Message) (mailer.Result, error)
}

type Handler struct {
	store     Store
	testStore TestEmailStore
	mailer    Mailer
	mailerSet bool
}

type Option func(*Handler)

func WithMailer(sender Mailer) Option {
	return func(handler *Handler) {
		handler.mailer = sender
		handler.mailerSet = true
	}
}

func WithTestEmailStore(store TestEmailStore) Option {
	return func(handler *Handler) {
		handler.testStore = store
	}
}

func NewHandler(store Store, options ...Option) *Handler {
	handler := &Handler{store: store}
	if testStore, ok := store.(TestEmailStore); ok {
		handler.testStore = testStore
	}
	for _, option := range options {
		if option != nil {
			option(handler)
		}
	}
	return handler
}

func (h *Handler) ListSettings(w http.ResponseWriter, r *http.Request) {
	projectParam, validationErr := httpapi.ParseIntegerQuery(r, "project_id")
	if validationErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validationErr})
		return
	}
	if !projectParam.Present {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id is required")
		return
	}
	isAdmin, adminErr := settingsAdminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	projectID := projectParam.Canonical
	if !h.requireProjectAccess(w, r, projectID, isAdmin) {
		return
	}
	rows, err := h.store.ListSettings(r.Context(), projectID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	items := make([]settingResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, serializeSetting(row))
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, listResponse{Items: items, Total: len(items)})
}

func (h *Handler) CreateSetting(w http.ResponseWriter, r *http.Request) {
	var request CreateRequest
	if err := decodeSettingsBody(r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if request.ProjectID == nil || request.RuleName == nil || request.Frequency == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id, rule_name and frequency are required")
		return
	}
	if strings.TrimSpace(*request.RuleName) == "" || len(*request.RuleName) > 128 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "rule_name must be between 1 and 128 characters")
		return
	}
	if !validFrequency(*request.Frequency) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "frequency must be daily, weekly or monthly")
		return
	}
	isAdmin, adminErr := settingsAdminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	projectID := strconv.FormatInt(*request.ProjectID, 10)
	if !h.requireProjectAccess(w, r, projectID, isAdmin) {
		return
	}
	enabled := true
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	value := Setting{
		ProjectID:   *request.ProjectID,
		RuleName:    strings.TrimSpace(*request.RuleName),
		Frequency:   *request.Frequency,
		ReportTypes: nonNilStrings(request.ReportTypes),
		Recipients:  nonNilStrings(request.Recipients),
		Enabled:     enabled,
		CreatedBy:   requestUserID(r),
	}
	created, err := h.store.CreateSetting(r.Context(), value)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if created == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, serializeSetting(*created))
}

func (h *Handler) UpdateSetting(w http.ResponseWriter, r *http.Request) {
	var request UpdateRequest
	if err := decodeSettingsBody(r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	id, present, ok := settingRequestID(w, r, request.ID)
	if !ok {
		return
	}
	if !present {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "id is required")
		return
	}
	current, err := h.store.GetSetting(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if current == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Subscription not found")
		return
	}
	isAdmin, adminErr := settingsAdminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	if !h.requireProjectAccess(w, r, strconv.FormatInt(current.ProjectID, 10), isAdmin) {
		return
	}
	value := *current
	if request.RuleName != nil {
		if len(*request.RuleName) > 128 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "rule_name must be at most 128 characters")
			return
		}
		value.RuleName = *request.RuleName
	}
	if request.Frequency != nil {
		if !validFrequency(*request.Frequency) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "frequency must be daily, weekly or monthly")
			return
		}
		value.Frequency = *request.Frequency
	}
	if request.ReportTypes != nil {
		value.ReportTypes = nonNilStrings(*request.ReportTypes)
	}
	if request.Recipients != nil {
		value.Recipients = nonNilStrings(*request.Recipients)
	}
	if request.Enabled != nil {
		value.Enabled = *request.Enabled
	}
	updated, err := h.store.UpdateSetting(r.Context(), id, value)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if updated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Subscription not found")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, serializeSetting(*updated))
}

func (h *Handler) DeleteSetting(w http.ResponseWriter, r *http.Request) {
	id, _, ok := settingRequestID(w, r, nil)
	if !ok {
		return
	}
	current, err := h.store.GetSetting(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if current == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Subscription not found")
		return
	}
	isAdmin, adminErr := settingsAdminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	if !h.requireProjectAccess(w, r, strconv.FormatInt(current.ProjectID, 10), isAdmin) {
		return
	}
	deleted, err := h.store.DeleteSetting(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !deleted {
		httpapi.WriteDetail(w, http.StatusNotFound, "Subscription not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) TestSubscriptionEmail(w http.ResponseWriter, r *http.Request) {
	id, present, ok := settingRequestID(w, r, nil)
	if !ok {
		return
	}
	if !present {
		httpapi.WriteDetail(w, http.StatusNotFound, "Subscription not found")
		return
	}
	current, err := h.store.GetSetting(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if current == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Subscription not found")
		return
	}
	isAdmin, adminErr := settingsAdminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	if !h.requireProjectAccess(w, r, strconv.FormatInt(current.ProjectID, 10), isAdmin) {
		return
	}

	var request *TestEmailRequest
	if err := decodeSettingsBody(r, &request); err != nil || request == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	recipients := current.Recipients
	if request.TestRecipients != nil && len(*request.TestRecipients) > 0 {
		recipients = *request.TestRecipients
	}
	if len(recipients) == 0 {
		_ = h.recordTestEmailAudit(r, current, "", "failure", nil, nil, "无收件人配置")
		_ = httpapi.WriteJSON(w, http.StatusOK, TestEmailResponse{
			Success: false,
			Message: "无收件人配置",
		})
		return
	}
	recipient := recipients[0]
	if h.testStore == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "test email audit store is not configured")
		return
	}

	idempotencyKey, explicitKey, validationErr := testEmailIdempotencyKey(r, current, recipient)
	if validationErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*validationErr})
		return
	}
	fingerprint := testEmailFingerprint(current.ID, current.ProjectID, recipient, current.Frequency)
	if explicitKey {
		attempt, err := h.testStore.FindTestEmailAttempt(r.Context(), idempotencyKey)
		if err != nil {
			httpapi.WriteInternalServerError(w)
			return
		}
		if attempt != nil {
			if attempt.Fingerprint != fingerprint {
				httpapi.WriteDetail(w, http.StatusConflict, "Idempotency-Key 已被用于不同的请求")
				return
			}
			if attempt.Result == "success" {
				_ = httpapi.WriteJSON(w, http.StatusOK, TestEmailResponse{
					Success:  true,
					Message:  fmt.Sprintf("测试邮件已发送到 %s", recipient),
					ResendID: attempt.ResendID,
				})
				return
			}
		}
	}

	if h.mailer == nil || !h.mailer.Configured() {
		err := errors.New("test email mailer not configured")
		_ = h.recordTestEmailAudit(r, current, recipient, "failure", nil, &idempotencyKey, err.Error())
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, err.Error())
		return
	}

	result, sendErr := h.mailer.Send(r.Context(), mailer.Message{
		To:             recipient,
		Subject:        testEmailSubject(current.Frequency),
		HTML:           testEmailHTML(current.Frequency),
		IdempotencyKey: idempotencyKey,
	})
	if sendErr != nil {
		_ = h.recordTestEmailAudit(r, current, recipient, "failure", nil, &idempotencyKey, sendErr.Error())
		if errors.Is(sendErr, mailer.ErrNotConfigured) {
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "test email mailer not configured")
			return
		}
		_ = httpapi.WriteJSON(w, http.StatusOK, TestEmailResponse{
			Success: false,
			Message: "发送失败: " + sendErr.Error(),
		})
		return
	}

	resendID := result.ID
	var resendIDPointer *string
	if resendID != "" {
		resendIDPointer = &resendID
	}
	if err := h.recordTestEmailAudit(
		r,
		current,
		recipient,
		"success",
		resendIDPointer,
		&idempotencyKey,
		"",
	); err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, TestEmailResponse{
		Success:  true,
		Message:  fmt.Sprintf("测试邮件已发送到 %s", recipient),
		ResendID: resendIDPointer,
	})
}

func (h *Handler) requireProjectAccess(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	isAdmin bool,
) bool {
	project, err := h.store.GetProject(r.Context(), projectID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return false
	}
	if project == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
		return false
	}
	if isAdmin {
		return true
	}
	user, ok := auth.UserContextFromContext(r.Context())
	if ok && (settingsTextContainsName(project.ProjectOperator, user.Operator) ||
		settingsTextContainsName(project.AssistantOperator, user.Operator)) {
		return true
	}
	httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	return false
}

func (h *Handler) RegisterRoutes(
	router chi.Router,
	authMiddleware func(http.Handler) http.Handler,
) {
	route := router
	if authMiddleware != nil {
		route = router.With(authMiddleware)
	}
	base := "/api/v1/notification-settings"
	route.Get(base, h.ListSettings)
	route.Post(base, h.CreateSetting)
	route.Put(base, h.UpdateSetting)
	route.Delete(base+"/{setting_id}", h.DeleteSetting)

	route.Get(base+"/subscriptions", h.ListSettings)
	route.Post(base+"/subscriptions", h.CreateSetting)
	route.Put(base+"/subscriptions/{subscription_id}", h.UpdateSetting)
	route.Delete(base+"/subscriptions/{subscription_id}", h.DeleteSetting)
	route.Post(base+"/subscriptions/{subscription_id}/test", h.TestSubscriptionEmail)
}

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, options ...Option) *Registrar {
	handler := NewHandler(store, options...)
	if !handler.mailerSet {
		handler.mailer = newEnvironmentMailer()
	}
	return &Registrar{handler: handler}
}

func (r *Registrar) ModuleName() string {
	return "notification_settings"
}

func (r *Registrar) RegisterRoutes(
	router chi.Router,
	authMiddleware func(http.Handler) http.Handler,
) {
	r.handler.RegisterRoutes(router, authMiddleware)
}

func settingRequestID(
	w http.ResponseWriter,
	r *http.Request,
	bodyID *int64,
) (int64, bool, bool) {
	raw := chi.URLParam(r, "setting_id")
	if raw == "" {
		raw = chi.URLParam(r, "subscription_id")
	}
	if raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid subscription_id")
			return 0, false, false
		}
		return id, true, true
	}
	if bodyID != nil {
		return *bodyID, true, true
	}
	return 0, false, true
}

func decodeSettingsBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func settingsAdminHeader(r *http.Request) (bool, *httpapi.ValidationError) {
	user, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		return false, nil
	}
	value, err := httpapi.ParseOptionalBoolHeaderValue(
		"X-Is-Admin",
		user.IsAdminHeader,
		user.IsAdminHeaderPresent,
	)
	if err != nil {
		return false, err
	}
	if value != nil {
		return *value, nil
	}
	return user.IsAdmin, nil
}

func requestUserID(r *http.Request) *int64 {
	user, ok := auth.UserContextFromContext(r.Context())
	if !ok || user.UserID == "" {
		return nil
	}
	value := strings.ReplaceAll(strings.TrimSpace(user.UserID), "_", "")
	id, err := strconv.ParseInt(value, 10, 32)
	if err != nil {
		return nil
	}
	result := id
	return &result
}

func (h *Handler) recordTestEmailAudit(
	r *http.Request,
	subscription *Setting,
	recipient string,
	result string,
	resendID *string,
	idempotencyKey *string,
	errorMessage string,
) error {
	if h == nil || h.testStore == nil {
		return errors.New("test email audit store is not configured")
	}
	var operator *string
	if user, ok := auth.UserContextFromContext(r.Context()); ok {
		if value := strings.TrimSpace(user.Operator); value != "" {
			operator = &value
		}
	}
	var traceID *string
	if value := strings.TrimSpace(r.Header.Get("X-Request-ID")); value != "" {
		traceID = &value
	}
	method := r.Method
	path := r.URL.Path
	var ipAddress *string
	if value := strings.TrimSpace(r.RemoteAddr); value != "" {
		ipAddress = &value
	}
	var userAgent *string
	if value := strings.TrimSpace(r.UserAgent()); value != "" {
		userAgent = &value
	}
	var errorMessagePointer *string
	if errorMessage != "" {
		errorMessagePointer = &errorMessage
	}
	return h.testStore.RecordTestEmailAudit(r.Context(), TestEmailAudit{
		SubscriptionID: subscription.ID,
		ProjectID:      subscription.ProjectID,
		Recipient:      recipient,
		Frequency:      subscription.Frequency,
		Fingerprint:    testEmailFingerprint(subscription.ID, subscription.ProjectID, recipient, subscription.Frequency),
		Result:         result,
		ResendID:       resendID,
		Operator:       operator,
		TraceID:        traceID,
		RequestMethod:  &method,
		RequestPath:    &path,
		IPAddress:      ipAddress,
		UserAgent:      userAgent,
		IdempotencyKey: idempotencyKey,
		ErrorMessage:   errorMessagePointer,
	})
}

func testEmailIdempotencyKey(
	r *http.Request,
	subscription *Setting,
	recipient string,
) (string, bool, *httpapi.ValidationError) {
	for _, header := range []string{"Idempotency-Key", "X-Idempotency-Key"} {
		values, present := r.Header[http.CanonicalHeaderKey(header)]
		if !present {
			continue
		}
		raw := ""
		if len(values) == 1 {
			raw = values[0]
		}
		key := strings.TrimSpace(raw)
		if len(values) != 1 || key == "" || len(key) > 64 || testEmailContainsControl(key) {
			return "", true, &httpapi.ValidationError{
				Type:  "value_error",
				Loc:   []string{"header", header},
				Msg:   "Idempotency-Key 必须为非空字符串且不超过 64 字符",
				Input: raw,
			}
		}
		return key, true, nil
	}

	fingerprint := testEmailFingerprint(subscription.ID, subscription.ProjectID, recipient, subscription.Frequency)
	return "notification-test:" + fingerprint[:16], false, nil
}

func testEmailFingerprint(
	subscriptionID int64,
	projectID int64,
	recipient string,
	frequency string,
) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf(
		"%d|%d|%s|%s",
		subscriptionID,
		projectID,
		strings.TrimSpace(recipient),
		frequency,
	)))
	return fmt.Sprintf("%x", sum[:])
}

func testEmailContainsControl(value string) bool {
	for _, char := range value {
		if char < 0x20 || char == 0x7f {
			return true
		}
	}
	return false
}

func testEmailFrequencyLabel(frequency string) string {
	switch frequency {
	case "daily":
		return "每日"
	case "weekly":
		return "每周"
	case "monthly":
		return "每月"
	default:
		return frequency
	}
}

func testEmailSubject(frequency string) string {
	return fmt.Sprintf(
		"BelieveBoy Dashboard · %s运营报告配置测试",
		html.EscapeString(testEmailFrequencyLabel(frequency)),
	)
}

func testEmailHTML(frequency string) string {
	label := html.EscapeString(testEmailFrequencyLabel(frequency))
	return fmt.Sprintf(`
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, sans-serif; padding: 40px; text-align: center; background: #F3F4F6;">
  <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
    <div style="font-size: 48px; margin-bottom: 16px;">📧</div>
    <h2 style="color: #111827; margin: 0 0 8px;">测试邮件</h2>
    <p style="color: #6B7280; font-size: 14px;">这是一封来自 <strong>BelieveBoy Dashboard</strong> 的测试邮件。</p>
    <p style="color: #374151; font-size: 14px;">报告频率：%s</p>
    <div style="margin-top: 32px; padding: 16px; background: #F0FDF4; border-radius: 8px; border: 1px solid #BBF7D0;">
      <span style="color: #16A34A; font-size: 12px; font-weight: 600;">✅ 邮件发送功能正常</span>
    </div>
  </div>
</body>
</html>`, label)
}

func validFrequency(value string) bool {
	switch value {
	case "daily", "weekly", "monthly":
		return true
	default:
		return false
	}
}

func nonNilStrings(value []string) []string {
	if value == nil {
		return []string{}
	}
	return value
}

func serializeSetting(value Setting) settingResponse {
	return settingResponse{
		ID:          value.ID,
		ProjectID:   value.ProjectID,
		RuleName:    value.RuleName,
		Frequency:   value.Frequency,
		ReportTypes: nonNilStrings(value.ReportTypes),
		Recipients:  nonNilStrings(value.Recipients),
		Enabled:     value.Enabled,
		CreatedBy:   value.CreatedBy,
		CreatedAt:   httpapi.Timestamp(value.CreatedAt),
		UpdatedAt:   httpapi.Timestamp(value.UpdatedAt),
	}
}

func settingsTextContainsName(value *string, target string) bool {
	target = strings.TrimSpace(target)
	if target == "" || value == nil {
		return false
	}
	names := strings.FieldsFunc(*value, func(char rune) bool {
		switch char {
		case '、', ',', '，', ';', '\n':
			return true
		default:
			return false
		}
	})
	for _, name := range names {
		if strings.TrimSpace(name) == target {
			return true
		}
	}
	return false
}
