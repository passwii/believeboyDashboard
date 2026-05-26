from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


class HealthData(BaseModel):
    # 账户健康评级
    account_health_rating: str | None = None
    # 客户服务绩效
    negative_feedback: int | None = None
    a2z_claims: int | None = None
    chargeback_claims: int | None = None
    # 配送绩效
    late_shipment_rate: float | None = None
    pre_fulfillment_cancel_rate: float | None = None
    valid_tracking_rate: float | None = None
    on_time_delivery_rate: float | None = None


class ComplianceData(BaseModel):
    ip_infringement: int | None = None
    ip_complaints: int | None = None
    product_authenticity_complaints: int | None = None
    product_condition_complaints: int | None = None
    food_product_safety: int | None = None
    listing_policy_violations: int | None = None
    restricted_product_violations: int | None = None
    review_policy_violations: int | None = None
    other_policy_violations: int | None = None
    regulatory_compliance: int | None = None


class InspectionTemplateField(BaseModel):
    key: str
    label: str
    label_en: str
    type: str
    unit: str | None = None
    options: list[str] | None = None
    threshold_warning: float | None = None
    threshold_critical: float | None = None
    threshold_direction: str | None = None


class InspectionTemplateResponse(BaseModel):
    health_fields: list[InspectionTemplateField]
    service_performance_fields: list[InspectionTemplateField]
    shipping_performance_fields: list[InspectionTemplateField]
    compliance_fields: list[InspectionTemplateField]


class InspectionScreenshotItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    r2_key: str
    filename: str
    content_type: str
    file_size: int
    caption: str | None
    sort_order: int
    url: str
    thumbnail_url: str | None = None
    created_at: datetime


class InspectionPeriodItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    week_start: date
    week_end: date
    deadline: datetime
    created_at: datetime


class InspectionReportCreate(BaseModel):
    health_data: HealthData | None = None
    compliance_data: ComplianceData | None = None
    status_summary: str | None = None
    screenshot_ids: list[int] = []


class InspectionReportUpdate(BaseModel):
    health_data: HealthData | None = None
    compliance_data: ComplianceData | None = None
    status_summary: str | None = None
    screenshot_ids: list[int] | None = None


class InspectionReportItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    period_id: int
    project_id: int
    status: str
    health_data: HealthData | None
    compliance_data: ComplianceData | None
    status_summary: str | None
    submitted_by: str | None
    submitted_at: datetime | None
    screenshots: list[InspectionScreenshotItem]
    created_at: datetime
    updated_at: datetime


class InspectionOverviewItem(BaseModel):
    project_id: int
    project_name: str
    status: str
    account_health_rating: str | None = None
    # 客户服务绩效
    negative_feedback: int | None = None
    a2z_claims: int | None = None
    chargeback_claims: int | None = None
    # 配送绩效
    late_shipment_rate: float | None = None
    valid_tracking_rate: float | None = None
    on_time_delivery_rate: float | None = None
    # 合规汇总
    compliance_total: int | None = None
    status_summary: str | None = None
    submitted_by: str | None = None
    submitted_at: datetime | None = None
    screenshots: list[dict] = []


class InspectionOverviewResponse(BaseModel):
    period: InspectionPeriodItem
    items: list[InspectionOverviewItem]
    total_projects: int
    submitted_count: int
    overdue_count: int


class InspectionPeriodListResponse(BaseModel):
    items: list[InspectionPeriodItem]
    total: int


class InspectionHistoryItem(BaseModel):
    id: int
    period_id: int
    week_start: date
    week_end: date
    project_id: int
    project_name: str
    status: str
    account_health_rating: str | None = None
    compliance_total: int | None = None
    submitted_by: str | None = None
    submitted_at: datetime | None = None


class InspectionHistoryResponse(BaseModel):
    items: list[InspectionHistoryItem]
    total: int
