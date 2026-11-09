package return_analysis

import (
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

type mockReturnStore struct {
	analysisResp *ReturnAnalysisResponse
	rawRows      []ReturnRawRowItem
	verifyErr    error
	analysisErr  error
	rawErr       error
}

func (m *mockReturnStore) VerifyProjectAccess(_ context.Context, _ int64, _ string, _ bool) error {
	return m.verifyErr
}
func (m *mockReturnStore) GetReturnAnalysis(_ context.Context, _ ReturnAnalysisFilter) (*ReturnAnalysisResponse, error) {
	if m.analysisErr != nil {
		return nil, m.analysisErr
	}
	return m.analysisResp, nil
}
func (m *mockReturnStore) GetRawRows(_ context.Context, _ ReturnAnalysisFilter, _ int) ([]ReturnRawRowItem, error) {
	if m.rawErr != nil {
		return nil, m.rawErr
	}
	return m.rawRows, nil
}

type mockReturnAuditor struct{}

func (a *mockReturnAuditor) LogAction(_ context.Context, _ audit.Entry) error             { return nil }
func (a *mockReturnAuditor) LogActionTx(_ context.Context, _ pgx.Tx, _ audit.Entry) error { return nil }
func (a *mockReturnAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

func setupReturnRouter(store Store) chi.Router {
	r := chi.NewRouter()
	registrar := NewRegistrar(store, &mockReturnAuditor{})
	registrar.RegisterRoutes(r, func(next http.Handler) http.Handler { return next })
	return r
}

func TestReturnAnalysisHandler(t *testing.T) {
	store := &mockReturnStore{
		analysisResp: &ReturnAnalysisResponse{
			ProjectID:   1,
			ProjectName: "Test Project",
			Country:     "US",
			StartDate:   "2026-10-01",
			EndDate:     "2026-10-31",
			Summary: ReturnAnalysisSummary{
				TotalReturns:      10,
				TotalQuantity:     15,
				OverallReturnRate: 2.5,
				DataAvailable:     true,
			},
			SummaryText: "本周期表现良好",
		},
		rawRows: []ReturnRawRowItem{
			{
				ReturnDate:          "2026-10-15",
				OrderID:             "111-222",
				SKU:                 "SKU-A",
				Quantity:            1,
				DetailedDisposition: "DEFECTIVE",
				DispositionDisplay:  "有缺陷",
				Reason:              "DEFECTIVE",
				ReasonDisplay:       "有缺陷",
				Status:              "Unit returned to inventory",
				StatusDisplay:       "退回库存",
			},
		},
	}
	router := setupReturnRouter(store)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "admin", IsAdmin: true})

	// 1. Success GetReturnAnalysis
	req := httptest.NewRequest(http.MethodGet, "/api/v1/return-analysis?project_id=1&start_date=2026-10-01&end_date=2026-10-31", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp ReturnAnalysisResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Summary.TotalReturns != 10 {
		t.Fatalf("unexpected summary returns: %d", resp.Summary.TotalReturns)
	}

	// 2. Invalid date format
	req = httptest.NewRequest(http.MethodGet, "/api/v1/return-analysis?project_id=1&start_date=invalid-date&end_date=2026-10-31", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d", rec.Code)
	}

	// 3. Success GetRawRows
	req = httptest.NewRequest(http.MethodGet, "/api/v1/return-analysis/raw-rows?project_id=1&start_date=2026-10-01&end_date=2026-10-31", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var rawResp ReturnRawRowsResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &rawResp)
	if rawResp.RowCount != 1 || len(rawResp.Rows) != 1 {
		t.Fatalf("unexpected raw rows: %+v", rawResp)
	}
}

func TestReturnReasonAliasesAndFallbacks(t *testing.T) {
	cases := map[string]string{
		"AMZ-PG-WJ-TOO-SMALL":    "首饰过小或过短",
		"CR-MISSING_ITEM_IN_SET": "缺少配件",
		"CR-DEFECTIVE":           "有缺陷",
		"UNKNOWN_CODE":           "UNKNOWN_CODE",
	}
	for input, want := range cases {
		if got := TranslateReason(input); got != want {
			t.Fatalf("TranslateReason(%q) = %q, want %q", input, got, want)
		}
	}
}
