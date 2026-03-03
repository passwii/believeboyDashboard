from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel


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


class CategoryResearchOverviewResponse(BaseModel):
    dataset: CategoryResearchDatasetItem
    kpis: CategoryResearchOverviewKpis
    brand_sales_share: list[CategoryResearchBrandShareItem]
    listing_age_distribution: list[CategoryResearchBucketItem]
    fulfillment_distribution: list[CategoryResearchBucketItem]
    fixed_price_bands: list[CategoryResearchBucketItem]
    quantile_price_bands: list[CategoryResearchQuantileBandItem]
    price_stats: CategoryResearchPriceStats
    price_sales_correlation: float
    fba_fee_distribution: list[CategoryResearchBucketItem]
    price_sales_points: list[CategoryResearchPriceSalesPoint]
    available_asins: list[str]


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
    is_amazon: bool
    is_new_90d: bool


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
