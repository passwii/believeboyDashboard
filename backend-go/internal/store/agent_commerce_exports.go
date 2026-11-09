package store

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_commerce"
)

func (s *AgentCommerceStore) ListNewProductExports(
	ctx context.Context,
	projectID int64,
	snapshotIDs []int64,
) ([]agent_commerce.NewProductExportRow, error) {
	if s == nil || s.db == nil {
		return nil, agent_commerce.ErrServiceUnavailable
	}
	if len(snapshotIDs) == 0 {
		return []agent_commerce.NewProductExportRow{}, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select `+newProductCalculationSelectColumns+`
		   from public.new_product_calculations
		  where project_id = $1 and id = any($2)`,
		projectID,
		snapshotIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("list new product exports: %w", err)
	}
	defer rows.Close()
	items := make([]agent_commerce.NewProductExportRow, 0, len(snapshotIDs))
	for rows.Next() {
		item, err := scanNewProductCalculation(rows)
		if err != nil {
			return nil, fmt.Errorf("scan new product export: %w", err)
		}
		country := ""
		if item.Country != nil {
			country = *item.Country
		}
		items = append(items, agent_commerce.NewProductExportRow{
			ID:                        item.ID,
			ProjectName:               item.ProjectName,
			SKU:                       item.SKU,
			Country:                   country,
			CalculationType:           item.CalculationType,
			PackageLengthCM:           item.PackageLengthCM,
			PackageWidthCM:            item.PackageWidthCM,
			PackageHeightCM:           item.PackageHeightCM,
			WeightKG:                  item.WeightKG,
			FOBProductCostRMB:         item.FOBProductCostRMB,
			FirstLegCostRMB:           item.FirstLegCostRMB,
			DDPCostRMB:                item.DDPCostRMB,
			DDPCostUSD:                item.DDPCostUSD,
			SalePriceUSD:              item.SalePriceUSD,
			ReferralFeeUSD:            item.Fees.ReferralFeeUSD,
			AdvertisingFeeUSD:         item.Fees.AdvertisingFeeUSD,
			AdvertisingRate:           item.AdvertisingRate,
			ReturnLossUSD:             item.Fees.ReturnLossUSD,
			ReturnLossRate:            item.ReturnLossRate,
			FBAFulfillmentFeeUSD:      item.Fees.FBAFulfillmentFeeUSD,
			InboundConfigFeeUSD:       item.Fees.InboundConfigFeeUSD,
			StorageFeeUSD:             item.Fees.StorageFeeUSD,
			StorageMonths:             item.StorageMonths,
			TotalFeeUSD:               item.Fees.TotalFeeUSD,
			PayoutUSD:                 item.Profit.PayoutUSD,
			ProfitUSD:                 item.Profit.ProfitUSD,
			ProfitRate:                item.Profit.ProfitRate,
			VolumeCubicIn:             item.Dimensions.VolumeCubicIn,
			VolumeCubicFt:             item.Dimensions.VolumeCubicFt,
			LongestSideIn:             item.Dimensions.LongestSideIn,
			MiddleSideIn:              item.Dimensions.MiddleSideIn,
			ShortestSideIn:            item.Dimensions.ShortestSideIn,
			SizeTierLabel:             item.SizeTierLabel,
			PriceBandLabel:            item.PriceBandLabel,
			ChargeableWeightLB:        item.Weights.ChargeableWeightLB,
			ProductWeightLB:           item.Weights.ProductWeightLB,
			DimensionalWeightLB:       item.Weights.DimensionalWeightLB,
			ChargeableWeightRule:      item.Weights.ChargeableWeightRule,
			FulfillmentFeeRuleLabel:   item.FulfillmentFeeRuleLabel,
			InboundConfigFeeRuleLabel: item.InboundConfigFeeRuleLabel,
			StorageFeeRuleLabel:       item.StorageFeeRuleLabel,
			USDToRMBRate:              item.USDToRMBRate,
			CreatedAt:                 item.CreatedAt,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *AgentCommerceStore) ListShopExport(
	ctx context.Context,
	projectID int64,
	filter agent_commerce.ShopExportFilter,
) (agent_commerce.ShopExportData, error) {
	if s == nil || s.db == nil {
		return agent_commerce.ShopExportData{}, agent_commerce.ErrServiceUnavailable
	}
	if filter.Mode != "current" && filter.Mode != "history" {
		return agent_commerce.ShopExportData{}, agent_commerce.ErrValidation
	}
	countries, err := s.listShopExportCountries(ctx, projectID, filter)
	if err != nil {
		return agent_commerce.ShopExportData{}, err
	}
	calculationRows, err := s.listShopCalculationExportRows(ctx, projectID, filter)
	if err != nil {
		return agent_commerce.ShopExportData{}, err
	}
	calculationKeys := make(map[string]bool, len(calculationRows))
	for _, row := range calculationRows {
		calculationKeys[strings.ToUpper(row.Country)+"\x00"+row.SKU] = true
	}
	masters, err := s.listShopExportMasters(ctx, projectID, filter)
	if err != nil {
		return agent_commerce.ShopExportData{}, err
	}
	rowCount := len(calculationRows)
	for _, master := range masters {
		country := strings.ToUpper(strings.TrimSpace(master.Country))
		if country != "" {
			countries[country] = true
		}
	}
	if filter.IncludeUncomputed {
		for _, master := range masters {
			key := strings.ToUpper(master.Country) + "\x00" + master.SKU
			if !calculationKeys[key] {
				rowCount++
			}
		}
	}
	if rowCount > maxAgentCommerceExportRows {
		return agent_commerce.ShopExportData{}, agent_commerce.ErrExportTooLarge
	}
	countryList := make([]string, 0, len(countries))
	for country := range countries {
		countryList = append(countryList, country)
	}
	sort.Strings(countryList)
	return agent_commerce.ShopExportData{
		Calculations: calculationRows,
		Masters:      masters,
		Countries:    countryList,
		RowCount:     rowCount,
	}, nil
}

const maxAgentCommerceExportRows = 50000

func (s *AgentCommerceStore) listShopExportCountries(
	ctx context.Context,
	projectID int64,
	filter agent_commerce.ShopExportFilter,
) (map[string]bool, error) {
	conditions := []string{"project_id = $1", "deleted_at is null"}
	args := []any{projectID}
	if filter.Country != nil {
		args = append(args, strings.ToUpper(strings.TrimSpace(*filter.Country)))
		conditions = append(conditions, fmt.Sprintf("upper(country) = $%d", len(args)))
	}
	if filter.SKU != nil {
		args = append(args, *filter.SKU)
		conditions = append(conditions, fmt.Sprintf("sku = $%d", len(args)))
	}
	if filter.AsOf != nil {
		args = append(args, *filter.AsOf)
		conditions = append(conditions, fmt.Sprintf("observed_at <= $%d", len(args)))
	}
	rows, err := s.db.Query(
		ctx,
		`select distinct upper(country)
		   from public.shop_calculation
		  where `+strings.Join(conditions, " and "),
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]bool)
	for rows.Next() {
		var country string
		if err := rows.Scan(&country); err != nil {
			return nil, err
		}
		result[country] = true
	}
	return result, rows.Err()
}

func (s *AgentCommerceStore) listShopCalculationExportRows(
	ctx context.Context,
	projectID int64,
	filter agent_commerce.ShopExportFilter,
) ([]agent_commerce.ShopExportRow, error) {
	baseConditions := []string{
		"project_id = $1",
		"deleted_at is null",
	}
	args := []any{projectID}
	if filter.Country != nil {
		args = append(args, strings.ToUpper(strings.TrimSpace(*filter.Country)))
		baseConditions = append(baseConditions, fmt.Sprintf("country = $%d", len(args)))
	}
	if filter.SKU != nil {
		args = append(args, *filter.SKU)
		baseConditions = append(baseConditions, fmt.Sprintf("sku = $%d", len(args)))
	}
	var asOfArg int
	if filter.AsOf != nil {
		args = append(args, *filter.AsOf)
		asOfArg = len(args)
		baseConditions = append(baseConditions, fmt.Sprintf("observed_at <= $%d", asOfArg))
	}
	query := ""
	if filter.Mode == "current" {
		query = `with latest_ids as (
			select project_id, sku, country, max(id) as id
			from public.shop_calculation
			where ` + strings.Join(baseConditions, " and ") + `
			group by project_id, sku, country
		)
		select ` + shopCalculationSelectColumns + `
		from public.shop_calculation as sc
		where sc.id in (select id from latest_ids)
		order by sc.country asc, sc.sku asc`
	} else {
		query = `select ` + shopCalculationSelectColumns + `
			from public.shop_calculation
			where ` + strings.Join(baseConditions, " and ") + `
			order by country asc, sku asc, observed_at desc, id desc`
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list shop calculation export rows: %w", err)
	}
	defer rows.Close()
	result := make([]agent_commerce.ShopExportRow, 0)
	for rows.Next() {
		item, err := scanShopCalculationItem(rows)
		if err != nil {
			return nil, fmt.Errorf("scan shop calculation export row: %w", err)
		}
		result = append(result, agent_commerce.ShopExportRow{
			ID:                        item.ID,
			SKU:                       item.SKU,
			ASIN:                      item.ASIN,
			Country:                   item.Country,
			Source:                    item.Source,
			ObservedAt:                item.ObservedAt,
			Warnings:                  item.Warnings,
			FOBProductCostRMB:         item.FOBProductCostRMB,
			PackageLengthCM:           item.PackageLengthCM,
			PackageWidthCM:            item.PackageWidthCM,
			PackageHeightCM:           item.PackageHeightCM,
			WeightKG:                  item.WeightKG,
			FirstLegCostRMB:           item.FirstLegCostRMB,
			DDPCostRMB:                item.Profit.DDPCostRMB,
			DDPCostUSD:                item.Profit.DDPCostUSD,
			USDToRMBRate:              item.USDToRMBRate,
			SalePriceUSD:              item.SalePriceUSD,
			AdvertisingRate:           item.AdvertisingRate,
			AdvertisingFeeUSD:         item.Fees.AdvertisingFeeUSD,
			ReturnLossRate:            item.ReturnLossRate,
			ReturnLossUSD:             item.Fees.ReturnLossUSD,
			ReferralFeeUSD:            item.Fees.ReferralFeeUSD,
			FBAFulfillmentFeeUSD:      item.Fees.FBAFulfillmentFeeUSD,
			InboundConfigFeeUSD:       item.Fees.InboundConfigFeeUSD,
			StorageMonths:             item.StorageMonths,
			StorageFeeUSD:             item.Fees.StorageFeeUSD,
			TotalFeeUSD:               item.Fees.TotalFeeUSD,
			PayoutUSD:                 item.Profit.PayoutUSD,
			ProfitUSD:                 item.Profit.ProfitUSD,
			ProfitRate:                item.Profit.ProfitRate,
			SizeTierLabel:             item.SizeTierLabel,
			PriceBandLabel:            item.PriceBandLabel,
			FulfillmentFeeRuleLabel:   item.FulfillmentFeeRuleLabel,
			InboundConfigFeeRuleLabel: item.InboundConfigFeeRuleLabel,
			StorageFeeRuleLabel:       item.StorageFeeRuleLabel,
			PlatformFeeUSD:            item.Fees.PlatformFeeUSD,
			DeliveryFeeUSD:            item.Fees.DeliveryFeeUSD,
			InboundConfigFeeManualUSD: item.Fees.InboundConfigFeeManualUSD,
			StorageFeeManualUSD:       item.Fees.StorageFeeManualUSD,
			VATUSD:                    item.Profit.VATUSD,
			ProfitAfterVATUSD:         item.Profit.ProfitAfterVATUSD,
			ProfitAfterVATRate:        item.Profit.ProfitAfterVATRate,
		})
		if len(result) > maxAgentCommerceExportRows {
			return nil, agent_commerce.ErrExportTooLarge
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *AgentCommerceStore) listShopExportMasters(
	ctx context.Context,
	projectID int64,
	filter agent_commerce.ShopExportFilter,
) ([]agent_commerce.ShopExportMaster, error) {
	conditions := []string{"project_id = $1", "is_active = true"}
	args := []any{projectID}
	if filter.Country != nil {
		args = append(args, strings.ToUpper(strings.TrimSpace(*filter.Country)))
		conditions = append(conditions, fmt.Sprintf("upper(country) = $%d", len(args)))
	}
	if filter.SKU != nil {
		args = append(args, *filter.SKU)
		conditions = append(conditions, fmt.Sprintf("sku = $%d", len(args)))
	}
	rows, err := s.db.Query(
		ctx,
		`select sku, asin, upper(country), fob_unit_cost, package_length_cm,
		        package_width_cm, package_height_cm, weight_kg, first_leg_cost_rmb, sort_order
		   from public.product_costs
		  where `+strings.Join(conditions, " and ")+`
		  order by upper(country) asc, sort_order asc, id asc`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	deduped := make(map[string]agent_commerce.ShopExportMaster)
	for rows.Next() {
		var item agent_commerce.ShopExportMaster
		if err := rows.Scan(
			&item.SKU, &item.ASIN, &item.Country, &item.FOBUnitCost,
			&item.PackageLengthCM, &item.PackageWidthCM, &item.PackageHeightCM,
			&item.WeightKG, &item.FirstLegCostRMB, &item.SortOrder,
		); err != nil {
			return nil, err
		}
		key := strings.ToUpper(item.Country) + "\x00" + item.SKU
		if _, exists := deduped[key]; exists {
			continue
		}
		deduped[key] = item
		if len(deduped) > maxAgentCommerceExportRows {
			return nil, agent_commerce.ErrExportTooLarge
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]agent_commerce.ShopExportMaster, 0, len(deduped))
	for _, item := range deduped {
		result = append(result, item)
	}
	sortShopMasters(result)
	return result, nil
}

func sortShopMasters(values []agent_commerce.ShopExportMaster) {
	for left := 0; left < len(values); left++ {
		for right := left + 1; right < len(values); right++ {
			if values[right].Country < values[left].Country ||
				(values[right].Country == values[left].Country &&
					values[right].SortOrder < values[left].SortOrder) {
				values[left], values[right] = values[right], values[left]
			}
		}
	}
}
