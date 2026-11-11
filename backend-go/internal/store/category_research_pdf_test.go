package store

import (
	"strings"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/category_research"
)

func TestBuildCategorySummaryHTML(t *testing.T) {
	dataset := category_research.CategoryResearchDatasetItem{
		Marketplace: "US", CategoryKeywordEn: "kitchen scale", CategoryNameZh: "厨房秤",
		Version: 2, RowCountProducts: 20, RowCountTrends: 100,
	}
	overview := category_research.CategoryResearchOverviewResponse{
		Kpis: category_research.CategoryResearchOverviewKpis{
			SampleCount: 20, BrandCount: 8, AveragePriceUsd: 19.99, TotalMonthlySales: 5000, AmazonShare: 0.4,
		},
		AdvancedMetrics: category_research.CategoryResearchAdvancedMetrics{
			MarketGrowth:    map[string]any{"growth_level": "高增长", "last12_vs_prev12_growth": 0.25},
			Seasonality:     map[string]any{"seasonality_level": "明显", "peak3_month_sales_share": 0.42, "recommended_entry_months": []any{"3月", "4月"}},
			BrandMonopoly:   map[string]any{"brand_cr3": 0.55, "risk_level": "中"},
			SellerMonopoly:  map[string]any{"seller_cr3": 0.48, "risk_level": "中"},
			ChinaSellerComp: map[string]any{"china_seller_sales_share": 0.7, "risk_level": "高"},
			NewProductOpp:   map[string]any{"opportunity_level": "中", "new_product_sales_share": 0.12},
			DataQuality:     map[string]any{"score": 90.5, "summary": "良好"},
			ActionRecs:      []any{map[string]any{"priority": "P0", "action": "先做小批量测款", "why": "市场增长", "required_validation": []any{"价格带", "评论"}}},
		},
		BrandSalesShare: []category_research.CategoryResearchBrandShareItem{{Brand: "BrandA", MonthlySales: 900, Share: 0.18}},
	}
	html := buildCategorySummaryHTML(dataset, overview)
	for _, expected := range []string{"调研分析摘要", "厨房秤", "核心指标", "进入判断", "竞争与风险", "建议动作", "P0", "BrandA"} {
		if !strings.Contains(html, expected) {
			t.Fatalf("html missing %q", expected)
		}
	}
}
