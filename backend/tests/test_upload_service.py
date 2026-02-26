from pathlib import Path
from tempfile import SpooledTemporaryFile

import pytest
from fastapi import HTTPException, UploadFile

from app.core.config import Settings
from app.services.upload_service import save_upload_file


def _build_settings(tmp_path: Path) -> Settings:
    return Settings(
        upload_root=tmp_path / 'uploads',
        result_root=tmp_path / 'results',
        product_cost_cache_sqlite_path=tmp_path / 'cache' / 'query_cache.db',
        allowed_upload_extensions={'.csv'},
    )


def _build_upload_file(filename: str, content_type: str, payload: bytes) -> UploadFile:
    file = SpooledTemporaryFile()
    file.write(payload)
    file.seek(0)
    return UploadFile(file=file, filename=filename, headers={'content-type': content_type})


def test_monthly_summary_pdf_allows_pdf_when_global_extensions_exclude_pdf(tmp_path: Path):
    settings = _build_settings(tmp_path)
    upload = _build_upload_file('2026JanMonthlyUnifiedSummary.pdf', 'application/pdf', b'%PDF-1.4')

    payload = save_upload_file(upload, settings=settings, project_name='Demo 项目', file_type='monthly_summary_pdf')

    assert payload['filename'].endswith('.pdf')
    assert Path(payload['file_path']).exists()


def test_monthly_summary_pdf_rejects_non_pdf(tmp_path: Path):
    settings = _build_settings(tmp_path)
    upload = _build_upload_file('2026JanMonthlyUnifiedSummary.csv', 'text/csv', b'header\nrow')

    with pytest.raises(HTTPException) as exc_info:
        save_upload_file(upload, settings=settings, project_name='Demo 项目', file_type='monthly_summary_pdf')

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == 'Unsupported extension: .csv (expected: .pdf)'


def test_upload_folder_uses_project_name_as_parent(tmp_path: Path):
    settings = _build_settings(tmp_path)
    upload = _build_upload_file('2026JanMonthlyUnifiedSummary.pdf', 'application/pdf', b'%PDF-1.4')

    payload = save_upload_file(upload, settings=settings, project_name='Demo 项目', file_type='monthly_summary_pdf')

    saved_path = Path(payload['file_path'])
    assert saved_path.parent.name == 'monthly-summary-pdf'
    assert saved_path.parent.parent.name == 'Demo-项目'
