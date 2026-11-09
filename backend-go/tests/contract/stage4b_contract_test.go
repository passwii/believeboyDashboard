package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ad_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ad_upload"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_ad_data"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/rpa_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type stage4BAuditor struct {
	entries []audit.Entry
}

func (a *stage4BAuditor) LogAction(_ context.Context, e audit.Entry) error {
	a.entries = append(a.entries, e)
	return nil
}
func (a *stage4BAuditor) LogActionTx(_ context.Context, _ pgx.Tx, e audit.Entry) error {
	a.entries = append(a.entries, e)
	return nil
}
func (a *stage4BAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

type stage4BAdAnalysisStore struct {
	forbiddenProjectID int64
}

func (s *stage4BAdAnalysisStore) VerifyProjectAccess(_ context.Context, projectID int64, _ string, isAdmin bool) error {
	if !isAdmin && projectID == s.forbiddenProjectID {
		return ad_analysis.ErrProjectForbidden
	}
	if projectID == 404 {
		return ad_analysis.ErrProjectNotFound
	}
	return nil
}
func (s *stage4BAdAnalysisStore) BuildOverview(_ context.Context, filter ad_analysis.BaseFilter) (*ad_analysis.AdAnalysisOverviewResponse, error) {
	helper := "广告总花费"
	return &ad_analysis.AdAnalysisOverviewResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		Metrics: []ad_analysis.AdAnalysisMetricCard{
			{Label: "Spend", Value: 123.45, DisplayValue: "$123.45", Helper: &helper},
		},
		TopCampaigns: []map[string]any{{"campaign_name": "Test Camp", "spend": 123.45}},
	}, nil
}
func (s *stage4BAdAnalysisStore) BuildCampaigns(_ context.Context, filter ad_analysis.CampaignsFilter) (*ad_analysis.AdAnalysisCampaignsResponse, error) {
	return &ad_analysis.AdAnalysisCampaignsResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		SummaryCards: []map[string]any{
			{"label": "活动数", "value": "1", "helper": "活动数量"},
		},
		Items: []map[string]any{
			{"campaign_name": "Camp1", "spend": 50.0, "orders_7d": 2, "grade": "A"},
		},
	}, nil
}
func (s *stage4BAdAnalysisStore) BuildProducts(_ context.Context, filter ad_analysis.ProductsFilter) (*ad_analysis.AdAnalysisProductsResponse, error) {
	return &ad_analysis.AdAnalysisProductsResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		SummaryCards: []map[string]any{
			{"label": "SKU 数", "value": "1"},
		},
		Items: []map[string]any{
			{"ad_sku": "SKU1", "ad_asin": "ASIN1", "spend": 30.0, "grade": "主推"},
		},
	}, nil
}
func (s *stage4BAdAnalysisStore) BuildTimeTrend(_ context.Context, filter ad_analysis.BaseFilter) (*ad_analysis.AdAnalysisTimeTrendResponse, error) {
	return &ad_analysis.AdAnalysisTimeTrendResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		Summary: []map[string]any{
			{"report_date": "2026-10-10", "clicks": 10, "spend": 25.5},
		},
	}, nil
}
func (s *stage4BAdAnalysisStore) BuildPurchasedProducts(_ context.Context, filter ad_analysis.PurchasedProductsFilter) (*ad_analysis.AdAnalysisPurchasedProductsResponse, error) {
	return &ad_analysis.AdAnalysisPurchasedProductsResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		Items: []map[string]any{
			{"purchased_asin": "ASIN2", "ad_sku": "SKU1", "other_sku_sales_7d": 120.0},
		},
	}, nil
}
func (s *stage4BAdAnalysisStore) BuildSearchTerms(_ context.Context, filter ad_analysis.SearchTermsFilter) (*ad_analysis.AdAnalysisSearchTermsResponse, error) {
	return &ad_analysis.AdAnalysisSearchTermsResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		SummaryCards: []map[string]any{
			{"label": "搜索词数", "value": "1"},
		},
		Items: []map[string]any{
			{"search_term": "wireless mouse", "spend": 15.0, "orders_7d": 1, "action": "加词放量"},
		},
	}, nil
}
func (s *stage4BAdAnalysisStore) BuildTargets(_ context.Context, filter ad_analysis.TargetsFilter) (*ad_analysis.AdAnalysisTargetsResponse, error) {
	return &ad_analysis.AdAnalysisTargetsResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		SummaryCards: []map[string]any{
			{"label": "投放入口数", "value": "1"},
		},
		Items: []map[string]any{
			{"target_text": "b0xxxx", "spend": 10.0, "action": "保留放量"},
		},
	}, nil
}
func (s *stage4BAdAnalysisStore) BuildBudget(_ context.Context, filter ad_analysis.BudgetFilter) (*ad_analysis.AdAnalysisBudgetResponse, error) {
	return &ad_analysis.AdAnalysisBudgetResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		SummaryCards: []map[string]any{
			{"label": "预算活动数", "value": "1"},
		},
		Items: []map[string]any{
			{"campaign_name": "Camp1", "budget": 20.0, "action": "优先加预算"},
		},
	}, nil
}
func (s *stage4BAdAnalysisStore) BuildPlacements(_ context.Context, filter ad_analysis.PlacementsFilter) (*ad_analysis.AdAnalysisPlacementsResponse, error) {
	return &ad_analysis.AdAnalysisPlacementsResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		SummaryCards: []map[string]any{
			{"label": "可提高系数", "value": "1"},
		},
		Items: []map[string]any{
			{"campaign_name": "Camp1", "placement": "Top of Search", "action": "可提高系数"},
		},
	}, nil
}
func (s *stage4BAdAnalysisStore) BuildTrafficQuality(_ context.Context, filter ad_analysis.TrafficQualityFilter) (*ad_analysis.AdAnalysisTrafficQualityResponse, error) {
	return &ad_analysis.AdAnalysisTrafficQualityResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		SummaryCards: []map[string]any{
			{"label": "高风险活动", "value": "0"},
		},
		Items: []map[string]any{
			{"campaign_name": "Camp1", "risk_level": "正常"},
		},
	}, nil
}

type stage4BRpaStore struct{}

func (s *stage4BRpaStore) GetReportStatusForDate(_ context.Context, _, country, _ string, _ bool) (*rpa_reports.RpaReportStatusResponse, error) {
	return &rpa_reports.RpaReportStatusResponse{
		Country: country,
		Items: []rpa_reports.ProjectReportStatus{
			{
				ProjectID:   7,
				ProjectName: "US Project",
				Country:     country,
				Statuses: []rpa_reports.ReportTypeStatus{
					{ReportType: "ad_campaign_report", HasData: true, IsUploaded: true},
				},
			},
		},
	}, nil
}

type stage4BAdUploadStore struct{}

func (s *stage4BAdUploadStore) Recognize(_ context.Context, filename string, _ []byte, country, _ string, _ bool) (*ad_upload.AdUploadRecognitionResponse, error) {
	return &ad_upload.AdUploadRecognitionResponse{
		TempFileID:       "tmp_stage4b",
		OriginalFilename: filename,
		Extension:        ".csv",
		ReportType:       "ad_campaign_report",
		ReportLabel:      "广告活动",
		Status:           "recognized",
		Country:          country,
		ProjectMatch: ad_upload.AdUploadProjectMatchSummary{
			Status: "matched",
		},
	}, nil
}
func (s *stage4BAdUploadStore) Commit(_ context.Context, req ad_upload.AdUploadCommitRequest, _ string, _ bool) (*ad_upload.AdUploadCommitResponse, error) {
	start := "2026-10-10"
	return &ad_upload.AdUploadCommitResponse{
		ID:              99,
		ReportType:      req.ReportType,
		ReportLabel:     "广告活动",
		IngestionStatus: "saved",
		ProjectName:     "Test Project",
		Country:         req.Country,
		ReportStartDate: start,
		ReportEndDate:   start,
		FileID:          req.TempFileID,
		FilePath:        "/tmp/test.csv",
		Version:         1,
		IsCurrent:       true,
		Message:         "入库成功",
	}, nil
}
func (s *stage4BAdUploadStore) ListStatus(_ context.Context, filter ad_upload.AdUploadStatusFilter) (*ad_upload.AdUploadStatusResponse, error) {
	return &ad_upload.AdUploadStatusResponse{
		Country: filter.Country,
		Items: []ad_upload.AdUploadStatusItem{
			{ID: 99, ProjectName: "Test Project", ReportType: "ad_campaign_report"},
		},
	}, nil
}

type stage4BInternalAdDataStore struct {
	forbiddenProjectID int64
}

func (s *stage4BInternalAdDataStore) VerifyProjectAccess(_ context.Context, projectID int64, _ string, isAdmin bool) error {
	if !isAdmin && projectID == s.forbiddenProjectID {
		return internal_ad_data.ErrProjectForbidden
	}
	if projectID == 404 {
		return internal_ad_data.ErrProjectNotFound
	}
	return nil
}
func (s *stage4BInternalAdDataStore) ListAdUploadFiles(_ context.Context, _ int64, _, country *string, _ bool, _, _ int) ([]internal_ad_data.AdUploadFileItem, error) {
	c := "US"
	if country != nil {
		c = *country
	}
	return []internal_ad_data.AdUploadFileItem{
		{FileID: 10, ReportType: "ad_campaign_report", Country: c, IsCurrent: true},
	}, nil
}
func (s *stage4BInternalAdDataStore) QueryRaw(_ context.Context, filter internal_ad_data.RawQueryFilter) (*internal_ad_data.RawResponse, error) {
	return &internal_ad_data.RawResponse{
		ProjectID: filter.ProjectID,
		Period:    internal_ad_data.PeriodInfo{Type: "relative", Value: "7d", StartDate: "2026-10-01", EndDate: "2026-10-07"},
		Country:   filter.Country,
		Data:      []map[string]any{{"campaign_name": "Test Camp", "spend": 10.5}},
		Summary:   internal_ad_data.RawSummary{TotalRows: 1, DateRange: []string{"2026-10-01", "2026-10-07"}},
	}, nil
}

func TestStage4BContract(t *testing.T) {
	router := chi.NewRouter()
	auditor := &stage4BAuditor{}

	authMiddleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			identity := auth.UserContextFromRequest(r)
			ctx := auth.WithUserContext(r.Context(), identity)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}

	adAnalysisStore := &stage4BAdAnalysisStore{forbiddenProjectID: 99}
	rpaStore := &stage4BRpaStore{}
	adUploadStore := &stage4BAdUploadStore{}
	internalDataStore := &stage4BInternalAdDataStore{forbiddenProjectID: 99}

	ad_analysis.NewRegistrar(adAnalysisStore, auditor).RegisterRoutes(router, authMiddleware)
	rpa_reports.NewRegistrar(rpaStore, auditor).RegisterRoutes(router, authMiddleware)
	ad_upload.NewRegistrar(adUploadStore, auditor).RegisterRoutes(router, authMiddleware)
	internal_ad_data.NewRegistrar(internalDataStore, auditor).RegisterRoutes(router, authMiddleware)

	adminReq := func(method, path string, body string) *http.Request {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("X-API-Key", "test-key")
		req.Header.Set("X-User-Name", "admin")
		req.Header.Set("X-Is-Admin", "true")
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		return req
	}

	userReq := func(method, path string, body string) *http.Request {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("X-API-Key", "test-key")
		req.Header.Set("X-User-Name", "alice")
		req.Header.Set("X-Operator", "alice")
		req.Header.Set("X-Is-Admin", "false")
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		return req
	}

	// 1. ad_analysis 10 endpoints
	adEndpoints := []string{
		"/api/v1/ad-analysis/overview?project_id=1&country=US",
		"/api/v1/ad-analysis/campaigns?project_id=1&country=US",
		"/api/v1/ad-analysis/products?project_id=1&country=US",
		"/api/v1/ad-analysis/time-trend?project_id=1&country=US",
		"/api/v1/ad-analysis/purchased-products?project_id=1&country=US",
		"/api/v1/ad-analysis/search-terms?project_id=1&country=US",
		"/api/v1/ad-analysis/targets?project_id=1&country=US",
		"/api/v1/ad-analysis/budget?project_id=1&country=US",
		"/api/v1/ad-analysis/placements?project_id=1&country=US",
		"/api/v1/ad-analysis/traffic-quality?project_id=1&country=US",
	}
	for _, ep := range adEndpoints {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, adminReq(http.MethodGet, ep, ""))
		if rec.Code != http.StatusOK {
			t.Fatalf("endpoint %s failed with %d: %s", ep, rec.Code, rec.Body.String())
		}
		var m map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
			t.Fatalf("endpoint %s invalid json: %v", ep, err)
		}
		if strings.Contains(rec.Body.String(), `"projectId"`) || strings.Contains(rec.Body.String(), `"summaryCards"`) {
			t.Fatalf("endpoint %s returned camelCase response: %s", ep, rec.Body.String())
		}
	}

	// ad_analysis 403 Forbidden check
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, userReq(http.MethodGet, "/api/v1/ad-analysis/overview?project_id=99&country=US", ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden on unauthorized project, got %d", rec.Code)
	}

	// 2. rpa_reports endpoint
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, adminReq(http.MethodGet, "/api/v1/rpa-reports/status?report_date=2026-10-10&country=US", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("rpa status failed with %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"report_type"`) || strings.Contains(rec.Body.String(), `"reportType"`) {
		t.Fatalf("rpa status schema mismatch: %s", rec.Body.String())
	}

	// 3. ad_upload endpoints
	// recognize
	var uploadBuf bytes.Buffer
	mw := multipart.NewWriter(&uploadBuf)
	part, _ := mw.CreateFormFile("file", "test.csv")
	_, _ = part.Write([]byte("开始日期,结束日期,广告活动名称,预算,定位类型,竞价策略\n"))
	_ = mw.Close()
	uploadReq := httptest.NewRequest(http.MethodPost, "/api/v1/ad-upload/recognize", &uploadBuf)
	uploadReq.Header.Set("Content-Type", mw.FormDataContentType())
	uploadReq.Header.Set("X-API-Key", "test-key")
	uploadReq.Header.Set("X-Is-Admin", "true")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, uploadReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("ad-upload/recognize failed with %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"temp_file_id"`) || strings.Contains(rec.Body.String(), `"tempFileId"`) {
		t.Fatalf("ad-upload/recognize schema mismatch: %s", rec.Body.String())
	}

	// commit (and verify audit logging)
	commitPayload := `{"temp_file_id":"tmp_stage4b","report_type":"ad_campaign_report","project_name":"Test Project","country":"US"}`
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, adminReq(http.MethodPost, "/api/v1/ad-upload/commit", commitPayload))
	if rec.Code != http.StatusOK {
		t.Fatalf("ad-upload/commit failed with %d: %s", rec.Code, rec.Body.String())
	}
	if len(auditor.entries) != 1 || auditor.entries[0].Action != "ad_upload.commit" {
		t.Fatalf("expected audit log for ad_upload.commit, got: %#v", auditor.entries)
	}

	// status
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, adminReq(http.MethodGet, "/api/v1/ad-upload/status?country=US", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("ad-upload/status failed with %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"items"`) {
		t.Fatalf("ad-upload/status schema mismatch: %s", rec.Body.String())
	}

	// 4. internal_ad_data endpoints
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, adminReq(http.MethodGet, "/api/v1/internal/ad-data", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("internal/ad-data root failed: %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, adminReq(http.MethodGet, "/api/v1/internal/ad-data/projects/1/ad-upload-files", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("internal/ad-data upload files failed: %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"file_id"`) || strings.Contains(rec.Body.String(), `"fileId"`) {
		t.Fatalf("upload files schema mismatch: %s", rec.Body.String())
	}

	rawEndpoints := []string{
		"/api/v1/internal/ad-data/projects/1/ad-campaigns-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-search-terms-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-budgets-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-targets-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-placements-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-promoted-products-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-time-trends-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-search-term-shares-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-invalid-traffic-raw?period=7d",
		"/api/v1/internal/ad-data/projects/1/ad-purchased-products-raw?period=7d",
	}
	for _, rawEP := range rawEndpoints {
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, adminReq(http.MethodGet, rawEP, ""))
		if rec.Code != http.StatusOK {
			t.Fatalf("raw endpoint %s failed with %d: %s", rawEP, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `"total_rows"`) || strings.Contains(rec.Body.String(), `"totalRows"`) {
			t.Fatalf("raw endpoint %s schema mismatch: %s", rawEP, rec.Body.String())
		}
	}
}
