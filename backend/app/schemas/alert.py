from __future__ import annotations

from datetime import date, datetime, time
from typing import Optional

from pydantic import BaseModel, Field


class AlertRuleBase(BaseModel):
    name: str = Field(max_length=64)
    project_id: int
    country: str = "US"
    metric: str = Field(max_length=32)
    trigger_type: str = Field(default="threshold", max_length=16)
    condition: str = Field(max_length=16)
    threshold: float
    window_days: int = 7
    severity: str = Field(default="warning", max_length=16)
    notification_channels: str = Field(default="in_app", max_length=16)


class AlertRuleCreate(AlertRuleBase):
    pass


class AlertRuleUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=64)
    metric: Optional[str] = Field(default=None, max_length=32)
    trigger_type: Optional[str] = Field(default=None, max_length=16)
    condition: Optional[str] = Field(default=None, max_length=16)
    threshold: Optional[float] = None
    window_days: Optional[int] = None
    severity: Optional[str] = Field(default=None, max_length=16)
    notification_channels: Optional[str] = Field(default=None, max_length=16)
    is_active: Optional[bool] = None


class AlertRuleItem(AlertRuleBase):
    id: int
    is_active: bool
    created_by: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AlertEventItem(BaseModel):
    id: int
    rule_id: int
    project_id: int
    metric: str
    current_value: float
    baseline_value: float
    deviation_pct: float
    severity: str
    message: str
    status: str
    triggered_at: datetime
    acknowledged_at: Optional[datetime] = None
    acknowledged_by: Optional[str] = None
    # Reconciliation-specific fields
    match_rate: Optional[float] = None
    mismatched_items: Optional[int] = None
    total_diff: Optional[float] = None
    report_month: Optional[str] = None
    report_id: Optional[int] = None

    model_config = {"from_attributes": True}


class AlertEventListResponse(BaseModel):
    items: list[AlertEventItem]
    total: int
    page: int
    page_size: int


class AlertStatsResponse(BaseModel):
    total_active: int
    critical_count: int
    warning_count: int
    info_count: int
    acknowledged_today: int
    resolved_today: int


class AlertPreferenceItem(BaseModel):
    email_enabled: bool
    in_app_enabled: bool
    min_severity: str
    quiet_hours_start: Optional[str] = None
    quiet_hours_end: Optional[str] = None

    model_config = {"from_attributes": True}


class AlertPreferenceUpdate(BaseModel):
    email_enabled: Optional[bool] = None
    in_app_enabled: Optional[bool] = None
    min_severity: Optional[str] = Field(default=None, max_length=16)
    quiet_hours_start: Optional[str] = None
    quiet_hours_end: Optional[str] = None


class TriggerDetectionResponse(BaseModel):
    rules_evaluated: int
    events_created: int
    messages_sent: int


class MetricOption(BaseModel):
    value: str
    label: str
    description: str


class MetricOptionsResponse(BaseModel):
    metrics: list[MetricOption]