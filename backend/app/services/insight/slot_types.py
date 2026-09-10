"""Insight slot typed payload：首个 role 的四个命名空间 slot。

全部 `extra="forbid"`；slot 名采用小写点分隔命名空间。
广告/库存未来只能新增自身 namespace，不得复用 `report.*` 语义。
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PositiveInt, model_validator

from app.schemas.insight import CountryCode

_FROZEN = ConfigDict(extra="forbid")

ReportFrequency = Literal["daily", "weekly", "monthly"]


class ReportContextSlot(BaseModel):
    """`report.context`：报表范围与口径；须与请求 scope 一致（由 validator 校验）。"""

    model_config = _FROZEN

    slot_version: Literal[1]
    frequency: ReportFrequency
    report_date: date
    date_range_start: date
    date_range_end: date
    project_ids: list[PositiveInt] = Field(min_length=1, max_length=50)
    country: CountryCode
    project_name: str | None = Field(default=None, min_length=1, max_length=256)

    @model_validator(mode="after")
    def _check_range(self) -> ReportContextSlot:
        if self.date_range_end < self.date_range_start:
            raise ValueError("date_range_end must be >= date_range_start")
        return self


class ReportDataSlot(BaseModel):
    """`report.data`：版本化 JSON envelope；payload 只接受真实对象，不接受 repr/二进制/字符串化 JSON。"""

    model_config = _FROZEN

    slot_version: Literal[1]
    encoding: Literal["json"] = "json"
    payload: dict[str, object]

    @model_validator(mode="before")
    @classmethod
    def _reject_stringified(cls, data: object) -> object:
        if isinstance(data, dict):
            payload = data.get("payload")
            if isinstance(payload, str):
                raise TypeError("payload must be a JSON object, not a stringified JSON string")
            if isinstance(payload, bytes):
                raise TypeError("payload must be a JSON object, not binary")
        return data


class ProjectSummary(BaseModel):
    model_config = _FROZEN

    project_id: PositiveInt
    name: str = Field(min_length=1, max_length=256)
    country: CountryCode | None = None


class ProjectContextSlot(BaseModel):
    """`project.context`：项目摘要列表，最多 50 项。"""

    model_config = _FROZEN

    slot_version: Literal[1]
    projects: list[ProjectSummary] = Field(min_length=1, max_length=50)


class SkuSummary(BaseModel):
    model_config = _FROZEN

    sku: str = Field(min_length=1, max_length=128)
    asin: str | None = Field(default=None, min_length=1, max_length=32)
    project_id: PositiveInt | None = None
    title: str | None = Field(default=None, min_length=1, max_length=512)
    factory_info: str | None = Field(default=None, min_length=1, max_length=512)


class SkuContextSlot(BaseModel):
    """`sku.context`：SKU 摘要列表，最多 200 项。"""

    model_config = _FROZEN

    slot_version: Literal[1]
    skus: list[SkuSummary] = Field(min_length=1, max_length=200)
