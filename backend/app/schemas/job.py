from datetime import datetime
from pydantic import BaseModel, Field

from app.models.job import JobStatus


class CreateJobRequest(BaseModel):
    job_type: str = Field(min_length=1, max_length=128)
    file_id: str = Field(min_length=1)
    params: dict = Field(default_factory=dict)


class JobResponse(BaseModel):
    id: int
    job_type: str
    status: JobStatus
    payload_json: dict
    operator: str | None
    created_at: datetime | None
    updated_at: datetime | None


class JobRunResponse(BaseModel):
    id: int
    started_at: datetime | None
    finished_at: datetime | None
    operator: str | None
    log_excerpt: str | None
    error_message: str | None
    result_path: str | None


class JobDetailResponse(JobResponse):
    runs: list[JobRunResponse] = Field(default_factory=list)
