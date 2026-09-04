"""周期对比计算工具。

用于计算当前周期与上一周期的数据对比。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional

from app.utils.math_utils import round_ratio, safe_ratio


@dataclass
class PeriodComparison:
    """周期对比结果。"""

    current_start: str
    current_end: str
    previous_start: str
    previous_end: str
    spend_change_ratio: Optional[float]
    clicks_change_ratio: Optional[float]
    sales_change_ratio: Optional[float]
    orders_change_ratio: Optional[float]
    cpc_change_ratio: Optional[float]
    acos_change_ratio: Optional[float]
    summary: str

    def to_dict(self) -> dict[str, float | str | None]:
        return {
            "current_start": self.current_start,
            "current_end": self.current_end,
            "previous_start": self.previous_start,
            "previous_end": self.previous_end,
            "spend_change_ratio": self.spend_change_ratio,
            "clicks_change_ratio": self.clicks_change_ratio,
            "sales_change_ratio": self.sales_change_ratio,
            "orders_change_ratio": self.orders_change_ratio,
            "cpc_change_ratio": self.cpc_change_ratio,
            "acos_change_ratio": self.acos_change_ratio,
            "summary": self.summary,
        }


def build_period_comparison(
    current_start: Optional[date],
    current_end: Optional[date],
    previous_start: Optional[date],
    previous_end: Optional[date],
    current_spend: Decimal,
    previous_spend: Decimal,
    current_clicks: int,
    previous_clicks: int,
    current_sales: Decimal,
    previous_sales: Decimal,
    current_orders: int,
    previous_orders: int,
) -> Optional[dict[str, float | str | None]]:
    """构建周期对比数据。

    Args:
        current_start: 当前周期开始
        current_end: 当前周期结束
        previous_start: 上周期开始
        previous_end: 上周期结束
        current_spend: 当前周期花费
        previous_spend: 上周期花费
        current_clicks: 当前周期点击
        previous_clicks: 上周期点击
        current_sales: 当前周期销售
        previous_sales: 上周期销售
        current_orders: 当前周期订单
        previous_orders: 上周期订单

    Returns:
        对比结果字典，无有效数据时返回 None
    """
    if current_start is None or current_end is None or previous_start is None or previous_end is None:
        return None

    current_cpc = safe_ratio(current_spend, current_clicks)
    previous_cpc = safe_ratio(previous_spend, previous_clicks)
    current_acos = safe_ratio(current_spend, current_sales)
    previous_acos = safe_ratio(previous_spend, previous_sales)

    spend_change_ratio = (
        round_ratio(safe_ratio(current_spend - previous_spend, previous_spend))
        if previous_spend > 0 else None
    )
    clicks_change_ratio = (
        round_ratio(safe_ratio(Decimal(current_clicks - previous_clicks), previous_clicks))
        if previous_clicks > 0 else None
    )
    sales_change_ratio = (
        round_ratio(safe_ratio(current_sales - previous_sales, previous_sales))
        if previous_sales > 0 else None
    )
    orders_change_ratio = (
        round_ratio(safe_ratio(Decimal(current_orders - previous_orders), previous_orders))
        if previous_orders > 0 else None
    )
    cpc_change_ratio = (
        round_ratio(safe_ratio(current_cpc - previous_cpc, previous_cpc))
        if previous_cpc > 0 else None
    )
    acos_change_ratio = (
        round_ratio(safe_ratio(current_acos - previous_acos, previous_acos))
        if previous_acos > 0 else None
    )

    # 生成摘要
    if spend_change_ratio is None:
        summary = "上一周期没有足够数据，当前周期先作为基准观察。"
    elif spend_change_ratio > 0 and (sales_change_ratio is None or (sales_change_ratio < spend_change_ratio)):
        summary = "当前周期投放规模放大，但产出增长弱于花费增长，效率承压。"
    elif spend_change_ratio > 0:
        summary = "当前周期花费和产出同步增长，整体属于扩量阶段。"
    elif sales_change_ratio is not None and sales_change_ratio >= 0:
        summary = "当前周期在收缩花费的同时保持了产出，偏向收缩提效。"
    else:
        summary = "当前周期规模和产出同步走弱，需要优先回看管理层与来源层。"

    return {
        "current_start": current_start.isoformat(),
        "current_end": current_end.isoformat(),
        "previous_start": previous_start.isoformat(),
        "previous_end": previous_end.isoformat(),
        "spend_change_ratio": spend_change_ratio,
        "clicks_change_ratio": clicks_change_ratio,
        "sales_change_ratio": sales_change_ratio,
        "orders_change_ratio": orders_change_ratio,
        "cpc_change_ratio": cpc_change_ratio,
        "acos_change_ratio": acos_change_ratio,
        "summary": summary,
    }