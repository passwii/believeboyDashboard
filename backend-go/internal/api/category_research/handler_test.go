package category_research

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockCategoryStore struct {
	datasets      []CategoryResearchDatasetItem
	importResp    *CategoryResearchImportResponse
	overview      *CategoryResearchOverviewResponse
	recomputeResp *CategoryResearchRecomputeResponse
	batchResp     *CategoryResearchBatchRecomputeResponse
	products      []CategoryResearchProductRow
	hasNext       bool
	updatedCount  int
	trends        []CategoryResearchTrendPoint
	marketTrends  []CategoryResearchMarketTrendPoint
	exports       []CategoryResearchExportItem

	getDatasetErr    error
	importedFilename string
}

func (m *mockCategoryStore) ListDatasets(_ context.Context, _ CategoryResearchFilter) ([]CategoryResearchDatasetItem, error) {
	return m.datasets, nil
}
func (m *mockCategoryStore) GetDataset(_ context.Context, _ int64) (*CategoryResearchDatasetItem, error) {
	if m.getDatasetErr != nil {
		return nil, m.getDatasetErr
	}
	return &CategoryResearchDatasetItem{ID: 1, CategoryKeywordEn: "keyboard"}, nil
}
func (m *mockCategoryStore) ImportDataset(_ context.Context, _ string, _ string, _ string, filename string, _ []byte, _ string) (*CategoryResearchImportResponse, error) {
	m.importedFilename = filename
	return m.importResp, nil
}
func (m *mockCategoryStore) GetDatasetOverview(_ context.Context, _ int64, _ string, _ string) (*CategoryResearchOverviewResponse, error) {
	if m.getDatasetErr != nil {
		return nil, m.getDatasetErr
	}
	return m.overview, nil
}
func (m *mockCategoryStore) RecomputeDataset(_ context.Context, _ int64) (*CategoryResearchRecomputeResponse, error) {
	if m.getDatasetErr != nil {
		return nil, m.getDatasetErr
	}
	return m.recomputeResp, nil
}
func (m *mockCategoryStore) BatchRecomputeDatasets(_ context.Context, _ *string, _ *string, _ bool) (*CategoryResearchBatchRecomputeResponse, error) {
	return m.batchResp, nil
}
func (m *mockCategoryStore) ListProducts(_ context.Context, _ CategoryResearchProductsFilter) ([]CategoryResearchProductRow, bool, error) {
	if m.getDatasetErr != nil {
		return nil, false, m.getDatasetErr
	}
	return m.products, m.hasNext, nil
}
func (m *mockCategoryStore) UpsertManualDimensions(_ context.Context, _ int64, _ []CategoryResearchManualDimensionUpsertItem) (int, error) {
	if m.getDatasetErr != nil {
		return 0, m.getDatasetErr
	}
	return m.updatedCount, nil
}
func (m *mockCategoryStore) GetTrend(_ context.Context, _ int64, _ string) ([]CategoryResearchTrendPoint, error) {
	if m.getDatasetErr != nil {
		return nil, m.getDatasetErr
	}
	return m.trends, nil
}
func (m *mockCategoryStore) GetMarketTrend(_ context.Context, _ int64, _ int) ([]CategoryResearchMarketTrendPoint, error) {
	if m.getDatasetErr != nil {
		return nil, m.getDatasetErr
	}
	return m.marketTrends, nil
}
func (m *mockCategoryStore) ListExports(_ context.Context, _ int64) ([]CategoryResearchExportItem, error) {
	if m.getDatasetErr != nil {
		return nil, m.getDatasetErr
	}
	return m.exports, nil
}
func (m *mockCategoryStore) GetExportData(_ context.Context, _ int64, _ string, _ string, _ string) (string, []byte, error) {
	if m.getDatasetErr != nil {
		return "", nil, m.getDatasetErr
	}
	return "export.xlsx", []byte("excel-data"), nil
}

type mockCategoryAuditor struct{}

func (a *mockCategoryAuditor) LogAction(_ context.Context, _ audit.Entry) error { return nil }
func (a *mockCategoryAuditor) LogActionTx(_ context.Context, _ pgx.Tx, _ audit.Entry) error {
	return nil
}
func (a *mockCategoryAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

func setupCategoryRouter(store Store) chi.Router {
	r := chi.NewRouter()
	registrar := NewRegistrar(store, &mockCategoryAuditor{})
	registrar.RegisterRoutes(r, func(next http.Handler) http.Handler { return next })
	return r
}

func TestCategoryResearchHandler(t *testing.T) {
	store := &mockCategoryStore{
		datasets: []CategoryResearchDatasetItem{
			{ID: 1, Marketplace: "US", CategoryKeywordEn: "yoga mat", CategoryNameZh: "瑜伽垫"},
		},
		importResp: &CategoryResearchImportResponse{
			DatasetID:        1,
			Version:          1,
			IsCurrent:        true,
			RowCountProducts: 50,
			RowCountTrends:   100,
		},
		overview: &CategoryResearchOverviewResponse{
			Dataset: CategoryResearchDatasetItem{ID: 1, CategoryKeywordEn: "yoga mat"},
			Kpis:    CategoryResearchOverviewKpis{SampleCount: 50},
		},
		recomputeResp: &CategoryResearchRecomputeResponse{
			DatasetID:        1,
			RowCountProducts: 50,
		},
		batchResp: &CategoryResearchBatchRecomputeResponse{
			Matched:    1,
			Recomputed: 1,
			DatasetIDs: []int64{1},
		},
		products: []CategoryResearchProductRow{
			{ID: 10, ASIN: stringPointer("B001"), Brand: stringPointer("BrandX"), MonthlySales: 200},
		},
		trends: []CategoryResearchTrendPoint{
			{YearMonth: "2026-05", MonthlySales: 100},
		},
		marketTrends: []CategoryResearchMarketTrendPoint{
			{YearMonth: "2026-05", MonthlySales: 5000},
		},
		exports: []CategoryResearchExportItem{
			{Key: "overview", Label: "Overview", Filename: "overview.xlsx", Format: "xlsx", Available: true},
		},
	}
	router := setupCategoryRouter(store)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "admin", IsAdmin: true})

	// 1. List datasets
	req := httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets", nil).WithContext(adminCtx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 2. Import dataset
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	part, _ := w.CreateFormFile("file", "data.xlsx")
	part.Write([]byte("fake data"))
	_ = w.WriteField("category_keyword_en", "yoga mat")
	_ = w.WriteField("category_name_zh", "瑜伽垫")
	_ = w.WriteField("marketplace", "US")
	w.Close()

	req = httptest.NewRequest(http.MethodPost, "/api/v1/category-research/datasets/import", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if store.importedFilename != "data.xlsx" {
		t.Fatalf("imported filename = %q", store.importedFilename)
	}

	// 3. Get Overview
	req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 4. Products
	req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/products?page=1&page_size=50", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 5. Trend
	req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/trend?asin=B001", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 6. Market Trend
	req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/market-trend?months=24", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 7. Exports
	req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/exports", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// 8. Download Export
	req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/exports/overview", nil).WithContext(adminCtx)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestCategoryResearchImportRejectsUnsafeExtensionAndSanitizesPath(t *testing.T) {
	store := &mockCategoryStore{
		importResp: &CategoryResearchImportResponse{DatasetID: 1, Version: 1, IsCurrent: true},
	}
	router := setupCategoryRouter(store)
	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "admin", IsAdmin: true})

	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	part, _ := w.CreateFormFile("file", "../../report.txt")
	_, _ = part.Write([]byte("plain text"))
	_ = w.WriteField("category_keyword_en", "yoga mat")
	_ = w.WriteField("category_name_zh", "瑜伽垫")
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/category-research/datasets/import", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for .txt, got %d: %s", rec.Code, rec.Body.String())
	}

	b.Reset()
	w = multipart.NewWriter(&b)
	part, _ = w.CreateFormFile("file", "../../report.xlsx")
	_, _ = part.Write([]byte("workbook"))
	_ = w.WriteField("category_keyword_en", "yoga mat")
	_ = w.WriteField("category_name_zh", "瑜伽垫")
	_ = w.Close()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/category-research/datasets/import", &b).WithContext(adminCtx)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if store.importedFilename != "report.xlsx" {
		t.Fatalf("path not sanitized: %q", store.importedFilename)
	}
}

func stringPointer(s string) *string { return &s }
