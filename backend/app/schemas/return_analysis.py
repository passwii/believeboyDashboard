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
    # 退货率（退货数量/销售数量，百分比）；分母为 0 时为 None。
    # 前端对行级已有 ``sales_quantity > 0`` 守卫、图表也能容 null，故行级
    # 可空是安全的（与 summary 级不同，见 ReturnAnalysisSummary 注释）。
    return_rate: float | None = None
    # 退货周期（天）= 退货日期 - 原单日期（purchase_date_pt），按 (order_id, sku) 精准匹配
    avg_return_cycle_days: float | None = None  # 平均退货周期
    min_return_cycle_days: int | None = None  # 最快退货周期
    max_return_cycle_days: int | None = None  # 最慢退货周期


class ReturnDataSpan(BaseModel):
    """当前生效退货数据的实际日期跨度（BLF-1078 P1-5）。

    ``None`` 表示该店没有任何当前生效的退货数据。
    """

    min_return_date: str | None = None
    max_return_date: str | None = None


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
    # 退货率（退货数量/销售数量），百分比；分母为 0 时为 None（BLF-1078 P1-5）
    return_rate: float | None = None


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
    """退货分析汇总

    BLF-1078 P1-5：新增 ``data_available`` / ``data_span`` 两个可信度字段，
    用来区分「真的零退货」与「本窗口没有退货数据」。

    * ``data_available is False`` → 本窗口与退货数据跨度无交集（或该店根本
      没有退货数据），此时 ``overall_return_rate`` 不可信，调用方不应引用。
      生产反例：犀牛 2025 有 8690 件销售、退货数据却自 2026-03-28 才开始，
      曾被渲染为「0% 退货率、表现完美」。
    * ``data_span`` 给出该店当前生效退货数据的实际范围（不受本窗口限制），
      调用方可在同一响应内判断该数字是否可信。
    * ``overall_return_rate`` 本身保持非空数值（见字段注释的兼容性取舍）。
    """

    total_returns: int
    total_quantity: int
    unique_skus: int
    top_return_sku: str | None
    top_return_reason: str | None
    # BLF-1074：与 reason_rows[].reason_display 同源的翻译值。前端 Top 磁贴此前
    # 自带一份只覆盖 14 个 code 的重复对照表，遇到其余 16 个 code 就裸露英文
    # （实测 3 个项目命中）。改为后端产出，前端不再重复翻译。
    top_return_reason_display: str | None = None
    # 同期销售汇总
    total_sales_quantity: int = 0
    total_sales_amount: float = 0.0
    # 整体退货率（退货量/销售量，百分比）。
    #
    # BLF-1078 P1-5：保持 **非空数值**（无数据时为 0.0）——本 schema 与内部
    # Web 路由（``/api/v1/return-analysis``）共用同一个类、同一份 Redis v2
    # 缓存，而 Web 前端直接对该字段做 ``.toFixed(1)``。把它改成可空会在
    # 「选了无数据窗口」时让页面抛 TypeError，属跨端破坏性变更。
    #
    # 「无数据」与「真实 0% 退货」的区分改由并列的 ``data_available`` /
    # ``data_span`` 表达：调用方必须先看 ``data_available`` 再决定是否采信该
    # 数字。前端侧把该字段改为可空或直接渲染 ``data_available=false`` 需与
    # 前端同步，不能单方面改契约（BLF-555 职责边界）。
    overall_return_rate: float = 0.0
    # ``False`` 表示该窗口与退货数据跨度无交集（或无任何退货数据）——
    # 此时 ``overall_return_rate`` 不可信（生产实例：犀牛 2025 有 8690 件
    # 销售、退货数据却自 2026-03-28 才开始，曾被渲染为「0% 退货率」）。
    data_available: bool = True
    data_span: ReturnDataSpan | None = None


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
    # BLF-1078 P1-3：ranking_rows 是否被硬上限截断（超过上限时尾部 SKU 会消失）。
    # 调用方据此判断是否需缩小窗口/换用 R2 分页获取完整榜单。
    ranking_truncated: bool = False
    ranking_total_count: int = 0
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
