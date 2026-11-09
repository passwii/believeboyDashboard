package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/new_product_calculations"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shop_calculation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func TestStage3StoresAgainstBLFTest(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	projectName := fmt.Sprintf("stage3-store-integration-%d", time.Now().UnixNano())
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}
	db := NewPGXDB(pool)

	var projectID int64
	if err := pool.QueryRow(
		ctx,
		`insert into public.projects (project_name, sort_order, project_operator, commission_rate)
		 values ($1, 9999, 'alice', 0.15) returning id`,
		projectName,
	).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`insert into public.product_costs (
		   project_id, project_name, sku, asin, country,
		   fob_unit_cost, first_leg_cost_rmb,
		   package_length_cm, package_width_cm, package_height_cm, weight_kg,
		   is_active
		 ) values ($1, $2, 'INTEGRATION-1', 'B0INTEGRATION', 'US',
		   20, 5, 10, 8, 5, 0.5, true)`,
		projectID,
		projectName,
	); err != nil {
		t.Fatalf("insert product master: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from public.new_product_calculations where project_id = $1`, projectID)
		_, _ = pool.Exec(context.Background(), `delete from public.shop_calculation where project_id = $1`, projectID)
		_, _ = pool.Exec(context.Background(), `delete from public.pricing_calculation_runs where project_id = $1`, projectID)
		_, _ = pool.Exec(context.Background(), `delete from public.product_costs where project_id = $1`, projectID)
		_, _ = pool.Exec(context.Background(), `delete from public.projects where id = $1`, projectID)
	})

	t.Run("pricing calculation runs", func(t *testing.T) {
		store := NewPricingCalculationStore(db)
		project := projectID
		item, err := store.CreateRun(ctx, pricing_calculation.RunItem{
			Country: "US", ProductName: "stage3 real run", CalculationType: "profit_calc",
			ProjectID: &project, SKU: stage3StringPtr("INTEGRATION-1"),
			PackageLengthCM: 10, PackageWidthCM: 8, PackageHeightCM: 5, WeightKG: 0.5,
			FOBProductCostRMB: 20, FirstLegCostRMB: 5, SalePriceUSD: 20,
			CommissionRate: 0.15, AdvertisingRate: 0.12, ReturnLossRate: 0.04,
			StorageMonths: 1, InboundPlacementMode: "single_destination",
			USDToRMBRate: 7.2, USDToRMBRateSource: "manual",
			SizeTier: "small_standard", SizeTierLabel: "小号标准尺寸",
			PriceBand: "between_10_50", PriceBandLabel: "售价 $10 ~ $50",
			Dimensions: pricing_calculation.PricingCalculationDimensions{
				LongestSideIn: 3.94, MiddleSideIn: 3.15, ShortestSideIn: 1.97,
				LengthPlusGirthIn: 13.78, VolumeCubicIn: 24.44, VolumeCubicFt: 0.0141,
			},
			Weights: pricing_calculation.PricingCalculationWeights{
				ProductWeightLB: 1.1, ProductWeightOZ: 17.64, DimensionalWeightLB: 0.176,
				ChargeableWeightLB: 1.1, ChargeableWeightOZ: 17.64, ChargeableWeightRule: "商品重量",
			},
			Fees: pricing_calculation.PricingCalculationFees{
				ReferralFeeUSD: 2.88, AdvertisingFeeUSD: 2.4, ReturnLossUSD: 0.8,
				FBAFulfillmentFeeUSD: 3.42, InboundConfigFeeUSD: 0.32,
				StorageFeeUSD: 0.01, TotalFeeUSD: 9.83,
			},
			Profit: pricing_calculation.PricingCalculationProfit{
				DDPCostRMB: 25, DDPCostUSD: 3.47, PayoutUSD: 10.17,
				ProfitUSD: 6.7, ProfitRate: 0.335,
			},
			Warnings: []string{}, CreatedBy: stage3StringPtr("alice"),
		})
		if err != nil {
			t.Fatalf("CreateRun() error = %v", err)
		}
		if item.ID == 0 || item.Profit.ProfitUSD != 6.7 ||
			item.Profit.DDPCostRMB != 25 || item.Profit.DDPCostUSD != 3.47 ||
			item.CompetitorURL != nil {
			t.Fatalf("unexpected created run: %#v", item)
		}
		list, total, err := store.ListRuns(ctx, pricing_calculation.RunListFilter{
			Page: 1, PageSize: 10, ExcludeProjectID: false, Operator: "alice",
		})
		if err != nil || total != 1 || len(list) != 1 {
			t.Fatalf("ListRuns() = %d/%d, %v", len(list), total, err)
		}
		updateItem := item
		updateItem.Fees.TotalFeeUSD = 9.5
		updateItem.Profit.PayoutUSD = 10.5
		updateItem.Profit.ProfitUSD = 7.03
		updateItem.Profit.ProfitRate = 0.3515
		updated, err := store.UpdateRun(ctx, item.ID, updateItem)
		if err != nil || updated == nil || updated.Profit.ProfitUSD != 7.03 {
			t.Fatalf("UpdateRun() = %#v, %v", updated, err)
		}
		deleted, err := store.DeleteRun(ctx, item.ID)
		if err != nil || !deleted {
			t.Fatalf("DeleteRun() = %v, %v", deleted, err)
		}
	})

	t.Run("new product calculations", func(t *testing.T) {
		store := NewProductCalculationStore(db)
		request := stage3NewProductRequest(projectID, projectName)
		request.PackageLengthCM = 0
		request.PackageWidthCM = 0
		request.PackageHeightCM = 0
		request.WeightKG = 0
		request.FOBProductCostRMB = 0
		request.FirstLegCostRMB = 0
		created, err := store.Upsert(ctx, request, "alice")
		if err != nil {
			t.Fatalf("Upsert() error = %v", err)
		}
		if created == nil || created.ID == 0 || created.SalePriceUSD != 20 ||
			created.PackageLengthCM != 10 || created.PackageWidthCM != 8 ||
			created.PackageHeightCM != 5 || created.WeightKG != 0.5 ||
			created.FOBProductCostRMB != 20 || created.FirstLegCostRMB != 5 ||
			created.ProjectName != projectName {
			t.Fatalf("created = %#v", created)
		}
		if created.Profit.DDPCostRMB != 25 || created.Profit.DDPCostUSD != 3.47 ||
			created.Profit.ProfitUSD == request.ProfitUSD ||
			created.Fees.TotalFeeUSD == request.TotalFeeUSD {
			t.Fatalf("server did not replace client-derived values: %#v", created)
		}
		request.SalePriceUSD = 25
		request.ProfitUSD = 7
		request.ProfitRate = 0.28
		request.TotalFeeUSD = 1
		updated, err := store.Upsert(ctx, request, "alice")
		if err != nil {
			t.Fatalf("second Upsert() error = %v", err)
		}
		if updated.ID != created.ID || updated.SalePriceUSD != 25 ||
			updated.Profit.ProfitUSD == 7 || updated.Fees.TotalFeeUSD == 1 {
			t.Fatalf("updated = %#v, created id=%d", updated, created.ID)
		}
		got, err := store.Get(ctx, projectID, "INTEGRATION-1", "profit_calc")
		if err != nil || got == nil || got.SalePriceUSD != 25 {
			t.Fatalf("Get() = %#v, %v", got, err)
		}
		listed, err := store.List(ctx, new_product_calculations.ListFilter{
			ProjectID: &projectID, Page: 1, PageSize: 10, Operator: "alice",
		})
		if err != nil || listed.Total != 1 || len(listed.Items) != 1 {
			t.Fatalf("List() = %#v, %v", listed, err)
		}
		reverse := stage3NewProductRequest(projectID, projectName)
		reverse.CalculationType = "profit_reverse"
		reverse.TargetProfitRate = stage3FloatPtr(0.25)
		reverse.SalePriceUSD = 0.01
		reverseResult, err := store.Upsert(ctx, reverse, "alice")
		if err != nil {
			t.Fatalf("reverse Upsert() error = %v", err)
		}
		if reverseResult.CalculationType != "profit_reverse" ||
			reverseResult.SalePriceUSD <= reverse.SalePriceUSD ||
			reverseResult.Profit.ProfitRate < 0.25 {
			t.Fatalf("reverse result = %#v, want computed suggested price", reverseResult)
		}
		deleted, err := store.Delete(ctx, created.ID)
		if err != nil || !deleted {
			t.Fatalf("Delete() = %v, %v", deleted, err)
		}
	})

	t.Run("shop calculation append aggregate and soft delete", func(t *testing.T) {
		store := NewShopCalculationStore(db)
		first, err := store.Append(ctx, stage3ShopRequest(projectID, projectName, "SHOP-1", 20, 8, 4), "alice")
		if err != nil {
			t.Fatalf("Append(first) error = %v", err)
		}
		second, err := store.Append(ctx, stage3ShopRequest(projectID, projectName, "SHOP-2", 30, 15, -3), "alice")
		if err != nil {
			t.Fatalf("Append(second) error = %v", err)
		}
		if first.ID == 0 || second.ID == 0 {
			t.Fatalf("ids = %d/%d", first.ID, second.ID)
		}
		aggregate, err := store.AggregateCurrent(ctx, projectID, "US")
		if err != nil {
			t.Fatalf("AggregateCurrent() error = %v", err)
		}
		if aggregate.RevenueUSD != 50 || aggregate.PlatformFeesUSD != 23 ||
			aggregate.ProcurementCostRMB != 40 ||
			aggregate.DDPCostRMB != 252 || aggregate.DDPCostUSD != 35 ||
			aggregate.ProfitUSD != -8 ||
			aggregate.GrossMarginRate != -0.16 {
			t.Fatalf("aggregate = %#v", aggregate)
		}
		auditService := audit.NewService(db)
		err = store.RunInTx(ctx, func(
			txCtx context.Context,
			tx pgx.Tx,
			txStore shop_calculation.Store,
		) error {
			_, appendErr := txStore.Append(
				txCtx,
				stage3ShopRequest(projectID, projectName, "SHOP-ROLLBACK", 40, 20, 5),
				"alice",
			)
			if appendErr != nil {
				return appendErr
			}
			auditCtx, cancel := context.WithCancel(txCtx)
			cancel()
			return auditService.LogActionTx(auditCtx, tx, audit.Entry{
				Action:     "stage3.rollback.test",
				TargetType: "shop_calculation",
				AfterJSON:  map[string]any{"sku": "SHOP-ROLLBACK"},
			})
		})
		if err == nil {
			t.Fatal("expected audit serialization failure")
		}
		var rollbackCount int
		if err := pool.QueryRow(
			ctx,
			`select count(*) from public.shop_calculation
			 where project_id = $1 and sku = 'SHOP-ROLLBACK'`,
			projectID,
		).Scan(&rollbackCount); err != nil {
			t.Fatalf("count rollback row: %v", err)
		}
		if rollbackCount != 0 {
			t.Fatalf("audit failure committed %d shop rows, want rollback", rollbackCount)
		}
		deleted, err := store.DeleteGroup(ctx, first.ID)
		if err != nil || !deleted {
			t.Fatalf("DeleteGroup() = %v, %v", deleted, err)
		}
		current, total, err := store.List(ctx, shop_calculation.ShopCalculationListFilter{
			ProjectID: &projectID, Page: 1, PageSize: 10,
		})
		if err != nil || total != 1 || len(current) != 1 || current[0].SKU != "SHOP-2" {
			t.Fatalf("current after delete = %#v/%d, %v", current, total, err)
		}
		history, err := store.History(ctx, shop_calculation.ShopCalculationHistoryFilter{
			ProjectID: projectID, IncludeDeleted: true,
		})
		if err != nil || len(history) != 2 {
			t.Fatalf("history len=%d, err=%v", len(history), err)
		}
	})
}

func stage3NewProductRequest(projectID int64, projectName string) new_product_calculations.CreateRequest {
	country := "US"
	return new_product_calculations.CreateRequest{
		ProjectID: projectID, ProjectName: projectName, SKU: "INTEGRATION-1",
		Country: &country, CalculationType: "profit_calc",
		PackageLengthCM: 10, PackageWidthCM: 8, PackageHeightCM: 5, WeightKG: 0.5,
		FOBProductCostRMB: 20, FirstLegCostRMB: 5, DDPCostRMB: 25, DDPCostUSD: 3.47,
		SalePriceUSD: 20, TargetProfitRate: stage3FloatPtr(0.25),
		AdvertisingRate: 0.12, ReturnLossRate: 0.04, StorageMonths: 1,
		InboundPlacementMode: "single_destination", USDToRMBRate: 7.2,
		USDToRMBRateSource: "manual", SizeTier: "small_standard",
		SizeTierLabel: "小号标准尺寸", PriceBand: "between_10_50",
		PriceBandLabel: "售价 $10 ~ $50",
		LongestSideIn:  3.94, MiddleSideIn: 3.15, ShortestSideIn: 1.97,
		LengthPlusGirthIn: 13.78, VolumeCubicIn: 24.44, VolumeCubicFt: 0.0141,
		ProductWeightLB: 1.1, ProductWeightOZ: 17.64, DimensionalWeightLB: 0.176,
		ChargeableWeightLB: 1.1, ChargeableWeightOZ: 17.64, ChargeableWeightRule: "商品重量",
		FulfillmentFeeRuleLabel:   "小号标准尺寸 / 不超过 2 盎司",
		InboundConfigFeeRuleLabel: "小号标准尺寸 / 单点入仓 / 不超过 8 盎司",
		StorageFeeRuleLabel:       "标准尺寸 / 非危险品 / 非旺季",
		ReferralFeeUSD:            2.88, AdvertisingFeeUSD: 2.4, ReturnLossUSD: 0.8,
		FBAFulfillmentFeeUSD: 3.42, InboundConfigFeeUSD: 0.32, StorageFeeUSD: 0.01,
		TotalFeeUSD: 9.83, PayoutUSD: 10.17, ProfitUSD: 6.7, ProfitRate: 0.335,
		Warnings: []string{"真实 warnings"}, Notes: stage3StringPtr("notes"),
	}
}

func stage3ShopRequest(projectID int64, projectName, sku string, revenue, fee, profit float64) shop_calculation.ShopCalculationCreateRequest {
	observedAt := time.Now().UTC()
	return shop_calculation.ShopCalculationCreateRequest{
		ProjectID: projectID, ProjectName: projectName, SKU: sku, Country: "US",
		AccountingType: "profit_calc", PackageLengthCM: 10, PackageWidthCM: 8,
		PackageHeightCM: 5, WeightKG: 0.5, FOBProductCostRMB: 20,
		FirstLegCostRMB: 5, DDPCostRMB: 126, DDPCostUSD: 17.5,
		SalePriceUSD: revenue, AdvertisingRate: 0.12, ReturnLossRate: 0.04,
		StorageMonths: 1, InboundPlacementMode: "single_destination",
		USDToRMBRate: 7.2, USDToRMBRateSource: "manual", SizeTier: "small_standard",
		SizeTierLabel: "小号标准尺寸", PriceBand: "between_10_50",
		PriceBandLabel: "售价 $10 ~ $50",
		LongestSideIn:  3.94, MiddleSideIn: 3.15, ShortestSideIn: 1.97,
		LengthPlusGirthIn: 13.78, VolumeCubicIn: 24.44, VolumeCubicFt: 0.0141,
		ProductWeightLB: 1.1, ProductWeightOZ: 17.64, DimensionalWeightLB: 0.176,
		ChargeableWeightLB: 1.1, ChargeableWeightOZ: 17.64, ChargeableWeightRule: "商品重量",
		FulfillmentFeeRuleLabel: "fulfillment", InboundConfigFeeRuleLabel: "inbound",
		StorageFeeRuleLabel: "storage", ReferralFeeUSD: fee * 0.6,
		AdvertisingFeeUSD: fee * 0.2, ReturnLossUSD: fee * 0.2,
		FBAFulfillmentFeeUSD: 3.42, InboundConfigFeeUSD: 0.32, StorageFeeUSD: 0.01,
		TotalFeeUSD: fee, PlatformFeeUSD: fee * 0.6, PayoutUSD: revenue - fee,
		ProfitUSD: profit, ProfitRate: profit / revenue, Warnings: []string{},
		Source: "manual", ObservedAt: &observedAt,
	}
}

func stage3StringPtr(value string) *string  { return &value }
func stage3FloatPtr(value float64) *float64 { return &value }
