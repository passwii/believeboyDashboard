"""Report upload data services.

Aggregates and re-exports all public functions from the upload subpackage
for backward compatibility. New code should import from the specific submodule.
"""

from app.services.data.upload.recognition import (
    RecognitionPayload,
    _result_to_payload,
    recognize_saved_report_upload,
)
from app.services.data.upload.project_match import (
    _build_project_match,
)
from app.services.data.upload.persistence import (
    commit_report_upload,
    upsert_file_only_report_status,
)
from app.services.data.upload.status import (
    STATUS_REPORT_TYPES,
    _status_cell,
    list_report_upload_statuses,
)

__all__ = [
    "RecognitionPayload",
    "_result_to_payload",
    "_build_project_match",
    "recognize_saved_report_upload",
    "commit_report_upload",
    "upsert_file_only_report_status",
    "STATUS_REPORT_TYPES",
    "_status_cell",
    "list_report_upload_statuses",
]
