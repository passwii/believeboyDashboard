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
