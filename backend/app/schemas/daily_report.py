from datetime import datetime

from pydantic import BaseModel, Field

from app.models.job import JobStatus


class CreateDailyReportRequest(BaseModel):
    project_name: str = Field(min_length=1, max_length=128)
    country: str = Field(default='US', min_length=2, max_length=8)
    report_date: str = Field(min_length=10, max_length=10)
    sales_report_file_id: str = Field(min_length=1)
    ad_report_file_id: str = Field(min_length=1)
    inventory_report_file_id: str = Field(min_length=1)


class DailyReportResponse(BaseModel):
    job_id: int
    status_endpoint: str | None = None
    result_endpoint: str | None = None
    status: JobStatus
    created_at: datetime | None


class DailyReportTaskStatusResponse(BaseModel):
    task_id: int
    status: JobStatus
    stage: str
    progress: int
    message: str | None
    error_message: str | None
    persistence_status: str | None = None
    persistence_message: str | None = None
    created_at: datetime
    updated_at: datetime
