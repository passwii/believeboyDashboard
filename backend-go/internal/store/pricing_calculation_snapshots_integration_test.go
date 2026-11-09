package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation_snapshots"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func TestPricingCalculationSnapshotStoreIntegration(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	projectName := fmt.Sprintf("stage3-snapshot-integration-%d", time.Now().UnixNano())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}

	var projectID int64
	if err := pool.QueryRow(
		ctx,
		`insert into public.projects (project_name, sort_order, project_operator)
		 values ($1, 9999, 'alice')
		 returning id`,
		projectName,
	).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from public.pricing_calculation_snapshots where project_id = $1`, projectID)
		_, _ = pool.Exec(context.Background(), `delete from public.shop_calculation where project_id = $1`, projectID)
		_, _ = pool.Exec(context.Background(), `delete from public.projects where id = $1`, projectID)
	})

	for _, fixture := range []struct {
		sku        string
		salePrice  float64
		profit     float64
		profitRate float64
	}{
		{sku: "A-1", salePrice: 18.00, profit: -2.00, profitRate: -0.1111},
		{sku: "A-1", salePrice: 20.00, profit: 3.00, profitRate: 0.1500},
		{sku: "B-1", salePrice: 16.00, profit: -1.00, profitRate: -0.0625},
	} {
		_, err := pool.Exec(
			ctx,
			`insert into public.shop_calculation (
			   project_id, project_name, sku, country, accounting_type,
			   package_length_cm, package_width_cm, package_height_cm, weight_kg,
			   fob_product_cost_rmb, first_leg_cost_rmb, ddp_cost_rmb, ddp_cost_usd,
			   sale_price_usd, advertising_rate, return_loss_rate, storage_months,
			   inbound_placement_mode, usd_to_rmb_rate, usd_to_rmb_rate_source,
			   size_tier, size_tier_label, price_band, price_band_label,
			   longest_side_in, middle_side_in, shortest_side_in,
			   length_plus_girth_in, volume_cubic_in, volume_cubic_ft,
			   product_weight_lb, product_weight_oz, dimensional_weight_lb,
			   chargeable_weight_lb, chargeable_weight_oz, chargeable_weight_rule,
			   fulfillment_fee_rule_label, inbound_config_fee_rule_label,
			   storage_fee_rule_label, referral_fee_usd, advertising_fee_usd,
			   return_loss_usd, fba_fulfillment_fee_usd, inbound_config_fee_usd,
			   storage_fee_usd, total_fee_usd, payout_usd, profit_usd, profit_rate,
			   created_by, source
			 ) values (
			   $1, $2, $3, 'US', 'profit_calc',
			   10, 8, 5, 0.5,
			   20, 5, 25, 3.47,
			   $4, 0.12, 0.04, 1,
			   'single_destination', 7.2, 'manual',
			   'small_standard', '小号标准尺寸', 'between_10_50', '售价 $10 ~ $50',
			   3.94, 3.15, 1.97, 13.78, 24.44, 0.0141,
			   1.1, 17.64, 0.176, 1.1, 17.64, '商品重量',
			   '小号标准尺寸 / 不超过 2 盎司', '小号标准尺寸 / 单点入仓 / 不超过 8 盎司',
			   '标准尺寸 / 非危险品 / 非旺季', 3.0, 2.4, 0.64, 2.43,
			   0.32, 0.01, 8.8, 11.2, $5, $6, 'alice', 'manual'
			 )`,
			projectID, projectName, fixture.sku, fixture.salePrice,
			fixture.profit, fixture.profitRate,
		)
		if err != nil {
			t.Fatalf("insert shop_calculation fixture: %v", err)
		}
	}

	store := NewPricingCalculationSnapshotStore(NewPGXDB(pool))
	if err := store.VerifyProjectAccess(ctx, projectID, "alice", false); err != nil {
		t.Fatalf("alice access error = %v", err)
	}
	if err := store.VerifyProjectAccess(ctx, projectID, "bob", false); err == nil {
		t.Fatal("bob access error = nil, want forbidden")
	}

	var snapshotID int64
	err = store.RunInTx(ctx, func(
		txCtx context.Context,
		tx pgx.Tx,
		txStore pricing_calculation_snapshots.Store,
	) error {
		createdID, createErr := txStore.Create(
			txCtx,
			projectID,
			"US",
			snapshotTestStringPtr("integration"),
			snapshotTestStringPtr("real SQL"),
			"alice",
		)
		if createErr != nil {
			return createErr
		}
		snapshotID = createdID
		targetID := fmt.Sprint(createdID)
		return audit.NewService(NewPGXDB(pool)).LogActionTx(txCtx, tx, audit.Entry{
			Action:     "pricing_calculation_snapshot.create",
			TargetType: "pricing_calculation_snapshot",
			TargetID:   &targetID,
		})
	})
	if err != nil {
		t.Fatalf("transactional Create() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(
			context.Background(),
			`delete from public.operation_audit_logs
			 where action = 'pricing_calculation_snapshot.create' and target_id = $1`,
			fmt.Sprint(snapshotID),
		)
	})
	detail, err := store.Get(ctx, snapshotID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if detail.RowCount != 2 || len(detail.Items) != 2 {
		t.Fatalf("row_count=%d items=%d, want 2/2", detail.RowCount, len(detail.Items))
	}
	if detail.Summary.Total != 2 || detail.Summary.Profitable != 1 || detail.Summary.PassRate != 50 {
		t.Fatalf("summary = %#v", detail.Summary)
	}
	if detail.Items[0].SKU != "A-1" || detail.Items[0].SalePriceUSD != 20 {
		t.Fatalf("latest row not selected: %#v", detail.Items[0])
	}
	if detail.Items[0].Anchor == nil || detail.Items[0].Anchor.BreakevenAdvertisingRate == nil {
		t.Fatalf("anchor = %#v", detail.Items[0].Anchor)
	}

	list, err := store.List(ctx, projectID, "US", 1, 50)
	if err != nil || len(list) != 1 {
		t.Fatalf("List() = %d, %v", len(list), err)
	}
	items, err := store.GetItems(ctx, snapshotID)
	if err != nil || items.Total != 2 || items.SnapshotID != snapshotID {
		t.Fatalf("GetItems() = %#v, %v", items, err)
	}
	updated, err := store.Update(ctx, snapshotID, snapshotTestStringPtr("renamed"), snapshotTestStringPtr("updated"), "admin")
	if err != nil || updated == nil || updated.Name == nil || *updated.Name != "renamed" {
		t.Fatalf("Update() = %#v, %v", updated, err)
	}
	deleted, err := store.Delete(ctx, snapshotID)
	if err != nil || !deleted {
		t.Fatalf("Delete() = %v, %v", deleted, err)
	}
}

func snapshotTestStringPtr(value string) *string {
	return &value
}
