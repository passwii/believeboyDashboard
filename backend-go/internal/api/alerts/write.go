package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type RuleUpdate struct {
	Name                 *string  `json:"name"`
	Metric               *string  `json:"metric"`
	TriggerType          *string  `json:"trigger_type"`
	Condition            *string  `json:"condition"`
	Threshold            *float64 `json:"threshold"`
	WindowDays           *int     `json:"window_days"`
	Severity             *string  `json:"severity"`
	NotificationChannels *string  `json:"notification_channels"`
	IsActive             *bool    `json:"is_active"`
}

type CreateRuleRequest struct {
	Name                 *string  `json:"name"`
	ProjectID            *int64   `json:"project_id"`
	Country              *string  `json:"country"`
	Metric               *string  `json:"metric"`
	TriggerType          *string  `json:"trigger_type"`
	Condition            *string  `json:"condition"`
	Threshold            *float64 `json:"threshold"`
	WindowDays           *int     `json:"window_days"`
	Severity             *string  `json:"severity"`
	NotificationChannels *string  `json:"notification_channels"`
}

type WriteStore interface {
	GetRule(context.Context, int64) (*Rule, error)
	CreateRule(context.Context, Rule) (*Rule, error)
	UpdateRule(context.Context, int64, RuleUpdate) (*Rule, error)
	DeleteRule(context.Context, int64) (bool, error)
	GetEvent(context.Context, int64) (*Event, error)
	AcknowledgeEvent(context.Context, int64, *string) (*Event, error)
	ResolveEvent(context.Context, int64) (*Event, error)
}

func (h *Handler) CreateRule(w http.ResponseWriter, r *http.Request) {
	var request CreateRuleRequest
	if err := decodeAlertBody(r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if request.Name == nil || request.ProjectID == nil || request.Metric == nil ||
		request.Condition == nil || request.Threshold == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "name, project_id, metric, condition and threshold are required")
		return
	}
	if !validRuleString(request.Name, 64) ||
		!validRuleString(request.Metric, 32) ||
		!validRuleString(request.Condition, 16) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "rule field exceeds its maximum length")
		return
	}
	isAdmin, adminErr := adminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	projectID := strconv.FormatInt(*request.ProjectID, 10)
	if !h.requireProjectAccess(w, r, projectID, isAdmin) {
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}

	operator := requestOperator(r)
	if operator == "" {
		operator = "system"
	}
	value := Rule{
		Name:                 *request.Name,
		ProjectID:            *request.ProjectID,
		Country:              valueOrDefault(request.Country, "US"),
		Metric:               *request.Metric,
		TriggerType:          valueOrDefault(request.TriggerType, "threshold"),
		Condition:            *request.Condition,
		Threshold:            *request.Threshold,
		WindowDays:           intOrDefault(request.WindowDays, 7),
		Severity:             valueOrDefault(request.Severity, "warning"),
		NotificationChannels: valueOrDefault(request.NotificationChannels, "in_app"),
		IsActive:             true,
		CreatedBy:            operator,
	}
	if len(value.Country) > 2 || len(value.TriggerType) > 16 ||
		len(value.Severity) > 16 || len(value.NotificationChannels) > 16 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "rule field exceeds its maximum length")
		return
	}
	created, err := writer.CreateRule(r.Context(), value)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if created == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, serializeRule(*created))
}

func (h *Handler) UpdateRule(w http.ResponseWriter, r *http.Request) {
	id, ok := alertPathID(w, r, "rule_id")
	if !ok {
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	current, err := writer.GetRule(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if current == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Rule not found")
		return
	}
	var request RuleUpdate
	if err := decodeAlertBody(r, &request); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if !validRuleString(request.Name, 64) ||
		!validRuleString(request.Metric, 32) ||
		!validRuleString(request.TriggerType, 16) ||
		!validRuleString(request.Condition, 16) ||
		!validRuleString(request.Severity, 16) ||
		!validRuleString(request.NotificationChannels, 16) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "rule field exceeds its maximum length")
		return
	}
	isAdmin, adminErr := adminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	if !h.requireProjectAccess(w, r, strconv.FormatInt(current.ProjectID, 10), isAdmin) {
		return
	}
	updated, err := writer.UpdateRule(r.Context(), id, request)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if updated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Rule not found")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, serializeRule(*updated))
}

func (h *Handler) DeleteRule(w http.ResponseWriter, r *http.Request) {
	id, ok := alertPathID(w, r, "rule_id")
	if !ok {
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	current, err := writer.GetRule(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if current == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Rule not found")
		return
	}
	isAdmin, adminErr := adminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	if !h.requireProjectAccess(w, r, strconv.FormatInt(current.ProjectID, 10), isAdmin) {
		return
	}
	deleted, err := writer.DeleteRule(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if !deleted {
		httpapi.WriteDetail(w, http.StatusNotFound, "Rule not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) AcknowledgeEvent(w http.ResponseWriter, r *http.Request) {
	h.updateEventStatus(w, r, true)
}

func (h *Handler) ResolveEvent(w http.ResponseWriter, r *http.Request) {
	h.updateEventStatus(w, r, false)
}

func (h *Handler) updateEventStatus(w http.ResponseWriter, r *http.Request, acknowledge bool) {
	id, ok := alertPathID(w, r, "event_id")
	if !ok {
		return
	}
	writer, ok := h.store.(WriteStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}
	current, err := writer.GetEvent(r.Context(), id)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if current == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Event not found")
		return
	}
	isAdmin, adminErr := adminHeader(r)
	if adminErr != nil {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{*adminErr})
		return
	}
	if !h.requireProjectAccess(w, r, strconv.FormatInt(current.ProjectID, 10), isAdmin) {
		return
	}
	var updated *Event
	if acknowledge {
		var operator *string
		if value := requestOperator(r); value != "" {
			operator = &value
		}
		updated, err = writer.AcknowledgeEvent(r.Context(), id, operator)
	} else {
		updated, err = writer.ResolveEvent(r.Context(), id)
	}
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if updated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Event not found")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, serializeEvent(*updated))
}

func (h *Handler) RegisterWriteRoutes(
	router chi.Router,
	authMiddleware func(http.Handler) http.Handler,
) {
	writeRouter := router
	if authMiddleware != nil {
		writeRouter = router.With(authMiddleware)
	}
	writeRouter.Post("/api/v1/alerts/rules", h.CreateRule)
	writeRouter.Patch("/api/v1/alerts/rules/{rule_id}", h.UpdateRule)
	writeRouter.Delete("/api/v1/alerts/rules/{rule_id}", h.DeleteRule)
	writeRouter.Post("/api/v1/alerts/events/{event_id}/acknowledge", h.AcknowledgeEvent)
	writeRouter.Post("/api/v1/alerts/events/{event_id}/resolve", h.ResolveEvent)
	writeRouter.Post("/api/v1/alerts/detect", h.Detect)
	writeRouter.Get("/api/v1/alerts/preferences", h.GetPreferences)
	writeRouter.Patch("/api/v1/alerts/preferences", h.UpdatePreferences)
}

func alertPathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	raw := chi.URLParam(r, name)
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid "+name)
		return 0, false
	}
	return id, true
}

func decodeAlertBody(r *http.Request, target any) error {
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

func validRuleString(value *string, maxLength int) bool {
	return value == nil || len(*value) <= maxLength
}

func valueOrDefault(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func intOrDefault(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}

func serializeRule(row Rule) ruleResponse {
	return ruleResponse{
		Name:                 row.Name,
		ProjectID:            row.ProjectID,
		Country:              row.Country,
		Metric:               row.Metric,
		TriggerType:          row.TriggerType,
		Condition:            row.Condition,
		Threshold:            row.Threshold,
		WindowDays:           row.WindowDays,
		Severity:             row.Severity,
		NotificationChannels: row.NotificationChannels,
		ID:                   row.ID,
		IsActive:             row.IsActive,
		CreatedBy:            row.CreatedBy,
		CreatedAt:            httpapi.Timestamp(row.CreatedAt),
		UpdatedAt:            httpapi.Timestamp(row.UpdatedAt),
	}
}

func serializeEvent(row Event) eventResponse {
	return eventResponse{
		ID:              row.ID,
		RuleID:          row.RuleID,
		ProjectID:       row.ProjectID,
		Metric:          row.Metric,
		CurrentValue:    row.CurrentValue,
		BaselineValue:   row.BaselineValue,
		DeviationPct:    row.DeviationPct,
		Severity:        row.Severity,
		Message:         row.Message,
		Status:          row.Status,
		TriggeredAt:     httpapi.Timestamp(row.TriggeredAt),
		AcknowledgedAt:  httpapi.OptionalTimestamp(row.AcknowledgedAt),
		AcknowledgedBy:  row.AcknowledgedBy,
		MatchRate:       row.MatchRate,
		MismatchedItems: row.MismatchedItems,
		TotalDiff:       row.TotalDiff,
		ReportMonth:     row.ReportMonth,
		ReportID:        row.ReportID,
	}
}
