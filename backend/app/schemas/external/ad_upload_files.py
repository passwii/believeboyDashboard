"""AdUploadFile response schema（BLF-459 V3 恢复：内部 ad-data 页用）。

``GET /internal/ad-data/projects/{id}/ad-upload-files`` 每个文件返回一项。
Schema 有意省略内部列（``recognition_payload``、``matched_columns``、
``warnings``、``ingestion_error``、``upload_file_path``、``stored_filename``、
``logical_filename`` 等）——UI 只需要关联报表周期所需的元数据。
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
