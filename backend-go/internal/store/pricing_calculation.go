package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/pricing_calculation"
)

type PricingCalculationStore struct {
	db FullDB
}

func NewPricingCalculationStore(db FullDB) *PricingCalculationStore {
	return &PricingCalculationStore{db: db}
}

func (s *PricingCalculationStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, pricing_calculation.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &PricingCalculationStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

const pricingRunSelectColumns = `
	id, country, product_name, calculation_type, project_id, sku,
	package_length_cm, package_width_cm, package_height_cm, weight_kg,
	fob_product_cost_rmb, first_leg_cost_rmb, first_leg_unit_price_rmb_per_kg,
	ddp_cost_rmb, ddp_cost_usd, sale_price_usd, commission_rate,
	advertising_rate, return_loss_rate,
	storage_months, inbound_placement_mode, usd_to_rmb_rate, usd_to_rmb_rate_source,
	size_tier, size_tier_label, price_band, price_band_label,
	longest_side_in, middle_side_in, shortest_side_in, length_plus_girth_in,
	volume_cubic_in, volume_cubic_ft, product_weight_lb, product_weight_oz,
	dimensional_weight_lb, chargeable_weight_lb, chargeable_weight_oz,
	chargeable_weight_rule, fulfillment_fee_rule_label,
	inbound_config_fee_rule_label, storage_fee_rule_label,
	referral_fee_usd, advertising_fee_usd, return_loss_usd,
	fba_fulfillment_fee_usd, inbound_config_fee_usd, storage_fee_usd, total_fee_usd,
	payout_usd, profit_usd, profit_rate, vat_usd, profit_after_vat_usd,
	profit_after_vat_rate, delivery_fee_usd, platform_fee_usd,
	full_container_quantity, full_container_price_rmb,
	warnings_json, created_by, competitor_url, created_at, updated_at`

func (s *PricingCalculationStore) GetLatestExchangeRate(
	ctx context.Context,
	currency string,
) (float64, string, error) {
	var rate pgtype.Numeric
	var yearMonth string
	err := s.db.QueryRow(ctx, `
		select rate, year_month
		from public.exchange_rates
		where currency = $1
		order by year_month desc, id desc
		limit 1
	`, strings.ToUpper(strings.TrimSpace(currency))).Scan(&rate, &yearMonth)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", pricing_calculation.ErrExchangeRateNotFound
	}
	if err != nil {
		return 0, "", err
	}
	value, err := numericFloat64(rate)
	if err != nil {
		return 0, "", fmt.Errorf("decode %s exchange rate: %w", currency, err)
	}
	return value, yearMonth, nil
}

func (s *PricingCalculationStore) GetHistoricalShippingCost(
	ctx context.Context,
	projectID int64,
	sku string,
) (*float64, error) {
	var value pgtype.Numeric
	err := s.db.QueryRow(ctx, `
		select average_logistics_unit_price
		from public.shipment_sku_summaries
		where project_id = $1 and sku = $2
		limit 1
	`, projectID, strings.TrimSpace(sku)).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !value.Valid {
		return nil, nil
	}
	cost, err := numericFloat64(value)
	if err != nil {
		return nil, fmt.Errorf("decode historical shipping cost: %w", err)
	}
	return &cost, nil
}

func (s *PricingCalculationStore) VerifyProjectAccess(
	ctx context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) error {
	var projectOperator, assistantOperator pgtype.Text
	err := s.db.QueryRow(
		ctx,
		`select project_operator, assistant_operator from public.projects where id = $1`,
		projectID,
	).Scan(&projectOperator, &assistantOperator)
	if errors.Is(err, pgx.ErrNoRows) {
		return pricing_calculation.ErrProjectNotFound
	}
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return pricing_calculation.ErrProjectForbidden
	}
	if textContainsName(Text(projectOperator), operator) || textContainsName(Text(assistantOperator), operator) {
		return nil
	}
	return pricing_calculation.ErrProjectForbidden
}

func (s *PricingCalculationStore) CreateRun(
	ctx context.Context,
	item pricing_calculation.RunItem,
) (pricing_calculation.RunItem, error) {
	warnings, err := json.Marshal(nonNilPricingWarnings(item.Warnings))
	if err != nil {
		return pricing_calculation.RunItem{}, fmt.Errorf("encode pricing warnings: %w", err)
	}
	notes := (*string)(nil)
	if len(item.Warnings) > 0 {
		value := strings.Join(item.Warnings, "\n")
		notes = &value
	}
	row := s.db.QueryRow(ctx, `
		insert into public.pricing_calculation_runs (
			country, product_name, calculation_type, project_id, sku,
			package_length_cm, package_width_cm, package_height_cm, weight_kg,
			fob_product_cost_rmb, first_leg_cost_rmb, first_leg_unit_price_rmb_per_kg,
			ddp_cost_rmb, ddp_cost_usd, sale_price_usd,
			commission_rate, advertising_rate, return_loss_rate, storage_months,
			inbound_placement_mode, usd_to_rmb_rate, usd_to_rmb_rate_source,
			size_tier, size_tier_label, price_band, price_band_label,
			longest_side_in, middle_side_in, shortest_side_in, length_plus_girth_in,
			volume_cubic_in, volume_cubic_ft, product_weight_lb, product_weight_oz,
			dimensional_weight_lb, chargeable_weight_lb, chargeable_weight_oz,
			chargeable_weight_rule, fulfillment_fee_rule_label,
			inbound_config_fee_rule_label, storage_fee_rule_label,
			referral_fee_usd, advertising_fee_usd, return_loss_usd,
			fba_fulfillment_fee_usd, inbound_config_fee_usd, storage_fee_usd, total_fee_usd,
			payout_usd, profit_usd, profit_rate, vat_usd, profit_after_vat_usd,
			profit_after_vat_rate, delivery_fee_usd, platform_fee_usd,
			full_container_quantity, full_container_price_rmb,
			warnings_json, notes, created_by, competitor_url
		) values (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
			$11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
			$21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
			$31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
			$41, $42, $43, $44, $45, $46, $47, $48, $49, $50,
			$51, $52, $53, $54, $55, $56, $57, $58, $59, $60,
			$61, $62
		)
		returning `+pricingRunSelectColumns,
		item.Country,
		item.ProductName,
		item.CalculationType,
		item.ProjectID,
		item.SKU,
		item.PackageLengthCM,
		item.PackageWidthCM,
		item.PackageHeightCM,
		item.WeightKG,
		item.FOBProductCostRMB,
		item.FirstLegCostRMB,
		item.FirstLegUnitPriceRMBPerKG,
		item.Profit.DDPCostRMB,
		item.Profit.DDPCostUSD,
		item.SalePriceUSD,
		item.CommissionRate,
		item.AdvertisingRate,
		item.ReturnLossRate,
		item.StorageMonths,
		item.InboundPlacementMode,
		item.USDToRMBRate,
		item.USDToRMBRateSource,
		item.SizeTier,
		item.SizeTierLabel,
		item.PriceBand,
		item.PriceBandLabel,
		item.Dimensions.LongestSideIn,
		item.Dimensions.MiddleSideIn,
		item.Dimensions.ShortestSideIn,
		item.Dimensions.LengthPlusGirthIn,
		item.Dimensions.VolumeCubicIn,
		item.Dimensions.VolumeCubicFt,
		item.Weights.ProductWeightLB,
		item.Weights.ProductWeightOZ,
		item.Weights.DimensionalWeightLB,
		item.Weights.ChargeableWeightLB,
		item.Weights.ChargeableWeightOZ,
		item.Weights.ChargeableWeightRule,
		item.FulfillmentFeeRuleLabel,
		item.InboundConfigFeeRuleLabel,
		item.StorageFeeRuleLabel,
		item.Fees.ReferralFeeUSD,
		item.Fees.AdvertisingFeeUSD,
		item.Fees.ReturnLossUSD,
		item.Fees.FBAFulfillmentFeeUSD,
		item.Fees.InboundConfigFeeUSD,
		item.Fees.StorageFeeUSD,
		item.Fees.TotalFeeUSD,
		item.Profit.PayoutUSD,
		item.Profit.ProfitUSD,
		item.Profit.ProfitRate,
		item.Profit.VATUSD,
		item.Profit.ProfitAfterVATUSD,
		item.Profit.ProfitAfterVATRate,
		item.DeliveryFeeUSD,
		item.Fees.PlatformFeeUSD,
		item.FullContainerQuantity,
		item.FullContainerPriceRMB,
		warnings,
		notes,
		item.CreatedBy,
		item.CompetitorURL,
	)
	created, err := scanPricingRun(row)
	if err != nil {
		return pricing_calculation.RunItem{}, err
	}
	return created, nil
}

func (s *PricingCalculationStore) ListRuns(
	ctx context.Context,
	filter pricing_calculation.RunListFilter,
) ([]pricing_calculation.RunItem, int, error) {
	page := max(filter.Page, 1)
	pageSize := min(max(filter.PageSize, 1), 100)
	where, args, visible := pricingRunWhere(filter)
	if !visible {
		return []pricing_calculation.RunItem{}, 0, nil
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " where " + strings.Join(where, " and ")
	}
	var total int
	if err := s.db.QueryRow(
		ctx,
		"select count(*) from public.pricing_calculation_runs"+whereSQL,
		args...,
	).Scan(&total); err != nil {
		return nil, 0, err
	}
	listArgs := append([]any(nil), args...)
	offset := safeOffset(page, pageSize)
	listArgs = append(listArgs, offset, pageSize)
	rows, err := s.db.Query(
		ctx,
		"select "+pricingRunSelectColumns+" from public.pricing_calculation_runs"+whereSQL+
			fmt.Sprintf(" order by created_at desc, id desc offset $%d limit $%d", len(args)+1, len(args)+2),
		listArgs...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := make([]pricing_calculation.RunItem, 0)
	for rows.Next() {
		item, err := scanPricingRun(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

func (s *PricingCalculationStore) GetRun(
	ctx context.Context,
	runID int64,
) (*pricing_calculation.RunItem, error) {
	item, err := scanPricingRun(s.db.QueryRow(
		ctx,
		"select "+pricingRunSelectColumns+" from public.pricing_calculation_runs where id = $1 limit 1",
		runID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *PricingCalculationStore) DeleteRun(ctx context.Context, runID int64) (bool, error) {
	tag, err := s.db.Exec(ctx, `
		delete from public.pricing_calculation_runs where id = $1
	`, runID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *PricingCalculationStore) UpdateRun(
	ctx context.Context,
	runID int64,
	item pricing_calculation.RunItem,
) (*pricing_calculation.RunItem, error) {
	warnings, err := json.Marshal(nonNilPricingWarnings(item.Warnings))
	if err != nil {
		return nil, fmt.Errorf("encode pricing warnings: %w", err)
	}
	notes := (*string)(nil)
	if len(item.Warnings) > 0 {
		value := strings.Join(item.Warnings, "\n")
		notes = &value
	}
	columns := []string{
		"fob_product_cost_rmb", "first_leg_cost_rmb", "ddp_cost_rmb", "ddp_cost_usd",
		"sale_price_usd", "commission_rate", "advertising_rate", "return_loss_rate",
		"storage_months", "inbound_placement_mode", "usd_to_rmb_rate", "usd_to_rmb_rate_source",
		"size_tier", "size_tier_label", "price_band", "price_band_label",
		"longest_side_in", "middle_side_in", "shortest_side_in", "length_plus_girth_in",
		"volume_cubic_in", "volume_cubic_ft", "product_weight_lb", "product_weight_oz",
		"dimensional_weight_lb", "chargeable_weight_lb", "chargeable_weight_oz",
		"chargeable_weight_rule", "fulfillment_fee_rule_label",
		"inbound_config_fee_rule_label", "storage_fee_rule_label",
		"referral_fee_usd", "advertising_fee_usd", "return_loss_usd",
		"fba_fulfillment_fee_usd", "inbound_config_fee_usd", "storage_fee_usd",
		"total_fee_usd", "payout_usd", "profit_usd", "profit_rate", "vat_usd",
		"profit_after_vat_usd", "profit_after_vat_rate", "delivery_fee_usd",
		"platform_fee_usd", "full_container_quantity", "full_container_price_rmb",
		"warnings_json", "notes",
	}
	args := []any{
		item.FOBProductCostRMB, item.FirstLegCostRMB,
		item.Profit.DDPCostRMB, item.Profit.DDPCostUSD, item.SalePriceUSD,
		item.CommissionRate, item.AdvertisingRate, item.ReturnLossRate,
		item.StorageMonths, item.InboundPlacementMode, item.USDToRMBRate,
		item.USDToRMBRateSource, item.SizeTier, item.SizeTierLabel,
		item.PriceBand, item.PriceBandLabel,
		item.Dimensions.LongestSideIn, item.Dimensions.MiddleSideIn,
		item.Dimensions.ShortestSideIn, item.Dimensions.LengthPlusGirthIn,
		item.Dimensions.VolumeCubicIn, item.Dimensions.VolumeCubicFt,
		item.Weights.ProductWeightLB, item.Weights.ProductWeightOZ,
		item.Weights.DimensionalWeightLB, item.Weights.ChargeableWeightLB,
		item.Weights.ChargeableWeightOZ, item.Weights.ChargeableWeightRule,
		item.FulfillmentFeeRuleLabel, item.InboundConfigFeeRuleLabel,
		item.StorageFeeRuleLabel, item.Fees.ReferralFeeUSD,
		item.Fees.AdvertisingFeeUSD, item.Fees.ReturnLossUSD,
		item.Fees.FBAFulfillmentFeeUSD, item.Fees.InboundConfigFeeUSD,
		item.Fees.StorageFeeUSD, item.Fees.TotalFeeUSD,
		item.Profit.PayoutUSD, item.Profit.ProfitUSD, item.Profit.ProfitRate,
		item.Profit.VATUSD, item.Profit.ProfitAfterVATUSD, item.Profit.ProfitAfterVATRate,
		item.DeliveryFeeUSD, item.Fees.PlatformFeeUSD,
		item.FullContainerQuantity, item.FullContainerPriceRMB,
		warnings, notes,
	}
	setParts := make([]string, len(columns))
	for index, column := range columns {
		setParts[index] = fmt.Sprintf("%s = $%d", column, index+1)
	}
	args = append(args, runID)
	query := `update public.pricing_calculation_runs set ` +
		strings.Join(setParts, ", ") +
		fmt.Sprintf(", updated_at = now() where id = $%d returning ", len(args)) +
		pricingRunSelectColumns
	row := s.db.QueryRow(ctx, query, args...)
	updated, err := scanPricingRun(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &updated, nil
}

func pricingRunWhere(filter pricing_calculation.RunListFilter) ([]string, []any, bool) {
	where := make([]string, 0, 4)
	args := make([]any, 0, 4)
	add := func(clause string, value any) string {
		args = append(args, value)
		return fmt.Sprintf(clause, len(args))
	}
	if filter.ExcludeProjectID {
		where = append(where, "project_id is null")
	}
	if strings.TrimSpace(filter.Country) != "" {
		where = append(where, add("country = $%d", strings.TrimSpace(filter.Country)))
	}
	if !filter.IsAdmin {
		operator := strings.TrimSpace(filter.Operator)
		if operator == "" {
			return nil, nil, false
		}
		where = append(where, add("created_by = $%d", operator))
	}
	if keyword := strings.TrimSpace(filter.Keyword); keyword != "" {
		pattern := "%" + keyword + "%"
		args = append(args, pattern)
		placeholder := len(args)
		where = append(where, fmt.Sprintf("(product_name ilike $%d or coalesce(created_by, '') ilike $%d)", placeholder, placeholder))
	}
	return where, args, true
}

type pricingRunScanner interface {
	Scan(dest ...any) error
}

func scanPricingRun(row pricingRunScanner) (pricing_calculation.RunItem, error) {
	var (
		item                  pricing_calculation.RunItem
		projectID             pgtype.Int8
		sku                   pgtype.Text
		firstLegUnitPrice     pgtype.Float8
		profitAfterVAT        pgtype.Float8
		profitAfterVATRate    pgtype.Float8
		deliveryFee           pgtype.Float8
		platformFee           pgtype.Float8
		fullContainerQuantity pgtype.Float8
		fullContainerPrice    pgtype.Float8
		warningsJSON          []byte
		createdBy             pgtype.Text
		competitorURL         pgtype.Text
		createdAt             time.Time
		updatedAt             time.Time
	)
	err := row.Scan(
		&item.ID,
		&item.Country,
		&item.ProductName,
		&item.CalculationType,
		&projectID,
		&sku,
		&item.PackageLengthCM,
		&item.PackageWidthCM,
		&item.PackageHeightCM,
		&item.WeightKG,
		&item.FOBProductCostRMB,
		&item.FirstLegCostRMB,
		&firstLegUnitPrice,
		&item.Profit.DDPCostRMB,
		&item.Profit.DDPCostUSD,
		&item.SalePriceUSD,
		&item.CommissionRate,
		&item.AdvertisingRate,
		&item.ReturnLossRate,
		&item.StorageMonths,
		&item.InboundPlacementMode,
		&item.USDToRMBRate,
		&item.USDToRMBRateSource,
		&item.SizeTier,
		&item.SizeTierLabel,
		&item.PriceBand,
		&item.PriceBandLabel,
		&item.Dimensions.LongestSideIn,
		&item.Dimensions.MiddleSideIn,
		&item.Dimensions.ShortestSideIn,
		&item.Dimensions.LengthPlusGirthIn,
		&item.Dimensions.VolumeCubicIn,
		&item.Dimensions.VolumeCubicFt,
		&item.Weights.ProductWeightLB,
		&item.Weights.ProductWeightOZ,
		&item.Weights.DimensionalWeightLB,
		&item.Weights.ChargeableWeightLB,
		&item.Weights.ChargeableWeightOZ,
		&item.Weights.ChargeableWeightRule,
		&item.FulfillmentFeeRuleLabel,
		&item.InboundConfigFeeRuleLabel,
		&item.StorageFeeRuleLabel,
		&item.Fees.ReferralFeeUSD,
		&item.Fees.AdvertisingFeeUSD,
		&item.Fees.ReturnLossUSD,
		&item.Fees.FBAFulfillmentFeeUSD,
		&item.Fees.InboundConfigFeeUSD,
		&item.Fees.StorageFeeUSD,
		&item.Fees.TotalFeeUSD,
		&item.Profit.PayoutUSD,
		&item.Profit.ProfitUSD,
		&item.Profit.ProfitRate,
		&item.Profit.VATUSD,
		&profitAfterVAT,
		&profitAfterVATRate,
		&deliveryFee,
		&platformFee,
		&fullContainerQuantity,
		&fullContainerPrice,
		&warningsJSON,
		&createdBy,
		&competitorURL,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return pricing_calculation.RunItem{}, err
	}
	if projectID.Valid {
		value := projectID.Int64
		item.ProjectID = &value
	}
	item.SKU = Text(sku)
	item.FirstLegUnitPriceRMBPerKG = pricingFloat8Pointer(firstLegUnitPrice)
	item.Profit.ProfitAfterVATUSD = pricingFloat8Pointer(profitAfterVAT)
	item.Profit.ProfitAfterVATRate = pricingFloat8Pointer(profitAfterVATRate)
	if deliveryFee.Valid {
		item.DeliveryFeeUSD = deliveryFee.Float64
	}
	if platformFee.Valid {
		item.Fees.PlatformFeeUSD = platformFee.Float64
	}
	if fullContainerQuantity.Valid {
		item.FullContainerQuantity = fullContainerQuantity.Float64
	}
	if fullContainerPrice.Valid {
		item.FullContainerPriceRMB = fullContainerPrice.Float64
	}
	item.CreatedBy = Text(createdBy)
	item.CompetitorURL = Text(competitorURL)
	item.CreatedAt = createdAt.Format(time.RFC3339Nano)
	item.UpdatedAt = updatedAt.Format(time.RFC3339Nano)
	item.Warnings = nonNilPricingWarnings(nil)
	if len(warningsJSON) > 0 {
		if err := json.Unmarshal(warningsJSON, &item.Warnings); err != nil {
			return pricing_calculation.RunItem{}, fmt.Errorf("decode pricing warnings: %w", err)
		}
		item.Warnings = nonNilPricingWarnings(item.Warnings)
	}
	return item, nil
}

func pricingFloat8Pointer(value pgtype.Float8) *float64 {
	if !value.Valid {
		return nil
	}
	result := value.Float64
	return &result
}

func nonNilPricingWarnings(value []string) []string {
	if value == nil {
		return []string{}
	}
	return value
}
