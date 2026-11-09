package agent_monthly_reports

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const (
	ErrorCodeAgentAuthFailed         = "AGENT_AUTH_FAILED"
	ErrorCodeAgentProjectOutOfScope  = "AGENT_PROJECT_OUT_OF_SCOPE"
	ErrorCodeAgentBusinessOutOfScope = "AGENT_BUSINESS_OUT_OF_SCOPE"
	ErrorCodeAgentRateLimitExceeded  = "AGENT_RATE_LIMIT_EXCEEDED"
	ErrorCodeIdempotencyConflict     = "IDEMPOTENCY_KEY_CONFLICT"
	ErrorCodeConfirmTokenInvalid     = "CONFIRM_TOKEN_INVALID"
	ErrorCodeConfirmTokenExpired     = "CONFIRM_TOKEN_EXPIRED"
	ErrorCodeInvalidInput            = "MONTHLY_REPORT_INVALID_INPUT"
	ErrorCodeTooLarge                = "MONTHLY_REPORT_TOO_LARGE"
	ErrorCodeUploadConflict          = "MONTHLY_REPORT_UPLOAD_CONFLICT"
	ErrorCodeNotReady                = "MONTHLY_REPORT_NOT_READY"
	ErrorCodeExpired                 = "MONTHLY_REPORT_EXPIRED"
	ErrorCodeConflict                = "MONTHLY_REPORT_CONFLICT"
	ErrorCodeDispatchFailed          = "MONTHLY_REPORT_DISPATCH_FAILED"
	ErrorCodeValidationFailed        = "VALIDATION_FAILED"
	ErrorCodeNotFound                = "RESOURCE_NOT_FOUND"
	ErrorCodeInternal                = "INTERNAL_ERROR"
)

type apiError struct {
	Status       int
	Code         string
	HumanMessage string
	AgentHint    string
	Reason       string
	Details      any
}

func (e *apiError) Error() string {
	if e == nil {
		return "agent monthly reports: nil error"
	}
	return e.Code + ": " + e.HumanMessage
}

func writeSuccess(
	w http.ResponseWriter,
	status int,
	data any,
	idempotencyKey *string,
	extra map[string]any,
) {
	payload := map[string]any{
		"ok":   true,
		"data": data,
	}
	if idempotencyKey != nil && *idempotencyKey != "" {
		payload["idempotency_key"] = *idempotencyKey
	}
	for key, value := range extra {
		payload[key] = value
	}
	writeJSON(w, status, payload)
}

func writeError(w http.ResponseWriter, err error) {
	var apiErr *apiError
	if !errors.As(err, &apiErr) {
		apiErr = mapStoreError(err)
	}
	if apiErr == nil {
		apiErr = &apiError{
			Status:       http.StatusInternalServerError,
			Code:         ErrorCodeInternal,
			HumanMessage: "服务器内部错误",
			AgentHint:    "请稍后重试",
		}
	}
	errorPayload := map[string]any{
		"code":          apiErr.Code,
		"human_message": apiErr.HumanMessage,
		"agent_hint":    apiErr.AgentHint,
	}
	if apiErr.Reason != "" {
		errorPayload["reason"] = apiErr.Reason
	}
	if apiErr.Details != nil {
		errorPayload["details"] = apiErr.Details
	}
	writeJSON(w, apiErr.Status, map[string]any{
		"ok":    false,
		"error": errorPayload,
	})
}

func writeValidationError(w http.ResponseWriter, details any) {
	writeError(w, &apiError{
		Status:       http.StatusUnprocessableEntity,
		Code:         ErrorCodeValidationFailed,
		HumanMessage: "请求参数校验失败",
		AgentHint:    "请根据 details 修正参数后重试",
		Details:      details,
	})
}

func mapStoreError(err error) *apiError {
	switch {
	case errors.Is(err, store.ErrAgentMonthlyIdempotencyConflict):
		return &apiError{
			Status:       http.StatusConflict,
			Code:         ErrorCodeIdempotencyConflict,
			HumanMessage: "Idempotency-Key 已被用于不同的请求体",
			AgentHint:    "新请求请生成新的 Idempotency-Key；重放请保持请求体完全一致",
		}
	case errors.Is(err, store.ErrAgentMonthlyExpired):
		return &apiError{
			Status:       http.StatusConflict,
			Code:         ErrorCodeExpired,
			HumanMessage: "月报草稿或输入已过期",
			AgentHint:    "临时输入与结果保留 24 小时；请新建上传会话与 build 后重试",
		}
	case errors.Is(err, store.ErrAgentMonthlyNotReady):
		return &apiError{
			Status:       http.StatusConflict,
			Code:         ErrorCodeNotReady,
			HumanMessage: "月报草稿尚不可用",
			AgentHint:    "请轮询 GET /builds/{build_id} 直到 status=success 再预览/下载/确认",
		}
	case errors.Is(err, store.ErrAgentMonthlyConflict):
		return &apiError{
			Status:       http.StatusConflict,
			Code:         ErrorCodeConflict,
			HumanMessage: "该 项目+国家+月份 已有月报",
			AgentHint:    "阶段一不自动替换当前版本；请在 dashboard 侧处理",
		}
	case errors.Is(err, store.ErrAgentMonthlyNotFound):
		return &apiError{
			Status:       http.StatusNotFound,
			Code:         ErrorCodeNotFound,
			HumanMessage: "请求的资源不存在",
			AgentHint:    "请检查资源 id；跨凭据资源不可见",
		}
	case errors.Is(err, store.ErrAgentMonthlyInvalidInput):
		return &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeValidationFailed,
			HumanMessage: "请求参数校验失败",
			AgentHint:    "请检查 country、report_month、文件类型和大小",
		}
	case errors.Is(err, store.ErrAgentMonthlyDependency):
		return &apiError{
			Status:       http.StatusServiceUnavailable,
			Code:         ErrorCodeDispatchFailed,
			HumanMessage: "月报依赖暂不可用",
			AgentHint:    "请稍后重试；依赖恢复前不会假成功",
		}
	default:
		return &apiError{
			Status:       http.StatusInternalServerError,
			Code:         ErrorCodeInternal,
			HumanMessage: "服务器内部错误",
			AgentHint:    "请稍后重试；若持续出现请联系管理员",
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
