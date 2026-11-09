package alerts

import (
	"errors"
	"net/http"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (h *Handler) Detect(w http.ResponseWriter, r *http.Request) {
	isAdmin, adminErr := adminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	if !isAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "Admin only")
		return
	}

	store, ok := h.store.(DetectionStore)
	if !ok {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Alert detection dependency unavailable")
		return
	}

	entry := newAuditContext(r, "alerts.detect", "alert_detection", nil)
	result, err := store.Detect(r.Context(), DetectionInput{
		Today: time.Now().Format("2006-01-02"),
		Audit: entry,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrDetectionConflict):
			httpapi.WriteDetail(w, http.StatusConflict, "Alert detection already in progress")
		case errors.Is(err, ErrDetectionUnavailable):
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Alert detection dependency unavailable")
		default:
			httpapi.WriteInternalServerError(w)
		}
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func newAuditContext(r *http.Request, action, targetType string, targetID *string) AuditContext {
	method := r.Method
	path := r.URL.Path
	userAgent := r.UserAgent()
	idempotencyKey := r.Header.Get("Idempotency-Key")
	if idempotencyKey == "" {
		idempotencyKey = r.Header.Get("X-Idempotency-Key")
	}
	traceID := r.Header.Get("X-Request-ID")
	ipAddress := r.RemoteAddr

	entry := AuditContext{
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		Operator:   optionalRequestOperator(r),
	}
	if method != "" {
		entry.RequestMethod = &method
	}
	if path != "" {
		entry.RequestPath = &path
	}
	if userAgent != "" {
		entry.UserAgent = &userAgent
	}
	if idempotencyKey != "" {
		entry.IdempotencyKey = &idempotencyKey
	}
	if traceID != "" {
		entry.TraceID = &traceID
	}
	if ipAddress != "" {
		entry.IPAddress = &ipAddress
	}
	return entry
}

func optionalRequestOperator(r *http.Request) *string {
	operator := requestOperator(r)
	if operator == "" {
		return nil
	}
	return &operator
}
