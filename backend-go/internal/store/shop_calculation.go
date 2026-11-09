package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shop_calculation"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type ShopCalculationStore struct {
	db FullDB
}

func NewShopCalculationStore(db FullDB) *ShopCalculationStore {
	return &ShopCalculationStore{db: db}
}

func (s *ShopCalculationStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, shop_calculation.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &ShopCalculationStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

const shopCalculationSelectColumns = `
	id, project_id, project_name, sku, asin, country, accounting_type,
	package_length_cm, package_width_cm, package_height_cm, weight_kg,
	fob_product_cost_rmb, first_leg_cost_rmb, ddp_cost_rmb, ddp_cost_usd,
	sale_price_usd, advertising_rate, return_loss_rate, storage_months,
	inbound_placement_mode, usd_to_rmb_rate, usd_to_rmb_rate_source,
	size_tier, size_tier_label, price_band, price_band_label,
	longest_side_in, middle_side_in, shortest_side_in, length_plus_girth_in,
	volume_cubic_in, volume_cubic_ft, product_weight_lb, product_weight_oz,
	dimensional_weight_lb, chargeable_weight_lb, chargeable_weight_oz,
	chargeable_weight_rule, fulfillment_fee_rule_label,
	inbound_config_fee_rule_label, storage_fee_rule_label,
	referral_fee_usd, advertising_fee_usd, return_loss_usd,
	fba_fulfillment_fee_usd, inbound_config_fee_usd, storage_fee_usd,
	total_fee_usd, delivery_fee_usd, inbound_config_fee_manual_usd,
	storage_fee_manual_usd, platform_fee_usd, payout_usd, profit_usd,
	profit_rate, vat_usd, profit_after_vat_usd, profit_after_vat_rate,
	warnings_json::text, notes, created_by, observed_at, source, created_at, updated_at`

func (s *ShopCalculationStore) VerifyProjectAccess(
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
		return shop_calculation.ErrProjectNotFound
	}
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return shop_calculation.ErrProjectForbidden
	}
	if textContainsName(projectOperator, operator) || textContainsName(assistantOperator, operator) {
		return nil
	}
	return shop_calculation.ErrProjectForbidden
}

func (s *ShopCalculationStore) AccessibleProjectIDs(
	ctx context.Context,
	operator string,
) ([]int64, error) {
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return []int64{}, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select id
		 from public.projects
		 where coalesce(is_active, true) = true
		   and (
		     exists (
		       select 1 from unnest(regexp_split_to_array(
		         coalesce(project_operator, ''),
		         '[、,，;[:space:]]+'
		       )) as names(value)
		       where btrim(names.value) = $1
		     )
		     or exists (
		       select 1 from unnest(regexp_split_to_array(
		         coalesce(assistant_operator, ''),
		         '[、,，;[:space:]]+'
		       )) as names(value)
		       where btrim(names.value) = $1
		     )
		   )
		 order by sort_order asc, id asc`,
		operator,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func (s *ShopCalculationStore) List(
	ctx context.Context,
	filter shop_calculation.ShopCalculationListFilter,
) ([]shop_calculation.ShopCalculationItem, int, error) {
	page := filter.Page
	if page < 1 {
		page = 1
	}
	pageSize := filter.PageSize
	if pageSize < 1 {
		pageSize = 200
	}
	if pageSize > 500 {
		pageSize = 500
	}

	conditions, args := shopCalculationListConditions(filter)
	where := ""
	if len(conditions) > 0 {
		where = " where " + strings.Join(conditions, " and ")
	}
	cte := currentShopCalculationsCTE("")

	var total int
	if err := s.db.QueryRow(
		ctx,
		cte+` select count(*) from current_rows`+where,
		args...,
	).Scan(&total); err != nil {
		return nil, 0, err
	}

	queryArgs := append([]any(nil), args...)
	queryArgs = append(queryArgs, pageSize, httpapi.SafeOffset(page, pageSize))
	query := cte + ` select ` + shopCalculationSelectColumns + `
		from current_rows` + where + fmt.Sprintf(
		" order by observed_at desc, id desc limit $%d offset $%d",
		len(queryArgs)-1,
		len(queryArgs),
	)
	rows, err := s.db.Query(ctx, query, queryArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := make([]shop_calculation.ShopCalculationItem, 0)
	for rows.Next() {
		item, err := scanShopCalculationItem(rows)
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

func shopCalculationListConditions(
	filter shop_calculation.ShopCalculationListFilter,
) ([]string, []any) {
	conditions := make([]string, 0, 3)
	args := make([]any, 0, 5)
	if filter.ProjectID != nil {
		args = append(args, *filter.ProjectID)
		conditions = append(conditions, fmt.Sprintf("project_id = $%d", len(args)))
	}
	if len(filter.ProjectIDs) > 0 {
		args = append(args, filter.ProjectIDs)
		conditions = append(conditions, fmt.Sprintf("project_id::bigint = any($%d::bigint[])", len(args)))
	}
	if filter.Country != nil {
		args = append(args, *filter.Country)
		conditions = append(conditions, fmt.Sprintf("country = $%d", len(args)))
	}
	return conditions, args
}

func (s *ShopCalculationStore) History(
	ctx context.Context,
	filter shop_calculation.ShopCalculationHistoryFilter,
) ([]shop_calculation.ShopCalculationItem, error) {
	conditions := []string{"project_id = $1"}
	args := []any{filter.ProjectID}
	if filter.SKU != nil {
		args = append(args, *filter.SKU)
		conditions = append(conditions, fmt.Sprintf("sku = $%d", len(args)))
	}
	if filter.Country != nil {
		args = append(args, *filter.Country)
		conditions = append(conditions, fmt.Sprintf("country = $%d", len(args)))
	}
	if !filter.IncludeDeleted {
		conditions = append(conditions, "deleted_at is null")
	}

	rows, err := s.db.Query(
		ctx,
		`select `+shopCalculationSelectColumns+`
		 from public.shop_calculation
		 where `+strings.Join(conditions, " and ")+`
		 order by observed_at desc, id desc`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]shop_calculation.ShopCalculationItem, 0)
	for rows.Next() {
		item, err := scanShopCalculationItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *ShopCalculationStore) Append(
	ctx context.Context,
	request shop_calculation.ShopCalculationCreateRequest,
	operator string,
) (shop_calculation.ShopCalculationItem, error) {
	if request.AccountingType == "" {
		request.AccountingType = "profit_calc"
	}
	source := strings.TrimSpace(request.Source)
	if source == "" {
		source = "manual"
	}
	warnings := request.Warnings
	if warnings == nil {
		warnings = []string{}
	}
	warningsJSON, err := json.Marshal(warnings)
	if err != nil {
		return shop_calculation.ShopCalculationItem{}, err
	}

	columns := []string{
		"project_id", "project_name", "sku", "asin", "country", "accounting_type",
		"package_length_cm", "package_width_cm", "package_height_cm", "weight_kg",
		"fob_product_cost_rmb", "first_leg_cost_rmb", "ddp_cost_rmb", "ddp_cost_usd",
		"sale_price_usd", "advertising_rate", "return_loss_rate", "storage_months",
		"inbound_placement_mode", "usd_to_rmb_rate", "usd_to_rmb_rate_source",
		"size_tier", "size_tier_label", "price_band", "price_band_label",
		"longest_side_in", "middle_side_in", "shortest_side_in", "length_plus_girth_in",
		"volume_cubic_in", "volume_cubic_ft", "product_weight_lb", "product_weight_oz",
		"dimensional_weight_lb", "chargeable_weight_lb", "chargeable_weight_oz",
		"chargeable_weight_rule", "fulfillment_fee_rule_label",
		"inbound_config_fee_rule_label", "storage_fee_rule_label",
		"referral_fee_usd", "advertising_fee_usd", "return_loss_usd",
		"fba_fulfillment_fee_usd", "inbound_config_fee_usd", "storage_fee_usd",
		"total_fee_usd", "delivery_fee_usd", "inbound_config_fee_manual_usd",
		"storage_fee_manual_usd", "platform_fee_usd", "payout_usd", "profit_usd",
		"profit_rate", "vat_usd", "profit_after_vat_usd", "profit_after_vat_rate",
		"warnings_json", "notes", "created_by", "observed_at", "source",
	}
	args := []any{
		request.ProjectID, request.ProjectName, request.SKU, request.ASIN, request.Country, request.AccountingType,
		request.PackageLengthCM, request.PackageWidthCM, request.PackageHeightCM, request.WeightKG,
		request.FOBProductCostRMB, request.FirstLegCostRMB, request.DDPCostRMB, request.DDPCostUSD,
		request.SalePriceUSD, request.AdvertisingRate, request.ReturnLossRate, request.StorageMonths,
		request.InboundPlacementMode, request.USDToRMBRate, request.USDToRMBRateSource,
		request.SizeTier, request.SizeTierLabel, request.PriceBand, request.PriceBandLabel,
		request.LongestSideIn, request.MiddleSideIn, request.ShortestSideIn, request.LengthPlusGirthIn,
		request.VolumeCubicIn, request.VolumeCubicFt, request.ProductWeightLB, request.ProductWeightOZ,
		request.DimensionalWeightLB, request.ChargeableWeightLB, request.ChargeableWeightOZ,
		request.ChargeableWeightRule, request.FulfillmentFeeRuleLabel,
		request.InboundConfigFeeRuleLabel, request.StorageFeeRuleLabel,
		request.ReferralFeeUSD, request.AdvertisingFeeUSD, request.ReturnLossUSD,
		request.FBAFulfillmentFeeUSD, request.InboundConfigFeeUSD, request.StorageFeeUSD,
		request.TotalFeeUSD, request.DeliveryFeeUSD, request.InboundConfigFeeManualUSD,
		request.StorageFeeManualUSD, request.PlatformFeeUSD, request.PayoutUSD, request.ProfitUSD,
		request.ProfitRate, request.VATUSD, request.ProfitAfterVATUSD, request.ProfitAfterVATRate,
		warningsJSON, request.Notes, nullableShopText(operator), request.ObservedAt, source,
	}
	placeholders := make([]string, len(args))
	for i := range args {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}
	placeholders[57] += "::json"
	placeholders[60] = "coalesce($" + fmt.Sprint(61) + "::timestamptz, now())"

	query := `insert into public.shop_calculation (` + strings.Join(columns, ", ") + `)
		values (` + strings.Join(placeholders, ", ") + `)
		returning ` + shopCalculationSelectColumns
	item, err := scanShopCalculationItem(s.db.QueryRow(ctx, query, args...))
	if err != nil {
		return shop_calculation.ShopCalculationItem{}, err
	}
	return item, nil
}

func nullableShopText(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func (s *ShopCalculationStore) ProjectIDForItem(ctx context.Context, itemID int64) (int64, error) {
	var projectID int64
	err := s.db.QueryRow(
		ctx,
		`select project_id from public.shop_calculation where id = $1`,
		itemID,
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, shop_calculation.ErrNotFound
	}
	return projectID, err
}

func (s *ShopCalculationStore) DeleteGroup(ctx context.Context, itemID int64) (bool, error) {
	tag, err := s.db.Exec(
		ctx,
		`update public.shop_calculation as target
		 set deleted_at = now(), updated_at = now()
		 where target.deleted_at is null
		   and (target.project_id, target.sku, target.country) in (
		     select source.project_id, source.sku, source.country
		     from public.shop_calculation as source
		     where source.id = $1
		   )`,
		itemID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *ShopCalculationStore) AggregateCurrent(
	ctx context.Context,
	projectID int64,
	country string,
) (shop_calculation.ShopCalculationAggregate, error) {
	country = strings.ToUpper(strings.TrimSpace(country))
	filter := "and project_id = $1"
	args := []any{projectID}
	if country != "" {
		filter += " and country = $2"
		args = append(args, country)
	}
	var aggregate shop_calculation.ShopCalculationAggregate
	err := s.db.QueryRow(
		ctx,
		currentShopCalculationsCTE(filter)+`
		 select coalesce(sum(sale_price_usd), 0),
		        coalesce(sum(total_fee_usd), 0),
		        coalesce(sum(fob_product_cost_rmb), 0),
		        coalesce(sum(ddp_cost_rmb), 0),
		        coalesce(sum(ddp_cost_usd), 0)
		 from current_rows`,
		args...,
	).Scan(
		&aggregate.RevenueUSD,
		&aggregate.PlatformFeesUSD,
		&aggregate.ProcurementCostRMB,
		&aggregate.DDPCostRMB,
		&aggregate.DDPCostUSD,
	)
	if err != nil {
		return shop_calculation.ShopCalculationAggregate{}, err
	}
	aggregate.ProfitUSD = math.Round(
		(aggregate.RevenueUSD-aggregate.PlatformFeesUSD-aggregate.DDPCostUSD)*100,
	) / 100
	if aggregate.RevenueUSD != 0 {
		aggregate.GrossMarginRate = math.Round(
			(aggregate.ProfitUSD/aggregate.RevenueUSD)*10000,
		) / 10000
	}
	aggregate.ProjectID = projectID
	aggregate.Country = country
	return aggregate, nil
}

func currentShopCalculationsCTE(additionalFilter string) string {
	return `with latest_ids as (
		select project_id, sku, country, max(id) as id
		from public.shop_calculation
		where deleted_at is null ` + additionalFilter + `
		group by project_id, sku, country
	), current_rows as (
		select sc.*
		from public.shop_calculation as sc
		join latest_ids on latest_ids.id = sc.id
	)`
}

func scanShopCalculationItem(row interface{ Scan(...any) error }) (shop_calculation.ShopCalculationItem, error) {
	var item shop_calculation.ShopCalculationItem
	var asin, notes, createdBy *string
	var afterVATUSD, afterVATRate *float64
	var warningsJSON []byte
	err := row.Scan(
		&item.ID, &item.ProjectID, &item.ProjectName, &item.SKU, &asin, &item.Country,
		&item.AccountingType, &item.PackageLengthCM, &item.PackageWidthCM,
		&item.PackageHeightCM, &item.WeightKG, &item.FOBProductCostRMB,
		&item.FirstLegCostRMB, &item.DDPCostRMB, &item.DDPCostUSD, &item.SalePriceUSD,
		&item.AdvertisingRate, &item.ReturnLossRate, &item.StorageMonths,
		&item.InboundPlacementMode, &item.USDToRMBRate, &item.USDToRMBRateSource,
		&item.SizeTier, &item.SizeTierLabel, &item.PriceBand, &item.PriceBandLabel,
		&item.Dimensions.LongestSideIn, &item.Dimensions.MiddleSideIn,
		&item.Dimensions.ShortestSideIn, &item.Dimensions.LengthPlusGirthIn,
		&item.Dimensions.VolumeCubicIn, &item.Dimensions.VolumeCubicFt,
		&item.Weights.ProductWeightLB, &item.Weights.ProductWeightOZ,
		&item.Weights.DimensionalWeightLB, &item.Weights.ChargeableWeightLB,
		&item.Weights.ChargeableWeightOZ, &item.Weights.ChargeableWeightRule,
		&item.FulfillmentFeeRuleLabel, &item.InboundConfigFeeRuleLabel,
		&item.StorageFeeRuleLabel, &item.Fees.ReferralFeeUSD,
		&item.Fees.AdvertisingFeeUSD, &item.Fees.ReturnLossUSD,
		&item.Fees.FBAFulfillmentFeeUSD, &item.Fees.InboundConfigFeeUSD,
		&item.Fees.StorageFeeUSD, &item.Fees.TotalFeeUSD, &item.Fees.DeliveryFeeUSD,
		&item.Fees.InboundConfigFeeManualUSD, &item.Fees.StorageFeeManualUSD,
		&item.Fees.PlatformFeeUSD, &item.Profit.PayoutUSD, &item.Profit.ProfitUSD,
		&item.Profit.ProfitRate, &item.Profit.VATUSD, &afterVATUSD, &afterVATRate,
		&warningsJSON, &notes, &createdBy, &item.ObservedAt, &item.Source,
		&item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return shop_calculation.ShopCalculationItem{}, err
	}
	item.ASIN = asin
	item.Profit.DDPCostRMB = item.DDPCostRMB
	item.Profit.DDPCostUSD = item.DDPCostUSD
	item.Profit.ProfitAfterVATUSD = afterVATUSD
	item.Profit.ProfitAfterVATRate = afterVATRate
	item.Notes = notes
	item.CreatedBy = createdBy
	item.Warnings = []string{}
	if len(warningsJSON) > 0 {
		if err := json.Unmarshal(warningsJSON, &item.Warnings); err != nil {
			return shop_calculation.ShopCalculationItem{}, fmt.Errorf("decode shop calculation warnings: %w", err)
		}
		if item.Warnings == nil {
			item.Warnings = []string{}
		}
	}
	item.Anchor = shop_calculation.DeriveAnchor(item)
	return item, nil
}
