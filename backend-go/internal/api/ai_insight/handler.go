package ai_insight

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxLegacyBodyBytes = 1 << 20

type Handler struct {
	store    Store
	enqueuer JobEnqueuer
	cfg      Config
}

func NewHandler(store Store, enqueuer JobEnqueuer, cfg Config) *Handler {
	return &Handler{store: store, enqueuer: enqueuer, cfg: cfg.normalized()}
}

func (handler *Handler) Generate(w http.ResponseWriter, r *http.Request) {
	var payload GenerateRequest
	if !decodeJSONBody(w, r, &payload) {
		return
	}
	if payload.ProjectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a positive integer")
		return
	}
	if payload.Country == "" {
		payload.Country = "US"
	}
	payload.Country = strings.ToUpper(strings.TrimSpace(payload.Country))
	if len([]rune(payload.Country)) > 2 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country must contain at most 2 characters")
		return
	}
	start, err := parseDate(payload.DateRangeStart)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "date_range_start must be a valid date")
		return
	}
	end, err := parseDate(payload.DateRangeEnd)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "date_range_end must be a valid date")
		return
	}
	if len(payload.FocusAreas) > 10 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "focus_areas must contain at most 10 items")
		return
	}
	payload.InsightType = NormalizeInsightType(payload.InsightType)
	identity := requestIdentity(r)
	if _, err := handler.store.VerifyProjectAccess(r.Context(), payload.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		WriteAccessError(w, err)
		return
	}
	if payload.InsightType == "ad_analysis" && IsDomainCanonical(handler.cfg.CanonicalDomains, "ad_analysis") {
		writeDomainSwitchError(w, "ad_analysis", true)
		return
	}
	if handler.enqueuer == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Insight job enqueuer is not configured")
		return
	}
	insight, err := handler.store.CreateInsight(r.Context(), CreateInsightInput{
		ProjectID:      payload.ProjectID,
		Country:        payload.Country,
		DateRangeStart: start,
		DateRangeEnd:   end,
		InsightType:    payload.InsightType,
		Model:          payload.Model,
		FocusAreas:     payload.FocusAreas,
		Operator:       identity.Operator,
		Audit:          MutationMetaFromRequest(r, identity.Operator),
	})
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	insightID := insight.ID
	if err := handler.enqueuer.EnqueueGenerate(r.Context(), GenerateJob{InsightID: &insightID}); err != nil {
		_ = handler.store.FailGeneration(r.Context(), insight.ID, "insight enqueue failed")
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Insight queue unavailable")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, StatusResponse{Status: "pending", InsightID: &insightID})
}

func (handler *Handler) Stream(w http.ResponseWriter, r *http.Request) {
	insightID, ok := pathID(w, r, "insight_id")
	if !ok {
		return
	}
	snapshot, err := handler.store.GetInsightStatus(r.Context(), insightID)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	identity := requestIdentity(r)
	if _, err := handler.store.VerifyProjectAccess(r.Context(), snapshot.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		WriteAccessError(w, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	if snapshot.Status == "completed" || snapshot.Status == "failed" {
		writeLegacySSE(w, map[string]any{
			"type":          "status",
			"status":        snapshot.Status,
			"sub_status":    nil,
			"insight_id":    snapshot.ID,
			"title":         snapshot.Title,
			"content":       snapshot.Content,
			"error_message": snapshot.ErrorMessage,
		})
		flusher.Flush()
		return
	}

	ticker := time.NewTicker(handler.cfg.SSEPollInterval)
	defer ticker.Stop()
	timeout := time.NewTimer(handler.cfg.SSETimeout)
	defer timeout.Stop()
	lastStatus := snapshot.Status
	for {
		select {
		case <-r.Context().Done():
			return
		case <-timeout.C:
			writeLegacySSE(w, map[string]any{
				"type":       "error",
				"error":      "洞察生成超时，请稍后查看结果",
				"insight_id": snapshot.ID,
			})
			flusher.Flush()
			return
		case <-ticker.C:
			next, err := handler.store.GetInsightStatus(r.Context(), insightID)
			if err != nil {
				return
			}
			if next.Status != lastStatus {
				lastStatus = next.Status
				if next.Status != "completed" && next.Status != "failed" {
					writeLegacySSE(w, map[string]any{
						"type":       "status",
						"status":     next.Status,
						"sub_status": next.SubStatus,
						"insight_id": next.ID,
					})
				}
			}
			switch next.Status {
			case "completed":
				writeLegacySSE(w, map[string]any{
					"type":          "done",
					"status":        "completed",
					"insight_id":    next.ID,
					"title":         next.Title,
					"content":       next.Content,
					"error_message": nil,
				})
				flusher.Flush()
				return
			case "failed":
				message := ""
				if next.ErrorMessage != nil {
					message = *next.ErrorMessage
				}
				if message == "" {
					message = "洞察生成失败"
				}
				writeLegacySSE(w, map[string]any{
					"type":          "error",
					"error":         message,
					"insight_id":    next.ID,
					"status":        "failed",
					"error_message": next.ErrorMessage,
				})
				flusher.Flush()
				return
			default:
				writeLegacySSE(w, map[string]any{"type": "ping"})
				flusher.Flush()
			}
		}
	}
}

func (handler *Handler) List(w http.ResponseWriter, r *http.Request) {
	filter := ListFilter{Operator: requestIdentity(r).Operator, IsAdmin: requestIdentity(r).IsAdmin}
	if raw := r.URL.Query().Get("project_id"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a valid positive integer")
			return
		}
		filter.ProjectID = &value
	}
	if raw := r.URL.Query().Get("country"); raw != "" {
		value := strings.ToUpper(strings.TrimSpace(raw))
		filter.Country = &value
	}
	if raw := r.URL.Query().Get("status_filter"); raw != "" {
		filter.Status = &raw
	}
	if raw := r.URL.Query().Get("insight_type"); raw != "" {
		filter.Type = &raw
	}
	filter.Limit = 20
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 || value > 200 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "limit must be between 1 and 200")
			return
		}
		filter.Limit = value
	}
	if raw := r.URL.Query().Get("offset"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "offset must be greater than or equal to 0")
			return
		}
		filter.Offset = value
	}
	items, total, err := handler.store.ListInsights(r.Context(), filter)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	if items == nil {
		items = []InsightItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, InsightListResponse{Items: items, Total: total})
}

func (handler *Handler) Latest(w http.ResponseWriter, r *http.Request) {
	projectID, ok := requiredPositiveQuery(w, r, "project_id")
	if !ok {
		return
	}
	identity := requestIdentity(r)
	if _, err := handler.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin); err != nil {
		WriteAccessError(w, err)
		return
	}
	country := "US"
	if raw := r.URL.Query().Get("country"); raw != "" {
		country = strings.ToUpper(strings.TrimSpace(raw))
	}
	detail, err := handler.store.GetLatestInsight(r.Context(), projectID, country)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (handler *Handler) ListSchedules(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	filter := ScheduleFilter{Operator: identity.Operator, IsAdmin: identity.IsAdmin}
	if raw := r.URL.Query().Get("project_id"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a valid positive integer")
			return
		}
		filter.ProjectID = &value
	}
	if raw := r.URL.Query().Get("is_active"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "is_active must be a valid boolean")
			return
		}
		filter.IsActive = &value
	}
	if raw := r.URL.Query().Get("insight_type"); raw != "" {
		filter.Type = &raw
	}
	schedules, err := handler.store.ListSchedules(r.Context(), filter)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	if schedules == nil {
		schedules = []Schedule{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, ScheduleListResponse{Items: schedules, Total: len(schedules)})
}

func (handler *Handler) CreateSchedule(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		ProjectID         int64   `json:"project_id"`
		Country           string  `json:"country"`
		InsightType       string  `json:"insight_type"`
		CronExpression    string  `json:"cron_expression"`
		DateRangeStrategy string  `json:"date_range_strategy"`
		Model             *string `json:"model"`
	}
	if !decodeJSONBody(w, r, &payload) {
		return
	}
	if payload.ProjectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a positive integer")
		return
	}
	if payload.Country == "" {
		payload.Country = "US"
	}
	payload.Country = normalizeScheduleCountry(payload.Country)
	if !validScheduleCountry(payload.Country) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country must be one of US, DE, UK")
		return
	}
	if payload.InsightType == "" {
		payload.InsightType = "daily"
	}
	if !validScheduleType(payload.InsightType) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "insight_type must be one of daily, weekly, monthly, custom")
		return
	}
	cron, ok := validateCron(w, payload.CronExpression)
	if !ok {
		return
	}
	if payload.DateRangeStrategy == "" {
		payload.DateRangeStrategy = "yesterday"
	}
	if !validDateStrategy(payload.DateRangeStrategy) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "date_range_strategy is invalid")
		return
	}
	identity := requestIdentity(r)
	if _, err := handler.store.VerifyProjectAccess(r.Context(), payload.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		WriteAccessError(w, err)
		return
	}
	schedule, err := handler.store.CreateSchedule(r.Context(), CreateScheduleInput{
		ProjectID: payload.ProjectID, Country: payload.Country, InsightType: payload.InsightType,
		CronExpression: cron, DateRangeStrategy: payload.DateRangeStrategy, Model: payload.Model,
		Operator: identity.Operator, Audit: MutationMetaFromRequest(r, identity.Operator),
	})
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusCreated, schedule)
}

func (handler *Handler) UpdateSchedule(w http.ResponseWriter, r *http.Request) {
	scheduleID, ok := pathID(w, r, "schedule_id")
	if !ok {
		return
	}
	schedule, err := handler.store.GetSchedule(r.Context(), scheduleID)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	identity := requestIdentity(r)
	if _, err := handler.store.VerifyProjectAccess(r.Context(), schedule.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		WriteAccessError(w, err)
		return
	}
	var raw map[string]json.RawMessage
	if !decodeMapBody(w, r, &raw) {
		return
	}
	input := UpdateScheduleInput{Operator: identity.Operator, IsAdmin: identity.IsAdmin, Audit: MutationMetaFromRequest(r, identity.Operator)}
	if value, present := raw["country"]; present {
		var country string
		if json.Unmarshal(value, &country) != nil || !validScheduleCountry(normalizeScheduleCountry(country)) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "country must be one of US, DE, UK")
			return
		}
		country = normalizeScheduleCountry(country)
		input.Country = &country
	}
	if value, present := raw["insight_type"]; present {
		var insightType string
		if json.Unmarshal(value, &insightType) != nil || !validScheduleType(insightType) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "insight_type is invalid")
			return
		}
		input.InsightType = &insightType
	}
	if value, present := raw["cron_expression"]; present {
		var cron string
		if json.Unmarshal(value, &cron) != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "cron_expression is invalid")
			return
		}
		normalized, valid := validateCron(w, cron)
		if !valid {
			return
		}
		input.CronExpression = &normalized
	}
	if value, present := raw["date_range_strategy"]; present {
		var strategy string
		if json.Unmarshal(value, &strategy) != nil || !validDateStrategy(strategy) {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "date_range_strategy is invalid")
			return
		}
		input.DateRangeStrategy = &strategy
	}
	if value, present := raw["model"]; present {
		input.ModelSet = true
		if string(value) != "null" {
			var model string
			if json.Unmarshal(value, &model) != nil {
				httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "model must be a string or null")
				return
			}
			input.Model = &model
		}
	}
	if value, present := raw["is_active"]; present {
		var active bool
		if json.Unmarshal(value, &active) != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "is_active must be a boolean")
			return
		}
		input.IsActive = &active
	}
	updated, err := handler.store.UpdateSchedule(r.Context(), scheduleID, input)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, updated)
}

func (handler *Handler) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	handler.scheduleAction(w, r, func(ctx context.Context, id int64, identity auth.UserContext) (any, error) {
		deleted, err := handler.store.DeleteSchedule(ctx, id, identity.Operator, identity.IsAdmin, MutationMetaFromRequest(r, identity.Operator))
		if err != nil {
			return nil, err
		}
		return ScheduleDeleteResponse{Deleted: deleted, ID: id}, nil
	})
}

func (handler *Handler) ToggleSchedule(w http.ResponseWriter, r *http.Request) {
	handler.scheduleAction(w, r, func(ctx context.Context, id int64, identity auth.UserContext) (any, error) {
		schedule, err := handler.store.ToggleSchedule(ctx, id, identity.Operator, identity.IsAdmin, MutationMetaFromRequest(r, identity.Operator))
		if err != nil {
			return nil, err
		}
		message := "任务已禁用"
		if schedule.IsActive {
			message = "任务已启用"
		}
		return ScheduleToggleResponse{ID: schedule.ID, IsActive: schedule.IsActive, Message: message}, nil
	})
}

func (handler *Handler) RunScheduleNow(w http.ResponseWriter, r *http.Request) {
	if handler.enqueuer == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Insight job enqueuer is not configured")
		return
	}
	handler.scheduleAction(w, r, func(ctx context.Context, id int64, identity auth.UserContext) (any, error) {
		schedule, err := handler.store.GetSchedule(ctx, id)
		if err != nil {
			return nil, err
		}
		if role := legacyDomainRole(schedule.InsightType); role != "" && IsDomainCanonical(handler.cfg.CanonicalDomains, role) {
			return nil, ErrDomainSwitchNeeded
		}
		result, err := handler.store.RunScheduleNow(ctx, id, identity.Operator, identity.IsAdmin, MutationMetaFromRequest(r, identity.Operator))
		if err != nil {
			return nil, err
		}
		scheduleID := id
		insightID := result.InsightID
		if err := handler.enqueuer.EnqueueGenerate(ctx, GenerateJob{ScheduleID: &scheduleID, InsightID: &insightID}); err != nil {
			_ = handler.store.FailScheduleRun(ctx, id, insightID, "insight enqueue failed")
			return nil, ErrEnqueuerMissing
		}
		return ScheduleRunNowResponse{
			ID: id, InsightID: insightID, Status: result.Status, Message: result.Message,
		}, nil
	})
}

func (handler *Handler) Get(w http.ResponseWriter, r *http.Request) {
	insightID, ok := pathID(w, r, "insight_id")
	if !ok {
		return
	}
	detail, err := handler.store.GetInsight(r.Context(), insightID)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	identity := requestIdentity(r)
	if _, err := handler.store.VerifyProjectAccess(r.Context(), detail.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		WriteAccessError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (handler *Handler) Update(w http.ResponseWriter, r *http.Request) {
	insightID, ok := pathID(w, r, "insight_id")
	if !ok {
		return
	}
	var payload struct {
		Content string `json:"content"`
	}
	if !decodeJSONBody(w, r, &payload) {
		return
	}
	if len([]rune(payload.Content)) < 1 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "content must contain at least 1 character")
		return
	}
	identity := requestIdentity(r)
	detail, err := handler.store.UpdateInsightContent(r.Context(), insightID, UpdateInsightInput{
		Content: payload.Content, Operator: identity.Operator, IsAdmin: identity.IsAdmin,
		Audit: MutationMetaFromRequest(r, identity.Operator),
	})
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (handler *Handler) Retry(w http.ResponseWriter, r *http.Request) {
	if handler.enqueuer == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Insight job enqueuer is not configured")
		return
	}
	insightID, ok := pathID(w, r, "insight_id")
	if !ok {
		return
	}
	identity := requestIdentity(r)
	detail, err := handler.store.ResetInsightForRetry(
		r.Context(), insightID, identity.Operator, identity.IsAdmin,
		MutationMetaFromRequest(r, identity.Operator),
	)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	if err := handler.enqueuer.EnqueueGenerate(r.Context(), GenerateJob{InsightID: &insightID}); err != nil {
		_ = handler.store.FailGeneration(r.Context(), insightID, "insight enqueue failed")
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Insight queue unavailable")
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, RetryResponse{Status: "pending", InsightID: detail.ID})
}

func (handler *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	insightID, ok := pathID(w, r, "insight_id")
	if !ok {
		return
	}
	identity := requestIdentity(r)
	deleted, err := handler.store.DeleteInsight(
		r.Context(), insightID, identity.Operator, identity.IsAdmin,
		MutationMetaFromRequest(r, identity.Operator),
	)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, DeleteResponse{Deleted: deleted, ID: insightID})
}

func (handler *Handler) EvolutionReport(w http.ResponseWriter, r *http.Request) {
	var projectID *int64
	if raw := r.URL.Query().Get("project_id"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a positive integer")
			return
		}
		projectID = &value
		identity := requestIdentity(r)
		if _, err := handler.store.VerifyProjectAccess(r.Context(), value, identity.Operator, identity.IsAdmin); err != nil {
			WriteAccessError(w, err)
			return
		}
	}
	rows, err := handler.store.ListAdAgentRuns(r.Context(), projectID, 100)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, EvolveDimensions(rows))
}

func (handler *Handler) scheduleAction(w http.ResponseWriter, r *http.Request, action func(context.Context, int64, auth.UserContext) (any, error)) {
	scheduleID, ok := pathID(w, r, "schedule_id")
	if !ok {
		return
	}
	schedule, err := handler.store.GetSchedule(r.Context(), scheduleID)
	if err != nil {
		writeInsightStoreError(w, err)
		return
	}
	identity := requestIdentity(r)
	if _, err := handler.store.VerifyProjectAccess(r.Context(), schedule.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		WriteAccessError(w, err)
		return
	}
	result, err := action(r.Context(), scheduleID, identity)
	if err != nil {
		switch {
		case errors.Is(err, ErrDomainSwitchNeeded):
			writeDomainSwitchError(w, legacyDomainRole(schedule.InsightType), true)
		case errors.Is(err, ErrEnqueuerMissing):
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Insight queue unavailable")
		default:
			writeInsightStoreError(w, err)
		}
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, result)
}

func requestIdentity(r *http.Request) auth.UserContext {
	identity, ok := auth.UserContextFromContext(r.Context())
	if ok {
		return identity
	}
	return auth.UserContextFromRequest(r)
}

func pathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	value, err := strconv.ParseInt(strings.TrimSpace(chi.URLParam(r, name)), 10, 64)
	if err != nil || value <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid "+name)
		return 0, false
	}
	return value, true
}

func requiredPositiveQuery(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "field required: "+name)
		return 0, false
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, name+" must be a valid positive integer")
		return 0, false
	}
	return value, true
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, target any) bool {
	body := http.MaxBytesReader(w, r.Body, maxLegacyBodyBytes)
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(target); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	if err := ensureEOF(decoder); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	return true
}

func decodeMapBody(w http.ResponseWriter, r *http.Request, target *map[string]json.RawMessage) bool {
	body := http.MaxBytesReader(w, r.Body, maxLegacyBodyBytes)
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(target); err != nil || *target == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return false
	}
	return true
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err == io.EOF {
		return nil
	} else if err != nil {
		return err
	}
	return errors.New("multiple JSON values")
}

func parseDate(value string) (time.Time, error) {
	return time.Parse("2006-01-02", strings.TrimSpace(value))
}

func normalizeScheduleCountry(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if value == "GB" {
		return "UK"
	}
	return value
}

func validScheduleCountry(value string) bool {
	return value == "US" || value == "DE" || value == "UK"
}

func validScheduleType(value string) bool {
	return value == "daily" || value == "weekly" || value == "monthly" || value == "custom"
}

func validDateStrategy(value string) bool {
	switch value {
	case "yesterday", "last_7d", "last_30d", "prev_month", "current_month", "last_week":
		return true
	default:
		return false
	}
}

func validateCron(w http.ResponseWriter, value string) (string, bool) {
	value = strings.TrimSpace(value)
	if len(strings.Fields(value)) != 5 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Cron 表达式必须是 5 个字段：分 时 日 月 周")
		return "", false
	}
	return value, true
}

func legacyDomainRole(insightType string) string {
	if insightType == "ad_analysis" {
		return "ad_analysis"
	}
	return ""
}

// LegacyDomainRole exposes the old InsightType -> canonical role mapping to
// worker-side schedule generation without importing endpoint internals.
func LegacyDomainRole(insightType string) string {
	return legacyDomainRole(insightType)
}

func writeDomainSwitchError(w http.ResponseWriter, roleID string, enabled bool) {
	message := roleID + " 已切换到 canonical Insight，旧生成入口已冻结；请改用 canonical run 入口"
	if !enabled {
		message = roleID + " 尚未切换到 canonical Insight，canonical 入口暂不可用"
	}
	_ = httpapi.WriteJSON(w, http.StatusConflict, map[string]any{
		"detail": map[string]any{"code": "DOMAIN_SWITCH_NOT_READY", "message": message, "retryable": false},
	})
}

func writeLegacySSE(w io.Writer, payload map[string]any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
}

func writeInsightStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	case errors.Is(err, ErrInsightNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "洞察不存在")
	case errors.Is(err, ErrScheduleNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "定时任务不存在")
	case errors.Is(err, ErrInsightCompleted):
		httpapi.WriteDetail(w, http.StatusBadRequest, "已完成的洞察无法重试，请删除后重新生成")
	case errors.Is(err, ErrInvalidState):
		httpapi.WriteDetail(w, http.StatusConflict, "洞察状态不允许该操作")
	default:
		httpapi.WriteInternalServerError(w)
	}
}
