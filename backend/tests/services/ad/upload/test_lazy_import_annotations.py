from typing import Any, get_type_hints

from app.services.ad.upload.project_match import _build_project_match
from app.services.ad.upload.recognition import _detect_report_spec


def test_lazy_imported_dataframe_annotations_are_runtime_resolvable() -> None:
    assert get_type_hints(_build_project_match)['df'] is Any
    assert get_type_hints(_detect_report_spec)['df'] is Any
