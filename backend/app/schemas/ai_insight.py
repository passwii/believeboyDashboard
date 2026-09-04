from datetime import date, datetime

from pydantic import BaseModel, Field


class InsightGenerateRequest(BaseModel):
    project_id: int
    country: str = Field(default='US', max_length=2)
    date_range_start: date
    date_range_end: date
    insight_type: str = Field(default='custom', max_length=32)
    model: str | None = Field(default=None, max_length=200)
    focus_areas: list[str] | None = Field(default=None, max_length=10)


class InsightStatusResponse(BaseModel):
    status: str
    insight_id: int | None = None
    error_message: str | None = None


class InsightChunkResponse(BaseModel):
    type: str = 'chunk'
    delta: str


class InsightDoneResponse(BaseModel):
    type: str = 'done'
    insight_id: int
    title: str


class InsightItem(BaseModel):
    id: int
    project_id: int
    project_name: str
    country: str
    title: str
    insight_type: str
    date_range_start: date
    date_range_end: date
    status: str
    sub_status: str | None = None  # 细粒度子阶段: data_aggregating / ai_generating / title_generating
    error_message: str | None = None
    created_by: str
    created_at: datetime
    updated_at: datetime

    model_config = {'from_attributes': True}


class InsightDetail(InsightItem):
    content: str
    strategy_metadata: str | None = None

    model_config = {'from_attributes': True}


class InsightListResponse(BaseModel):
    items: list[InsightItem]
    total: int


class InsightDeleteResponse(BaseModel):
    deleted: bool
    id: int


class InsightUpdateRequest(BaseModel):
    content: str = Field(default='', min_length=1)


class InsightRetryResponse(BaseModel):
    status: str
    insight_id: int


class AggregationDetail(BaseModel):
    """数据聚合步骤的详细信息"""
    step: str  # 步骤标识，如 data_aggregating_sales
    step_label: str  # 显示标签，如"销售数据"
    status: str  # "running" | "completed" | "error"
    progress_percent: int = 0  # 0-100
    record_count: int | None = None  # 记录数量
    total_amount: float | None = None  # 总金额（销售/广告等）
    days_count: int | None = None  # 数据天数
    data_preview: dict | None = None  # 数据预览（如 top_skus 的前3条）
    message: str | None = None  # 状态消息
    elapsed_ms: int | None = None  # 已耗时（毫秒）


class InsightStatusEvent(BaseModel):
    """SSE 状态事件，支持详细数据"""
    type: str = 'status'
    status: str
    sub_status: str | None = None
    insight_id: int | None = None
    title: str | None = None
    content: str | None = None
    error_message: str | None = None
    detail: AggregationDetail | None = None  # 详细状态数据
