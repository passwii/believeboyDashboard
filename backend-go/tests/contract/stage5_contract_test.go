package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/complaints"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/daily_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_ad_data"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_ledger"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/inventory_replenishment"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/new_product_calculations"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation_snapshots"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/return_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/rpa_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipment_schedules"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shop_calculation"
)

type stage5CredentialResolver struct {
	credential *agent.Credential
}

func (r *stage5CredentialResolver) ResolveAgentCredential(
	context.Context,
	string,
	string,
) (*agent.Credential, error) {
	return r.credential, nil
}

type stage5ProjectStore struct {
	items  []projects.ProjectItem
	shops  map[int64][]projects.ProjectShopItem
	filter struct {
		showInactive bool
	}
}

func (s *stage5ProjectStore) ListManage(
	context.Context,
	string,
	bool,
	bool,
) ([]projects.ProjectItem, error) {
	return s.items, nil
}

func (s *stage5ProjectStore) ListProjectShops(
	_ context.Context,
	projectID int64,
) ([]projects.ProjectShopItem, error) {
	return s.shops[projectID], nil
}

type stage5SalesStore struct{}

func (stage5SalesStore) GetDailyAnalysis(
	context.Context,
	int64,
	string,
	string,
	string,
	*string,
) (*daily_analysis.DailyAnalysisResponse, error) {
	return &daily_analysis.DailyAnalysisResponse{
		Console: daily_analysis.DailyAnalysisConsoleResponse{
			ProjectID:   1,
			ProjectName: "Project A",
			Country:     "US",
			StartDate:   "2026-11-01",
			EndDate:     "2026-11-07",
		},
		SummaryRows: []daily_analysis.DailyAnalysisSummaryRow{{
			Date: "2026-11-07", OrderQty: 3, SalesAmount: 99.5,
		}},
	}, nil
}

type stage5InventoryStore struct{}

func (stage5InventoryStore) GetInventoryAnalysis(
	context.Context,
	inventory_replenishment.ReplenishmentFilter,
) (inventory_replenishment.InventoryAnalysisResponse, error) {
	return inventory_replenishment.InventoryAnalysisResponse{
		Items: []inventory_replenishment.InventoryAnalysisItem{{
			ProjectID: 1, ProjectName: "Project A", Country: "US",
			SKU: "SKU-1", AvailableQty: 12, StockStatus: "in_stock",
		}},
		Summary: inventory_replenishment.InventoryAnalysisSummary{
			SKUCount: 1, TotalAvailableQty: 12,
		},
	}, nil
}

type stage5ReplenishmentStore struct {
	updated bool
	update  inventory_replenishment.InventoryReplenishmentSettingUpdate
}

func (s *stage5ReplenishmentStore) GetInventoryAnalysis(context.Context, inventory_replenishment.ReplenishmentFilter) (inventory_replenishment.InventoryAnalysisResponse, error) {
	return inventory_replenishment.InventoryAnalysisResponse{}, nil
}
func (s *stage5ReplenishmentStore) ListSnapshotOptions(context.Context, *int64, *string) ([]inventory_replenishment.InventorySnapshotOption, error) {
	return []inventory_replenishment.InventorySnapshotOption{}, nil
}
func (s *stage5ReplenishmentStore) ListAnalysis(context.Context, inventory_replenishment.ReplenishmentFilter) (inventory_replenishment.InventoryReplenishmentListResponse, error) {
	return inventory_replenishment.InventoryReplenishmentListResponse{
		Items: []inventory_replenishment.InventoryReplenishmentListItem{{
			ProjectID: 1, ProjectName: "Project A", SKU: "SKU-1", Country: "US",
		}},
		Total: 1, Page: 1, PageSize: 20,
	}, nil
}
func (s *stage5ReplenishmentStore) UpdateSetting(
	_ context.Context,
	projectID int64,
	sku string,
	update inventory_replenishment.InventoryReplenishmentSettingUpdate,
	_ string,
) (inventory_replenishment.InventoryReplenishmentSettingItem, error) {
	s.updated = true
	s.update = update
	return inventory_replenishment.InventoryReplenishmentSettingItem{
		ProjectID: projectID, SKU: sku, Country: "US", SafetyFactor: 1.5,
	}, nil
}
func (s *stage5ReplenishmentStore) ListShipments(context.Context, *int64, *string) (inventory_replenishment.InventoryReplenishmentShipmentResponse, error) {
	return inventory_replenishment.InventoryReplenishmentShipmentResponse{}, nil
}
func (s *stage5ReplenishmentStore) ListCalendar(context.Context, *int64, *string) (inventory_replenishment.CalendarResponse, error) {
	return inventory_replenishment.CalendarResponse{}, nil
}
func (s *stage5ReplenishmentStore) ListSeasonal(context.Context, *int64, *string) (inventory_replenishment.SeasonalReplenishmentListResponse, error) {
	return inventory_replenishment.SeasonalReplenishmentListResponse{}, nil
}
func (s *stage5ReplenishmentStore) ListSnapshots(context.Context, *int64, *string) ([]inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	return nil, nil
}
func (s *stage5ReplenishmentStore) CreateSnapshot(context.Context, int64, string, inventory_replenishment.CreateSnapshotRequest, string) (inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	return inventory_replenishment.InventoryReplenishmentSnapshotListItem{}, nil
}
func (s *stage5ReplenishmentStore) UpdateSnapshot(context.Context, int64, inventory_replenishment.UpdateSnapshotRequest, string) (*inventory_replenishment.InventoryReplenishmentSnapshotListItem, error) {
	return nil, nil
}
func (s *stage5ReplenishmentStore) DeleteSnapshot(context.Context, int64, string) (bool, error) {
	return false, nil
}
func (s *stage5ReplenishmentStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}

type stage5ReportStore struct{}

func (stage5ReportStore) GetReportStatusForDate(
	context.Context,
	string,
	string,
	string,
	bool,
) (*rpa_reports.RpaReportStatusResponse, error) {
	return &rpa_reports.RpaReportStatusResponse{
		Country: "US",
		Items: []rpa_reports.ProjectReportStatus{
			{ProjectID: 1, ProjectName: "Project A", Country: "US", Statuses: []rpa_reports.ReportTypeStatus{
				{ReportType: "inventory_report", HasData: true, IsUploaded: true},
			}},
			{ProjectID: 2, ProjectName: "Project B", Country: "US", Statuses: []rpa_reports.ReportTypeStatus{
				{ReportType: "inventory_report", HasData: false, IsUploaded: false},
			}},
		},
	}, nil
}

type stage5AdStore struct{}

func (stage5AdStore) QueryRaw(
	_ context.Context,
	filter internal_ad_data.RawQueryFilter,
) (*internal_ad_data.RawResponse, error) {
	return &internal_ad_data.RawResponse{
		ProjectID: filter.ProjectID,
		Country:   filter.Country,
		Data:      []map[string]any{{"campaign_name": "Campaign A"}},
		Summary:   internal_ad_data.RawSummary{TotalRows: 1},
	}, nil
}

type stage5ComplaintStore struct{}

func (stage5ComplaintStore) GetOverview(context.Context, string, *string) (complaints.OverviewResponse, error) {
	return complaints.OverviewResponse{}, nil
}

func (stage5ComplaintStore) ListComplaints(
	_ context.Context,
	filter complaints.ComplaintFilter,
) (complaints.ComplaintListResponse, error) {
	return complaints.ComplaintListResponse{
		Items: []complaints.ComplaintListItem{{
			ID: 9, ProjectID: 1, ProjectName: "Project A", Status: "pending",
		}},
		Total: 1, Page: filter.Page, PageSize: filter.PageSize,
	}, nil
}

type stage5AuditStore struct{}

func (stage5AuditStore) QueryAuditLogs(_ context.Context, targetType string, targetIDs []string, limit int) ([]agent.AuditItem, error) {
	return []agent.AuditItem{{
		ID: 1, Action: "shipment.create", Result: "success",
	}}, nil
}

type stage5LedgerStore struct{}

func (stage5LedgerStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (stage5LedgerStore) ListMonths(context.Context, int64, *string) (inventory_ledger.MonthsResponse, error) {
	return inventory_ledger.MonthsResponse{
		ProjectID: 1,
		Months:    []string{"2026-10-01", "2026-11-01"},
	}, nil
}
func (stage5LedgerStore) GetSnapshot(context.Context, int64, *string, string) (inventory_ledger.MonthlySnapshotResponse, error) {
	return inventory_ledger.MonthlySnapshotResponse{
		ReportMonth: "2026-11-01",
		SKUs:        []inventory_ledger.SkuMonthEom{{MSKU: "SKU-1", QtyEOM: 10}},
	}, nil
}
func (stage5LedgerStore) GetEvents(context.Context, int64, *string, string) (inventory_ledger.EventsResponse, error) {
	return inventory_ledger.EventsResponse{ReportMonth: "2026-11-01", SKUs: []inventory_ledger.SkuMonthEvents{}}, nil
}
func (stage5LedgerStore) GetClusters(context.Context, int64, *string, string) (inventory_ledger.ReceiptClustersResponse, error) {
	return inventory_ledger.ReceiptClustersResponse{ReportMonth: "2026-11-01", Clusters: []inventory_ledger.ReceiptCluster{}}, nil
}
func (stage5LedgerStore) GetLocationDetail(context.Context, int64, *string, string) (inventory_ledger.LocationDetailResponse, error) {
	return inventory_ledger.LocationDetailResponse{ReportMonth: "2026-11-01", Rows: []inventory_ledger.LocationDetail{}}, nil
}
func (stage5LedgerStore) GetTrend(context.Context, int64, *string) (inventory_ledger.TrendResponse, error) {
	return inventory_ledger.TrendResponse{ProjectID: 1, Months: []inventory_ledger.TrendMonthItem{{ReportMonth: "2026-11-01"}}}, nil
}
func (stage5LedgerStore) GetDetail(context.Context, int64, *string, string, *string, *string) (inventory_ledger.LedgerDetailResponse, error) {
	return inventory_ledger.LedgerDetailResponse{
		ReportMonth: "2026-11-01",
		Rows:        []inventory_ledger.LedgerDetailRow{{ID: 1, MSKU: "SKU-1", EventType: "receipts", Quantity: 3}},
	}, nil
}
func (stage5LedgerStore) GetSummary(context.Context, int64, *string, string, *string, *string) (inventory_ledger.LedgerSummaryResponse, error) {
	return inventory_ledger.LedgerSummaryResponse{ReportMonth: "2026-11-01", Rows: []inventory_ledger.LedgerSummaryRow{}}, nil
}
func (stage5LedgerStore) ListBatches(context.Context, int64, *string) (inventory_ledger.IngestBatchesResponse, error) {
	return inventory_ledger.IngestBatchesResponse{ProjectID: 1, Batches: []inventory_ledger.IngestBatchInfo{}}, nil
}
func (stage5LedgerStore) GetConsistency(context.Context, int64, *string, string) (inventory_ledger.ConsistencyCheckResult, error) {
	return inventory_ledger.ConsistencyCheckResult{ReportMonth: "2026-11-01", Status: "OK"}, nil
}
func (stage5LedgerStore) GetMonthAnalysis(context.Context, int64, *string, string) (inventory_ledger.LedgerMonthAnalysisResponse, error) {
	return inventory_ledger.LedgerMonthAnalysisResponse{ProjectID: 1, ReportMonth: "2026-11-01"}, nil
}

type stage5ShipmentStore struct {
	created    bool
	updated    bool
	deleted    bool
	calculated bool
}

func (s *stage5ShipmentStore) ListShipmentSchedules(context.Context, shipment_schedules.ShipmentFilter) (shipment_schedules.ShipmentScheduleListResponse, error) {
	return shipment_schedules.ShipmentScheduleListResponse{
		Items: []shipment_schedules.ShipmentScheduleListItem{{
			ID: 42, ProjectID: 1, ProjectName: "Project A", Country: "US",
			ShipmentNo: "SHP-1", ShipmentStatus: "draft",
		}},
		Page: 1, PageSize: 20, HasNext: false,
	}, nil
}
func (s *stage5ShipmentStore) ListSkuSummary(context.Context, *int64, *string, *string, *string) (shipment_schedules.ShipmentSkuSummaryResponse, error) {
	return shipment_schedules.ShipmentSkuSummaryResponse{Items: []shipment_schedules.ShipmentSkuSummaryItem{{SKU: "SKU-1", TotalQuantity: 3}}}, nil
}
func (s *stage5ShipmentStore) ListFbaBoxDetails(context.Context, []int64, []string, []string) (shipment_schedules.ShipmentFbaBoxDetailResponse, error) {
	return shipment_schedules.ShipmentFbaBoxDetailResponse{Items: []shipment_schedules.ShipmentFbaBoxDetailItem{{SKU: "SKU-1"}}}, nil
}
func (s *stage5ShipmentStore) ListBatches(context.Context, *int64, []int64, *string) ([]string, error) {
	return []string{"BATCH-1"}, nil
}
func (s *stage5ShipmentStore) GetShipmentSchedule(_ context.Context, id int64) (*shipment_schedules.ShipmentScheduleDetail, error) {
	return &shipment_schedules.ShipmentScheduleDetail{
		ID: id, ProjectID: 1, ProjectName: "Project A", Country: "US",
		ShipmentNo: "SHP-1", ShipmentStatus: "draft",
	}, nil
}
func (s *stage5ShipmentStore) CreateShipmentSchedule(_ context.Context, create shipment_schedules.ShipmentScheduleCreate, _ string) (shipment_schedules.ShipmentScheduleDetail, error) {
	s.created = true
	return shipment_schedules.ShipmentScheduleDetail{
		ID: 42, ProjectID: create.ProjectID, Country: create.Country,
		ShipmentNo: create.ShipmentNo, ShipmentStatus: create.ShipmentStatus,
	}, nil
}
func (s *stage5ShipmentStore) UpdateShipmentSchedule(_ context.Context, id int64, update shipment_schedules.ShipmentScheduleUpdate, _ string) (*shipment_schedules.ShipmentScheduleDetail, error) {
	s.updated = true
	return &shipment_schedules.ShipmentScheduleDetail{
		ID: id, ProjectID: update.ProjectID, Country: update.Country,
		ShipmentNo: update.ShipmentNo, ShipmentStatus: update.ShipmentStatus,
	}, nil
}
func (s *stage5ShipmentStore) DeleteShipmentSchedule(context.Context, int64) (bool, error) {
	s.deleted = true
	return true, nil
}
func (s *stage5ShipmentStore) CalculateCosts(context.Context, int64, shipment_schedules.ShipmentCostCalculateRequest) (*shipment_schedules.ShipmentScheduleDetail, error) {
	s.calculated = true
	return &shipment_schedules.ShipmentScheduleDetail{ID: 42, ShipmentNo: "SHP-1"}, nil
}

type stage5ShopStore struct {
	appended bool
}

func (s *stage5ShopStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (s *stage5ShopStore) List(context.Context, shop_calculation.ShopCalculationListFilter) ([]shop_calculation.ShopCalculationItem, int, error) {
	return []shop_calculation.ShopCalculationItem{{
		ID: 11, ProjectID: 1, ProjectName: "Project A", SKU: "SKU-1", Country: "US",
	}}, 1, nil
}
func (s *stage5ShopStore) History(context.Context, shop_calculation.ShopCalculationHistoryFilter) ([]shop_calculation.ShopCalculationItem, error) {
	return []shop_calculation.ShopCalculationItem{{ID: 11, ProjectID: 1, SKU: "SKU-1", Country: "US"}}, nil
}
func (s *stage5ShopStore) Append(_ context.Context, request shop_calculation.ShopCalculationCreateRequest, _ string) (shop_calculation.ShopCalculationItem, error) {
	s.appended = true
	return shop_calculation.ShopCalculationItem{ID: 11, ProjectID: request.ProjectID, SKU: request.SKU, Country: request.Country}, nil
}
func (stage5ShopStore) ProjectIDForItem(context.Context, int64) (int64, error) { return 1, nil }
func (stage5ShopStore) DeleteGroup(context.Context, int64) (bool, error)       { return true, nil }
func (stage5ShopStore) AggregateCurrent(context.Context, int64, string) (shop_calculation.ShopCalculationAggregate, error) {
	return shop_calculation.ShopCalculationAggregate{ProjectID: 1, Country: "US"}, nil
}

type stage5NewProductStore struct{}

func (stage5NewProductStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (stage5NewProductStore) List(context.Context, new_product_calculations.ListFilter) (new_product_calculations.ListResponse, error) {
	return new_product_calculations.ListResponse{
		Items: []new_product_calculations.NewProductCalculationItem{{
			ID: 21, ProjectID: 1, SKU: "SKU-2", CalculationType: "profit_calc",
		}},
		Total: 1, Page: 1, PageSize: 20,
	}, nil
}
func (stage5NewProductStore) Get(_ context.Context, projectID int64, sku, calculationType string) (*new_product_calculations.NewProductCalculationItem, error) {
	return &new_product_calculations.NewProductCalculationItem{
		ID: 21, ProjectID: projectID, SKU: sku, CalculationType: calculationType,
	}, nil
}
func (stage5NewProductStore) Upsert(_ context.Context, input new_product_calculations.CreateRequest, _ string) (*new_product_calculations.NewProductCalculationItem, error) {
	return &new_product_calculations.NewProductCalculationItem{ID: 21, ProjectID: input.ProjectID, SKU: input.SKU}, nil
}
func (stage5NewProductStore) ProjectID(context.Context, int64) (int64, error) { return 1, nil }
func (stage5NewProductStore) Delete(context.Context, int64) (bool, error)     { return true, nil }

type stage5PricingSnapshotStore struct{}

func (stage5PricingSnapshotStore) List(context.Context, int64, string, int, int) ([]pricing_calculation_snapshots.SnapshotListItem, error) {
	return []pricing_calculation_snapshots.SnapshotListItem{{
		ID: 31, ProjectID: 1, Country: "US", SnapshotDate: "2026-11-01", RowCount: 2,
	}}, nil
}

type stage5ReturnStore struct{}

func (stage5ReturnStore) VerifyProjectAccess(context.Context, int64, string, bool) error {
	return nil
}
func (stage5ReturnStore) GetReturnAnalysis(_ context.Context, filter return_analysis.ReturnAnalysisFilter) (*return_analysis.ReturnAnalysisResponse, error) {
	return &return_analysis.ReturnAnalysisResponse{
		ProjectID: filter.ProjectID, ProjectName: "Project A", Country: filter.Country,
		StartDate: filter.StartDate, EndDate: filter.EndDate,
		Summary:      return_analysis.ReturnAnalysisSummary{TotalReturns: 4, DataAvailable: true},
		RankingRows:  []return_analysis.ReturnRankingItem{{SKU: "SKU-1", ReturnCount: 4}},
		FeedbackRows: []return_analysis.CustomerFeedbackItem{{SKU: "SKU-1", CustomerComment: "secret"}},
	}, nil
}
func (stage5ReturnStore) GetRawRows(context.Context, return_analysis.ReturnAnalysisFilter, int) ([]return_analysis.ReturnRawRowItem, error) {
	return []return_analysis.ReturnRawRowItem{{OrderID: "O-1", SKU: "SKU-1", Quantity: 1}}, nil
}

func TestStage5AgentAuthenticationAndScopeContract(t *testing.T) {
	stores := agent.Stores{
		Projects: &stage5ProjectStore{
			items: []projects.ProjectItem{
				{ID: 1, Name: "Project A", Country: "US", IsActive: true},
				{ID: 2, Name: "Project B", Country: "DE", IsActive: true},
			},
			shops: map[int64][]projects.ProjectShopItem{
				1: {{ID: 10, Country: "US", ShopID: "shop-1"}},
			},
		},
		Sales:         stage5SalesStore{},
		Inventory:     stage5InventoryStore{},
		Replenishment: &stage5ReplenishmentStore{},
		ReportStatus:  stage5ReportStore{},
		Ads:           stage5AdStore{},
		Complaints:    stage5ComplaintStore{},
	}
	options := agent.Options{
		Credentials: &stage5CredentialResolver{credential: &agent.Credential{
			KeyID: 7, AgentID: "agent-1", Label: "Agent One",
			ProjectScope: "1", BusinessScope: "sales, inventory, replenishment_analysis, report_upload_status, complaint_center, ad_analysis",
		}},
		ConfirmStore: agent.NewMemoryConfirmStore(time.Now),
		Now:          time.Now,
	}
	router := chi.NewRouter()
	agent.NewRegistrar(stores, options).RegisterRoutes(router, nil)

	requestAgent := func(method, target string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer bbx_stage5")
		req.Header.Set("X-Agent-Id", "agent-1")
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	assertAgentErrorCode(t, rec, http.StatusUnauthorized, "AGENT_AUTH_FAILED")

	rec = requestAgent(http.MethodGet, "/api/v1/agent/health", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("health status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("health response missing ok shell: %s", rec.Body.String())
	}

	rec = requestAgent(http.MethodGet, "/api/v1/agent/projects", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("projects status=%d body=%s", rec.Code, rec.Body.String())
	}
	var projectsResp struct {
		OK   bool `json:"ok"`
		Data []struct {
			ProjectID int64 `json:"project_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &projectsResp); err != nil {
		t.Fatalf("decode projects response: %v", err)
	}
	if !projectsResp.OK || len(projectsResp.Data) != 1 || projectsResp.Data[0].ProjectID != 1 {
		t.Fatalf("projects were not project_scope filtered: %s", rec.Body.String())
	}

	rec = requestAgent(http.MethodGet, "/api/v1/agent/projects/1/sales/summary?period=7d&country=US", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("sales status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = requestAgent(http.MethodGet, "/api/v1/agent/projects/2/sales/summary?period=7d&country=US", nil, nil)
	assertAgentErrorCode(t, rec, http.StatusForbidden, "AGENT_PROJECT_OUT_OF_SCOPE")

	rec = requestAgent(http.MethodGet, "/api/v1/agent/projects/1/inventory?country=US", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"available_qty":12`) {
		t.Fatalf("inventory status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = requestAgent(http.MethodGet, "/api/v1/agent/projects/1/ad-campaigns?period=7d&country=US", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("ad aggregate status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = requestAgent(http.MethodGet, "/api/v1/agent/report-upload-status?report_date=2026-11-08&country=US", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("report status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"project_id":2`) {
		t.Fatalf("report upload items not project_scope filtered: %s", rec.Body.String())
	}

	rec = requestAgent(http.MethodGet, "/api/v1/agent/complaint-center/complaints?date=2026-11-08", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("complaints status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestStage5BusinessDomainRouteContracts(t *testing.T) {
	stores := agent.Stores{
		Projects: &stage5ProjectStore{
			items: []projects.ProjectItem{{ID: 1, Name: "Project A", Country: "US", IsActive: true}},
			shops: map[int64][]projects.ProjectShopItem{},
		},
		Sales:            stage5SalesStore{},
		Inventory:        stage5InventoryStore{},
		Ledger:           stage5LedgerStore{},
		Shipments:        &stage5ShipmentStore{},
		ShopCalculations: &stage5ShopStore{},
		NewProducts:      stage5NewProductStore{},
		PricingSnapshots: stage5PricingSnapshotStore{},
		Returns:          stage5ReturnStore{},
		Replenishment:    &stage5ReplenishmentStore{},
		Ads:              stage5AdStore{},
		Audit:            stage5AuditStore{},
	}
	options := agent.Options{
		Credentials: &stage5CredentialResolver{credential: &agent.Credential{
			KeyID: 7, AgentID: "agent-1", Label: "Agent One", ProjectScope: "1",
			BusinessScope: strings.Join([]string{
				"sales", "inventory", "inventory_ledger", "shipments",
				"shop_calculations", "new_product_calculations", "return_analysis",
				"replenishment_analysis", "report_upload_status", "complaint_center",
				"ad_analysis",
			}, ","),
		}},
		ConfirmStore: agent.NewMemoryConfirmStore(time.Now),
		Now:          time.Now,
	}
	router := chi.NewRouter()
	agent.NewRegistrar(stores, options).RegisterRoutes(router, nil)

	cases := []struct {
		name   string
		target string
		field  string
	}{
		{
			name:   "inventory ledger months",
			target: "/api/v1/agent/projects/1/inventory-ledger/months?country=US",
			field:  `"2026-11-01"`,
		},
		{
			name:   "inventory ledger detail",
			target: "/api/v1/agent/projects/1/inventory-ledger/detail?period=2026-11&country=US",
			field:  `"event_type":"receipts"`,
		},
		{
			name:   "shipments list",
			target: "/api/v1/agent/projects/1/shipments?country=US&page=1&page_size=20",
			field:  `"shipment_no":"SHP-1"`,
		},
		{
			name:   "shipment detail",
			target: "/api/v1/agent/projects/1/shipments/SHP-1",
			field:  `"shipment_no":"SHP-1"`,
		},
		{
			name:   "shop calculations list",
			target: "/api/v1/agent/projects/1/shop-calculations?country=US",
			field:  `"sku":"SKU-1"`,
		},
		{
			name:   "new product list",
			target: "/api/v1/agent/projects/1/new-product-calculations",
			field:  `"sku":"SKU-2"`,
		},
		{
			name:   "pricing snapshots",
			target: "/api/v1/agent/projects/1/pricing-snapshots?country=US",
			field:  `"snapshot_date":"2026-11-01"`,
		},
		{
			name:   "return overview",
			target: "/api/v1/agent/projects/1/return-analysis/overview?start_date=2026-11-01&end_date=2026-11-07&country=US",
			field:  `"total_returns":4`,
		},
		{
			name:   "return raw",
			target: "/api/v1/agent/projects/1/return-analysis-raw?period=7d&country=US",
			field:  `"order_id":"O-1"`,
		},
		{
			name:   "replenishment list",
			target: "/api/v1/agent/projects/1/replenishment-analysis?country=US",
			field:  `"sku":"SKU-1"`,
		},
		{
			name:   "replenishment summary",
			target: "/api/v1/agent/projects/1/replenishment-analysis/summary?country=US",
			field:  `"summary"`,
		},
		{
			name:   "replenishment settings",
			target: "/api/v1/agent/projects/1/replenishment-analysis/settings?country=US",
			field:  `"items"`,
		},
		{
			name:   "ad placements raw",
			target: "/api/v1/agent/projects/1/ad-placements-raw?period=7d&country=US",
			field:  `"campaign_name":"Campaign A"`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := authenticatedAgentRequest(t, router, http.MethodGet, tc.target, nil, nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"ok":true`) ||
				!strings.Contains(rec.Body.String(), tc.field) {
				t.Fatalf("response missing %s: %s", tc.field, rec.Body.String())
			}
		})
	}
}

func TestStage5RegistersFullBusinessRouteSurface(t *testing.T) {
	options := agent.Options{
		Credentials: &stage5CredentialResolver{credential: &agent.Credential{
			KeyID: 7, AgentID: "agent-1", ProjectScope: "*", BusinessScope: "*",
		}},
		ConfirmStore: agent.NewMemoryConfirmStore(time.Now),
		Now:          time.Now,
	}
	router := chi.NewRouter()
	agent.NewRegistrar(agent.Stores{}, options).RegisterRoutes(router, nil)

	routes := map[string]bool{}
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		routes[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	if len(routes) < 80 {
		t.Fatalf("registered routes = %d, want at least 80", len(routes))
	}

	required := []string{
		"GET /api/v1/agent/health",
		"GET /api/v1/agent/projects",
		"GET /api/v1/agent/projects/{project_id}/inventory-ledger/months",
		"GET /api/v1/agent/projects/{project_id}/shipments",
		"GET /api/v1/agent/projects/{project_id}/shop-calculations",
		"GET /api/v1/agent/projects/{project_id}/new-product-calculations",
		"GET /api/v1/agent/projects/{project_id}/pricing-snapshots",
		"GET /api/v1/agent/projects/{project_id}/return-analysis/overview",
		"GET /api/v1/agent/projects/{project_id}/replenishment-analysis",
		"GET /api/v1/agent/projects/{project_id}/ad-invalid-traffic",
		"GET /api/v1/agent/projects/{project_id}/ad-purchased-products-raw",
	}
	for _, route := range required {
		if !routes[route] {
			t.Errorf("missing route %s", route)
		}
	}
}

func TestStage5ConfirmationAndResponseContract(t *testing.T) {
	replenishmentStore := &stage5ReplenishmentStore{}
	stores := agent.Stores{
		Replenishment: replenishmentStore,
	}
	options := agent.Options{
		Credentials: &stage5CredentialResolver{credential: &agent.Credential{
			KeyID: 7, AgentID: "agent-1", Label: "Agent One",
			ProjectScope: "1", BusinessScope: "replenishment_analysis",
		}},
		ConfirmStore: agent.NewMemoryConfirmStore(time.Now),
		Now:          time.Now,
	}
	router := chi.NewRouter()
	agent.NewRegistrar(stores, options).RegisterRoutes(router, nil)

	body := []byte(`{"safety_factor":1.5,"production_lead_days":20}`)
	headers := map[string]string{"Idempotency-Key": "idem-stage5"}
	rec := authenticatedAgentRequest(t, router, http.MethodPut,
		"/api/v1/agent/projects/1/replenishment-analysis/settings/SKU-1", body, headers)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview status=%d body=%s", rec.Code, rec.Body.String())
	}
	var preview struct {
		OK                   bool   `json:"ok"`
		RequiresConfirmation bool   `json:"requires_confirmation"`
		ConfirmToken         string `json:"confirm_token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if preview.OK || !preview.RequiresConfirmation || preview.ConfirmToken == "" {
		t.Fatalf("unexpected preview shell: %s", rec.Body.String())
	}
	if replenishmentStore.updated {
		t.Fatal("preview mutated the replenishment setting")
	}

	headers["X-Confirm-Token"] = preview.ConfirmToken
	rec = authenticatedAgentRequest(t, router, http.MethodPut,
		"/api/v1/agent/projects/1/replenishment-analysis/settings/SKU-1", body, headers)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("confirmed status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !replenishmentStore.updated {
		t.Fatal("confirmed request did not mutate the replenishment setting")
	}
	if replenishmentStore.update.SafetyFactor == nil || *replenishmentStore.update.SafetyFactor != 1.5 {
		t.Fatalf("confirmed request update = %#v", replenishmentStore.update)
	}

	rec = authenticatedAgentRequest(t, router, http.MethodPut,
		"/api/v1/agent/projects/1/replenishment-analysis/settings/SKU-1", body, headers)
	assertAgentErrorCode(t, rec, http.StatusBadRequest, "CONFIRM_TOKEN_INVALID")
}

func TestStage5ConfirmationBodyMismatchFailsClosed(t *testing.T) {
	stores := agent.Stores{Replenishment: &stage5ReplenishmentStore{}}
	options := agent.Options{
		Credentials: &stage5CredentialResolver{credential: &agent.Credential{
			KeyID: 7, AgentID: "agent-1", ProjectScope: "1",
			BusinessScope: "replenishment_analysis",
		}},
		ConfirmStore: agent.NewMemoryConfirmStore(time.Now),
		Now:          time.Now,
	}
	router := chi.NewRouter()
	agent.NewRegistrar(stores, options).RegisterRoutes(router, nil)

	firstBody := []byte(`{"safety_factor":1.5}`)
	rec := authenticatedAgentRequest(t, router, http.MethodPut,
		"/api/v1/agent/projects/1/replenishment-analysis/settings/SKU-1", firstBody, nil)
	var preview struct {
		ConfirmToken string `json:"confirm_token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &preview)

	rec = authenticatedAgentRequest(t, router, http.MethodPut,
		"/api/v1/agent/projects/1/replenishment-analysis/settings/SKU-1",
		[]byte(`{"safety_factor":3}`), map[string]string{"X-Confirm-Token": preview.ConfirmToken})
	assertAgentErrorCode(t, rec, http.StatusBadRequest, "CONFIRM_TOKEN_INVALID")
}

func authenticatedAgentRequest(
	t *testing.T,
	handler http.Handler,
	method string,
	target string,
	body []byte,
	headers map[string]string,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer bbx_stage5")
	req.Header.Set("X-Agent-Id", "agent-1")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func assertAgentErrorCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status=%d, want %d; body=%s", rec.Code, status, rec.Body.String())
	}
	var payload struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error shell: %v; body=%s", err, rec.Body.String())
	}
	if payload.OK || payload.Error.Code != code {
		t.Fatalf("error code=%q ok=%v, want %q; body=%s", payload.Error.Code, payload.OK, code, rec.Body.String())
	}
}

func TestStage5ConfirmationResourcePathMismatchFailsClosed(t *testing.T) {
	stores := agent.Stores{Replenishment: &stage5ReplenishmentStore{}}
	options := agent.Options{
		Credentials: &stage5CredentialResolver{credential: &agent.Credential{
			KeyID: 7, AgentID: "agent-1", ProjectScope: "1",
			BusinessScope: "replenishment_analysis",
		}},
		ConfirmStore: agent.NewMemoryConfirmStore(time.Now),
		Now:          time.Now,
	}
	router := chi.NewRouter()
	agent.NewRegistrar(stores, options).RegisterRoutes(router, nil)

	body := []byte(`{"safety_factor":1.5}`)
	rec := authenticatedAgentRequest(t, router, http.MethodPut,
		"/api/v1/agent/projects/1/replenishment-analysis/settings/SKU-1", body, nil)
	var preview struct {
		ConfirmToken string `json:"confirm_token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &preview)

	// Replay token against SKU-2 instead of SKU-1
	rec = authenticatedAgentRequest(t, router, http.MethodPut,
		"/api/v1/agent/projects/1/replenishment-analysis/settings/SKU-2",
		body, map[string]string{"X-Confirm-Token": preview.ConfirmToken})
	assertAgentErrorCode(t, rec, http.StatusBadRequest, "CONFIRM_TOKEN_INVALID")
}

func TestStage5ConfirmationPreviewPrevalidatesDTO(t *testing.T) {
	stores := agent.Stores{
		Shipments: &stage5ShipmentStore{},
	}
	options := agent.Options{
		Credentials: &stage5CredentialResolver{credential: &agent.Credential{
			KeyID: 7, AgentID: "agent-1", ProjectScope: "1",
			BusinessScope: "shipments",
		}},
		ConfirmStore: agent.NewMemoryConfirmStore(time.Now),
		Now:          time.Now,
	}
	router := chi.NewRouter()
	agent.NewRegistrar(stores, options).RegisterRoutes(router, nil)

	// Invalid body with empty shipment_no
	invalidBody := []byte(`{"shipment_no":""}`)
	rec := authenticatedAgentRequest(t, router, http.MethodPost,
		"/api/v1/agent/projects/1/shipments", invalidBody, nil)
	assertAgentErrorCode(t, rec, http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestStage5AgentRateLimiting(t *testing.T) {
	stores := agent.Stores{}
	options := agent.Options{
		Credentials: &stage5CredentialResolver{credential: &agent.Credential{
			KeyID: 7, AgentID: "agent-ratelimited", ProjectScope: "1",
			BusinessScope: "sales",
		}},
		ConfirmStore: agent.NewMemoryConfirmStore(time.Now),
		RateLimiter:  agentauth.NewMemoryRateLimiter(agentauth.RateLimit{Requests: 2, Window: time.Minute}),
		Now:          time.Now,
	}
	router := chi.NewRouter()
	agent.NewRegistrar(stores, options).RegisterRoutes(router, nil)

	headers := map[string]string{"X-Agent-Id": "agent-ratelimited"}
	req1 := authenticatedAgentRequest(t, router, http.MethodGet, "/api/v1/agent/health", nil, headers)
	if req1.Code != http.StatusOK {
		t.Fatalf("first request status=%d body=%s", req1.Code, req1.Body.String())
	}
	req2 := authenticatedAgentRequest(t, router, http.MethodGet, "/api/v1/agent/health", nil, headers)
	if req2.Code != http.StatusOK {
		t.Fatalf("second request status=%d body=%s", req2.Code, req2.Body.String())
	}
	req3 := authenticatedAgentRequest(t, router, http.MethodGet, "/api/v1/agent/health", nil, headers)
	if req3.Code != http.StatusTooManyRequests {
		t.Fatalf("third request status=%d want 429 body=%s", req3.Code, req3.Body.String())
	}
	if req3.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header on 429 rate limit response")
	}
}
