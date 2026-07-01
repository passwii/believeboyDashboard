"""AdUploadFile response schema for the external API.

``GET /external/projects/{id}/ad-upload-files`` returns one of these per file.
The schema deliberately omits internal columns (``recognition_payload``,
``matched_columns``, ``warnings``, ``ingestion_error``, ``upload_file_path``,
``stored_filename``, ``logical_filename``, etc.) — BI tools only need the
metadata required to correlate rows to a reporting period.
"""
from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


class AdUploadFileItem(BaseModel):
    # Allow ``model_validate(orm_row)`` to read attributes from SQLAlchemy
    # ORM instances.
    model_config = ConfigDict(from_attributes=True)

    file_id: int
    report_type: str
    report_label: str
    country: str
    period_start_date: date
    period_end_date: date
    version: int
    is_current: bool
    ingestion_status: str
    row_count_preview: int | None = None
    uploaded_at: datetime