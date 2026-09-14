from __future__ import annotations

from pydantic import BaseModel


class ReturnRankingItem(BaseModel):
    """高退货排行项"""

    sku: str
    asin: str | None
    product_name: str | None
    total_quantity: int  # 退货总数量
    return_count: int
    sales_quantity: int = 0  # 同周期销售数量
    return_rate: float = 0.0  # 退货率（退货数量/销售数量），百分比
    # 退货周期（天）= 退货日期 - 原单日期（purchase_date_pt），按 (order_id, sku) 精准匹配
    avg_return_cycle_days: float | None = None  # 平均退货周期
    min_return_cycle_days: int | None = None  # 最快退货周期
    max_return_cycle_days: int | None = None  # 最慢退货周期


class ReturnReasonItem(BaseModel):
    """退货原因分析项"""

    reason: str
    reason_display: str  # 翻译后的中文显示
    total_quantity: int
    return_count: int
    percentage: float


class ReturnTrendItem(BaseModel):
    """退货时间趋势项"""

    date: str
    total_quantity: int
    return_count: int
    sales_quantity: int = 0  # 同日销售数量
    sales_amount: float = 0.0  # 同日销售金额
    return_rate: float = 0.0  # 退货率（退货数量/销售数量），百分比


class DispositionItem(BaseModel):
    """商品状态项"""

    detailed_disposition: str
    disposition_display: str  # 翻译后的中文显示
    total_quantity: int
    return_count: int
    percentage: float


class StatusItem(BaseModel):
    """库存状态项"""

    status: str
    status_display: str  # 翻译后的中文显示
    total_quantity: int
    return_count: int
    percentage: float


class WeekdayItem(BaseModel):
    """星期分布项"""

    weekday: int  # 0=Monday, 6=Sunday
    weekday_display: str  # 中文星期名
    return_count: int
    percentage: float


class FulfillmentCenterItem(BaseModel):
    """仓库分布项"""

    fulfillment_center_id: str
    return_count: int
    quantity: int
    percentage: float


class CustomerFeedbackItem(BaseModel):
    """顾客反馈项（BLF-788：一条退货事件至多一行，多段评论去重后以「 | 」合并）"""

    sku: str
    order_id: str
    reason: str
    reason_display: str
    customer_comment: str
    return_date: str


class ReturnAnalysisSummary(BaseModel):
    """退货分析汇总"""

    total_returns: int
    total_quantity: int
    unique_skus: int
    top_return_sku: str | None
    top_return_reason: str | None
    # 同期销售汇总
    total_sales_quantity: int = 0
    total_sales_amount: float = 0.0
    overall_return_rate: float = 0.0  # 整体退货率（退货量/销售量）


class ReturnAnalysisResponse(BaseModel):
    """退货分析响应"""

    project_id: int
    project_name: str
    country: str
    start_date: str
    end_date: str
    summary: ReturnAnalysisSummary
    summary_text: str  # 模板化文字总结
    ranking_rows: list[ReturnRankingItem]
    reason_rows: list[ReturnReasonItem]
    trend_rows: list[ReturnTrendItem]
    disposition_rows: list[DispositionItem]
    status_rows: list[StatusItem]
    feedback_rows: list[CustomerFeedbackItem]
    weekday_rows: list[WeekdayItem]  # 星期分布
    fulfillment_center_rows: list[FulfillmentCenterItem]  # 仓库分布
    multi_item_return_count: int  # 多件退货单数
    multi_item_return_quantity: int  # 多件退货涉及总量


class ReturnRawRowItem(BaseModel):
    """亚马逊退货报表原始行（原始数据 Tab / Excel sheet 的一行，共 17 字段）。"""

    return_date: str  # 站点时区归一后的退货日期 YYYY-MM-DD
    original_return_datetime: str  # 报表原值 return-date（UTC ISO8601）
    order_id: str
    sku: str
    asin: str | None
    fnsku: str | None
    product_name: str | None
    quantity: int
    fulfillment_center_id: str | None
    detailed_disposition: str
    disposition_display: str  # 中文翻译
    reason: str
    reason_display: str  # 中文翻译
    status: str
    status_display: str  # 中文翻译
    license_plate_number: str | None
    customer_comment: str | None


class ReturnRawRowsResponse(BaseModel):
    """退货原始行响应（独立端点 /return-analysis/raw-rows）。"""

    project_id: int
    country: str
    start_date: str
    end_date: str
    row_count: int
    rows: list[ReturnRawRowItem]
