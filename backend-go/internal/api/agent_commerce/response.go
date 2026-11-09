package agent_commerce

import (
	"errors"
	"net/http"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type okResponse struct {
	OK             bool   `json:"ok"`
	Data           any    `json:"data,omitempty"`
	Action         string `json:"action,omitempty"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

type errorBody struct {
	Code         ErrorCode `json:"code"`
	Reason       string    `json:"reason,omitempty"`
	HumanMessage string    `json:"human_message"`
	AgentHint    string    `json:"agent_hint"`
	Details      any       `json:"details,omitempty"`
}

type errorResponse struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

func writeOK(w http.ResponseWriter, data any, action, idempotencyKey string) {
	_ = httpapi.WriteJSON(w, http.StatusOK, okResponse{
		OK:             true,
		Data:           data,
		Action:         action,
		IdempotencyKey: idempotencyKey,
	})
}

func writeAPIError(w http.ResponseWriter, apiErr *APIError) {
	if apiErr == nil {
		apiErr = newAPIError(CodeInternalError)
	}
	status := errorStatuses[apiErr.Code]
	if status == 0 {
		status = http.StatusInternalServerError
	}
	_ = httpapi.WriteJSON(w, status, errorResponse{
		OK: false,
		Error: errorBody{
			Code:         apiErr.Code,
			Reason:       apiErr.Reason,
			HumanMessage: apiErr.Human,
			AgentHint:    apiErr.Hint,
			Details:      apiErr.Details,
		},
	})
}

func writeValidationError(w http.ResponseWriter, message string, details any) {
	apiErr := newAPIError(CodeValidationFailed)
	if message != "" {
		apiErr.Human = message
	}
	apiErr.Details = details
	writeAPIError(w, apiErr)
}

func mapStoreError(err error) *APIError {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrProjectNotFound):
		return APIErrorWithMessage(CodeResourceNotFound, "项目不存在")
	case errors.Is(err, ErrSKUNotFound):
		return APIErrorWithMessage(CodeResourceNotFound, "SKU 记录不存在或不属于该项目")
	case errors.Is(err, ErrShipmentNotFound):
		return APIErrorWithMessage(CodeResourceNotFound, "排期不存在")
	case errors.Is(err, ErrDuplicate):
		return newAPIError(CodeSKUInfoDuplicate)
	case errors.Is(err, ErrConflict):
		apiErr := APIErrorWithMessage(CodeSKUInfoDuplicate, "资源状态冲突")
		return apiErr
	case errors.Is(err, ErrValidation):
		return APIErrorWithMessage(CodeValidationFailed, err.Error())
	case errors.Is(err, ErrExportTooLarge):
		return APIErrorWithMessage(CodeValidationFailed, "导出数据超过 50000 行上限，请缩小筛选范围")
	case errors.Is(err, ErrServiceUnavailable):
		return newAPIError(CodeServiceUnavailable)
	default:
		// Store/database failures are retryable gateway dependencies for Agent clients.
		return newAPIError(CodeServiceUnavailable)
	}
}
