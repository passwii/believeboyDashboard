"""域级 Insight run 请求体（BLF-1016）。

``/insight/runs`` 的请求体是 canonical 契约本身（调用方自带完整 slots）；
域端点相反：调用方只给**业务口径**（项目、站点、日期），slots 由服务端
按域 adapter 组装。故这里只描述口径参数，不暴露 slot 结构。

范围上限与 ``slots.trim_ad_payload`` 的序列裁剪一致（366 天）：不设上限
时一次请求可以拖入任意跨度的聚合查询，而 slot 只保留一年——口径必须与
实际进入 prompt 的数据一致。
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

from app.schemas.insight import CountryCode

#: 广告分析可请求的最大跨度（天），与 ad slot 的 366 条序列裁剪对齐。
AD_ANALYSIS_MAX_RANGE_DAYS = 366


class AdAnalysisRunRequest(BaseModel):
    """广告分析口径：单项目单站点 + 闭区间日期。"""

    model_config = ConfigDict(extra="forbid")

    project_id: int = Field(gt=0)
    country: CountryCode
    start_date: date
    end_date: date
    model_id: str | None = Field(default=None, max_length=128)

    @field_validator("end_date")
    @classmethod
    def _check_range(cls, end_date: date, info: ValidationInfo) -> date:
        """跨度校验挂在 ``end_date`` 上：错误能定位到具体字段（而非笼统的 body）。"""
        start_date = (info.data or {}).get("start_date")
        if not isinstance(start_date, date):
            return end_date  # start_date 自身非法：由它自己的错误报告
        if end_date < start_date:
            raise ValueError("end_date must not be earlier than start_date")
        if (end_date - start_date).days > AD_ANALYSIS_MAX_RANGE_DAYS:
            raise ValueError(
                f"date range must not exceed {AD_ANALYSIS_MAX_RANGE_DAYS} days"
            )
        return end_date


class InventoryHealthRunRequest(BaseModel):
    """库存健康口径：单项目单站点 + 可选口径日（缺省 = 最新快照口径）。"""

    model_config = ConfigDict(extra="forbid")

    project_id: int = Field(gt=0)
    country: CountryCode
    report_date: date | None = None
    model_id: str | None = Field(default=None, max_length=128)


__all__ = [
    "AD_ANALYSIS_MAX_RANGE_DAYS",
    "AdAnalysisRunRequest",
    "InventoryHealthRunRequest",
]
