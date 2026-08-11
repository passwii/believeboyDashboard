from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class InventoryDecisionPath(BaseModel):
    """BLF-502 S3/G1：决策路径解释——为什么是这个 state/action。

    ``state_rule`` ∈ P0..P13（spec §2.1 顺序短路命中规则）；
    ``critical_subtype`` ∈ shortage/aging/overstock（仅 critical）；
    ``action_rule`` 为决策表分支标识；``seasonal_override`` 表示季节性是否
    覆盖了动作判定。
    """

    state_rule: str | None = None
    critical_subtype: str | None = None
    action_rule: str | None = None
    seasonal_override: bool = False
    seasonal_phase_used: str | None = None


class InventorySignals(BaseModel):
    """inventory_state + action 决策依据的原始事实（透明度，spec §2.3）。

    不进判定，作为响应体里的独立字段供前端/外部 agent 消费。
    """

    sellable_days: float | None = None
    dms_3: float | None = None
    dms_7: float | None = None
    dms_14: float | None = None
    dms_30: float | None = None
    trend_ratio_7_30: float | None = None
    trend_ratio_3_7: float | None = None
    trend_label: str | None = None
    trend_momentum: str | None = None
    aging_share: dict[str, float] = Field(default_factory=dict)
    transit_ratio: float | None = None
    data_freshness_days: int = 0
    confidence: str = "low"
    # v1.2 季节性字段
    seasonal_factor: float | None = None
    seasonal_phase: str | None = None
    seasonal_source: str | None = None


class InventoryReplenishmentSummary(BaseModel):
    sku_count: int
    out_of_stock_risk_count: int
    healthy_count: int
    slow_moving_count: int
    pending_data_count: int
    total_available_inventory: int
    total_in_transit_quantity: int
    # v1.2: 三段式 state 计数（与旧字段并存以保持 BI 兼容）
    critical_count: int = 0
    deteriorating_count: int = 0
    watch_count: int = 0
    healthy_count_v2: int = 0
    unknown_count: int = 0
    # BLF-502 S6/G5: 分布（state 单维 / action 单维 / state×action 交叉矩阵）
    state_distribution: dict[str, int] = Field(default_factory=dict)
    action_distribution: dict[str, int] = Field(default_factory=dict)
    state_action_matrix: dict[str, dict[str, int]] = Field(default_factory=dict)


class InventoryReplenishmentListItem(BaseModel):
    project_id: int
    project_name: str
    sku: str
    country: str
    asin: str | None = None
    product_name: str | None = None
    available_inventory: int
    in_transit_quantity: int
    dms_30: float | None = None
    dms_14: float | None = None
    dms_7: float | None = None
    dms_3: float | None = None
    base_dms: float | None = None
    safety_factor: float
    weighted_dms: float | None = None
    sellable_days: float | None = None
    sellout_date: str | None = None
    sellout_date_with_transit: str | None = None
    production_lead_days: int
    shipping_days: int
    replenishment_order_date: str | None = None
    warehouse_entry_date: str | None = None
    shipment_order_date: str | None = None
    estimated_replenishment_quantity: int | None = None
    risk_status: str
    risk_anchor_date: str | None = None

    # ── BLF-630: 补货周期 / 覆盖时间线维度（order_buffer 锚点） ──
    production_plus_shipping_days: int = 0
    latest_order_date: str | None = None
    order_buffer_days: int | None = None
    coverage_end_date: str | None = None
    gap_days: int = 0
    gap_start_date: str | None = None
    next_transit_eta: str | None = None
    # BLF-630 二轮: 目标覆盖天数（补货量动态化基准）
    target_days: int = 90

    # ── v1.2 三段式（spec §3.2） ──
    # 判断维度
    inventory_state: str = "unknown"  # critical/deteriorating/watch/healthy/unknown
    # 动作维度
    replenishment_action: str = "NO_ACTION"  # ReplenishmentAction 枚举值
    # 透明度原始事实
    signals: InventorySignals | None = None
    # BLF-502 S3/G1: 决策路径解释（why this state/action）
    decision_path: InventoryDecisionPath | None = None

    # ── Age bucket (from FBA inventory snapshot) ──
    age_0_90_qty: int = 0
    age_91_180_qty: int = 0
    age_181_270_qty: int = 0
    age_271_365_qty: int = 0
    age_365_plus_qty: int = 0
    recommended_action: str | None = None


class InventoryReplenishmentListResponse(BaseModel):
    items: list[InventoryReplenishmentListItem]
    summary: InventoryReplenishmentSummary
    page: int
    page_size: int
    total: int
    has_next: bool


class InventoryReplenishmentSettingUpdate(BaseModel):
    asin: str | None = Field(default=None, max_length=64)
    production_lead_days: int = Field(ge=0)
    shipping_days: int = Field(ge=0)
    safety_factor: float = Field(ge=0)
    # BLF-630 二轮：目标覆盖天数（补货量动态化），缺省保持现值
    target_days: int | None = Field(default=None, ge=0)


class InventoryReplenishmentSettingItem(BaseModel):
    project_id: int
    project_name: str
    sku: str
    country: str
    asin: str | None = None
    production_lead_days: int
    shipping_days: int
    safety_factor: float
    target_days: int = 90


class InventoryReplenishmentShipmentItem(BaseModel):
    schedule_id: int
    shipment_no: str
    shipment_status: str
    shipping_method: str
    etd_date: str | None = None
    eta_date: str | None = None
    actual_inbound_date: str | None = None
    tracking_no: str | None = None
    quantity: int
    remark: str | None = None
    updated_at: str


class InventoryReplenishmentShipmentResponse(BaseModel):
    project_id: int
    sku: str
    items: list[InventoryReplenishmentShipmentItem]


class InventoryAnalysisSummary(BaseModel):
    sku_count: int
    out_of_stock_count: int
    aging_sku_count: int
    over_aged_sku_count: int
    total_available_qty: int
    total_age_0_90_qty: int
    total_age_91_180_qty: int
    total_age_181_270_qty: int
    total_age_271_365_qty: int
    total_age_365_plus_qty: int
    action_type_count: int


class ShipmentColumn(BaseModel):
    shipment_no: str
    label: str
    shipping_method: str | None = None
    forwarder_name: str | None = None
    etd_date: str | None = None
    eta_date: str | None = None


class InventoryAnalysisItem(BaseModel):
    project_id: int
    project_name: str
    country: str
    sku: str
    asin: str | None = None
    product_name: str | None = None
    available_qty: int
    age_0_90_qty: int
    age_91_180_qty: int
    age_181_270_qty: int
    age_271_365_qty: int
    age_365_plus_qty: int
    recommended_action: str | None = None
    recommended_action_label: str
    stock_status: str
    aging_status: str
    shipment_quantities: dict[str, int] = {}


class InventoryAnalysisResponse(BaseModel):
    project_id: int
    project_name: str
    country: str
    report_date: date | None = None
    summary: InventoryAnalysisSummary
    action_options: list[str]
    items: list[InventoryAnalysisItem]
    shipment_columns: list[ShipmentColumn] = []
    shipment_column_totals: dict[str, int] = {}


class InventorySnapshotOption(BaseModel):
    report_date: date
    is_current: bool


class CalendarRowItem(BaseModel):
    """Single SKU row for calendar/gantt view."""

    project_id: int
    project_name: str
    sku: str
    country: str
    risk_status: str
    # Timeline anchors
    today: str
    sellout_date: str | None = None
    order_date: str | None = None
    warehouse_entry_date: str | None = None
    # Current state
    available_inventory: int
    in_transit_quantity: int
    weighted_dms: float | None = None
    estimated_quantity: int | None = None
    # Warning flags
    is_slow_moving: bool = False
    is_critical: bool = False


class CalendarResponse(BaseModel):
    items: list[CalendarRowItem]
    page: int
    page_size: int
    total: int
    has_next: bool


# ---------------------------------------------------------------------------
# Seasonal replenishment (季节性补货)
# ---------------------------------------------------------------------------


class SeasonalReplenishmentListItem(BaseModel):
    """季节性补货分析单行。

    与 ``InventoryReplenishmentListItem`` 的区别：
    - 4 个主窗口 DMS (90/30/14/7)，不含 3D
    - 可选去年同期对照 (90/30/14/7 YoY)
    - 风险状态**不判定**（``risk_status`` 字段不存在）
    - 售卖截止锚点 = ``to_date`` + sellable_days（不是 ``date.today()``）
    """

    project_id: int
    project_name: str
    sku: str
    country: str
    asin: str | None = None
    product_name: str | None = None
    available_inventory: int
    in_transit_quantity: int
    dms_90: float | None = None
    dms_30: float | None = None
    dms_14: float | None = None
    dms_7: float | None = None
    dms_90_yoy: float | None = None
    dms_30_yoy: float | None = None
    dms_14_yoy: float | None = None
    dms_7_yoy: float | None = None
    base_dms: float | None = None
    weighted_dms: float | None = None
    sellable_days: float | None = None
    sellout_date: str | None = None
    sellout_date_with_transit: str | None = None
    production_lead_days: int
    shipping_days: int
    estimated_replenishment_quantity: int | None = None


class SeasonalReplenishmentListResponse(BaseModel):
    """季节性补货分析响应。

    复用 ``InventoryReplenishmentSummary``：季节性页面不判定风险，所以
    ``out_of_stock_risk_count`` / ``slow_moving_count`` / ``pending_data_count``
    固定返回 0，前端不应展示对应统计卡。
    """

    items: list[SeasonalReplenishmentListItem]
    summary: InventoryReplenishmentSummary
    page: int
    page_size: int
    total: int
    has_next: bool
    from_date: date
    to_date: date
    compare_year_offset: int
