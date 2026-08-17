//! 运营 → 调研分析（P5-3，BLF-724）
//!
//! 对齐 backend `backend/app/api/v1/endpoints/category_research.py` 的
//! 6 个端点（字段 snake_case 1:1；可选 / 带默认值字段一律
//! `#[serde(default)]` 容忍缺省）：
//! - `GET /api/v1/category-research/datasets?marketplace[&category_keyword_en][&current_only][&include_history]`
//!   → `Vec<`[`CategoryResearchDatasetItem`]`>`（数据集列表，含历史版本）；
//! - `GET /api/v1/category-research/datasets/{id}[?price_band_standard][&price_band_breaks]`
//!   → [`CategoryResearchOverviewResponse`]（单数据集总览 + KPI + 高级指标）；
//! - `GET /api/v1/category-research/datasets/{id}/market-trend?months`
//!   → [`CategoryResearchMarketTrendResponse`]（市场趋势近 N 个月月销量）；
//! - `GET /api/v1/category-research/datasets/{id}/products?page&page_size[&brand][&fulfillment_method][&price_band]`
//!   → [`CategoryResearchProductsResponse`]（产品明细分页）；
//! - `POST /api/v1/category-research/datasets/{id}/recompute` → [`CategoryResearchRecomputeResponse`]；
//! - `POST /api/v1/category-research/datasets/recompute` → [`CategoryResearchBatchRecomputeResponse`]。
//!
//! 与 frontend `app/dashboard/operations/research-analysis/page.tsx`
//! `CategoryResearchDataset` / `CategoryResearchOverview` 类型 1:1。
//!
//! 设计取舍（BLF-724）：
//! - **总览 KPI / 高级指标**（brand/seller/quality/growth/seasonality/opportunity/momentum 等）
//!   完整建模（视图层按需取数展示）。省略 web 端的 `dimension_blocks /
//!   metric_definitions / action_recommendations / signals / dimension_profiles /
//!   dimension_price_band_analysis / brand_price_band_analysis / price_band_standard /
//!   price_band_method_description` 等诊断/导出派生字段——GUI 视图只消费决策卡片
//!   与图表所需的核心键，诊断详情为 web 端特有。
//! - **总览 buckets**（brand_sales_share / listing_age_distribution / launch_month_distribution /
//!   fulfillment_distribution / fixed_price_bands / quantile_price_bands / fba_fee_distribution）
//!   保留为通用 [`CategoryResearchBucketItem`] / [`CategoryResearchBrandShareItem`] /
//!   [`CategoryResearchQuantileBandItem`]，便于后续若扩展视图层无需改 DTO。
//! - **产品明细 row 维度字段**（extracted_dimensions / manual_dimensions / effective_dimensions）
//!   用 [`serde_json::Map`] 承载（视图层按需取数；旧数据可能为空 map）。
//! - **导入 / 导出端点**（multipart upload + file response）：本棒 GUI 视图只消费
//!   「数据看板」读取入口，导入走 web 端；导出文件 GUI 暂不实现（与 weekly_product
//!   analysis 同款取舍——GUI 暂无导出基建）。

use chrono::{DateTime, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 数据集版本记录（对齐 backend `_to_dataset_item` 字段集；含历史版本）
///
/// `data_year/month/day` 为 `data_date` 的拆分（web 端 `formatDatasetDate` 优先用
/// `data_date`，否则用三者拼回；视图层直接展示 `data_date`，三者缺省时回退）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchDatasetItem {
    pub id: i64,
    pub marketplace: String,
    pub category_keyword_en: String,
    pub category_name_zh: String,
    pub version: i64,
    pub is_current: bool,
    #[serde(default)]
    pub superseded_at: Option<DateTime<chrono::Utc>>,
    #[serde(default)]
    pub upload_file_id: String,
    #[serde(default)]
    pub upload_file_path: String,
    #[serde(default)]
    pub original_filename: Option<String>,
    #[serde(default)]
    pub stored_filename: String,
    #[serde(default)]
    pub file_size_bytes: Option<i64>,
    #[serde(default)]
    pub file_sha256: Option<String>,
    #[serde(default)]
    pub ingestion_status: String,
    #[serde(default)]
    pub ingestion_error: Option<String>,
    #[serde(default)]
    pub data_date: Option<NaiveDate>,
    #[serde(default)]
    pub data_year: Option<i64>,
    #[serde(default)]
    pub data_month: Option<i64>,
    #[serde(default)]
    pub data_day: Option<i64>,
    pub row_count_products: i64,
    pub row_count_trends: i64,
    #[serde(default)]
    pub quality_warnings: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub created_at: Option<DateTime<chrono::Utc>>,
    #[serde(default)]
    pub updated_at: Option<DateTime<chrono::Utc>>,
}

/// KPI 顶层（对齐 backend `CategoryResearchOverviewKpis`）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchOverviewKpis {
    #[serde(default)]
    pub sample_count: i64,
    #[serde(default)]
    pub brand_count: i64,
    #[serde(default)]
    pub average_price_usd: f64,
    #[serde(default)]
    pub total_monthly_sales: i64,
    #[serde(default)]
    pub total_monthly_revenue_usd: f64,
    #[serde(default)]
    pub amazon_share: f64,
}

/// 单桶（数量分布；listing_age / launch_month / fulfillment / fixed_price_bands / fba_fee）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchBucketItem {
    pub label: String,
    pub count: i64,
}

/// 单桶（带月销量；launch_month_distribution）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchBucketSalesItem {
    pub label: String,
    pub count: i64,
    #[serde(default)]
    pub monthly_sales: i64,
}

/// 品牌销量份额（对齐 `CategoryResearchBrandShareItem`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchBrandShareItem {
    pub brand: String,
    pub monthly_sales: i64,
    pub share: f64,
}

/// 分位数价格带（对齐 `CategoryResearchQuantileBandItem`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchQuantileBandItem {
    pub label: String,
    #[serde(default)]
    pub min_price: f64,
    #[serde(default)]
    pub max_price: f64,
    pub count: i64,
}

/// 价格统计（均值 / 中位数 / p25 / p75）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchPriceStats {
    #[serde(default)]
    pub mean: f64,
    #[serde(default)]
    pub median: f64,
    #[serde(default)]
    pub p25: f64,
    #[serde(default)]
    pub p75: f64,
}

/// 价格-销量散点（asin / price / monthly_sales）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchPriceSalesPoint {
    #[serde(default)]
    pub asin: Option<String>,
    #[serde(default)]
    pub price_usd: f64,
    #[serde(default)]
    pub monthly_sales: i64,
}

/// 市场集中度（CR3/5/10 + HHI）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchMarketConcentration {
    #[serde(default)]
    pub cr3: f64,
    #[serde(default)]
    pub cr5: f64,
    #[serde(default)]
    pub cr10: f64,
    #[serde(default)]
    pub hhi: f64,
}

/// 品牌垄断（CR3/5/10 + HHI + 风险等级）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchBrandMonopoly {
    #[serde(default)]
    pub brand_cr3: f64,
    #[serde(default)]
    pub brand_cr5: f64,
    #[serde(default)]
    pub brand_cr10: f64,
    #[serde(default)]
    pub brand_hhi: f64,
    #[serde(default)]
    pub risk_level: String,
}

/// 卖家份额（top sellers 列表）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchSellerShareItem {
    pub seller: String,
    pub monthly_sales: i64,
    pub share: f64,
}

/// 卖家垄断（CR1/3/5/10 + HHI + 风险等级 + top sellers）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchSellerMonopoly {
    #[serde(default)]
    pub seller_count: i64,
    #[serde(default = "default_seller_cr1")]
    pub seller_cr1: f64,
    #[serde(default)]
    pub seller_cr3: f64,
    #[serde(default)]
    pub seller_cr5: f64,
    #[serde(default)]
    pub seller_cr10: f64,
    #[serde(default)]
    pub seller_hhi: f64,
    #[serde(default)]
    pub amazon_seller_sales_share: f64,
    #[serde(default)]
    pub risk_level: String,
    #[serde(default)]
    pub top_sellers: Vec<CategoryResearchSellerShareItem>,
}

/// 单 ASIN 份额（产品垄断 top_asins 用）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchAsinShareItem {
    pub asin: String,
    pub monthly_sales: i64,
    pub share: f64,
}

/// 产品垄断（CR1/3/10 + top1:100 ratio + 风险等级 + top asins）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchProductMonopoly {
    #[serde(default)]
    pub asin_top1_share: f64,
    #[serde(default)]
    pub asin_top3_share: f64,
    #[serde(default)]
    pub asin_top10_share: f64,
    #[serde(default)]
    pub top1_to_top100_ratio: f64,
    #[serde(default)]
    pub risk_level: String,
    #[serde(default)]
    pub top_asins: Vec<CategoryResearchAsinShareItem>,
}

/// 中国卖家竞争（数量 + 销量份额 + 风险等级）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchChinaSellerCompetition {
    #[serde(default)]
    pub china_seller_count: i64,
    #[serde(default)]
    pub china_seller_count_share: f64,
    #[serde(default)]
    pub china_seller_sales_share: f64,
    #[serde(default)]
    pub risk_level: String,
}

/// 市场增长（斜率 + 同比 + CAGR + 等级 + tier）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchMarketGrowth {
    #[serde(default)]
    pub trend_slope: f64,
    #[serde(default)]
    pub last12_vs_prev12_growth: f64,
    #[serde(default)]
    pub cagr_like_growth: f64,
    #[serde(default)]
    pub growth_level: String,
    #[serde(default)]
    pub growth_tier: String,
    #[serde(default)]
    pub radar_score: f64,
}

/// 季节性（Peak3 份额 + CV + 等级 + 推荐月份）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchSeasonality {
    #[serde(default)]
    pub peak3_month_sales_share: f64,
    #[serde(default)]
    pub monthly_sales_cv: f64,
    #[serde(default)]
    pub seasonality_level: String,
    #[serde(default)]
    pub seasonality_tier: String,
    #[serde(default)]
    pub entry_friendliness_score: f64,
    #[serde(default)]
    pub recommended_entry_months: Vec<String>,
}

/// 评论研究（review 分布 + 低评论层份额）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchReviewResearch {
    #[serde(default)]
    pub average_rating: f64,
    #[serde(default)]
    pub review_median: f64,
    #[serde(default)]
    pub review_p75: f64,
    #[serde(default)]
    pub review_top10_share: f64,
    #[serde(default)]
    pub low_review_product_share: f64,
    #[serde(default)]
    pub low_review_threshold: i64,
}

/// 新品机会（数量 / 销量份额 + 机会等级）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchNewProductOpportunity {
    #[serde(default)]
    pub new_product_count: i64,
    #[serde(default)]
    pub new_product_share: f64,
    #[serde(default)]
    pub new_product_sales_share: f64,
    #[serde(default)]
    pub new_product_avg_monthly_sales: f64,
    #[serde(default)]
    pub new_product_median_price_usd: f64,
    #[serde(default)]
    pub opportunity_level: String,
    #[serde(default)]
    pub radar_score: f64,
}

/// 数据质量（综合分 + 各维度分 + 等级）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchDataQuality {
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub missing_trend_for_asin_count: i64,
    #[serde(default)]
    pub invalid_price_count: i64,
    #[serde(default)]
    pub invalid_fba_fee_count: i64,
    #[serde(default)]
    pub duplicate_asin_count: i64,
    #[serde(default)]
    pub missing_fba_fee_count: i64,
    #[serde(default)]
    pub missing_seller_country_count: i64,
    #[serde(default)]
    pub missing_brand_count: i64,
    #[serde(default)]
    pub unknown_fulfillment_count: i64,
    #[serde(default)]
    pub completeness_score: f64,
    #[serde(default)]
    pub validity_score: f64,
    #[serde(default)]
    pub consistency_score: f64,
    #[serde(default)]
    pub coverage_score: f64,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub warning_density: f64,
    #[serde(default)]
    pub summary: String,
}

/// ASIN 动量（近 3 月动量 + 同比 + 销量 CV）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchAsinMomentumItem {
    pub asin: String,
    #[serde(default)]
    pub avg_monthly_sales: f64,
    #[serde(default)]
    pub sales_cv: f64,
    #[serde(default)]
    pub yoy_growth: f64,
    #[serde(default)]
    pub recent_3m_momentum: f64,
}

/// 高级指标汇总（KPI 之上；决策卡片消费）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchAdvancedMetrics {
    #[serde(default)]
    pub market_concentration: CategoryResearchMarketConcentration,
    #[serde(default)]
    pub brand_monopoly: CategoryResearchBrandMonopoly,
    #[serde(default)]
    pub seller_monopoly: CategoryResearchSellerMonopoly,
    #[serde(default)]
    pub product_monopoly: CategoryResearchProductMonopoly,
    #[serde(default)]
    pub china_seller_competition: CategoryResearchChinaSellerCompetition,
    #[serde(default)]
    pub market_growth: CategoryResearchMarketGrowth,
    #[serde(default)]
    pub seasonality: CategoryResearchSeasonality,
    #[serde(default)]
    pub review_research: CategoryResearchReviewResearch,
    #[serde(default)]
    pub new_product_opportunity: CategoryResearchNewProductOpportunity,
    #[serde(default)]
    pub data_quality: CategoryResearchDataQuality,
    #[serde(default)]
    pub asin_momentum: Vec<CategoryResearchAsinMomentumItem>,
}

/// 总览响应（对齐 backend `CategoryResearchOverviewResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchOverviewResponse {
    pub dataset: CategoryResearchDatasetItem,
    pub kpis: CategoryResearchOverviewKpis,
    #[serde(default)]
    pub brand_sales_share: Vec<CategoryResearchBrandShareItem>,
    #[serde(default)]
    pub listing_age_distribution: Vec<CategoryResearchBucketItem>,
    #[serde(default)]
    pub launch_month_distribution: Vec<CategoryResearchBucketSalesItem>,
    #[serde(default)]
    pub fulfillment_distribution: Vec<CategoryResearchBucketItem>,
    #[serde(default)]
    pub fixed_price_bands: Vec<CategoryResearchBucketItem>,
    #[serde(default)]
    pub quantile_price_bands: Vec<CategoryResearchQuantileBandItem>,
    #[serde(default)]
    pub price_stats: CategoryResearchPriceStats,
    #[serde(default)]
    pub price_sales_correlation: f64,
    #[serde(default)]
    pub fba_fee_distribution: Vec<CategoryResearchBucketItem>,
    #[serde(default)]
    pub price_sales_points: Vec<CategoryResearchPriceSalesPoint>,
    #[serde(default)]
    pub available_asins: Vec<String>,
    #[serde(default)]
    pub advanced_metrics: CategoryResearchAdvancedMetrics,
}

/// 产品明细行（对齐 backend `CategoryResearchProductRow`）
///
/// 维度字段（extracted / manual / effective_dimensions）为 string→string map；旧数据
/// 可能为空 map，`#[serde(default)]` 容忍。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchProductRow {
    pub id: i64,
    pub source_row_no: i64,
    #[serde(default)]
    pub asin: Option<String>,
    #[serde(default)]
    pub parent_asin: Option<String>,
    #[serde(default)]
    pub product_name: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub seller: Option<String>,
    #[serde(default)]
    pub price_usd: Option<f64>,
    #[serde(default)]
    pub monthly_sales: i64,
    #[serde(default)]
    pub monthly_revenue_usd: Option<f64>,
    #[serde(default)]
    pub rating: Option<f64>,
    #[serde(default)]
    pub review_count: i64,
    #[serde(default)]
    pub launch_date: Option<NaiveDate>,
    #[serde(default)]
    pub listing_age_days: Option<i64>,
    #[serde(default)]
    pub fba_fee_usd: Option<f64>,
    #[serde(default)]
    pub fulfillment_method: Option<String>,
    #[serde(default)]
    pub bbx_seller_attribute: Option<String>,
    #[serde(default)]
    pub variant_count: Option<i64>,
    #[serde(default)]
    pub has_main_image_video: Option<bool>,
    #[serde(default)]
    pub is_climate_pledge_friendly: Option<bool>,
    #[serde(default)]
    pub has_brand_store: Option<bool>,
    #[serde(default)]
    pub seller_country_region: Option<String>,
    #[serde(default)]
    pub is_amazon: bool,
    #[serde(default)]
    pub is_new_90d: bool,
    #[serde(default)]
    pub extracted_dimensions: BTreeMap<String, String>,
    #[serde(default)]
    pub manual_dimensions: BTreeMap<String, String>,
    #[serde(default)]
    pub effective_dimensions: BTreeMap<String, String>,
}

/// 产品明细分页响应
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchProductsResponse {
    pub dataset_id: i64,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub page_size: i64,
    pub has_next: bool,
    #[serde(default)]
    pub rows: Vec<CategoryResearchProductRow>,
}

/// 市场趋势点
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchMarketTrendPoint {
    pub year_month: String,
    pub monthly_sales: i64,
}

/// 市场趋势响应（近 N 个月月销量序列）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchMarketTrendResponse {
    pub dataset_id: i64,
    #[serde(default)]
    pub months: i64,
    #[serde(default)]
    pub points: Vec<CategoryResearchMarketTrendPoint>,
}

/// 单数据集重算响应
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchRecomputeResponse {
    pub dataset_id: i64,
    pub row_count_products: i64,
    pub row_count_trends: i64,
    #[serde(default)]
    pub quality_warnings: BTreeMap<String, serde_json::Value>,
}

/// 批量重算响应
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResearchBatchRecomputeResponse {
    pub matched: i64,
    pub recomputed: i64,
    #[serde(default)]
    pub dataset_ids: Vec<i64>,
}

/// 卖家垄断 `seller_cr1` 的 Pydantic 默认值（0.0；后端 schema 显式 default，
/// 但老数据可能缺，serde 端也要 default 容错）
fn default_seller_cr1() -> f64 {
    0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 反序列化契约：backend `/category-research/datasets` 真实响应形态
    /// （含历史版本 + 缺省字段）
    #[test]
    fn dataset_item_deserializes_backend_shape() {
        let json = r#"[
            {
                "id": 7,
                "marketplace": "US",
                "category_keyword_en": "yoga mat",
                "category_name_zh": "瑜伽垫",
                "version": 3,
                "is_current": true,
                "superseded_at": null,
                "upload_file_id": "u-7",
                "upload_file_path": "/srv/uploads/7.xlsx",
                "original_filename": "yoga_us_2026_08.xlsx",
                "stored_filename": "7_yoga_us_2026_08.xlsx",
                "file_size_bytes": 188000,
                "file_sha256": "abcdef0123456789",
                "ingestion_status": "ok",
                "ingestion_error": null,
                "data_date": "2026-08-12",
                "data_year": 2026,
                "data_month": 8,
                "data_day": 12,
                "row_count_products": 420,
                "row_count_trends": 1680,
                "quality_warnings": {"missing_brand": 5},
                "created_by": "yawei",
                "created_at": "2026-08-13T02:11:00Z",
                "updated_at": "2026-08-15T03:24:00Z"
            },
            {
                "id": 6,
                "marketplace": "US",
                "category_keyword_en": "yoga mat",
                "category_name_zh": "瑜伽垫",
                "version": 2,
                "is_current": false,
                "superseded_at": "2026-08-13T02:11:00Z",
                "upload_file_id": "u-6",
                "upload_file_path": "/srv/uploads/6.xlsx",
                "original_filename": "yoga_us_2026_07.xlsx",
                "stored_filename": "6_yoga_us_2026_07.xlsx",
                "file_size_bytes": null,
                "file_sha256": null,
                "ingestion_status": "ok",
                "ingestion_error": null,
                "data_date": "2026-07-15",
                "data_year": 2026,
                "data_month": 7,
                "data_day": 15,
                "row_count_products": 380,
                "row_count_trends": 1500,
                "quality_warnings": {}
            }
        ]"#;
        let rows: Vec<CategoryResearchDatasetItem> =
            serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, 7);
        assert_eq!(rows[0].version, 3);
        assert!(rows[0].is_current);
        assert_eq!(
            rows[0].data_date,
            Some(NaiveDate::from_ymd_opt(2026, 8, 12).expect("合法日期"))
        );
        assert_eq!(rows[0].row_count_products, 420);
        assert_eq!(rows[0].quality_warnings.get("missing_brand"), Some(&serde_json::json!(5)));
        // 缺省字段容错（version=2 的旧记录）
        assert_eq!(rows[1].file_size_bytes, None);
        assert!(!rows[1].is_current);
    }

    /// 反序列化契约：overview 嵌套结构（KPI + 高级指标）
    #[test]
    fn overview_response_deserializes_backend_shape() {
        let json = r#"{
            "dataset": {
                "id": 7, "marketplace": "US", "category_keyword_en": "yoga mat",
                "category_name_zh": "瑜伽垫", "version": 3, "is_current": true,
                "upload_file_id": "u-7", "upload_file_path": "/srv/uploads/7.xlsx",
                "stored_filename": "7.xlsx", "ingestion_status": "ok",
                "data_date": "2026-08-12", "data_year": 2026,
                "data_month": 8, "data_day": 12,
                "row_count_products": 420, "row_count_trends": 1680,
                "quality_warnings": {}
            },
            "kpis": {
                "sample_count": 420, "brand_count": 78,
                "average_price_usd": 32.5, "total_monthly_sales": 12500,
                "total_monthly_revenue_usd": 406250.0, "amazon_share": 0.18
            },
            "brand_sales_share": [
                {"brand": "Gaiam", "monthly_sales": 2400, "share": 0.192},
                {"brand": "Amazon Basics", "monthly_sales": 2200, "share": 0.176}
            ],
            "listing_age_distribution": [
                {"label": "<30 天", "count": 12},
                {"label": "30-180 天", "count": 80}
            ],
            "launch_month_distribution": [
                {"label": "2024-09", "count": 5, "monthly_sales": 350}
            ],
            "fulfillment_distribution": [
                {"label": "FBA", "count": 380}
            ],
            "fixed_price_bands": [
                {"label": "$0-25", "count": 90},
                {"label": "$25-50", "count": 230}
            ],
            "quantile_price_bands": [
                {"label": "Q1", "min_price": 15.0, "max_price": 22.0, "count": 105}
            ],
            "price_stats": {"mean": 32.5, "median": 28.0, "p25": 22.0, "p75": 40.0},
            "price_sales_correlation": -0.18,
            "fba_fee_distribution": [
                {"label": "$0-3", "count": 200}
            ],
            "price_sales_points": [
                {"asin": "B0TEST123", "price_usd": 28.5, "monthly_sales": 120}
            ],
            "available_asins": ["B0TEST123", "B0TEST456"],
            "advanced_metrics": {
                "market_concentration": {"cr3": 0.42, "cr5": 0.58, "cr10": 0.71, "hhi": 950.0},
                "brand_monopoly": {
                    "brand_cr3": 0.42, "brand_cr5": 0.58, "brand_cr10": 0.71,
                    "brand_hhi": 950.0, "risk_level": "medium"
                },
                "seller_monopoly": {
                    "seller_count": 145, "seller_cr3": 0.51, "seller_cr5": 0.66,
                    "seller_cr10": 0.78, "seller_hhi": 1300.0,
                    "amazon_seller_sales_share": 0.18, "risk_level": "high",
                    "top_sellers": [
                        {"seller": "Gaiam LLC", "monthly_sales": 2200, "share": 0.176}
                    ]
                },
                "product_monopoly": {
                    "asin_top1_share": 0.05, "asin_top3_share": 0.12,
                    "asin_top10_share": 0.28, "top1_to_top100_ratio": 0.8,
                    "risk_level": "low",
                    "top_asins": [{"asin": "B0TEST123", "monthly_sales": 120, "share": 0.01}]
                },
                "china_seller_competition": {
                    "china_seller_count": 180, "china_seller_count_share": 0.43,
                    "china_seller_sales_share": 0.36, "risk_level": "medium"
                },
                "market_growth": {
                    "trend_slope": 12.5, "last12_vs_prev12_growth": 0.08,
                    "cagr_like_growth": 0.07, "growth_level": "growing",
                    "growth_tier": "fast_growing", "radar_score": 72.0
                },
                "seasonality": {
                    "peak3_month_sales_share": 0.32, "monthly_sales_cv": 0.18,
                    "seasonality_level": "moderate", "seasonality_tier": "moderate",
                    "entry_friendliness_score": 65.0,
                    "recommended_entry_months": ["3月", "9月"]
                },
                "review_research": {
                    "average_rating": 4.3, "review_median": 180, "review_p75": 800,
                    "review_top10_share": 0.62, "low_review_product_share": 0.28,
                    "low_review_threshold": 100
                },
                "new_product_opportunity": {
                    "new_product_count": 38, "new_product_share": 0.09,
                    "new_product_sales_share": 0.06, "new_product_avg_monthly_sales": 35.0,
                    "new_product_median_price_usd": 26.0, "opportunity_level": "medium",
                    "radar_score": 55.0
                },
                "data_quality": {
                    "score": 86.5, "missing_trend_for_asin_count": 12,
                    "invalid_price_count": 3, "invalid_fba_fee_count": 1,
                    "duplicate_asin_count": 0, "completeness_score": 92.0,
                    "validity_score": 95.0, "consistency_score": 80.0,
                    "coverage_score": 78.0, "level": "good",
                    "warning_density": 0.05, "summary": "整体数据可用"
                },
                "asin_momentum": [
                    {"asin": "B0TEST123", "avg_monthly_sales": 110.0, "sales_cv": 0.22,
                     "yoy_growth": 0.15, "recent_3m_momentum": 0.08}
                ]
            }
        }"#;
        let resp: CategoryResearchOverviewResponse =
            serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.dataset.id, 7);
        assert_eq!(resp.kpis.sample_count, 420);
        assert_eq!(resp.brand_sales_share.len(), 2);
        assert_eq!(resp.brand_sales_share[0].brand, "Gaiam");
        assert_eq!(resp.quantile_price_bands[0].min_price, 15.0);
        assert_eq!(resp.price_sales_points.len(), 1);
        assert_eq!(resp.advanced_metrics.brand_monopoly.risk_level, "medium");
        assert_eq!(resp.advanced_metrics.seller_monopoly.top_sellers.len(), 1);
        assert_eq!(resp.advanced_metrics.market_growth.growth_tier, "fast_growing");
        assert_eq!(
            resp.advanced_metrics.seasonality.recommended_entry_months,
            vec!["3月", "9月"]
        );
        assert_eq!(resp.advanced_metrics.data_quality.level, "good");
        assert_eq!(resp.advanced_metrics.asin_momentum[0].asin, "B0TEST123");
    }

    /// 反序列化契约：缺省高级指标字段（空对象）容忍
    #[test]
    fn overview_with_empty_advanced_metrics_deserializes() {
        let json = r#"{
            "dataset": {
                "id": 1, "marketplace": "US", "category_keyword_en": "k",
                "category_name_zh": "类", "version": 1, "is_current": true,
                "upload_file_id": "u", "upload_file_path": "p",
                "stored_filename": "s", "ingestion_status": "ok",
                "data_date": "2026-08-01", "data_year": 2026,
                "data_month": 8, "data_day": 1,
                "row_count_products": 0, "row_count_trends": 0,
                "quality_warnings": {}
            },
            "kpis": {
                "sample_count": 0, "brand_count": 0,
                "average_price_usd": 0.0, "total_monthly_sales": 0,
                "total_monthly_revenue_usd": 0.0, "amazon_share": 0.0
            }
        }"#;
        let resp: CategoryResearchOverviewResponse =
            serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.kpis.sample_count, 0);
        assert_eq!(resp.brand_sales_share.len(), 0);
        // 缺省 advanced_metrics 各子结构：取零值
        assert_eq!(resp.advanced_metrics.brand_monopoly.risk_level, "");
        assert!(resp.advanced_metrics.asin_momentum.is_empty());
    }

    /// 反序列化契约：products 分页
    #[test]
    fn products_response_deserializes_backend_shape() {
        let json = r#"{
            "dataset_id": 7, "page": 1, "page_size": 100, "has_next": true,
            "rows": [
                {
                    "id": 9001, "source_row_no": 1,
                    "asin": "B0TEST123", "parent_asin": null,
                    "product_name": "Premium Yoga Mat 6mm",
                    "brand": "Gaiam", "seller": "Gaiam LLC",
                    "price_usd": 28.5, "monthly_sales": 120,
                    "monthly_revenue_usd": 3420.0, "rating": 4.5,
                    "review_count": 1200, "launch_date": "2024-03-15",
                    "listing_age_days": 850, "fba_fee_usd": 4.2,
                    "fulfillment_method": "FBA",
                    "bbx_seller_attribute": "Brand",
                    "variant_count": 3, "has_main_image_video": true,
                    "is_climate_pledge_friendly": false,
                    "has_brand_store": true,
                    "seller_country_region": "US",
                    "is_amazon": false, "is_new_90d": false,
                    "extracted_dimensions": {"color": "purple"},
                    "manual_dimensions": {},
                    "effective_dimensions": {"color": "purple"}
                },
                {
                    "id": 9002, "source_row_no": 2,
                    "asin": null, "is_amazon": true, "is_new_90d": true
                }
            ]
        }"#;
        let resp: CategoryResearchProductsResponse =
            serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.dataset_id, 7);
        assert!(resp.has_next);
        assert_eq!(resp.rows.len(), 2);
        assert_eq!(resp.rows[0].asin.as_deref(), Some("B0TEST123"));
        assert_eq!(resp.rows[0].monthly_sales, 120);
        assert_eq!(resp.rows[0].extracted_dimensions.get("color"), Some(&"purple".to_string()));
        // 缺省字段容错
        assert_eq!(resp.rows[1].asin, None);
        assert!(resp.rows[1].is_amazon);
        assert!(resp.rows[1].is_new_90d);
        assert!(resp.rows[1].extracted_dimensions.is_empty());
    }

    /// 反序列化契约：market-trend 序列
    #[test]
    fn market_trend_deserializes_backend_shape() {
        let json = r#"{
            "dataset_id": 7, "months": 24,
            "points": [
                {"year_month": "2024-09", "monthly_sales": 8500},
                {"year_month": "2024-10", "monthly_sales": 9100},
                {"year_month": "2024-11", "monthly_sales": 10500}
            ]
        }"#;
        let resp: CategoryResearchMarketTrendResponse =
            serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.dataset_id, 7);
        assert_eq!(resp.months, 24);
        assert_eq!(resp.points.len(), 3);
        assert_eq!(resp.points[0].year_month, "2024-09");
        assert_eq!(resp.points[0].monthly_sales, 8500);

        // 缺省 months / points 容错
        let minimal = r#"{"dataset_id": 7}"#;
        let resp: CategoryResearchMarketTrendResponse =
            serde_json::from_str(minimal).expect("反序列化失败");
        assert_eq!(resp.months, 0);
        assert!(resp.points.is_empty());
    }

    /// 反序列化契约：recompute 响应
    #[test]
    fn recompute_response_deserializes_backend_shape() {
        let json = r#"{
            "dataset_id": 7, "row_count_products": 420,
            "row_count_trends": 1680,
            "quality_warnings": {"invalid_price_count": 3}
        }"#;
        let resp: CategoryResearchRecomputeResponse =
            serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.dataset_id, 7);
        assert_eq!(resp.row_count_products, 420);
        assert_eq!(
            resp.quality_warnings.get("invalid_price_count"),
            Some(&serde_json::json!(3))
        );
    }

    /// 反序列化契约：批量重算
    #[test]
    fn batch_recompute_deserializes_backend_shape() {
        let json = r#"{
            "matched": 5, "recomputed": 4, "dataset_ids": [7, 6, 5, 4]
        }"#;
        let resp: CategoryResearchBatchRecomputeResponse =
            serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.matched, 5);
        assert_eq!(resp.recomputed, 4);
        assert_eq!(resp.dataset_ids, vec![7, 6, 5, 4]);
    }
}
