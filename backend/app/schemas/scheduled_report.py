"""Scheduled Report Pydantic Schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


# 单次订阅允许选择的最大项目数（含「全部项目」不计）。
MAX_PROJECT_IDS = 100


def _normalize_email(v: str) -> str:
    """归一化邮箱：strip 首尾空白；空串视为未填写（None）。

    仅做轻量格式校验（必须包含 @ 且 @ 前后非空），不依赖 EmailStr 以免引入额外校验开销。
    """
    stripped = v.strip()
    if not stripped:
        return ""  # 空 → 归一为 ""，调用方据此置 NULL
    if stripped.count("@") != 1:
        raise ValueError("邮箱格式无效（需包含且仅包含一个 @）")
    local, domain = stripped.split("@")
    if not local or not domain or "." not in domain:
        raise ValueError("邮箱格式无效（用户名或域名不完整）")
    return stripped


def _normalize_project_ids(v: str | None) -> str | None:
    """归一化 project_ids：
    - None / "" → "*"
    - "*" → "*"
    - 逗号串：去重保序、非空 strip、必须全为正整数、上限 MAX_PROJECT_IDS
    """
    if v is None or v == "":
        return "*"
    if v == "*":
        return "*"
    parts = [p.strip() for p in v.split(",") if p.strip()]
    if not parts:
        return "*"
    try:
        ids = [int(p) for p in parts]
    except ValueError as e:
        raise ValueError(
            "project_ids 必须是 '*' 或逗号分隔的正整数 ID（收到的非数字片段：%r）" % e
        ) from e
    if any(i <= 0 for i in ids):
        raise ValueError("project_ids 不允许 0 或负数")
    # 去重保序
    seen: set[int] = set()
    dedup: list[int] = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            dedup.append(i)
    if len(dedup) > MAX_PROJECT_IDS:
        raise ValueError(
            f"project_ids 一次最多选择 {MAX_PROJECT_IDS} 个项目（实际 {len(dedup)}）"
        )
    return ",".join(str(i) for i in dedup)


class SubscriptionCreate(BaseModel):
    email: Optional[str] = Field(default=None, max_length=256, description="接收报告的邮箱地址；留空则不发送邮件，仅生成报告")
    project_ids: str = Field(default="*", max_length=500, description="项目 ID 列表，逗号分隔，* 表示全部")
    country: str = Field(default="US", max_length=256)
    frequency: str = Field(..., pattern="^(daily|weekly|monthly)$")
    dispatch_hour: int = Field(default=15, ge=0, le=23, description="发送时间（小时，0-23，北京时间）")
    dispatch_minute: int = Field(default=0, ge=0, le=59, description="发送时间（分钟，0-59）")
    dispatch_weekday: Optional[int] = Field(default=None, ge=0, le=6, description="周报发送日（0=周一..6=周日）")
    dispatch_day: Optional[int] = Field(default=None, ge=2, le=28, description="月报发送日（2-28）")
    ai_model: Optional[str] = Field(default=None, max_length=64, description="AI 摘要使用的模型，空则用默认模型")

    @field_validator("email")
    @classmethod
    def _validate_email(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return _normalize_email(v) or None

    @field_validator("project_ids")
    @classmethod
    def _validate_project_ids(cls, v: str) -> str:
        return _normalize_project_ids(v)  # type: ignore[arg-type]

    @model_validator(mode="after")
    def validate_frequency_fields(self) -> "SubscriptionCreate":
        if self.frequency == "weekly":
            if self.dispatch_weekday is None:
                self.dispatch_weekday = 0  # 默认周一
            # 周一 16:00 之前不允许
            if self.dispatch_weekday == 0 and self.dispatch_hour < 16:
                raise ValueError("周报最早可在周一 16:00 发送")
        elif self.frequency == "monthly":
            if self.dispatch_day is None:
                self.dispatch_day = 2  # 默认 2 号
        return self


class SubscriptionUpdate(BaseModel):
    email: Optional[str] = Field(default=None, max_length=256)
    project_ids: Optional[str] = Field(default=None, max_length=500)
    country: Optional[str] = Field(default=None, max_length=256)
    frequency: Optional[str] = Field(default=None, pattern="^(daily|weekly|monthly)$")
    dispatch_hour: Optional[int] = Field(default=None, ge=0, le=23, description="发送时间（小时，0-23，北京时间）")
    dispatch_minute: Optional[int] = Field(default=None, ge=0, le=59, description="发送时间（分钟，0-59）")
    dispatch_weekday: Optional[int] = Field(default=None, ge=0, le=6, description="周报发送日（0=周一..6=周日）")
    dispatch_day: Optional[int] = Field(default=None, ge=2, le=28, description="月报发送日（2-28）")
    ai_model: Optional[str] = Field(default=None, max_length=64)
    enabled: Optional[bool] = None

    @field_validator("email")
    @classmethod
    def _validate_email(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None  # 未提交，ORM 不动
        return _normalize_email(v) or None

    @field_validator("project_ids")
    @classmethod
    def _validate_project_ids(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None  # 未提交，ORM 不动
        return _normalize_project_ids(v)

    @model_validator(mode="after")
    def validate_frequency_fields(self) -> "SubscriptionUpdate":
        if self.frequency == "weekly" and self.dispatch_weekday is not None:
            if self.dispatch_weekday == 0 and self.dispatch_hour is not None and self.dispatch_hour < 16:
                raise ValueError("周报最早可在周一 16:00 发送")
        if self.frequency == "monthly" and self.dispatch_day is not None:
            if self.dispatch_day < 2:
                raise ValueError("月报最早可在每月 2 号发送")
        return self


class SubscriptionItem(BaseModel):
    id: int
    user_id: Optional[int]
    email: Optional[str]
    project_ids: str
    country: str
    frequency: str
    dispatch_hour: int = 15
    dispatch_minute: int = 0
    dispatch_weekday: Optional[int] = None
    dispatch_day: Optional[int] = None
    ai_model: Optional[str] = None
    enabled: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SubscriptionListResponse(BaseModel):
    items: list[SubscriptionItem]
    total: int


DeliveryStageValue = Literal[
    "pending", "preparing", "fetching_data", "generating_summary",
    "rendering_html", "capturing_screenshot", "sending", "done", "failed",
]
"""DeliveryLogItem stage 可选值: pending/preparing/fetching_data/generating_summary/rendering_html/capturing_screenshot/sending/done/failed"""

AiSummaryStatusValue = Literal["pending", "generating", "done", "failed"]


class DeliveryLogItem(BaseModel):
    id: int
    subscription_id: int
    frequency: str
    report_date: str
    report_month: Optional[str]
    email: Optional[str]
    status: str
    stage: DeliveryStageValue = "pending"
    error_message: Optional[str]
    sent_at: Optional[datetime]
    screenshot_r2_key: Optional[str] = None
    screenshot_r2_url: Optional[str] = None
    screenshot_r2_thumb_key: Optional[str] = None
    screenshot_r2_thumb_url: Optional[str] = None
    ai_summary: Optional[str] = None
    ai_summary_status: AiSummaryStatusValue = "pending"
    ai_summary_error: Optional[str] = None
    ai_summary_model: Optional[str] = None
    insight_run_id: Optional[str] = None
    ai_summary_updated_at: Optional[datetime] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DeliveryLogListResponse(BaseModel):
    items: list[DeliveryLogItem]
    total: int


class TestEmailRequest(BaseModel):
    # Pydantic schema named like a pytest test class — opt out of collection.
    __test__ = False

    email: str = Field(..., max_length=256)
    frequency: str = Field(default="daily", pattern="^(daily|weekly|monthly)$")
    project_ids: str = Field(default="*", max_length=500, description="项目 ID 列表，逗号分隔，* 表示全部")
    country: str = Field(default="US", max_length=256)
    ai_model: Optional[str] = Field(default=None, max_length=64, description="AI 摘要使用的模型，空则用默认模型")

    @field_validator("project_ids")
    @classmethod
    def _validate_project_ids(cls, v: str) -> str:
        return _normalize_project_ids(v)  # type: ignore[arg-type]


class TestEmailResponse(BaseModel):
    success: bool
    message: str
    resend_id: Optional[str] = None


class TriggerReportResponse(BaseModel):
    success: bool
    frequency: str
    subscriptions_affected: int
    skipped: int = 0
    message: str


LedgerStatusValue = Literal["sent", "failed", "missing"]
LedgerFrequencyValue = Literal["daily", "weekly", "monthly"]


class LedgerSummary(BaseModel):
    expected: int
    sent: int
    failed: int
    missing: int
    resendable: int


class LedgerItem(BaseModel):
    id: int
    ledger_key: str
    expected_date: str
    expected_at: datetime
    frequency: LedgerFrequencyValue
    subscription_id: int
    email: Optional[str]
    project_ids: str
    project_names: list[str] = Field(default_factory=list)
    country: str
    status: LedgerStatusValue
    latest_delivery_log_id: Optional[int] = None
    error_message: Optional[str] = None
    sent_at: Optional[datetime] = None
    can_resend: bool
    last_checked_at: datetime
    screenshot_r2_url: Optional[str] = None
    screenshot_r2_thumb_url: Optional[str] = None
    ai_summary: Optional[str] = None
    ai_summary_status: AiSummaryStatusValue = "pending"
    ai_summary_error: Optional[str] = None
    ai_summary_model: Optional[str] = None
    insight_run_id: Optional[str] = None
    ai_summary_updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class LedgerListResponse(BaseModel):
    items: list[LedgerItem]
    total: int
    summary: LedgerSummary


class LedgerResendResponse(BaseModel):
    success: bool
    ledger_key: str
    delivery_log_id: Optional[int] = None
    status: str
    message: str


class LedgerRegenerateSummaryResponse(BaseModel):
    success: bool
    ledger_key: str
    delivery_log_id: Optional[int] = None
    status: AiSummaryStatusValue
    insight_run_id: Optional[str] = None
    message: str
