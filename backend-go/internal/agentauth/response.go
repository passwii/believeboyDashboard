package agentauth

import (
	"encoding/json"
	"net/http"
)

const (
	ErrorCodeAgentAuthFailed         = "AGENT_AUTH_FAILED"
	ErrorCodeAgentBusinessOutOfScope = "AGENT_BUSINESS_OUT_OF_SCOPE"
	ErrorCodeAgentProjectOutOfScope  = "AGENT_PROJECT_OUT_OF_SCOPE"
	ErrorCodeAgentRateLimitExceeded  = "AGENT_RATE_LIMIT_EXCEEDED"
	ErrorCodeConfirmTokenInvalid     = "CONFIRM_TOKEN_INVALID"
	ErrorCodeConfirmTokenExpired     = "CONFIRM_TOKEN_EXPIRED"
	ErrorCodeValidationFailed        = "VALIDATION_FAILED"
	ErrorCodeInternalError           = "INTERNAL_ERROR"

	DetailTokenInvalid       = "token_invalid"
	DetailTokenExpired       = "token_expired"
	DetailTokenRevoked       = "token_revoked"
	DetailAgentIDMismatch    = "agent_id_mismatch"
	DetailBusinessNotInScope = "business_not_in_scope"
	DetailProjectNotInScope  = "project_not_in_scope"
	DetailInvalidProjectID   = "invalid_project_id"
	DetailRateLimitExceeded  = "rate_limit_exceeded"
	DetailConfirmInvalid     = "invalid"
	DetailConfirmExpired     = "expired"
	DetailValidationFailed   = "validation_failed"
	DetailConfirmStoreError  = "confirm_store_error"
	DetailInternalError      = "internal_error"
)

// APIError carries the stable agent error code and HTTP status for middleware failures.
type APIError struct {
	Status int
	Code   string
	Detail string
}

func (e *APIError) Error() string {
	if e == nil {
		return "agentauth: nil APIError"
	}
	if e.Detail == "" {
		return e.Code
	}
	return e.Code + ": " + e.Detail
}

// WriteSuccess writes the standard agent success envelope.
func WriteSuccess(w http.ResponseWriter, status int, data any) error {
	return writeJSON(w, status, struct {
		OK   bool `json:"ok"`
		Data any  `json:"data"`
	}{
		OK:   true,
		Data: data,
	})
}

// WriteError writes the standard agent error envelope.
func WriteError(w http.ResponseWriter, status int, code, detail string) {
	_ = writeJSON(w, status, struct {
		OK        bool   `json:"ok"`
		ErrorCode string `json:"error_code"`
		Detail    string `json:"detail"`
	}{
		OK:        false,
		ErrorCode: code,
		Detail:    detail,
	})
}

// WriteAPIError writes a typed middleware error, defaulting to a non-leaking 500 response.
func WriteAPIError(w http.ResponseWriter, err *APIError) {
	if err == nil {
		WriteError(w, http.StatusInternalServerError, ErrorCodeInternalError, DetailInternalError)
		return
	}
	status := err.Status
	if status == 0 {
		status = http.StatusInternalServerError
	}
	code := err.Code
	if code == "" {
		code = ErrorCodeInternalError
	}
	detail := err.Detail
	if detail == "" {
		detail = DetailInternalError
	}
	WriteError(w, status, code, detail)
}

func writeJSON(w http.ResponseWriter, status int, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, err = w.Write(payload)
	return err
}
