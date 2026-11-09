package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/daily_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/project_goals"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage4ADailyStore struct{}

func (stage4ADailyStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (stage4ADailyStore) AccessibleProjectIDs(context.Context, string, bool) ([]int64, error) {
	return []int64{1, 2}, nil
}
func (stage4ADailyStore) GetDailyAnalysis(_ context.Context, projectID int64, country string, startDate, endDate string, _ *string) (*daily_analysis.DailyAnalysisResponse, error) {
	return &daily_analysis.DailyAnalysisResponse{
		Console: daily_analysis.DailyAnalysisConsoleResponse{
			ProjectID:           projectID,
			ProjectName:         "Project Alpha",
			Country:             country,
			StartDate:           startDate,
			EndDate:             endDate,
			RequestedDays:       5,
			SummaryDays:         5,
			DetailRows:          5,
			SalesSourceDays:     5,
			AdSourceDays:        5,
			InventorySourceDays: 5,
			BusinessSourceDays:  5,
			MissingDates:        []string{},
		},
		SummaryRows: []daily_analysis.DailyAnalysisSummaryRow{
			{
				Date:               startDate,
				OrderQty:           10,
				PendingOrderQty:    2,
				SalesAmount:        1000.50,
				Impressions:        5000,
				Clicks:             200,
				CPC:                0.50,
				AdSpend:            100.0,
				AdOrders:           8,
				AvailableQty:       120,
				PageViews:          800,
				UnitsOrdered:       15,
				Sessions:           750,
				OrderedSalesAmount: 1100.0,
				ConversionRate:     0.02,
			},
		},
		DetailRows: []daily_analysis.DailyAnalysisDetailRow{
			{
				Date:               startDate,
				SKU:                "SKU-ALPHA-1",
				OrderQty:           10,
				PendingOrderQty:    2,
				SalesAmount:        1000.50,
				Impressions:        5000,
				Clicks:             200,
				CPC:                0.50,
				AdSpend:            100.0,
				AdOrders:           8,
				AvailableQty:       120,
				InTransitQty:       50,
				PageViews:          800,
				UnitsOrdered:       15,
				Sessions:           750,
				OrderedSalesAmount: 1100.0,
				ConversionRate:     0.02,
			},
		},
		AvailableDates: map[string][]string{
			"sales_report": {startDate},
		},
	}, nil
}
func (stage4ADailyStore) GetDailyAnalysisAll(_ context.Context, projectIDs []int64, _ string, startDate, _ string, _ *string, _ bool) (*daily_analysis.DailyAnalysisAllProjectsResponse, error) {
	return &daily_analysis.DailyAnalysisAllProjectsResponse{
		SummaryRows: []daily_analysis.DailyAnalysisSummaryRow{
			{Date: startDate, OrderQty: 20, SalesAmount: 2000.0},
		},
		DetailRows: []daily_analysis.DailyAnalysisDetailRow{
			{Date: startDate, SKU: "SKU-ALPHA-1", OrderQty: 20, SalesAmount: 2000.0},
		},
		AvailableDates: map[string][]string{
			"sales_report": {startDate},
		},
		ProjectBreakdown: map[int64]daily_analysis.ProjectBreakdownBlock{
			projectIDs[0]: {
				ProjectName: "Project Alpha",
				SummaryRows: []daily_analysis.DailyAnalysisSummaryRow{{Date: startDate, OrderQty: 20}},
				DetailRows:  []daily_analysis.DailyAnalysisDetailRow{{Date: startDate, SKU: "SKU-ALPHA-1", OrderQty: 20}},
			},
		},
	}, nil
}
func (stage4ADailyStore) GetDailyAnalysisAllCountries(_ context.Context, projectID int64, startDate, endDate string) (*daily_analysis.DailyAnalysisAllCountriesResponse, error) {
	note := "金额字段已按当月 CNY 中转折算为 USD 统一展示；非金额字段（订单/曝光/点击/库存等）保持原值。"
	return &daily_analysis.DailyAnalysisAllCountriesResponse{
		Console: daily_analysis.DailyAnalysisConsoleResponse{
			ProjectID:   projectID,
			ProjectName: "Project Alpha",
			Country:     "ALL",
			StartDate:   startDate,
			EndDate:     endDate,
		},
		SummaryRows: []daily_analysis.DailyAnalysisSummaryRow{{Date: startDate, OrderQty: 30, SalesAmount: 3000.0}},
		DetailRows:  []daily_analysis.DailyAnalysisDetailRow{{Date: startDate, SKU: "SKU-ALPHA-1", OrderQty: 30}},
		AvailableDates: map[string][]string{
			"sales_report": {startDate},
		},
		CountryBreakdown: map[string]daily_analysis.CountryBreakdownBlock{
			"US": {Currency: "USD", SourceCurrency: "USD"},
		},
		Currency:     "USD",
		CurrencyNote: &note,
	}, nil
}
func (stage4ADailyStore) GetDailyAnalysisAllProjectsCountries(_ context.Context, projectIDs []int64, startDate, endDate string) (*daily_analysis.DailyAnalysisAllProjectsCountriesResponse, error) {
	note := "金额字段已按当月 CNY 中转折算为 USD 统一展示；非金额字段（订单/曝光/点击/库存等）保持原值。"
	return &daily_analysis.DailyAnalysisAllProjectsCountriesResponse{
		Console: daily_analysis.DailyAnalysisConsoleResponse{
			ProjectID:   0,
			ProjectName: "全部项目",
			Country:     "ALL",
			StartDate:   startDate,
			EndDate:     endDate,
		},
		SummaryRows: []daily_analysis.DailyAnalysisSummaryRow{{Date: startDate, OrderQty: 60, SalesAmount: 6000.0}},
		DetailRows:  []daily_analysis.DailyAnalysisDetailRow{{Date: startDate, SKU: "SKU-ALPHA-1", OrderQty: 60}},
		AvailableDates: map[string][]string{
			"sales_report": {startDate},
		},
		ProjectBreakdown: map[int64]daily_analysis.ProjectBreakdownBlock{
			projectIDs[0]: {ProjectName: "Project Alpha"},
		},
		CountryBreakdown: map[string]daily_analysis.CountryBreakdownBlock{
			"US": {Currency: "USD", SourceCurrency: "USD"},
		},
		Currency:     "USD",
		CurrencyNote: &note,
	}, nil
}

type stage4AGoalsStore struct {
	goal project_goals.ProjectGoalItem
}

func (s *stage4AGoalsStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (s *stage4AGoalsStore) ListGoals(context.Context, int64, string, int, *string, *string) ([]project_goals.ProjectGoalItem, error) {
	return []project_goals.ProjectGoalItem{s.goal}, nil
}
func (s *stage4AGoalsStore) GetGoal(_ context.Context, id int64) (*project_goals.ProjectGoalItem, error) {
	if id == s.goal.ID {
		return &s.goal, nil
	}
	return nil, nil
}
func (s *stage4AGoalsStore) CreateGoal(_ context.Context, input project_goals.ProjectGoalCreate) (*project_goals.ProjectGoalItem, error) {
	item := s.goal
	item.ProjectID = input.ProjectID
	item.TargetAmount = input.TargetAmount
	return &item, nil
}
func (s *stage4AGoalsStore) UpdateGoal(_ context.Context, id int64, targetAmount float64) (*project_goals.ProjectGoalItem, error) {
	item := s.goal
	item.TargetAmount = targetAmount
	return &item, nil
}
func (s *stage4AGoalsStore) DeleteGoal(_ context.Context, _ int64) (bool, error) {
	return true, nil
}
func (s *stage4AGoalsStore) GetProgress(_ context.Context, projectID int64, country string, year int, _ string) (*project_goals.ProjectGoalProgressResponse, error) {
	month := 5
	return &project_goals.ProjectGoalProgressResponse{
		ProjectID: projectID,
		Country:   country,
		Year:      year,
		Currency:  "USD",
		MonthlyProgress: []project_goals.MonthlyProgressItem{
			{
				Year:                  year,
				Month:                 month,
				MonthLabel:            "2026年5月",
				TargetAmount:          10000.0,
				AchievedAmount:        8500.0,
				CompletionRate:        0.85,
				DaysInMonth:           31,
				TodayDay:              20,
				DailyTarget:           322.58,
				CumulativeDailyTarget: 6451.61,
				CompletionVsDaily:     1.31,
				CompletionVsMonthly:   0.85,
				Currency:              "USD",
			},
		},
		AnnualProgress: &project_goals.AnnualProgressItem{
			Year:           year,
			TargetAmount:   120000.0,
			AchievedAmount: 95000.0,
			CompletionRate: 0.7916,
			Currency:       "USD",
		},
	}, nil
}
func (s *stage4AGoalsStore) RunInTx(ctx context.Context, fn func(context.Context, pgx.Tx, project_goals.Store) error) error {
	return fn(ctx, nil, s)
}

func TestStage4ADailyAnalysisWireContract(t *testing.T) {
	reg := daily_analysis.NewRegistrar(stage4ADailyStore{})
	if reg.ModuleName() != "daily_analysis" {
		t.Fatalf("ModuleName() = %q, want daily_analysis", reg.ModuleName())
	}

	router := chi.NewRouter()
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	userCtx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "test-user", IsAdmin: true})

	// 1. GET /api/v1/daily-analysis
	req := httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis?project_id=1&start_date=2026-11-01&end_date=2026-11-05&country=US", nil).WithContext(userCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	for _, field := range []string{
		`"console"`, `"project_id"`, `"project_name"`, `"country"`, `"start_date"`, `"end_date"`,
		`"summary_rows"`, `"detail_rows"`, `"available_dates"`, `"order_qty"`, `"pending_order_qty"`,
		`"sales_amount"`, `"impressions"`, `"clicks"`, `"cpc"`, `"ad_spend"`, `"ad_orders"`,
		`"available_qty"`, `"in_transit_qty"`, `"page_views"`, `"units_ordered"`, `"conversion_rate"`,
	} {
		if !strings.Contains(rec.Body.String(), field) {
			t.Errorf("daily-analysis missing snake_case field %s: %s", field, rec.Body.String())
		}
	}
	for _, camel := range []string{`"projectId"`, `"projectName"`, `"startDate"`, `"summaryRows"`, `"detailRows"`} {
		if strings.Contains(rec.Body.String(), camel) {
			t.Errorf("daily-analysis contains camelCase field %s", camel)
		}
	}

	// 2. GET /api/v1/daily-analysis/all
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all?project_ids=all&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(userCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("all status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	for _, field := range []string{`"summary_rows"`, `"detail_rows"`, `"available_dates"`, `"project_breakdown"`} {
		if !strings.Contains(rec.Body.String(), field) {
			t.Errorf("daily-analysis/all missing %s: %s", field, rec.Body.String())
		}
	}

	// 3. GET /api/v1/daily-analysis/all-countries
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all-countries?project_id=1&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(userCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("all-countries status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	for _, field := range []string{`"country_breakdown"`, `"currency"`, `"currency_note"`} {
		if !strings.Contains(rec.Body.String(), field) {
			t.Errorf("daily-analysis/all-countries missing %s: %s", field, rec.Body.String())
		}
	}

	// 4. GET /api/v1/daily-analysis/all-projects-countries
	req = httptest.NewRequest(http.MethodGet, "/api/v1/daily-analysis/all-projects-countries?project_ids=1,2&start_date=2026-11-01&end_date=2026-11-05", nil).WithContext(userCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("all-projects-countries status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	for _, field := range []string{`"project_breakdown"`, `"country_breakdown"`, `"currency"`} {
		if !strings.Contains(rec.Body.String(), field) {
			t.Errorf("daily-analysis/all-projects-countries missing %s: %s", field, rec.Body.String())
		}
	}
}

func TestStage4AProjectGoalsWireContract(t *testing.T) {
	month := 5
	goalsStore := &stage4AGoalsStore{
		goal: project_goals.ProjectGoalItem{
			ID:           101,
			ProjectID:    1,
			Country:      "US",
			GoalType:     "monthly",
			MetricType:   "sales_amount",
			PeriodYear:   2026,
			PeriodMonth:  &month,
			TargetAmount: 15000.0,
			Currency:     "USD",
			CreatedAt:    "2026-11-01T00:00:00Z",
			UpdatedAt:    "2026-11-01T00:00:00Z",
		},
	}

	reg := project_goals.NewRegistrar(goalsStore, audit.NewMockService())
	if reg.ModuleName() != "project_goals" {
		t.Fatalf("ModuleName() = %q, want project_goals", reg.ModuleName())
	}

	router := chi.NewRouter()
	reg.RegisterRoutes(router, func(next http.Handler) http.Handler { return next })

	userCtx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "test-user", IsAdmin: true})

	// 1. GET /api/v1/project-goals
	req := httptest.NewRequest(http.MethodGet, "/api/v1/project-goals?project_id=1&country=US&year=2026", nil).WithContext(userCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	for _, field := range []string{
		`"goals"`, `"total"`, `"id"`, `"project_id"`, `"country"`, `"goal_type"`,
		`"metric_type"`, `"period_year"`, `"period_month"`, `"target_amount"`,
		`"currency"`, `"created_at"`, `"updated_at"`,
	} {
		if !strings.Contains(rec.Body.String(), field) {
			t.Errorf("project-goals missing %s: %s", field, rec.Body.String())
		}
	}
	for _, camel := range []string{`"projectId"`, `"goalType"`, `"targetAmount"`, `"createdAt"`} {
		if strings.Contains(rec.Body.String(), camel) {
			t.Errorf("project-goals contains camelCase %s", camel)
		}
	}

	// 2. GET /api/v1/project-goals/progress
	req = httptest.NewRequest(http.MethodGet, "/api/v1/project-goals/progress?project_id=1&country=US&year=2026", nil).WithContext(userCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("progress status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	for _, field := range []string{
		`"project_id"`, `"country"`, `"year"`, `"currency"`, `"monthly_progress"`,
		`"annual_progress"`, `"month_label"`, `"target_amount"`, `"achieved_amount"`,
		`"completion_rate"`, `"days_in_month"`, `"today_day"`, `"daily_target"`,
		`"cumulative_daily_target"`, `"completion_vs_daily"`, `"completion_vs_monthly"`,
	} {
		if !strings.Contains(rec.Body.String(), field) {
			t.Errorf("project-goals progress missing %s: %s", field, rec.Body.String())
		}
	}

	// 3. GET /api/v1/project-goals/{goal_id}
	req = httptest.NewRequest(http.MethodGet, "/api/v1/project-goals/101", nil).WithContext(userCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, want 200", rec.Code)
	}

	// 4. POST /api/v1/project-goals
	m := 6
	createPayload, _ := json.Marshal(project_goals.ProjectGoalCreate{
		ProjectID:    1,
		Country:      "US",
		GoalType:     "monthly",
		MetricType:   "sales_amount",
		PeriodYear:   2026,
		PeriodMonth:  &m,
		TargetAmount: 20000.0,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/v1/project-goals", bytes.NewReader(createPayload)).WithContext(userCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201: %s", rec.Code, rec.Body.String())
	}

	// 5. PUT /api/v1/project-goals/{goal_id}
	updatePayload, _ := json.Marshal(project_goals.ProjectGoalUpdate{TargetAmount: 25000.0})
	req = httptest.NewRequest(http.MethodPut, "/api/v1/project-goals/101", bytes.NewReader(updatePayload)).WithContext(userCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	// 6. DELETE /api/v1/project-goals/{goal_id}
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/project-goals/101", nil).WithContext(userCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, want 204: %s", rec.Code, rec.Body.String())
	}
}
