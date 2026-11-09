package agent

import (
	"net/http"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func writeOK(w http.ResponseWriter, data any, idempotencyKey string) {
	_ = httpapi.WriteJSON(w, http.StatusOK, okResponse{
		OK:             true,
		Data:           data,
		IdempotencyKey: idempotencyKey,
	})
}

func writeOKStatus(w http.ResponseWriter, status int, data any, idempotencyKey string) {
	_ = httpapi.WriteJSON(w, status, okResponse{
		OK:             true,
		Data:           data,
		IdempotencyKey: idempotencyKey,
	})
}

func writeAPIError(w http.ResponseWriter, err *APIError) {
	if err == nil {
		err = NewAPIError(ErrInternal)
	}
	status := errorStatus[err.Code]
	if status == 0 {
		status = http.StatusInternalServerError
	}
	payload := errorResponse{OK: false}
	payload.Error.Code = err.Code
	payload.Error.Reason = err.Reason
	payload.Error.Human = err.Human
	payload.Error.Hint = err.Hint
	payload.Error.Detail = err.Details
	_ = httpapi.WriteJSON(w, status, payload)
}

func writeValidationError(w http.ResponseWriter, message string, details any) {
	err := NewAPIError(ErrValidationFailed)
	if message != "" {
		err.Human = message
	}
	err.Details = details
	writeAPIError(w, err)
}
