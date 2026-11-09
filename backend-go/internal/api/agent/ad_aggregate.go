package agent

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_ad_data"
)

var adAggregateKeys = map[string][]string{
	"ad-campaigns":          {"campaign_name"},
	"ad-budgets":            {"campaign_name"},
	"ad-targets":            {"campaign_name", "ad_group_name", "target_text", "match_type"},
	"ad-placements":         {"campaign_name", "placement"},
	"ad-promoted-products":  {"campaign_name", "ad_sku", "ad_asin"},
	"ad-time-trends":        {"report_end_date", "country", "currency"},
	"ad-search-terms":       {"campaign_name", "ad_group_name", "match_type", "search_term", "targeting_type"},
	"ad-search-term-shares": {"search_term", "match_type"},
	"ad-invalid-traffic":    {"campaign_name"},
	"ad-purchased-products": {"campaign_name", "ad_group_name", "ad_sku", "ad_asin", "purchased_asin"},
}

var adLatestFields = map[string]bool{
	"budget":                         true,
	"status":                         true,
	"bidding_strategy":               true,
	"campaign_type":                  true,
	"targeting_type":                 true,
	"portfolio_name":                 true,
	"suggested_budget":               true,
	"budget_utilization_rate":        true,
	"missed_impressions_min":         true,
	"missed_impressions_max":         true,
	"missed_clicks_min":              true,
	"missed_clicks_max":              true,
	"missed_sales_min":               true,
	"missed_sales_max":               true,
	"top_of_search_impression_share": true,
	"ad_sku_units_7d":                true,
	"other_sku_units_7d":             true,
	"ad_sku_sales_7d":                true,
	"other_sku_sales_7d":             true,
	"scope_status":                   true,
	"impression_share":               true,
	"target_text":                    true,
	"ad_group_name":                  true,
	"other_sku_orders_7d":            true,
	"invalid_impression_rate":        true,
	"invalid_click_rate":             true,
}

type adAggregateGroup struct {
	key         string
	row         map[string]any
	latestOn    string
	impressions float64
	clicks      float64
	spend       float64
	sales       float64
	orders      float64
	units       float64
}

func aggregateAdResponse(
	resp *internal_ad_data.RawResponse,
	endpoint string,
) map[string]any {
	keys := adAggregateKeys[endpoint]
	if len(keys) == 0 {
		keys = []string{"campaign_name"}
	}
	groups := make(map[string]*adAggregateGroup)
	for _, row := range resp.Data {
		keyParts := make([]string, 0, len(keys))
		for _, key := range keys {
			keyParts = append(keyParts, fmt.Sprint(row[key]))
		}
		key := strings.Join(keyParts, "\x00")
		group := groups[key]
		if group == nil {
			group = &adAggregateGroup{key: key, row: make(map[string]any)}
			for _, field := range keys {
				group.row[field] = row[field]
			}
			groups[key] = group
		}
		group.impressions += numericValue(row["impressions"]) + numericValue(row["total_impressions"])
		group.clicks += numericValue(row["clicks"]) + numericValue(row["total_clicks"])
		group.spend += numericValue(row["spend"])
		group.sales += numericValue(row["sales_7d"])
		group.orders += numericValue(row["orders_7d"])
		group.units += numericValue(row["units_7d"])
		reportDate := fmt.Sprint(row["report_end_date"])
		if reportDate >= group.latestOn {
			group.latestOn = reportDate
			for field := range adLatestFields {
				if value, ok := row[field]; ok {
					group.row[field] = value
				}
			}
			if endpoint == "ad-time-trends" {
				group.row["report_end_date"] = row["report_end_date"]
			}
		}
	}

	ordered := make([]*adAggregateGroup, 0, len(groups))
	for _, group := range groups {
		ordered = append(ordered, group)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].key < ordered[j].key })

	data := make([]map[string]any, 0, len(ordered))
	var totalSpend, totalSales, totalOrders, totalRows float64
	for _, group := range ordered {
		row := group.row
		row["impressions"] = int(group.impressions)
		row["clicks"] = int(group.clicks)
		row["spend"] = round2(group.spend)
		row["sales_7d"] = round2(group.sales)
		row["orders_7d"] = int(group.orders)
		if group.units != 0 {
			row["units_7d"] = int(group.units)
		}
		row["ctr"] = percent(group.clicks, group.impressions)
		row["cpc"] = ratio(group.spend, group.clicks, 2)
		row["cvr"] = percent(group.orders, group.clicks)
		row["acos"] = percent(group.spend, group.sales)
		row["roas"] = ratio(group.sales, group.spend, 2)
		if endpoint == "ad-invalid-traffic" {
			row["invalid_impression_rate"] = percent(numericValue(row["invalid_impressions"]), numericValue(row["total_impressions"]))
			row["invalid_click_rate"] = percent(numericValue(row["invalid_clicks"]), numericValue(row["total_clicks"]))
		}
		data = append(data, row)
		totalSpend += group.spend
		totalSales += group.sales
		totalOrders += group.orders
		totalRows++
	}
	return map[string]any{
		"project_id": resp.ProjectID,
		"period":     resp.Period,
		"country":    resp.Country,
		"data":       data,
		"summary": map[string]any{
			"total_rows":   int(totalRows),
			"total_spend":  round2(totalSpend),
			"total_sales":  round2(totalSales),
			"total_orders": int(totalOrders),
			"overall_acos": percent(totalSpend, totalSales),
			"overall_roas": ratio(totalSales, totalSpend, 2),
		},
	}
}

func numericValue(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int32:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	case string:
		parsed, _ := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed
	default:
		parsed, _ := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(value)), 64)
		return parsed
	}
}

func percent(numerator, denominator float64) float64 {
	return ratio(numerator*100, denominator, 2)
}

func ratio(numerator, denominator float64, precision int) float64 {
	if denominator == 0 {
		return 0
	}
	value := numerator / denominator
	scale := math.Pow10(precision)
	return math.Round(value*scale) / scale
}

func round2(value float64) float64 {
	return math.Round(value*100) / 100
}
