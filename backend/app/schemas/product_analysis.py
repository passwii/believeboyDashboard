from datetime import datetime

from pydantic import BaseModel, Field

from app.models.job import JobStatus


class CreateProductAnalysisReportRequest(BaseModel):
    project_name: str = Field(min_length=1, max_length=128)
    report_start_date: str = Field(min_length=10, max_length=10)
    report_end_date: str = Field(min_length=10, max_length=10)
    business_report_file_id: str = Field(min_length=1)
    payment_report_file_id: str = Field(min_length=1)
    ad_report_file_id: str = Field(min_length=1)
    inventory_report_file_id: str | None = None
    country: str = 'US'


class ProductAnalysisReportResponse(BaseModel):
    job_id: int
    status_endpoint: str | None = None
    result_endpoint: str | None = None
    status: JobStatus
    created_at: datetime | None


class ProductAnalysisTaskStatusResponse(BaseModel):
    task_id: int
    status: JobStatus
    stage: str
    progress: int
    message: str | None
    error_message: str | None
    persistence_status: str
    persistence_message: str | None
    created_at: datetime
    updated_at: datetime
