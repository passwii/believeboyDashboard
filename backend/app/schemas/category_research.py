from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, Field


class CategoryResearchDatasetItem(BaseModel):
    id: int
    marketplace: str
    category_keyword_en: str
    category_name_zh: str
    version: int
    is_current: bool
    superseded_at: datetime | None
    upload_file_id: str
    upload_file_path: str
    original_filename: str | None
    stored_filename: str
    file_size_bytes: int | None
    file_sha256: str | None
    ingestion_status: str
    ingestion_error: str | None
    data_date: date | None
    data_year: int | None
    data_month: int | None
    data_day: int | None
    row_count_products: int
    row_count_trends: int
    quality_warnings: dict[str, Any]
    created_by: str | None
    created_at: datetime | None
    updated_at: datetime | None


class CategoryResearchImportResponse(BaseModel):
    dataset_id: int
    version: int
    is_current: bool
    row_count_products: int
    row_count_trends: int
    quality_warnings: dict[str, Any]


class CategoryResearchRecomputeResponse(BaseModel):
    dataset_id: int
    row_count_products: int
    row_count_trends: int
    quality_warnings: dict[str, Any]


class CategoryResearchBatchRecomputeResponse(BaseModel):
    matched: int
    recomputed: int
    dataset_ids: list[int]


class CategoryResearchOverviewKpis(BaseModel):
    sample_count: int
    brand_count: int
    average_price_usd: float
    total_monthly_sales: int
    total_monthly_revenue_usd: float
    amazon_share: float


class CategoryResearchBucketItem(BaseModel):
    label: str
    count: int


class CategoryResearchBucketSalesItem(BaseModel):
    label: str
    count: int
    monthly_sales: int


class CategoryResearchBrandShareItem(BaseModel):
    brand: str
    monthly_sales: int
    share: float


class CategoryResearchQuantileBandItem(BaseModel):
    label: str
    min_price: float
    max_price: float
    count: int


class CategoryResearchPriceStats(BaseModel):
    mean: float
    median: float
    p25: float
    p75: float


class CategoryResearchPriceSalesPoint(BaseModel):
    asin: str | None
    price_usd: float
    monthly_sales: int


class CategoryResearchMarketConcentration(BaseModel):
    cr3: float
    cr5: float
    cr10: float
    hhi: float


class CategoryResearchBrandMonopoly(BaseModel):
    brand_cr3: float
    brand_cr5: float
    brand_cr10: float
    brand_hhi: float
    risk_level: str


class CategoryResearchSellerShareItem(BaseModel):
    seller: str
    monthly_sales: int
    share: float


class CategoryResearchSellerMonopoly(BaseModel):
    seller_count: int
    seller_cr1: float = 0.0
    seller_cr3: float
    seller_cr5: float
    seller_cr10: float
    seller_hhi: float
    amazon_seller_sales_share: float
    risk_level: str
    top_sellers: list[CategoryResearchSellerShareItem]


class CategoryResearchAsinShareItem(BaseModel):
    asin: str
    monthly_sales: int
    share: float


class CategoryResearchProductMonopoly(BaseModel):
    asin_top1_share: float
    asin_top3_share: float
    asin_top10_share: float
    top1_to_top100_ratio: float
    risk_level: str
    top_asins: list[CategoryResearchAsinShareItem]


class CategoryResearchChinaSellerCompetition(BaseModel):
    china_seller_count: int
    china_seller_count_share: float
    china_seller_sales_share: float
    risk_level: str


class CategoryResearchMarketGrowth(BaseModel):
    trend_slope: float
    last12_vs_prev12_growth: float
    cagr_like_growth: float
    growth_level: str
    growth_tier: str = 'stable'
    radar_score: float = 50.0
    tier_thresholds: list[str] = Field(default_factory=list)


class CategoryResearchSeasonality(BaseModel):
    peak3_month_sales_share: float
    monthly_sales_cv: float
    seasonality_level: str
    recommended_entry_months: list[str]
    seasonality_tier: str = 'balanced'
    entry_friendliness_score: float = 50.0
    tier_thresholds: list[str] = Field(default_factory=list)


class CategoryResearchReviewResearch(BaseModel):
    average_rating: float = 0.0
    review_median: float
    review_p75: float
    review_top10_share: float
    low_review_product_share: float
    low_review_threshold: int = 100
    bottom_quartile_product_share: float = 0.0
    rating_band_distribution: list[dict[str, Any]] = Field(default_factory=list)
    review_segment_distribution: list[dict[str, Any]] = Field(default_factory=list)


class CategoryResearchPriceBandOpportunityItem(BaseModel):
    label: str
    count: int
    monthly_sales: int
    monthly_revenue_usd: float
    sales_share: float
    revenue_share: float
    average_rating: float
    average_review_count: float


class CategoryResearchNewProductOpportunity(BaseModel):
    new_product_count: int
    new_product_share: float
    new_product_sales_share: float
    new_product_avg_monthly_sales: float
    new_product_median_price_usd: float
    opportunity_level: str = 'low'
    radar_score: float = 0.0
    level_thresholds: list[str] = Field(default_factory=list)


class CategoryResearchSupplyComplexity(BaseModel):
    score: float
    fulfillment_mix_score: float
    fba_fee_pressure_score: float
    price_dispersion_score: float
    complexity_level: str = 'low'
    radar_score: float = 100.0
    level_thresholds: list[str] = Field(default_factory=list)
    explanation_lines: list[str] = Field(default_factory=list)


class CategoryResearchAsinMomentumItem(BaseModel):
    asin: str
    avg_monthly_sales: float
    sales_cv: float
    yoy_growth: float
    recent_3m_momentum: float


class CategoryResearchDataQuality(BaseModel):
    score: float
    missing_trend_for_asin_count: int
    invalid_price_count: int
    invalid_fba_fee_count: int
    duplicate_asin_count: int
    missing_fba_fee_count: int = 0
    missing_seller_country_count: int = 0
    missing_brand_count: int = 0
    unknown_fulfillment_count: int = 0
    completeness_score: float = 100.0
    validity_score: float = 100.0
    consistency_score: float = 100.0
    coverage_score: float = 100.0
    level: str = 'excellent'
    warning_density: float = 0.0
    summary: str = ''


class CategoryResearchDimensionBlock(BaseModel):
    key: str
    label: str
    summary: str
    risk_level: str
    metric_keys: list[str] = Field(default_factory=list)


class CategoryResearchMetricDefinition(BaseModel):
    key: str
    name: str
    formula_text: str
    thresholds: list[str] = Field(default_factory=list)
    interpretation_template: str
    pitfall: str
    action_hint: str


class CategoryResearchActionRecommendation(BaseModel):
    priority: str
    action: str
    why: str
    required_validation: list[str] = Field(default_factory=list)
    linked_dimension: str
    rule_basis: list[str] = Field(default_factory=list)


class CategoryResearchSignal(BaseModel):
    key: str
    label: str
    level: str
    direction: str
    linked_dimension: str


class CategoryResearchDimensionProfileValue(BaseModel):
    value: str
    count: int
    share: float


class CategoryResearchDimensionProfile(BaseModel):
    key: str
    label: str
    coverage: float
    distinct_count: int
    top_values: list[CategoryResearchDimensionProfileValue] = Field(default_factory=list)


class CategoryResearchBandDistributionItem(BaseModel):
    label: str
    count: int
    share: float


class CategoryResearchDimensionPriceBandValue(BaseModel):
    value: str
    count: int
    share: float
    band_distribution: list[CategoryResearchBandDistributionItem] = Field(default_factory=list)


class CategoryResearchDimensionPriceBandAnalysis(BaseModel):
    key: str
    label: str
    total_count: int
    values: list[CategoryResearchDimensionPriceBandValue] = Field(default_factory=list)


class CategoryResearchBrandPriceRange(BaseModel):
    min_price: float
    max_price: float


class CategoryResearchBrandPriceBandAnalysis(BaseModel):
    brand: str
    product_count: int
    monthly_sales: int
    price_range: CategoryResearchBrandPriceRange
    covered_bands: list[str] = Field(default_factory=list)
    band_distribution: list[CategoryResearchBandDistributionItem] = Field(default_factory=list)


class CategoryResearchAdvancedMetrics(BaseModel):
    market_concentration: CategoryResearchMarketConcentration
    brand_monopoly: CategoryResearchBrandMonopoly
    seller_monopoly: CategoryResearchSellerMonopoly
    product_monopoly: CategoryResearchProductMonopoly
    china_seller_competition: CategoryResearchChinaSellerCompetition
    market_growth: CategoryResearchMarketGrowth
    seasonality: CategoryResearchSeasonality
    review_research: CategoryResearchReviewResearch
    price_band_opportunities: list[CategoryResearchPriceBandOpportunityItem]
    new_product_opportunity: CategoryResearchNewProductOpportunity
    supply_complexity: CategoryResearchSupplyComplexity
    asin_momentum: list[CategoryResearchAsinMomentumItem]
    data_quality: CategoryResearchDataQuality
    dimension_blocks: list[CategoryResearchDimensionBlock] = Field(default_factory=list)
    metric_definitions: list[CategoryResearchMetricDefinition] = Field(default_factory=list)
    action_recommendations: list[CategoryResearchActionRecommendation] = Field(default_factory=list)
    signals: list[CategoryResearchSignal] = Field(default_factory=list)
    dimension_profiles: list[CategoryResearchDimensionProfile] = Field(default_factory=list)
    price_band_standard: str = 'default'
    price_band_breaks: list[float] = Field(default_factory=list)
    price_band_method: str = 'default'
    price_band_method_description: str = ''
    price_correlation_score: float = 0.0
    dimension_price_band_analysis: list[CategoryResearchDimensionPriceBandAnalysis] = Field(default_factory=list)
    brand_price_band_analysis: list[CategoryResearchBrandPriceBandAnalysis] = Field(default_factory=list)


class CategoryResearchOverviewResponse(BaseModel):
    dataset: CategoryResearchDatasetItem
    kpis: CategoryResearchOverviewKpis
    brand_sales_share: list[CategoryResearchBrandShareItem]
    listing_age_distribution: list[CategoryResearchBucketItem]
    launch_month_distribution: list[CategoryResearchBucketSalesItem]
    fulfillment_distribution: list[CategoryResearchBucketItem]
    fixed_price_bands: list[CategoryResearchBucketItem]
    quantile_price_bands: list[CategoryResearchQuantileBandItem]
    price_stats: CategoryResearchPriceStats
    price_sales_correlation: float
    fba_fee_distribution: list[CategoryResearchBucketItem]
    price_sales_points: list[CategoryResearchPriceSalesPoint]
    available_asins: list[str]
    advanced_metrics: CategoryResearchAdvancedMetrics


class CategoryResearchProductRow(BaseModel):
    id: int
    source_row_no: int
    asin: str | None
    parent_asin: str | None
    product_name: str | None
    brand: str | None
    seller: str | None
    price_usd: float | None
    monthly_sales: int
    monthly_revenue_usd: float | None
    rating: float | None
    review_count: int
    launch_date: date | None
    listing_age_days: int | None
    fba_fee_usd: float | None
    fulfillment_method: str | None
    bbx_seller_attribute: str | None
    variant_count: int | None
    has_main_image_video: bool | None
    is_climate_pledge_friendly: bool | None
    has_brand_store: bool | None
    seller_country_region: str | None
    is_amazon: bool
    is_new_90d: bool
    extracted_dimensions: dict[str, str] = Field(default_factory=dict)
    manual_dimensions: dict[str, str] = Field(default_factory=dict)
    effective_dimensions: dict[str, str] = Field(default_factory=dict)


class CategoryResearchProductsResponse(BaseModel):
    dataset_id: int
    page: int
    page_size: int
    has_next: bool
    rows: list[CategoryResearchProductRow]


class CategoryResearchTrendPoint(BaseModel):
    year_month: str
    monthly_sales: int


class CategoryResearchTrendResponse(BaseModel):
    dataset_id: int
    asin: str
    points: list[CategoryResearchTrendPoint]


class CategoryResearchMarketTrendPoint(BaseModel):
    year_month: str
    monthly_sales: int


class CategoryResearchMarketTrendResponse(BaseModel):
    dataset_id: int
    months: int
    points: list[CategoryResearchMarketTrendPoint]


class CategoryResearchManualDimensionUpsertItem(BaseModel):
    product_row_id: int
    key: str = Field(min_length=1, max_length=64)
    value: str | None = Field(default=None, max_length=255)


class CategoryResearchManualDimensionUpsertRequest(BaseModel):
    items: list[CategoryResearchManualDimensionUpsertItem] = Field(default_factory=list)


class CategoryResearchManualDimensionUpsertResponse(BaseModel):
    dataset_id: int
    updated_count: int


class CategoryResearchExportItem(BaseModel):
    key: str
    label: str
    description: str
    filename: str
    format: str
    available: bool = True


class CategoryResearchExportListResponse(BaseModel):
    dataset_id: int
    items: list[CategoryResearchExportItem] = Field(default_factory=list)
