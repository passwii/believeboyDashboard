package project_goals

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockProjectGoalStore struct {
	accessErr   error
	goals       []ProjectGoalItem
	goal        *ProjectGoalItem
	conflictErr bool
	progress    *ProjectGoalProgressResponse
}

func (m *mockProjectGoalStore) VerifyProjectAccess(_ context.Context, projectID int64, _ string, _ bool) error {
	if projectID == 999 {
		return ErrProjectNotFound
	}
	return m.accessErr
}

func (m *mockProjectGoalStore) ListGoals(_ context.Context, _ int64, _ string, _ int, _ *string, _ *string) ([]ProjectGoalItem, error) {
	return m.goals, nil
}

func (m *mockProjectGoalStore) GetGoal(_ context.Context, id int64) (*ProjectGoalItem, error) {
	if m.goal != nil && m.goal.ID == id {
		return m.goal, nil
	}
	return nil, nil
}

func (m *mockProjectGoalStore) CreateGoal(_ context.Context, input ProjectGoalCreate) (*ProjectGoalItem, error) {
	if m.conflictErr {
		return nil, ErrGoalConflict
	}
	return &ProjectGoalItem{
		ID:           10,
		ProjectID:    input.ProjectID,
		Country:      input.Country,
		GoalType:     input.GoalType,
		MetricType:   input.MetricType,
		PeriodYear:   input.PeriodYear,
		PeriodMonth:  input.PeriodMonth,
		TargetAmount: input.TargetAmount,
		Currency:     "USD",
		CreatedAt:    "2026-11-08T00:00:00Z",
		UpdatedAt:    "2026-11-08T00:00:00Z",
	}, nil
}

func (m *mockProjectGoalStore) UpdateGoal(_ context.Context, id int64, targetAmount float64) (*ProjectGoalItem, error) {
	if m.goal != nil && m.goal.ID == id {
		updated := *m.goal
		updated.TargetAmount = targetAmount
		return &updated, nil
	}
	return nil, ErrGoalNotFound
}

func (m *mockProjectGoalStore) DeleteGoal(_ context.Context, id int64) (bool, error) {
	if m.goal != nil && m.goal.ID == id {
		return true, nil
	}
	return false, nil
}

func (m *mockProjectGoalStore) GetProgress(_ context.Context, projectID int64, country string, year int, _ string) (*ProjectGoalProgressResponse, error) {
	if m.progress != nil {
		return m.progress, nil
	}
	return &ProjectGoalProgressResponse{
		ProjectID:       projectID,
		Country:         country,
		Year:            year,
		Currency:        "USD",
		MonthlyProgress: []MonthlyProgressItem{},
		AnnualProgress:  nil,
	}, nil
}

func (m *mockProjectGoalStore) RunInTx(ctx context.Context, fn func(context.Context, pgx.Tx, Store) error) error {
	return fn(ctx, nil, m)
}

type mockAuditor struct {
	entries []audit.Entry
}

func (a *mockAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return nil
}

func (a *mockAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	a.entries = append(a.entries, entry)
	return nil
}

func (a *mockAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

func setupGoalsRouter(store Store, auditor audit.Service) http.Handler {
	router := chi.NewRouter()
	reg := NewRegistrar(store, auditor)
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	return router
}

func TestProjectGoalsHandler(t *testing.T) {
	month := 5
	existingGoal := &ProjectGoalItem{
		ID:           1,
		ProjectID:    10,
		Country:      "US",
		GoalType:     "monthly",
		MetricType:   "sales_amount",
		PeriodYear:   2026,
		PeriodMonth:  &month,
		TargetAmount: 10000.0,
		Currency:     "USD",
		CreatedAt:    "2026-11-01T00:00:00Z",
		UpdatedAt:    "2026-11-01T00:00:00Z",
	}
	store := &mockProjectGoalStore{
		goals: []ProjectGoalItem{*existingGoal},
		goal:  existingGoal,
	}
	auditor := &mockAuditor{}
	router := setupGoalsRouter(store, auditor)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "admin",
		IsAdmin:  true,
	})

	// 1. List goals
	req := httptest.NewRequest(http.MethodGet, "/api/v1/project-goals?project_id=10&country=US&year=2026", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var listResp ProjectGoalListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if listResp.Total != 1 || len(listResp.Goals) != 1 {
		t.Fatalf("unexpected list response: %+v", listResp)
	}

	// 2. Get progress
	req = httptest.NewRequest(http.MethodGet, "/api/v1/project-goals/progress?project_id=10&country=US&year=2026", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// 3. Get single goal
	req = httptest.NewRequest(http.MethodGet, "/api/v1/project-goals/1", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 4. Get single goal not found -> 404
	req = httptest.NewRequest(http.MethodGet, "/api/v1/project-goals/99", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}

	// 5. Create goal (status 201 + audit log)
	m := 6
	createBody, _ := json.Marshal(ProjectGoalCreate{
		ProjectID:    10,
		Country:      "US",
		GoalType:     "monthly",
		MetricType:   "sales_amount",
		PeriodYear:   2026,
		PeriodMonth:  &m,
		TargetAmount: 20000.0,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/project-goals", bytes.NewReader(createBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.entries) == 0 || auditor.entries[len(auditor.entries)-1].Action != "project_goals.create" {
		t.Fatalf("expected audit entry for project_goals.create")
	}

	// 6. Create goal conflict -> 409
	store.conflictErr = true
	req = httptest.NewRequest(http.MethodPost, "/api/v1/project-goals", bytes.NewReader(createBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rec.Code, rec.Body.String())
	}
	store.conflictErr = false

	// 7. Create goal invalid validation (annual with period_month) -> 422
	invalidBody, _ := json.Marshal(ProjectGoalCreate{
		ProjectID:    10,
		GoalType:     "annual",
		PeriodYear:   2026,
		PeriodMonth:  &m,
		TargetAmount: 50000.0,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/project-goals", bytes.NewReader(invalidBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for annual with period_month, got %d", rec.Code)
	}

	// 8. Update goal (status 200 + audit log)
	updateBody, _ := json.Marshal(ProjectGoalUpdate{TargetAmount: 30000.0})
	req = httptest.NewRequest(http.MethodPut, "/api/v1/project-goals/1", bytes.NewReader(updateBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if auditor.entries[len(auditor.entries)-1].Action != "project_goals.update" {
		t.Fatalf("expected audit entry for project_goals.update")
	}

	// 9. Update goal negative target -> 422
	negBody, _ := json.Marshal(ProjectGoalUpdate{TargetAmount: -100.0})
	req = httptest.NewRequest(http.MethodPut, "/api/v1/project-goals/1", bytes.NewReader(negBody)).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for negative target, got %d", rec.Code)
	}

	// 10. Delete goal (status 204 + audit log)
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/project-goals/1", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if auditor.entries[len(auditor.entries)-1].Action != "project_goals.delete" {
		t.Fatalf("expected audit entry for project_goals.delete")
	}

	// 11. Forbidden check
	store.accessErr = ErrProjectForbidden
	nonAdminCtx := auth.WithUserContext(context.Background(), auth.UserContext{
		Operator: "intruder",
		IsAdmin:  false,
	})
	req = httptest.NewRequest(http.MethodGet, "/api/v1/project-goals?project_id=10", nil).WithContext(nonAdminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}
