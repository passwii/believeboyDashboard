"""daily-analysis 响应模型 + 全项目聚合响应的字节序列化（BLF-1038）。"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel


class DailyAnalysisConsoleResponse(BaseModel):
    project_id: int
    project_name: str
    country: str
    start_date: str
    end_date: str
    requested_days: int
    summary_days: int
    detail_rows: int
    sales_source_days: int
    ad_source_days: int
    inventory_source_days: int
    business_source_days: int
    missing_dates: list[str]
    latest_sales_date: str | None
    latest_ad_date: str | None
    latest_inventory_date: str | None
    latest_business_date: str | None


class DailyAnalysisSummaryRow(BaseModel):
    date: str
    order_qty: int
    # BLF-811：窗口内待发货订单量（order_status ∈ Pending/Unshipped 的已计数行
    # quantity 合计），order_qty 的子集；默认 0 兼容 Redis 旧缓存载荷。
    pending_order_qty: int = 0
    sales_amount: float
    impressions: int
    clicks: int
    cpc: float
    ad_spend: float
    ad_orders: int
    available_qty: int
    page_views: int = 0
    units_ordered: int = 0
    sessions: int = 0
    ordered_sales_amount: float = 0.0
    conversion_rate: float = 0.0


class DailyAnalysisDetailRow(BaseModel):
    date: str
    sku: str
    asin: str | None
    order_qty: int
    pending_order_qty: int = 0
    sales_amount: float
    impressions: int
    clicks: int
    cpc: float
    ad_spend: float
    ad_orders: int
    available_qty: int
    in_transit_qty: int = 0
    page_views: int = 0
    units_ordered: int = 0
    sessions: int = 0
    ordered_sales_amount: float = 0.0
    conversion_rate: float = 0.0


class DailyAnalysisResponse(BaseModel):
    console: DailyAnalysisConsoleResponse
    summary_rows: list[DailyAnalysisSummaryRow]
    detail_rows: list[DailyAnalysisDetailRow]
    available_dates: dict[str, Any]
    comparison_summary_rows: list[DailyAnalysisSummaryRow] | None = None


class DailyAnalysisAllProjectsResponse(BaseModel):
    summary_rows: list[DailyAnalysisSummaryRow]
    detail_rows: list[DailyAnalysisDetailRow]
    available_dates: dict[str, Any]
    project_breakdown: dict[int, dict[str, object]]


class DailyAnalysisAllCountriesResponse(BaseModel):
    """跨所有支持国家站点的聚合响应。

    金额字段（``sales_amount`` / ``ad_spend`` / ``ordered_sales_amount``）已按
    ``exchange_rates`` 表的当月 CNY 中转折算为 USD 统一展示；非金额字段
    （订单 / 曝光 / 点击 / 库存 / 销量 / 访问 / 在途等）保持原值。
    响应顶层 ``currency`` 字段固定为 ``"USD"``，便于前端识别并切换符号。
    """

    console: DailyAnalysisConsoleResponse
    summary_rows: list[DailyAnalysisSummaryRow]
    detail_rows: list[DailyAnalysisDetailRow]
    available_dates: dict[str, Any]
    country_breakdown: dict[str, dict[str, object]]
    currency: str = "USD"
    currency_note: str | None = None


class DailyAnalysisAllProjectsCountriesResponse(BaseModel):
    """全部项目 × 全部国家站点的聚合响应（BLF-913）。

    金额字段（``sales_amount`` / ``ad_spend`` / ``ordered_sales_amount``）已按
    ``exchange_rates`` 表的当月 CNY 中转折算为 USD 统一展示；非金额字段
    （订单 / 曝光 / 点击 / 库存 / 销量 / 访问 / 在途等）保持原值。
    响应顶层 ``currency`` 字段固定为 ``"USD"``。
    ``project_breakdown`` key 为项目 id（该项目跨 US/DE/UK 合并），
    ``country_breakdown`` key 为国家码（该国家跨项目合并），均为 USD 口径。
    """

    console: DailyAnalysisConsoleResponse
    summary_rows: list[DailyAnalysisSummaryRow]
    detail_rows: list[DailyAnalysisDetailRow]
    available_dates: dict[str, Any]
    project_breakdown: dict[int, dict[str, object]]
    country_breakdown: dict[str, dict[str, object]]
    currency: str = "USD"
    currency_note: str | None = None


# ── 全项目聚合响应的字节序列化（BLF-1038）──────────────────────────────
# `/daily-analysis/all` 的响应体约 3.4MB，命中缓存时若还得走
# Pydantic 校验 + FastAPI 序列化，prod 下足以吃掉 300ms 的延迟预算。
# 因此缓存里存的是**这里序列化好的字节**，命中直接 `Response(bytes)` 返回。

# 响应 schema 指纹进缓存 key：模型一改（字段增删 / 嵌套模型变化），
# 指纹随之变化 → 旧缓存体自然不再命中，无需人工 bump 版本号。
ALL_PROJECTS_RESPONSE_SCHEMA_FINGERPRINT: str = hashlib.sha256(
    json.dumps(
        DailyAnalysisAllProjectsResponse.model_json_schema(), sort_keys=True
    ).encode("utf-8")
).hexdigest()[:8]


def serialize_all_projects_response(
    payload: dict[str, object], *, include_detail: bool = True
) -> bytes:
    """把聚合结果 dict 序列化为响应字节（JSON，与 FastAPI 同口径）。

    先 ``model_validate`` 再 ``model_dump(mode="json")``：
    - 写进缓存前先过一遍响应模型，保证缓存体的形状一定合当前 schema；
    - 序列化设置对齐 FastAPI ``JSONResponse``（``ensure_ascii=False`` /
      ``allow_nan=False`` / ``separators=(",", ":")``），保证与未命中缓存时
      的响应体逐字节一致。

    ``include_detail=False``（BLF-1038，前端快报 / 首页 / 组合总览只读
    ``summary_rows``）：响应体**去掉** ``detail_rows`` 与
    ``project_breakdown[*].detail_rows`` 两个键（不是置空数组——留一个空数组
    会让消费方无法区分「没有明细数据」与「没请求明细」），其余字段与默认口径
    逐字节一致。59 天窗口实测 5.64MB → ~177KB。

    注意：``detail_rows`` 在响应模型里仍是必填字段（因此 OpenAPI 契约、前端
    生成的 TS 类型都不变），摘要形状是它的**子集**；两种形状互不兼容，缓存
    key 必须带上 ``include_detail``（见 ``make_daily_analysis_all_cache_key``）。
    """
    if include_detail:
        model = DailyAnalysisAllProjectsResponse.model_validate(payload)
        data = model.model_dump(mode="json")
    else:
        # 先给明细键填上空列表过模型（保留 summary_rows / available_dates 的
        # 校验与类型强转；直接删键会因必填字段缺失校验失败，直接 dump 原始
        # dict 又会跳过 Pydantic 的 Decimal→float 等强转），dump 后再摘键。
        stripped = dict(payload)
        stripped["detail_rows"] = []
        breakdown = payload.get("project_breakdown")
        if isinstance(breakdown, dict):
            stripped["project_breakdown"] = {
                project_id: (
                    {**entry, "detail_rows": []} if isinstance(entry, dict) else entry
                )
                for project_id, entry in breakdown.items()
            }
        model = DailyAnalysisAllProjectsResponse.model_validate(stripped)
        data = model.model_dump(mode="json")
        data.pop("detail_rows", None)
        dumped_breakdown = data.get("project_breakdown")
        if isinstance(dumped_breakdown, dict):
            for entry in dumped_breakdown.values():
                if isinstance(entry, dict):
                    entry.pop("detail_rows", None)

    return json.dumps(
        data,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
