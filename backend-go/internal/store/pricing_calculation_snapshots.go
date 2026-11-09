package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation_snapshots"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type PricingCalculationSnapshotStore struct {
	db FullDB
}

func NewPricingCalculationSnapshotStore(db FullDB) *PricingCalculationSnapshotStore {
	return &PricingCalculationSnapshotStore{db: db}
}

func (s *PricingCalculationSnapshotStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, pricing_calculation_snapshots.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &PricingCalculationSnapshotStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func (s *PricingCalculationSnapshotStore) VerifyProjectAccess(
	ctx context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) error {
	var projectOperator, assistantOperator *string
	err := s.db.QueryRow(
		ctx,
		`select project_operator, assistant_operator from public.projects where id = $1`,
		projectID,
	).Scan(&projectOperator, &assistantOperator)
	if errors.Is(err, pgx.ErrNoRows) {
		return pricing_calculation_snapshots.ErrProjectNotFound
	}
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return pricing_calculation_snapshots.ErrProjectForbidden
	}
	if textContainsName(projectOperator, operator) || textContainsName(assistantOperator, operator) {
		return nil
	}
	return pricing_calculation_snapshots.ErrProjectForbidden
}

func (s *PricingCalculationSnapshotStore) ProjectID(ctx context.Context, snapshotID int64) (int64, error) {
	var projectID int64
	err := s.db.QueryRow(
		ctx,
		`select project_id from public.pricing_calculation_snapshots where id = $1`,
		snapshotID,
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, pricing_calculation_snapshots.ErrNotFound
	}
	return projectID, err
}

const snapshotHeaderSelect = `
	id, project_id, project_name, country, snapshot_date, name, description,
	row_count, created_by, created_at, summary_json::text`

func (s *PricingCalculationSnapshotStore) List(
	ctx context.Context,
	projectID int64,
	country string,
	page int,
	pageSize int,
) ([]pricing_calculation_snapshots.SnapshotListItem, error) {
	pagination := normalizedSnapshotPagination(page, pageSize, 50, 100)
	rows, err := s.db.Query(
		ctx,
		`select `+snapshotHeaderSelect+`
		 from public.pricing_calculation_snapshots
		 where project_id = $1 and country = $2
		 order by snapshot_date desc, id desc
		 offset $3 limit $4`,
		projectID,
		country,
		pagination.offset,
		pagination.size,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]pricing_calculation_snapshots.SnapshotListItem, 0)
	for rows.Next() {
		item, err := scanSnapshotListRow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PricingCalculationSnapshotStore) Get(
	ctx context.Context,
	snapshotID int64,
) (*pricing_calculation_snapshots.SnapshotDetail, error) {
	header, err := s.getHeader(ctx, snapshotID)
	if err != nil {
		return nil, err
	}
	items, err := s.querySnapshotItems(ctx, snapshotID)
	if err != nil {
		return nil, err
	}
	return &pricing_calculation_snapshots.SnapshotDetail{
		SnapshotListItem: *header,
		Items:            items,
	}, nil
}

func (s *PricingCalculationSnapshotStore) GetItems(
	ctx context.Context,
	snapshotID int64,
) (*pricing_calculation_snapshots.SnapshotItemsResponse, error) {
	header, err := s.getHeader(ctx, snapshotID)
	if err != nil {
		return nil, err
	}
	items, err := s.querySnapshotItems(ctx, snapshotID)
	if err != nil {
		return nil, err
	}
	return &pricing_calculation_snapshots.SnapshotItemsResponse{
		Items:               items,
		Summary:             header.Summary,
		RowCount:            len(items),
		Total:               len(items),
		Page:                1,
		PageSize:            200,
		HasNext:             false,
		SnapshotID:          header.ID,
		SnapshotDate:        header.SnapshotDate,
		SnapshotName:        header.Name,
		SnapshotDescription: header.Description,
	}, nil
}

func (s *PricingCalculationSnapshotStore) getHeader(
	ctx context.Context,
	snapshotID int64,
) (*pricing_calculation_snapshots.SnapshotListItem, error) {
	item, err := scanSnapshotListRow(s.db.QueryRow(
		ctx,
		`select `+snapshotHeaderSelect+`
		 from public.pricing_calculation_snapshots where id = $1`,
		snapshotID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, pricing_calculation_snapshots.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

const latestShopCalculationsCTE = `
	with latest as (
		select sc.*
		from public.shop_calculation sc
		join (
			select project_id, sku, country, max(id) as id
			from public.shop_calculation
			where project_id = $1 and country = $2 and deleted_at is null
			group by project_id, sku, country
		) latest_ids on latest_ids.id = sc.id
	)`

func (s *PricingCalculationSnapshotStore) Create(
	ctx context.Context,
	projectID int64,
	country string,
	name *string,
	description *string,
	operator string,
) (int64, error) {
	country = normalizeCountry(country)
	if country == "" {
		country = "US"
	}

	var snapshotID int64
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		db := NewTxDB(tx)
		// Keep the summary and copied rows on one stable table snapshot. The
		// lock is released when the request transaction commits/rolls back.
		if _, err := db.Exec(ctx, `lock table public.shop_calculation in share mode`); err != nil {
			return err
		}
		var total, profitable int
		var projectName string
		err := db.QueryRow(
			ctx,
			latestShopCalculationsCTE+`
			 select count(*),
			        coalesce(sum(case when coalesce(profit_after_vat_usd, profit_usd) >= 0 then 1 else 0 end), 0),
			        coalesce(min(project_name), '')
			 from latest`,
			projectID,
			country,
		).Scan(&total, &profitable, &projectName)
		if err != nil {
			return err
		}
		if total == 0 {
			return fmt.Errorf("%w: 项目 %d 在 %s 站点下没有可快照的核算记录", pricing_calculation_snapshots.ErrSourceEmpty, projectID, country)
		}
		summary := pricing_calculation_snapshots.SnapshotSummary{
			Total:      total,
			Calculated: total,
			Profitable: profitable,
			PassRate:   float64(profitable) / float64(total) * 100,
		}
		summaryJSON, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		var createdAt time.Time
		err = db.QueryRow(
			ctx,
			`insert into public.pricing_calculation_snapshots (
			   project_id, project_name, country, name, description,
			   summary_json, row_count, created_by
			 ) values ($1, $2, $3, $4, $5, $6::json, $7, $8)
			 returning id, created_at`,
			projectID,
			projectName,
			country,
			snapshotOptionalStoreText(name, 255),
			snapshotOptionalStoreText(description, 4000),
			string(summaryJSON),
			total,
			snapshotOptionalStoreText(snapshotStringPtr(operator), 255),
		).Scan(&snapshotID, &createdAt)
		if err != nil {
			return err
		}

		_, err = db.Exec(
			ctx,
			latestShopCalculationsCTE+`,
			 numbered as (
			   select *, row_number() over (order by sku asc) - 1 as source_row_no
			   from latest
			 )
			 insert into public.pricing_calculation_snapshot_items (
			   snapshot_id, source_row_no, project_id, project_name, sku, asin,
			   country, calculation_type, package_length_cm, package_width_cm,
			   package_height_cm, weight_kg, fob_product_cost_rmb,
			   first_leg_cost_rmb, ddp_cost_rmb, ddp_cost_usd, sale_price_usd,
			   target_profit_rate, advertising_rate, return_loss_rate,
			   storage_months, inbound_placement_mode, usd_to_rmb_rate,
			   usd_to_rmb_rate_source, size_tier, size_tier_label, price_band,
			   price_band_label, longest_side_in, middle_side_in,
			   shortest_side_in, length_plus_girth_in, volume_cubic_in,
			   volume_cubic_ft, product_weight_lb, product_weight_oz,
			   dimensional_weight_lb, chargeable_weight_lb, chargeable_weight_oz,
			   chargeable_weight_rule, fulfillment_fee_rule_label,
			   inbound_config_fee_rule_label, storage_fee_rule_label,
			   referral_fee_usd, advertising_fee_usd, return_loss_usd,
			   fba_fulfillment_fee_usd, inbound_config_fee_usd, storage_fee_usd,
			   total_fee_usd, platform_fee_usd, delivery_fee_usd,
			   inbound_config_fee_manual_usd, storage_fee_manual_usd, payout_usd,
			   profit_usd, profit_rate, vat_usd, profit_after_vat_usd,
			   profit_after_vat_rate, warnings_json, notes
			 )
			 select $3, source_row_no, project_id, project_name, sku, asin,
			        country, accounting_type, package_length_cm, package_width_cm,
			        package_height_cm, weight_kg, fob_product_cost_rmb,
			        first_leg_cost_rmb, ddp_cost_rmb, ddp_cost_usd, sale_price_usd,
			        null, advertising_rate, return_loss_rate, storage_months,
			        inbound_placement_mode, usd_to_rmb_rate, usd_to_rmb_rate_source,
			        size_tier, size_tier_label, price_band, price_band_label,
			        longest_side_in, middle_side_in, shortest_side_in,
			        length_plus_girth_in, volume_cubic_in, volume_cubic_ft,
			        product_weight_lb, product_weight_oz, dimensional_weight_lb,
			        chargeable_weight_lb, chargeable_weight_oz,
			        chargeable_weight_rule, fulfillment_fee_rule_label,
			        inbound_config_fee_rule_label, storage_fee_rule_label,
			        referral_fee_usd, advertising_fee_usd, return_loss_usd,
			        fba_fulfillment_fee_usd, inbound_config_fee_usd, storage_fee_usd,
			        total_fee_usd, platform_fee_usd, delivery_fee_usd,
			        inbound_config_fee_manual_usd, storage_fee_manual_usd, payout_usd,
			        profit_usd, profit_rate, vat_usd, profit_after_vat_usd,
			        profit_after_vat_rate, warnings_json, notes
			 from numbered`,
			projectID,
			country,
			snapshotID,
		)
		return err
	})
	if err != nil {
		return 0, err
	}
	return snapshotID, nil
}

func (s *PricingCalculationSnapshotStore) Update(
	ctx context.Context,
	snapshotID int64,
	name *string,
	description *string,
	operator string,
) (*pricing_calculation_snapshots.SnapshotListItem, error) {
	setParts := make([]string, 0, 4)
	args := make([]any, 0, 4)
	if name != nil {
		args = append(args, snapshotOptionalStoreText(name, 255))
		setParts = append(setParts, fmt.Sprintf("name = $%d", len(args)))
	}
	if description != nil {
		args = append(args, snapshotOptionalStoreText(description, 4000))
		setParts = append(setParts, fmt.Sprintf("description = $%d", len(args)))
	}
	if strings.TrimSpace(operator) != "" {
		args = append(args, snapshotOptionalStoreText(snapshotStringPtr(operator), 255))
		setParts = append(setParts, fmt.Sprintf("created_by = $%d", len(args)))
	}
	if len(setParts) == 0 {
		return s.getHeader(ctx, snapshotID)
	}
	args = append(args, snapshotID)
	query := `update public.pricing_calculation_snapshots set ` +
		strings.Join(setParts, ", ") +
		fmt.Sprintf(" where id = $%d returning ", len(args)) +
		snapshotHeaderSelect
	item, err := scanSnapshotListRow(s.db.QueryRow(ctx, query, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, pricing_calculation_snapshots.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *PricingCalculationSnapshotStore) Delete(ctx context.Context, snapshotID int64) (bool, error) {
	var deletedID int64
	err := s.db.QueryRow(
		ctx,
		`delete from public.pricing_calculation_snapshots where id = $1 returning id`,
		snapshotID,
	).Scan(&deletedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

const snapshotItemSelect = `
	id, snapshot_id, source_row_no, project_id, project_name, sku, asin,
	country, calculation_type, package_length_cm, package_width_cm,
	package_height_cm, weight_kg, fob_product_cost_rmb, first_leg_cost_rmb,
	ddp_cost_rmb, ddp_cost_usd, sale_price_usd, advertising_rate,
	return_loss_rate, storage_months, inbound_placement_mode, usd_to_rmb_rate,
	usd_to_rmb_rate_source, size_tier, size_tier_label, price_band,
	price_band_label, longest_side_in, middle_side_in, shortest_side_in,
	length_plus_girth_in, volume_cubic_in, volume_cubic_ft, product_weight_lb,
	product_weight_oz, dimensional_weight_lb, chargeable_weight_lb,
	chargeable_weight_oz, chargeable_weight_rule, fulfillment_fee_rule_label,
	inbound_config_fee_rule_label, storage_fee_rule_label, referral_fee_usd,
	advertising_fee_usd, return_loss_usd, fba_fulfillment_fee_usd,
	inbound_config_fee_usd, storage_fee_usd, total_fee_usd, platform_fee_usd,
	delivery_fee_usd, inbound_config_fee_manual_usd, storage_fee_manual_usd,
	payout_usd, profit_usd, profit_rate, vat_usd, profit_after_vat_usd,
	profit_after_vat_rate, coalesce(warnings_json::text, '[]'), notes, created_at`

func (s *PricingCalculationSnapshotStore) querySnapshotItems(
	ctx context.Context,
	snapshotID int64,
) ([]pricing_calculation_snapshots.SnapshotItem, error) {
	rows, err := s.db.Query(
		ctx,
		`select `+snapshotItemSelect+`
		 from public.pricing_calculation_snapshot_items
		 where snapshot_id = $1
		 order by source_row_no asc`,
		snapshotID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]pricing_calculation_snapshots.SnapshotItem, 0)
	for rows.Next() {
		item, err := scanSnapshotItem(rows, snapshotID)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func scanSnapshotListRow(row rowScanner) (pricing_calculation_snapshots.SnapshotListItem, error) {
	var item pricing_calculation_snapshots.SnapshotListItem
	var snapshotDate, createdAt time.Time
	var summaryRaw string
	err := row.Scan(
		&item.ID,
		&item.ProjectID,
		&item.ProjectName,
		&item.Country,
		&snapshotDate,
		&item.Name,
		&item.Description,
		&item.RowCount,
		&item.CreatedBy,
		&createdAt,
		&summaryRaw,
	)
	if err != nil {
		return item, err
	}
	item.SnapshotDate = httpapi.Timestamp(snapshotDate)
	item.CreatedAt = httpapi.Timestamp(createdAt)
	item.Summary = parseSnapshotSummary(summaryRaw)
	return item, nil
}

func parseSnapshotSummary(raw string) pricing_calculation_snapshots.SnapshotSummary {
	var summary pricing_calculation_snapshots.SnapshotSummary
	if err := json.Unmarshal([]byte(raw), &summary); err != nil {
		return pricing_calculation_snapshots.SnapshotSummary{}
	}
	return summary
}

func scanSnapshotItem(row rowScanner, snapshotID int64) (pricing_calculation_snapshots.SnapshotItem, error) {
	var (
		item                                pricing_calculation_snapshots.SnapshotItem
		dbID, storedSnapshotID, sourceRowNo int64
		country                             *string
		profitAfterVATUSD, profitAfterRate  *float64
		warningsRaw                         string
		createdAt                           time.Time
	)
	err := row.Scan(
		&dbID, &storedSnapshotID, &sourceRowNo, &item.ProjectID, &item.ProjectName,
		&item.SKU, &item.ASIN, &country, &item.AccountingType,
		&item.PackageLengthCM, &item.PackageWidthCM, &item.PackageHeightCM,
		&item.WeightKG, &item.FOBProductCostRMB, &item.FirstLegCostRMB,
		&item.DDPCostRMB, &item.DDPCostUSD, &item.SalePriceUSD,
		&item.AdvertisingRate, &item.ReturnLossRate, &item.StorageMonths,
		&item.InboundPlacementMode, &item.USDToRMBRate,
		&item.USDToRMBRateSource, &item.SizeTier, &item.SizeTierLabel,
		&item.PriceBand, &item.PriceBandLabel,
		&item.Dimensions.LongestSideIn, &item.Dimensions.MiddleSideIn,
		&item.Dimensions.ShortestSideIn, &item.Dimensions.LengthPlusGirthIn,
		&item.Dimensions.VolumeCubicIn, &item.Dimensions.VolumeCubicFt,
		&item.Weights.ProductWeightLb, &item.Weights.ProductWeightOz,
		&item.Weights.DimensionalWeightLb, &item.Weights.ChargeableWeightLb,
		&item.Weights.ChargeableWeightOz, &item.Weights.ChargeableWeightRule,
		&item.FulfillmentFeeRuleLabel, &item.InboundConfigFeeRuleLabel,
		&item.StorageFeeRuleLabel, &item.Fees.ReferralFeeUSD,
		&item.Fees.AdvertisingFeeUSD, &item.Fees.ReturnLossUSD,
		&item.Fees.FBAFulfillmentFeeUSD, &item.Fees.InboundConfigFeeUSD,
		&item.Fees.StorageFeeUSD, &item.Fees.TotalFeeUSD,
		&item.Fees.PlatformFeeUSD, &item.Fees.DeliveryFeeUSD,
		&item.Fees.InboundConfigFeeManualUSD, &item.Fees.StorageFeeManualUSD,
		&item.Profit.PayoutUSD, &item.Profit.ProfitUSD, &item.Profit.ProfitRate,
		&item.Profit.VATUSD, &profitAfterVATUSD, &profitAfterRate,
		&warningsRaw, &item.Notes, &createdAt,
	)
	if err != nil {
		return item, err
	}
	item.ID = snapshotID*1_000_000 + sourceRowNo
	item.Country = "US"
	if country != nil && strings.TrimSpace(*country) != "" {
		item.Country = normalizeCountry(*country)
	}
	item.Profit.DDPCostRMB = item.DDPCostRMB
	item.Profit.DDPCostUSD = item.DDPCostUSD
	item.Profit.ProfitAfterVATUSD = profitAfterVATUSD
	item.Profit.ProfitAfterVATRate = profitAfterRate
	if err := json.Unmarshal([]byte(warningsRaw), &item.Warnings); err != nil || item.Warnings == nil {
		item.Warnings = []string{}
	}
	item.CreatedBy = nil
	item.ObservedAt = httpapi.Timestamp(createdAt)
	item.Source = "manual"
	item.CreatedAt = item.ObservedAt
	item.UpdatedAt = item.ObservedAt
	item.Anchor = snapshotAnchor(item)
	_ = dbID
	_ = storedSnapshotID
	return item, nil
}

func snapshotAnchor(item pricing_calculation_snapshots.SnapshotItem) *pricing_calculation_snapshots.SnapshotAnchor {
	nonAdRat := snapshotRatRound(
		new(big.Rat).Sub(
			snapshotDecimal(item.Fees.TotalFeeUSD),
			snapshotDecimal(item.Fees.AdvertisingFeeUSD),
		),
		2,
	)
	nonAd := snapshotRatFloat(nonAdRat)
	if item.SalePriceUSD <= 0 {
		return &pricing_calculation_snapshots.SnapshotAnchor{
			NonAdFeeUSD: &nonAd,
			Basis: pricing_calculation_snapshots.SnapshotAnchorBasis{
				ObservedAt:         snapshotStringPtr(item.ObservedAt),
				USDToRMBRate:       snapshotFloatPtr(item.USDToRMBRate),
				USDToRMBRateSource: snapshotStringPtr(item.USDToRMBRateSource),
			},
		}
	}
	ddp := snapshotRatRound(snapshotDecimal(item.Profit.DDPCostUSD), 2)
	price := snapshotRatRound(snapshotDecimal(item.SalePriceUSD), 2)
	breakevenRat := snapshotBreakeven(nonAdRat, ddp, price, nil)
	breakeven := snapshotRatFloat(breakevenRat)
	maxAdSpend := snapshotRatFloat(
		snapshotRatRound(new(big.Rat).Mul(price, breakevenRat), 2),
	)
	anchor := &pricing_calculation_snapshots.SnapshotAnchor{
		BreakevenAdvertisingRate: &breakeven,
		NonAdFeeUSD:              &nonAd,
		MaxAdSpendPerUnitUSD:     &maxAdSpend,
		Basis: pricing_calculation_snapshots.SnapshotAnchorBasis{
			ObservedAt:         snapshotStringPtr(item.ObservedAt),
			USDToRMBRate:       snapshotFloatPtr(item.USDToRMBRate),
			USDToRMBRateSource: snapshotStringPtr(item.USDToRMBRateSource),
		},
	}
	if item.Profit.ProfitAfterVATRate != nil {
		vat := snapshotRatRound(snapshotDecimal(item.Profit.VATUSD), 2)
		afterVAT := snapshotRatFloat(snapshotBreakeven(nonAdRat, ddp, price, vat))
		anchor.BreakevenAdvertisingRateAfterVAT = &afterVAT
	}
	return anchor
}

func snapshotBreakeven(nonAdFee, ddpCost, salePrice, vat *big.Rat) *big.Rat {
	totalCost := new(big.Rat).Add(new(big.Rat).Set(nonAdFee), ddpCost)
	if vat != nil {
		totalCost.Add(totalCost, vat)
	}
	rate := new(big.Rat).Sub(big.NewRat(1, 1), new(big.Rat).Quo(totalCost, salePrice))
	return snapshotRatRound(rate, 4)
}

func snapshotDecimal(value float64) *big.Rat {
	decimal, ok := new(big.Rat).SetString(strconv.FormatFloat(value, 'f', -1, 64))
	if !ok {
		return new(big.Rat)
	}
	return decimal
}

func snapshotRatRound(value *big.Rat, decimals int) *big.Rat {
	factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	scaledNumerator := new(big.Int).Mul(value.Num(), factor)
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(scaledNumerator, value.Denom(), remainder)
	absRemainder := new(big.Int).Abs(remainder)
	twiceRemainder := new(big.Int).Lsh(absRemainder, 1)
	if twiceRemainder.Cmp(value.Denom()) >= 0 {
		if scaledNumerator.Sign() < 0 {
			quotient.Sub(quotient, big.NewInt(1))
		} else {
			quotient.Add(quotient, big.NewInt(1))
		}
	}
	return new(big.Rat).SetFrac(quotient, factor)
}

func snapshotRatFloat(value *big.Rat) float64 {
	result, _ := value.Float64()
	return result
}

func snapshotRoundHalfUp(value float64, decimals int) float64 {
	rat, ok := new(big.Rat).SetString(strconv.FormatFloat(value, 'f', -1, 64))
	if !ok {
		return 0
	}
	factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	scaledNumerator := new(big.Int).Mul(rat.Num(), factor)
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(scaledNumerator, rat.Denom(), remainder)
	absRemainder := new(big.Int).Abs(remainder)
	twiceRemainder := new(big.Int).Lsh(absRemainder, 1)
	if twiceRemainder.Cmp(rat.Denom()) >= 0 {
		if scaledNumerator.Sign() < 0 {
			quotient.Sub(quotient, big.NewInt(1))
		} else {
			quotient.Add(quotient, big.NewInt(1))
		}
	}
	rounded := new(big.Rat).SetFrac(quotient, factor)
	result, _ := rounded.Float64()
	return result
}

func snapshotFloatPtr(value float64) *float64 {
	return &value
}

func snapshotStringPtr(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func snapshotOptionalStoreText(value *string, maxRunes int) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	runes := []rune(trimmed)
	if len(runes) > maxRunes {
		trimmed = string(runes[:maxRunes])
	}
	return &trimmed
}

type snapshotPagination struct {
	offset int
	size   int
}

func normalizedSnapshotPagination(page, pageSize, defaultPageSize, maxPageSize int) snapshotPagination {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = defaultPageSize
	}
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}
	return snapshotPagination{offset: (page - 1) * pageSize, size: pageSize}
}
