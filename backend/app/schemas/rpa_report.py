from __future__ import annotations

from pydantic import BaseModel, Field
from typing import Optional


class ReportTypeStatusSchema(BaseModel):
    report_type: str
    has_data: bool
    latest_date: Optional[str] = None
    original_filename: Optional[str] = None


class ProjectReportStatusSchema(BaseModel):
    project_id: int
    project_name: str
    country: str
    statuses: list[ReportTypeStatusSchema]


class RpaReportStatusResponseSchema(BaseModel):
    country: str
    items: list[ProjectReportStatusSchema]