package project_goals

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{store: store, auditor: auditor}
}

func (h *Handler) ListGoals(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	query := r.URL.Query()
	projectIDStr := query.Get("project_id")
	if projectIDStr == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "field required: project_id")
		return
	}
	projectID, err := strconv.ParseInt(projectIDStr, 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a valid positive integer")
		return
	}

	if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeAccessError(w, err)
		return
	}

	country := normalizeCountry(query.Get("country"))
	year := time.Now().Year()
	if yearStr := query.Get("year"); yearStr != "" {
		y, err := strconv.Atoi(yearStr)
		if err != nil || y < 2020 || y > 2100 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "year must be between 2020 and 2100")
			return
		}
		year = y
	}

	var goalType *string
	if gt := strings.TrimSpace(query.Get("goal_type")); gt != "" {
		goalType = &gt
	}

	metricType := "sales_amount"
	if mt := strings.TrimSpace(query.Get("metric_type")); mt == "sales_amount" {
		metricType = mt
	}

	goals, err := h.store.ListGoals(r.Context(), projectID, country, year, goalType, &metricType)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if goals == nil {
		goals = []ProjectGoalItem{}
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, ProjectGoalListResponse{
		Goals: goals,
		Total: len(goals),
	})
}

func (h *Handler) GetProgress(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	query := r.URL.Query()
	projectIDStr := query.Get("project_id")
	if projectIDStr == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "field required: project_id")
		return
	}
	projectID, err := strconv.ParseInt(projectIDStr, 10, 64)
	if err != nil || projectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a valid positive integer")
		return
	}

	if err := h.store.VerifyProjectAccess(r.Context(), projectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeAccessError(w, err)
		return
	}

	country := normalizeCountry(query.Get("country"))
	year := time.Now().Year()
	if yearStr := query.Get("year"); yearStr != "" {
		y, err := strconv.Atoi(yearStr)
		if err != nil || y < 2020 || y > 2100 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "year must be between 2020 and 2100")
			return
		}
		year = y
	}

	metricType := "sales_amount"
	if mt := strings.TrimSpace(query.Get("metric_type")); mt == "sales_amount" {
		metricType = mt
	}

	resp, err := h.store.GetProgress(r.Context(), projectID, country, year, metricType)
	if err != nil {
		if errors.Is(err, ErrProjectNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}

func (h *Handler) GetGoal(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	goalID, err := strconv.ParseInt(chi.URLParam(r, "goal_id"), 10, 64)
	if err != nil || goalID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid goal_id")
		return
	}

	goal, err := h.store.GetGoal(r.Context(), goalID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if goal == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "目标不存在")
		return
	}

	if err := h.store.VerifyProjectAccess(r.Context(), goal.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeAccessError(w, err)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, goal)
}

func (h *Handler) CreateGoal(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	var input ProjectGoalCreate
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}

	if input.ProjectID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be a positive integer")
		return
	}
	if input.Country == "" {
		input.Country = "US"
	} else {
		input.Country = normalizeCountry(input.Country)
	}
	if input.GoalType == "" {
		input.GoalType = "monthly"
	}
	if input.MetricType == "" {
		input.MetricType = "sales_amount"
	}

	if input.PeriodYear < 2020 || input.PeriodYear > 2100 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "period_year must be between 2020 and 2100")
		return
	}
	if input.TargetAmount < 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "target_amount must be greater than or equal to 0")
		return
	}
	if input.GoalType != "monthly" && input.GoalType != "annual" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "goal_type must be monthly or annual")
		return
	}
	if input.MetricType != "sales_amount" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "metric_type must be one of: sales_amount")
		return
	}
	if input.GoalType == "monthly" {
		if input.PeriodMonth == nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "月度目标必须指定 period_month")
			return
		}
		if *input.PeriodMonth < 1 || *input.PeriodMonth > 12 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "period_month must be between 1 and 12")
			return
		}
	}
	if input.GoalType == "annual" && input.PeriodMonth != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "年度目标不能指定 period_month")
		return
	}

	if err := h.store.VerifyProjectAccess(r.Context(), input.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeAccessError(w, err)
		return
	}

	var created *ProjectGoalItem
	err := h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		res, createErr := txStore.CreateGoal(ctx, input)
		if createErr != nil {
			return createErr
		}
		created = res
		targetID := strconv.FormatInt(created.ID, 10)
		return h.logActionTx(ctx, r, tx, audit.Entry{
			Action:     "project_goals.create",
			TargetType: "project_goal",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			AfterJSON:  created,
			Result:     "success",
		})
	})

	if err != nil {
		if errors.Is(err, ErrGoalConflict) {
			httpapi.WriteDetail(w, http.StatusConflict, "该目标已存在（同一项目/国家/类型/指标/年份/月份组合）")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusCreated, created)
}

func (h *Handler) UpdateGoal(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	goalID, err := strconv.ParseInt(chi.URLParam(r, "goal_id"), 10, 64)
	if err != nil || goalID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid goal_id")
		return
	}

	var input ProjectGoalUpdate
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if input.TargetAmount < 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "target_amount must be greater than or equal to 0")
		return
	}

	goal, err := h.store.GetGoal(r.Context(), goalID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if goal == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "目标不存在")
		return
	}

	if err := h.store.VerifyProjectAccess(r.Context(), goal.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeAccessError(w, err)
		return
	}

	var updated *ProjectGoalItem
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		res, updateErr := txStore.UpdateGoal(ctx, goalID, input.TargetAmount)
		if updateErr != nil {
			return updateErr
		}
		if res == nil {
			return ErrGoalNotFound
		}
		updated = res
		targetID := strconv.FormatInt(goalID, 10)
		return h.logActionTx(ctx, r, tx, audit.Entry{
			Action:     "project_goals.update",
			TargetType: "project_goal",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			BeforeJSON: goal,
			AfterJSON:  updated,
			Result:     "success",
		})
	})

	if err != nil {
		if errors.Is(err, ErrGoalNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "目标不存在")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	_ = httpapi.WriteJSON(w, http.StatusOK, updated)
}

func (h *Handler) DeleteGoal(w http.ResponseWriter, r *http.Request) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		identity = auth.UserContextFromRequest(r)
	}

	goalID, err := strconv.ParseInt(chi.URLParam(r, "goal_id"), 10, 64)
	if err != nil || goalID <= 0 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid goal_id")
		return
	}

	goal, err := h.store.GetGoal(r.Context(), goalID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if goal == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "目标不存在")
		return
	}

	if err := h.store.VerifyProjectAccess(r.Context(), goal.ProjectID, identity.Operator, identity.IsAdmin); err != nil {
		h.writeAccessError(w, err)
		return
	}

	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		deleted, delErr := txStore.DeleteGoal(ctx, goalID)
		if delErr != nil {
			return delErr
		}
		if !deleted {
			return ErrGoalNotFound
		}
		targetID := strconv.FormatInt(goalID, 10)
		return h.logActionTx(ctx, r, tx, audit.Entry{
			Action:     "project_goals.delete",
			TargetType: "project_goal",
			TargetID:   &targetID,
			Operator:   &identity.Operator,
			BeforeJSON: goal,
			Result:     "success",
		})
	})

	if err != nil {
		if errors.Is(err, ErrGoalNotFound) {
			httpapi.WriteDetail(w, http.StatusNotFound, "目标不存在")
			return
		}
		httpapi.WriteInternalServerError(w)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) runInTx(ctx context.Context, fn func(context.Context, pgx.Tx, Store) error) error {
	runner, ok := h.store.(TransactionRunner)
	if !ok {
		return fn(ctx, nil, h.store)
	}
	return runner.RunInTx(ctx, fn)
}

func (h *Handler) logActionTx(ctx context.Context, r *http.Request, tx pgx.Tx, entry audit.Entry) error {
	if h.auditor == nil {
		return nil
	}
	entry.PopulateFromRequest(r)
	if tx != nil {
		return h.auditor.LogActionTx(ctx, tx, entry)
	}
	return h.auditor.LogAction(ctx, entry)
}

func (h *Handler) writeAccessError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrProjectNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
	case errors.Is(err, ErrProjectForbidden):
		httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
	default:
		httpapi.WriteInternalServerError(w)
	}
}

func normalizeCountry(country string) string {
	c := strings.ToUpper(strings.TrimSpace(country))
	if c == "" {
		return "US"
	}
	if c == "GB" {
		return "UK"
	}
	return c
}
