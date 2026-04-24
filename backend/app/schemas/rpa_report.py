from __future__ import annotations

from pydantic import BaseModel, Field
from typing import Optional


class ReportTypeStatusSchema(BaseModel):
    report_type: str
    has_data: bool
    is_uploaded: bool
    # 报表实际业务日期（period_end_date / snapshot_at），用于历史月份内容填充
    latest_date: Optional[str] = None
    original_filename: Optional[str] = None
    status_source: Optional[str] = None


class ProjectReportStatusSchema(BaseModel):
    project_id: int
    project_name: str
    country: str
    statuses: list[ReportTypeStatusSchema]


class RpaReportStatusResponseSchema(BaseModel):
    country: str
    items: list[ProjectReportStatusSchema]
