from datetime import datetime

from pydantic import BaseModel, Field

from app.models.job import JobStatus


class CreateMonthlyReportRequest(BaseModel):
    project_name: str = Field(min_length=1, max_length=128)
    report_month: str = Field(min_length=7, max_length=7)
    transaction_file_id: str = Field(min_length=1)
    summary_pdf_file_id: str = Field(min_length=1)


class MonthlyReportResponse(BaseModel):
    job_id: int
    status: JobStatus
    created_at: datetime | None
