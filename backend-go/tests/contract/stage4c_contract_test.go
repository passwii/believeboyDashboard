package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/category_research"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/platform_revenues"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/report_reconciliation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/return_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/vat_invoices"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

// ---------------------------------------------------------------------------
// Mock Stores for Stage 4C
// ---------------------------------------------------------------------------

type stage4CPlatformRevenueStore struct{}

func (s *stage4CPlatformRevenueStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (s *stage4CPlatformRevenueStore) AccessibleProjectIDs(context.Context, string) ([]int64, error) {
	return []int64{1}, nil
}
func (s *stage4CPlatformRevenueStore) ListRevenues(context.Context, platform_revenues.PlatformRevenueFilter) ([]platform_revenues.PlatformRevenueItem, int, error) {
	return []platform_revenues.PlatformRevenueItem{
		{ID: 1, ProjectID: 1, ProjectName: "Project A", Country: "US", Amount: 100.0, Currency: "USD", RevenueType: "订单回款"},
	}, 1, nil
}
func (s *stage4CPlatformRevenueStore) GetRevenue(context.Context, int64, string, bool) (*platform_revenues.PlatformRevenueItem, error) {
	return &platform_revenues.PlatformRevenueItem{ID: 1, ProjectID: 1, ProjectName: "Project A", Country: "US", Amount: 100.0, Currency: "USD"}, nil
}
func (s *stage4CPlatformRevenueStore) CreateRevenue(_ context.Context, payload platform_revenues.PlatformRevenueCreate, _ string, _ bool) (*platform_revenues.PlatformRevenueItem, error) {
	return &platform_revenues.PlatformRevenueItem{
		ID: 1, ProjectID: payload.ProjectID, ProjectName: "Project A", Country: payload.Country, Amount: payload.Amount, Currency: payload.Currency,
	}, nil
}
func (s *stage4CPlatformRevenueStore) UpdateRevenue(_ context.Context, revenueID int64, _ platform_revenues.PlatformRevenueUpdate, _ string, _ bool) (*platform_revenues.PlatformRevenueItem, error) {
	return &platform_revenues.PlatformRevenueItem{ID: revenueID, ProjectID: 1, ProjectName: "Project A", Country: "US", Amount: 150.0}, nil
}
func (s *stage4CPlatformRevenueStore) DeleteRevenue(context.Context, int64, string, bool) error {
	return nil
}
func (s *stage4CPlatformRevenueStore) GetProjectCountries(context.Context, int64) ([]string, error) {
	return []string{"CA", "US"}, nil
}
func (s *stage4CPlatformRevenueStore) SavePaymentScreenshot(context.Context, string, string, string, []byte) (*platform_revenues.UploadImageResponse, error) {
	return &platform_revenues.UploadImageResponse{ID: "img-1", URL: "https://r2/img.webp", Filename: "slip.png", Size: 100}, nil
}

type stage4CVatStore struct{}

func (s *stage4CVatStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (s *stage4CVatStore) EnsureVatEnabled(context.Context, int64) error { return nil }
func (s *stage4CVatStore) ListEntities(context.Context, int64) ([]vat_invoices.VatEntityResponse, error) {
	return []vat_invoices.VatEntityResponse{
		{ID: 1, ProjectID: 1, VatEntityBase: vat_invoices.VatEntityBase{Country: "DE", CompanyName: "Seller DE"}},
	}, nil
}
func (s *stage4CVatStore) UpsertEntity(_ context.Context, payload vat_invoices.VatEntityCreate) (*vat_invoices.VatEntityResponse, error) {
	return &vat_invoices.VatEntityResponse{ID: 1, ProjectID: payload.ProjectID, VatEntityBase: payload.VatEntityBase}, nil
}
func (s *stage4CVatStore) UpdateEntity(_ context.Context, entityID int64, _ vat_invoices.VatEntityUpdate) (*vat_invoices.VatEntityResponse, error) {
	return &vat_invoices.VatEntityResponse{ID: entityID, ProjectID: 1, VatEntityBase: vat_invoices.VatEntityBase{Country: "DE", CompanyName: "Updated"}}, nil
}
func (s *stage4CVatStore) DeleteEntity(context.Context, int64) error { return nil }
func (s *stage4CVatStore) GetEntity(_ context.Context, entityID int64) (*vat_invoices.VatEntityResponse, error) {
	return &vat_invoices.VatEntityResponse{ID: entityID, ProjectID: 1, VatEntityBase: vat_invoices.VatEntityBase{Country: "DE", CompanyName: "Seller DE"}}, nil
}
func (s *stage4CVatStore) ListInvoices(context.Context, vat_invoices.VatInvoiceFilter) ([]vat_invoices.VatInvoiceListItem, error) {
	return []vat_invoices.VatInvoiceListItem{
		{ID: 10, InvoiceNo: "INV-DE-2026-000010", ProjectID: 1, Currency: "EUR", TotalIncl: "119.00", Status: "draft"},
	}, nil
}
func (s *stage4CVatStore) GetInvoice(_ context.Context, invoiceID int64) (*vat_invoices.VatInvoiceResponse, error) {
	url := "https://r2/inv.pdf"
	return &vat_invoices.VatInvoiceResponse{
		ID: invoiceID, InvoiceNo: "INV-DE-2026-000010", ProjectID: 1, Currency: "EUR", TotalIncl: "119.00", R2URL: &url, Status: "issued",
	}, nil
}
func (s *stage4CVatStore) CreateInvoice(_ context.Context, payload vat_invoices.VatInvoiceCreate, _ string) (*vat_invoices.VatInvoiceResponse, error) {
	return &vat_invoices.VatInvoiceResponse{
		ID: 10, InvoiceNo: "INV-DE-2026-000010", ProjectID: payload.ProjectID, Currency: payload.Currency, TotalIncl: "119.00", Status: "draft",
	}, nil
}
func (s *stage4CVatStore) AttachInvoicePdf(_ context.Context, invoiceID int64, _ string, _ []byte) (*vat_invoices.VatInvoicePdfUploadResponse, error) {
	return &vat_invoices.VatInvoicePdfUploadResponse{
		ID: invoiceID, InvoiceNo: "INV-DE-2026-000010", R2Key: "key", R2URL: "https://r2/inv.pdf", Status: "issued",
	}, nil
}
func (s *stage4CVatStore) VoidInvoice(_ context.Context, invoiceID int64, reason string) (*vat_invoices.VatInvoiceResponse, error) {
	return &vat_invoices.VatInvoiceResponse{
		ID: invoiceID, InvoiceNo: "INV-DE-2026-000010", ProjectID: 1, Status: "voided", VoidReason: &reason,
	}, nil
}

type stage4CReconStore struct{}

func (s *stage4CReconStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (s *stage4CReconStore) GetReportProjectID(context.Context, int64) (int64, error) {
	return 1, nil
}
func (s *stage4CReconStore) GetAvailableReports(context.Context, report_reconciliation.AvailableReportsFilter) ([]report_reconciliation.AvailableReportItem, error) {
	return []report_reconciliation.AvailableReportItem{
		{ReportID: 1, ProjectName: "Project A", Country: "US", ReportMonth: "2026-05", Status: "success", Pt3CalculationComplete: true},
	}, nil
}
func (s *stage4CReconStore) AutoReconcile(context.Context, report_reconciliation.AutoReconcileRequest, string, bool) (*report_reconciliation.ReconcileResultResponse, error) {
	recID := int64(100)
	return &report_reconciliation.ReconcileResultResponse{
		TotalItems: 9, MatchedItems: 9, MatchRate: 100.0, RecordID: &recID,
	}, nil
}
func (s *stage4CReconStore) GetReconciliationHistory(context.Context, report_reconciliation.HistoryFilter) ([]report_reconciliation.ReconciliationRecordResponse, error) {
	return []report_reconciliation.ReconciliationRecordResponse{
		{ID: 100, ReportID: 1, ProjectName: "Project A", Country: "US", ReportMonth: "2026-05", MatchRate: 100.0, Mode: "auto"},
	}, nil
}
func (s *stage4CReconStore) ManualReconcile(context.Context, *int64, []byte, []byte, float64, string, bool) (map[string]any, error) {
	return map[string]any{"matched_items": 9, "match_rate": 100.0}, nil
}
func (s *stage4CReconStore) UploadSummaryPdf(context.Context, int64, string, []byte, string, bool) (*report_reconciliation.PDFUploadResponse, error) {
	return &report_reconciliation.PDFUploadResponse{ReportID: 1, PdfFileID: "pdf-id", PdfFilePath: "https://r2/pdf", Message: "PDF uploaded to R2 successfully"}, nil
}
func (s *stage4CReconStore) UploadTransactionCsv(context.Context, int64, string, []byte, string, bool) (*report_reconciliation.CSVUploadResponse, error) {
	return &report_reconciliation.CSVUploadResponse{ReportID: 1, CsvFileID: "csv-id", CsvFilePath: "https://r2/csv", Message: "CSV uploaded to R2 successfully"}, nil
}
func (s *stage4CReconStore) ExportPt3Data(context.Context, int64, string, bool) (string, []byte, error) {
	return "pt3.xlsx", []byte("excel-data"), nil
}
func (s *stage4CReconStore) DownloadPdf(context.Context, int64, string, bool) (string, []byte, error) {
	return "summary.pdf", []byte("%PDF-1.4 sample"), nil
}
func (s *stage4CReconStore) DownloadCsv(context.Context, int64, string, bool) (string, []byte, error) {
	return "tx.csv", []byte("date,order_id\n"), nil
}

type stage4CReturnStore struct{}

func (s *stage4CReturnStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (s *stage4CReturnStore) GetReturnAnalysis(context.Context, return_analysis.ReturnAnalysisFilter) (*return_analysis.ReturnAnalysisResponse, error) {
	return &return_analysis.ReturnAnalysisResponse{
		ProjectID: 1, ProjectName: "Project A", Country: "US", StartDate: "2026-10-01", EndDate: "2026-10-31",
		Summary:     return_analysis.ReturnAnalysisSummary{TotalReturns: 5, TotalQuantity: 5, OverallReturnRate: 1.5, DataAvailable: true},
		SummaryText: "表现稳定",
	}, nil
}
func (s *stage4CReturnStore) GetRawRows(context.Context, return_analysis.ReturnAnalysisFilter, int) ([]return_analysis.ReturnRawRowItem, error) {
	return []return_analysis.ReturnRawRowItem{
		{ReturnDate: "2026-10-15", OrderID: "111", SKU: "SKU-1", Quantity: 1, Reason: "DEFECTIVE", ReasonDisplay: "有缺陷"},
	}, nil
}

type stage4CCategoryStore struct{}

func (s *stage4CCategoryStore) ListDatasets(context.Context, category_research.CategoryResearchFilter) ([]category_research.CategoryResearchDatasetItem, error) {
	return []category_research.CategoryResearchDatasetItem{
		{ID: 1, Marketplace: "US", CategoryKeywordEn: "stand", CategoryNameZh: "支架", Version: 1, IsCurrent: true},
	}, nil
}
func (s *stage4CCategoryStore) GetDataset(context.Context, int64) (*category_research.CategoryResearchDatasetItem, error) {
	return &category_research.CategoryResearchDatasetItem{ID: 1, Marketplace: "US", CategoryKeywordEn: "stand", CategoryNameZh: "支架"}, nil
}
func (s *stage4CCategoryStore) ImportDataset(context.Context, string, string, string, string, []byte, string) (*category_research.CategoryResearchImportResponse, error) {
	return &category_research.CategoryResearchImportResponse{DatasetID: 1, Version: 1, IsCurrent: true}, nil
}
func (s *stage4CCategoryStore) GetDatasetOverview(context.Context, int64, string, string) (*category_research.CategoryResearchOverviewResponse, error) {
	return &category_research.CategoryResearchOverviewResponse{
		Dataset: category_research.CategoryResearchDatasetItem{ID: 1, Marketplace: "US", CategoryKeywordEn: "stand"},
		Kpis:    category_research.CategoryResearchOverviewKpis{SampleCount: 100, AveragePriceUsd: 19.99},
	}, nil
}
func (s *stage4CCategoryStore) RecomputeDataset(context.Context, int64) (*category_research.CategoryResearchRecomputeResponse, error) {
	return &category_research.CategoryResearchRecomputeResponse{DatasetID: 1, RowCountProducts: 100}, nil
}
func (s *stage4CCategoryStore) BatchRecomputeDatasets(context.Context, *string, *string, bool) (*category_research.CategoryResearchBatchRecomputeResponse, error) {
	return &category_research.CategoryResearchBatchRecomputeResponse{Matched: 1, Recomputed: 1, DatasetIDs: []int64{1}}, nil
}
func (s *stage4CCategoryStore) ListProducts(context.Context, category_research.CategoryResearchProductsFilter) ([]category_research.CategoryResearchProductRow, bool, error) {
	return []category_research.CategoryResearchProductRow{
		{ID: 1, ASIN: stringPointer("B001"), Brand: stringPointer("Brand A"), MonthlySales: 500},
	}, false, nil
}
func (s *stage4CCategoryStore) UpsertManualDimensions(context.Context, int64, []category_research.CategoryResearchManualDimensionUpsertItem) (int, error) {
	return 1, nil
}
func (s *stage4CCategoryStore) GetTrend(context.Context, int64, string) ([]category_research.CategoryResearchTrendPoint, error) {
	return []category_research.CategoryResearchTrendPoint{{YearMonth: "2026-05", MonthlySales: 200}}, nil
}
func (s *stage4CCategoryStore) GetMarketTrend(context.Context, int64, int) ([]category_research.CategoryResearchMarketTrendPoint, error) {
	return []category_research.CategoryResearchMarketTrendPoint{{YearMonth: "2026-05", MonthlySales: 10000}}, nil
}
func (s *stage4CCategoryStore) ListExports(context.Context, int64) ([]category_research.CategoryResearchExportItem, error) {
	return []category_research.CategoryResearchExportItem{{Key: "overview", Label: "概览", Filename: "overview.xlsx", Available: true}}, nil
}
func (s *stage4CCategoryStore) GetExportData(context.Context, int64, string, string, string) (string, []byte, error) {
	return "overview.xlsx", []byte("excel-bytes"), nil
}

func stringPointer(s string) *string { return &s }

// ---------------------------------------------------------------------------
// Main Stage 4C Contract Test Suite
// ---------------------------------------------------------------------------

func TestStage4CAllModulesContracts(t *testing.T) {
	passthrough := func(next http.Handler) http.Handler { return next }

	router := chi.NewRouter()
	platform_revenues.NewRegistrar(&stage4CPlatformRevenueStore{}, nil).RegisterRoutes(router, passthrough)
	vat_invoices.NewRegistrar(&stage4CVatStore{}, nil).RegisterRoutes(router, passthrough)
	report_reconciliation.NewRegistrar(&stage4CReconStore{}, nil).RegisterRoutes(router, passthrough)
	return_analysis.NewRegistrar(&stage4CReturnStore{}, nil).RegisterRoutes(router, passthrough)
	category_research.NewRegistrar(&stage4CCategoryStore{}, nil).RegisterRoutes(router, passthrough)

	adminCtx := auth.WithUserContext(context.Background(), auth.UserContext{Operator: "admin", IsAdmin: true})

	// 1. Platform Revenues Contracts
	{
		// List
		req := httptest.NewRequest(http.MethodGet, "/api/v1/platform-revenues?page=1&page_size=20", nil).WithContext(adminCtx)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("platform-revenues list: expected 200, got %d", rec.Code)
		}

		// Create
		createB, _ := json.Marshal(platform_revenues.PlatformRevenueCreate{
			ProjectID: 1, Country: "US", ReceivedDate: "2026-11-08", Amount: 500.0, Currency: "USD", RevenueType: "订单回款",
		})
		req = httptest.NewRequest(http.MethodPost, "/api/v1/platform-revenues", bytes.NewReader(createB)).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("platform-revenues create: expected 201, got %d", rec.Code)
		}

		// Get Countries
		req = httptest.NewRequest(http.MethodGet, "/api/v1/platform-revenues/project-countries/1", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("platform-revenues countries: expected 200, got %d", rec.Code)
		}
	}

	// 2. VAT Invoices Contracts
	{
		// Entities list
		req := httptest.NewRequest(http.MethodGet, "/api/v1/vat-entities?project_id=1", nil).WithContext(adminCtx)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("vat-entities list: expected 200, got %d", rec.Code)
		}

		// Invoices list
		req = httptest.NewRequest(http.MethodGet, "/api/v1/vat-invoices?project_id=1", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("vat-invoices list: expected 200, got %d", rec.Code)
		}

		// Invoice PDF redirect
		req = httptest.NewRequest(http.MethodGet, "/api/v1/vat-invoices/10/pdf", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusFound {
			t.Fatalf("vat-invoices pdf: expected 302, got %d", rec.Code)
		}
	}

	// 3. Report Reconciliation Contracts
	{
		// Available reports
		req := httptest.NewRequest(http.MethodGet, "/api/v1/report-reconciliation/available-reports", nil).WithContext(adminCtx)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("recon available-reports: expected 200, got %d", rec.Code)
		}

		// Auto reconcile
		autoB, _ := json.Marshal(report_reconciliation.AutoReconcileRequest{ReportID: 1, Tolerance: 0.01})
		req = httptest.NewRequest(http.MethodPost, "/api/v1/report-reconciliation/auto-reconcile", bytes.NewReader(autoB)).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("recon auto-reconcile: expected 200, got %d", rec.Code)
		}

		// History
		req = httptest.NewRequest(http.MethodGet, "/api/v1/report-reconciliation/history", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("recon history: expected 200, got %d", rec.Code)
		}

		// Export PT3
		req = httptest.NewRequest(http.MethodGet, "/api/v1/report-reconciliation/reports/1/export-pt3", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("recon export-pt3: expected 200, got %d", rec.Code)
		}
	}

	// 4. Return Analysis Contracts
	{
		// Return analysis
		req := httptest.NewRequest(http.MethodGet, "/api/v1/return-analysis?project_id=1&start_date=2026-10-01&end_date=2026-10-31", nil).WithContext(adminCtx)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("return-analysis: expected 200, got %d", rec.Code)
		}

		// Raw rows
		req = httptest.NewRequest(http.MethodGet, "/api/v1/return-analysis/raw-rows?project_id=1&start_date=2026-10-01&end_date=2026-10-31", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("return-analysis raw-rows: expected 200, got %d", rec.Code)
		}
	}

	// 5. Category Research Contracts
	{
		// Datasets
		req := httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets", nil).WithContext(adminCtx)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("category datasets: expected 200, got %d", rec.Code)
		}

		// Overview
		req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("category overview: expected 200, got %d", rec.Code)
		}

		// Products
		req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/products?page=1&page_size=50", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("category products: expected 200, got %d", rec.Code)
		}

		// Trend
		req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/trend?asin=B001", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("category trend: expected 200, got %d", rec.Code)
		}

		// Market Trend
		req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/market-trend?months=24", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("category market-trend: expected 200, got %d", rec.Code)
		}

		// Exports
		req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/exports", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("category exports: expected 200, got %d", rec.Code)
		}

		// Download Export
		req = httptest.NewRequest(http.MethodGet, "/api/v1/category-research/datasets/1/exports/overview", nil).WithContext(adminCtx)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("category download export: expected 200, got %d", rec.Code)
		}
	}
}
