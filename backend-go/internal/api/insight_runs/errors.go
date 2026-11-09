package insight_runs

import (
	"errors"
	"net/http"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
)

func WriteTypedError(w http.ResponseWriter, status int, code, message string) {
	ai_insight.WriteTypedDetail(w, status, code, message)
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrRunNotFound):
		WriteTypedError(w, http.StatusNotFound, "RUN_NOT_FOUND", "Insight run not found")
	case errors.Is(err, ErrIdempotencyConflict):
		WriteTypedError(w, http.StatusConflict, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency key already used with a different payload")
	case errors.Is(err, ErrRunTerminal):
		WriteTypedError(w, http.StatusConflict, "RUN_TERMINAL", "Run is already terminal")
	case errors.Is(err, ErrInvalidTransition):
		WriteTypedError(w, http.StatusConflict, "INVALID_STATE_TRANSITION", "Run state transition is not allowed")
	case errors.Is(err, ErrProjectNotFound):
		WriteTypedError(w, http.StatusNotFound, "PROJECT_NOT_FOUND", "Project not found")
	case errors.Is(err, ErrProjectOutOfScope):
		WriteTypedError(w, http.StatusForbidden, "PROJECT_OUT_OF_SCOPE", "Project out of scope")
	case errors.Is(err, ErrCountryMismatch):
		WriteTypedError(w, http.StatusUnprocessableEntity, "COUNTRY_MISMATCH", "Project country does not match the request")
	default:
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
	}
}
