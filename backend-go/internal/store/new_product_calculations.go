package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/new_product_calculations"
)

type ProductCalculationStore struct {
	db FullDB
}

func NewProductCalculationStore(db FullDB) *ProductCalculationStore {
	return &ProductCalculationStore{db: db}
}

func (s *ProductCalculationStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, new_product_calculations.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &ProductCalculationStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

const newProductCalculationSelectColumns = `
	id, project_id, project_name, sku, asin, country, calculation_type,
	package_length_cm, package_width_cm, package_height_cm, weight_kg,
	fob_product_cost_rmb, first_leg_cost_rmb, ddp_cost_rmb, ddp_cost_usd,
	sale_price_usd, target_profit_rate, advertising_rate, return_loss_rate,
	storage_months, inbound_placement_mode, usd_to_rmb_rate, usd_to_rmb_rate_source,
	size_tier, size_tier_label, price_band, price_band_label,
	longest_side_in, middle_side_in, shortest_side_in, length_plus_girth_in,
	volume_cubic_in, volume_cubic_ft, product_weight_lb, product_weight_oz,
	dimensional_weight_lb, chargeable_weight_lb, chargeable_weight_oz,
	chargeable_weight_rule, fulfillment_fee_rule_label,
	inbound_config_fee_rule_label, storage_fee_rule_label,
	referral_fee_usd, advertising_fee_usd, return_loss_usd,
	fba_fulfillment_fee_usd, inbound_config_fee_usd, storage_fee_usd, total_fee_usd,
	delivery_fee_usd, inbound_config_fee_manual_usd, storage_fee_manual_usd,
	payout_usd, profit_usd, profit_rate, vat_usd, profit_after_vat_usd,
	profit_after_vat_rate, coalesce(warnings_json, '[]'::json)::text,
	notes, source, observed_at, created_by, created_at, updated_at`

var newProductCalculationInsertColumns = []string{
	"project_id", "project_name", "sku", "asin", "country", "calculation_type",
	"package_length_cm", "package_width_cm", "package_height_cm", "weight_kg",
	"fob_product_cost_rmb", "first_leg_cost_rmb", "ddp_cost_rmb", "ddp_cost_usd",
	"sale_price_usd", "target_profit_rate", "advertising_rate", "return_loss_rate",
	"storage_months", "inbound_placement_mode", "usd_to_rmb_rate", "usd_to_rmb_rate_source",
	"size_tier", "size_tier_label", "price_band", "price_band_label",
	"longest_side_in", "middle_side_in", "shortest_side_in", "length_plus_girth_in",
	"volume_cubic_in", "volume_cubic_ft", "product_weight_lb", "product_weight_oz",
	"dimensional_weight_lb", "chargeable_weight_lb", "chargeable_weight_oz",
	"chargeable_weight_rule", "fulfillment_fee_rule_label",
	"inbound_config_fee_rule_label", "storage_fee_rule_label",
	"referral_fee_usd", "advertising_fee_usd", "return_loss_usd",
	"fba_fulfillment_fee_usd", "inbound_config_fee_usd", "storage_fee_usd", "total_fee_usd",
	"delivery_fee_usd", "inbound_config_fee_manual_usd", "storage_fee_manual_usd",
	"payout_usd", "profit_usd", "profit_rate", "vat_usd", "profit_after_vat_usd",
	"profit_after_vat_rate", "warnings_json", "notes", "source", "observed_at", "created_by",
}

const newProductCalculationListWhere = `
	where ($1::bigint is null or n.project_id = $1)
	  and ($2::text is null or n.calculation_type = $2)
	  and ($3::text is null or n.country = $3)
	  and (
	    $4::boolean
	    or exists (
	      select 1
	      from public.projects p
	      where p.id = n.project_id
	        and $5::text <> ''
	        and (
	          exists (
	            select 1
	            from unnest(regexp_split_to_array(
	              coalesce(p.project_operator, ''),
	              '[、,，;[:space:]]+'
	            )) as project_names(value)
	            where btrim(project_names.value) = $5
	          )
	          or exists (
	            select 1
	            from unnest(regexp_split_to_array(
	              coalesce(p.assistant_operator, ''),
	              '[、,，;[:space:]]+'
	            )) as assistant_names(value)
	            where btrim(assistant_names.value) = $5
	          )
	        )
	    )
	  )`

func (s *ProductCalculationStore) List(
	ctx context.Context,
	filter new_product_calculations.ListFilter,
) (new_product_calculations.ListResponse, error) {
	page, pageSize := normalizeNewProductCalculationPagination(filter.Page, filter.PageSize)
	offset := safeNewProductCalculationOffset(page, pageSize)
	args := []any{
		filter.ProjectID,
		filter.CalculationType,
		filter.Country,
		filter.IsAdmin,
		strings.TrimSpace(filter.Operator),
	}

	var total int64
	countSQL := `select count(*) from public.new_product_calculations n` + newProductCalculationListWhere
	if err := s.db.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return new_product_calculations.ListResponse{}, err
	}

	queryArgs := append(append([]any(nil), args...), pageSize, offset)
	query := `select ` + newProductCalculationSelectColumns +
		` from public.new_product_calculations n` + newProductCalculationListWhere +
		` order by n.updated_at desc, n.id desc limit $6 offset $7`
	rows, err := s.db.Query(ctx, query, queryArgs...)
	if err != nil {
		return new_product_calculations.ListResponse{}, err
	}
	defer rows.Close()

	items := make([]new_product_calculations.NewProductCalculationItem, 0)
	for rows.Next() {
		item, err := scanNewProductCalculation(rows)
		if err != nil {
			return new_product_calculations.ListResponse{}, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return new_product_calculations.ListResponse{}, err
	}
	return new_product_calculations.ListResponse{
		Items: items, Total: int(total), Page: page, PageSize: pageSize,
	}, nil
}

func (s *ProductCalculationStore) Get(
	ctx context.Context,
	projectID int64,
	sku string,
	calculationType string,
) (*new_product_calculations.NewProductCalculationItem, error) {
	query := `select ` + newProductCalculationSelectColumns + `
		from public.new_product_calculations
		where project_id = $1 and sku = $2 and calculation_type = $3
		limit 1`
	item, err := scanNewProductCalculation(s.db.QueryRow(ctx, query, projectID, sku, calculationType))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return item, err
}

func (s *ProductCalculationStore) Upsert(
	ctx context.Context,
	input new_product_calculations.CreateRequest,
	operator string,
) (*new_product_calculations.NewProductCalculationItem, error) {
	authoritative, err := s.calculateAuthoritativeRequest(ctx, input)
	if err != nil {
		return nil, err
	}
	input = authoritative
	if input.Warnings == nil {
		input.Warnings = []string{}
	}
	warningsJSON, err := json.Marshal(input.Warnings)
	if err != nil {
		return nil, fmt.Errorf("marshal new-product warnings: %w", err)
	}

	values := []any{
		input.ProjectID, input.ProjectName, input.SKU, input.ASIN, input.Country, input.CalculationType,
		input.PackageLengthCM, input.PackageWidthCM, input.PackageHeightCM, input.WeightKG,
		input.FOBProductCostRMB, input.FirstLegCostRMB, input.DDPCostRMB, input.DDPCostUSD,
		input.SalePriceUSD, input.TargetProfitRate, input.AdvertisingRate, input.ReturnLossRate,
		input.StorageMonths, input.InboundPlacementMode, input.USDToRMBRate, input.USDToRMBRateSource,
		input.SizeTier, input.SizeTierLabel, input.PriceBand, input.PriceBandLabel,
		input.LongestSideIn, input.MiddleSideIn, input.ShortestSideIn, input.LengthPlusGirthIn,
		input.VolumeCubicIn, input.VolumeCubicFt, input.ProductWeightLB, input.ProductWeightOZ,
		input.DimensionalWeightLB, input.ChargeableWeightLB, input.ChargeableWeightOZ,
		input.ChargeableWeightRule, input.FulfillmentFeeRuleLabel,
		input.InboundConfigFeeRuleLabel, input.StorageFeeRuleLabel,
		input.ReferralFeeUSD, input.AdvertisingFeeUSD, input.ReturnLossUSD,
		input.FBAFulfillmentFeeUSD, input.InboundConfigFeeUSD, input.StorageFeeUSD, input.TotalFeeUSD,
		input.DeliveryFeeUSD, input.InboundConfigFeeManualUSD, input.StorageFeeManualUSD,
		input.PayoutUSD, input.ProfitUSD, input.ProfitRate, input.VATUSD,
		input.ProfitAfterVATUSD, input.ProfitAfterVATRate, warningsJSON, input.Notes,
		input.Source, input.ObservedAt, nullableTrimmedString(operator),
	}
	columns := strings.Join(newProductCalculationInsertColumns, ", ")
	placeholders := make([]string, len(values))
	for index := range placeholders {
		placeholders[index] = fmt.Sprintf("$%d", index+1)
	}
	operatorProvidedArg := len(values) + 1

	updates := make([]string, 0, len(newProductCalculationInsertColumns))
	for _, column := range newProductCalculationInsertColumns {
		switch column {
		case "project_id", "project_name", "sku", "calculation_type":
			continue
		case "created_by":
			updates = append(updates, fmt.Sprintf(
				"created_by = case when $%d::boolean then excluded.created_by else existing_row.created_by end",
				operatorProvidedArg,
			))
		case "source", "observed_at":
			updates = append(updates, fmt.Sprintf("%s = coalesce(excluded.%s, existing_row.%s)", column, column, column))
		default:
			updates = append(updates, fmt.Sprintf("%s = excluded.%s", column, column))
		}
	}
	updates = append(updates, "updated_at = now()")
	values = append(values, operator != "")

	query := fmt.Sprintf(
		`insert into public.new_product_calculations as existing_row (%s)
		 values (%s)
		 on conflict (project_id, sku, calculation_type) do update set %s
		 returning %s`,
		columns,
		strings.Join(placeholders, ", "),
		strings.Join(updates, ", "),
		newProductCalculationSelectColumns,
	)
	return scanNewProductCalculation(s.db.QueryRow(ctx, query, values...))
}

func (s *ProductCalculationStore) ProjectID(ctx context.Context, snapshotID int64) (int64, error) {
	var projectID int64
	err := s.db.QueryRow(
		ctx,
		`select project_id from public.new_product_calculations where id = $1 limit 1`,
		snapshotID,
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, new_product_calculations.ErrNotFound
	}
	return projectID, err
}

func (s *ProductCalculationStore) Delete(ctx context.Context, snapshotID int64) (bool, error) {
	tag, err := s.db.Exec(
		ctx,
		`delete from public.new_product_calculations where id = $1`,
		snapshotID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *ProductCalculationStore) VerifyProjectAccess(
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
		return new_product_calculations.ErrProjectNotFound
	}
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return new_product_calculations.ErrProjectForbidden
	}
	if projectOperatorContains(projectOperator, operator) || projectOperatorContains(assistantOperator, operator) {
		return nil
	}
	return new_product_calculations.ErrProjectForbidden
}

func scanNewProductCalculation(scanner interface{ Scan(...any) error }) (*new_product_calculations.NewProductCalculationItem, error) {
	var item new_product_calculations.NewProductCalculationItem
	var asin, country, notes, source, createdBy *string
	var targetProfitRate, profitAfterVATUSD, profitAfterVATRate *float64
	var observedAt *time.Time
	var warningsJSON []byte
	err := scanner.Scan(
		&item.ID, &item.ProjectID, &item.ProjectName, &item.SKU, &asin, &country,
		&item.CalculationType,
		&item.PackageLengthCM, &item.PackageWidthCM, &item.PackageHeightCM, &item.WeightKG,
		&item.FOBProductCostRMB, &item.FirstLegCostRMB, &item.DDPCostRMB, &item.DDPCostUSD,
		&item.SalePriceUSD, &targetProfitRate, &item.AdvertisingRate, &item.ReturnLossRate,
		&item.StorageMonths, &item.InboundPlacementMode, &item.USDToRMBRate,
		&item.USDToRMBRateSource,
		&item.SizeTier, &item.SizeTierLabel, &item.PriceBand, &item.PriceBandLabel,
		&item.Dimensions.LongestSideIn, &item.Dimensions.MiddleSideIn,
		&item.Dimensions.ShortestSideIn, &item.Dimensions.LengthPlusGirthIn,
		&item.Dimensions.VolumeCubicIn, &item.Dimensions.VolumeCubicFt,
		&item.Weights.ProductWeightLB, &item.Weights.ProductWeightOZ,
		&item.Weights.DimensionalWeightLB, &item.Weights.ChargeableWeightLB,
		&item.Weights.ChargeableWeightOZ, &item.Weights.ChargeableWeightRule,
		&item.FulfillmentFeeRuleLabel, &item.InboundConfigFeeRuleLabel, &item.StorageFeeRuleLabel,
		&item.Fees.ReferralFeeUSD, &item.Fees.AdvertisingFeeUSD, &item.Fees.ReturnLossUSD,
		&item.Fees.FBAFulfillmentFeeUSD, &item.Fees.InboundConfigFeeUSD,
		&item.Fees.StorageFeeUSD, &item.Fees.TotalFeeUSD,
		&item.Fees.DeliveryFeeUSD, &item.Fees.InboundConfigFeeManualUSD,
		&item.Fees.StorageFeeManualUSD,
		&item.Profit.PayoutUSD, &item.Profit.ProfitUSD, &item.Profit.ProfitRate,
		&item.Profit.VATUSD, &profitAfterVATUSD, &profitAfterVATRate,
		&warningsJSON, &notes, &source, &observedAt, &createdBy, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	item.ASIN = asin
	item.Country = country
	item.TargetProfitRate = targetProfitRate
	item.Profit.DDPCostRMB = item.DDPCostRMB
	item.Profit.DDPCostUSD = item.DDPCostUSD
	item.Profit.ProfitAfterVATUSD = profitAfterVATUSD
	item.Profit.ProfitAfterVATRate = profitAfterVATRate
	item.Notes = notes
	item.Source = source
	item.ObservedAt = observedAt
	item.CreatedBy = createdBy
	item.Warnings = []string{}
	if len(warningsJSON) > 0 {
		if err := json.Unmarshal(warningsJSON, &item.Warnings); err != nil {
			return nil, fmt.Errorf("decode new-product warnings: %w", err)
		}
		if item.Warnings == nil {
			item.Warnings = []string{}
		}
	}
	return &item, nil
}

func normalizeNewProductCalculationPagination(page, pageSize int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 200
	}
	if pageSize > 500 {
		pageSize = 500
	}
	return page, pageSize
}

func safeNewProductCalculationOffset(page, pageSize int) int {
	if page <= 1 {
		return 0
	}
	maxInt := int(^uint(0) >> 1)
	if page-1 > maxInt/pageSize {
		return maxInt
	}
	return (page - 1) * pageSize
}

func projectOperatorContains(value *string, operator string) bool {
	if value == nil || strings.TrimSpace(operator) == "" {
		return false
	}
	for _, candidate := range strings.FieldsFunc(*value, func(r rune) bool {
		return r == ',' || r == '、' || r == '，' || r == ';' ||
			r == '\n' || r == '\r' || r == '\t' || unicode.IsSpace(r)
	}) {
		if strings.TrimSpace(candidate) == operator {
			return true
		}
	}
	return false
}

func nullableTrimmedString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

var _ new_product_calculations.Store = (*ProductCalculationStore)(nil)
