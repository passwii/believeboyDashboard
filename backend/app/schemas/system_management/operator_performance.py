"""
运营绩效 Schema。
"""
from pydantic import BaseModel, Field


class OperatorPerformanceItem(BaseModel):
    id: int
    report_month: str
    week_index: int
    project_id: int
    project_name: str
    person_name: str
    role_type: str
    score: int
    note: str | None = None
    updated_by: str | None = None
    updated_at: str


class UpsertOperatorPerformanceItem(BaseModel):
    id: int | None = None
    report_month: str = Field(min_length=7, max_length=7)
    week_index: int = Field(ge=1, le=5)
    project_id: int = Field(gt=0)
    project_name: str = Field(min_length=1, max_length=255)
    person_name: str = Field(min_length=1, max_length=255)
    role_type: str = Field(min_length=1, max_length=32)
    score: int = Field(ge=0, le=100)
    note: str | None = Field(default=None, max_length=500)


class UpsertOperatorPerformanceRequest(BaseModel):
    items: list[UpsertOperatorPerformanceItem] = Field(default_factory=list)


class OperatorPerformanceResponse(BaseModel):
    report_month: str
    items: list[OperatorPerformanceItem] = Field(default_factory=list)