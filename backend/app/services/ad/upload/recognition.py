"""Ad upload recognition pipeline.

Uses ``REPORT_SPECS`` from ``specs.py`` (intentionally independent from
``app.utils.recognition`` — see specs.py for architecture rationale).
"""
from __future__ import annotations

from pathlib import Path
import shutil
from typing import TYPE_CHECKING, Any
import uuid

if TYPE_CHECKING:
    import pandas as pd

    DataFrameType = pd.DataFrame
else:
    DataFrameType = Any

from fastapi import HTTPException, UploadFile, status
from slugify import slugify
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.schemas.ad_upload import AdUploadRecognitionResponse
import app.services.project_service as project_service
from app.services.ad.upload.project_match import _build_project_match
from app.services.ad.upload.specs import ALLOWED_EXTENSIONS, REPORT_SPECS, ReportSpec
from app.services.ad.upload.utils import (
    _date_to_string,
    _read_dataframe,
    _safe_name,
    _safe_project_folder_name,
)
from app.services.ad.upload.specs import _periodic_required_columns
from app.utils.country import normalize_country


def save_ad_upload_temp_file(file: UploadFile, settings: Settings) -> dict:
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing filename')

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        expected = ', '.join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unsupported extension: {ext} (expected: {expected})',
        )

    folder = settings.upload_root / '_ad_upload_tmp'
    folder.mkdir(parents=True, exist_ok=True)

    temp_id = uuid.uuid4().hex
    safe_name = _safe_name(file.filename)
    stored_name = f'{temp_id}_{safe_name}'
    path = folder / stored_name

    size = 0
    with path.open('wb') as target:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > settings.max_upload_bytes:
                path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail='File too large',
                )
            target.write(chunk)

    return {
        'temp_file_id': stored_name,
        'file_path': str(path.resolve()),
        'original_filename': file.filename,
        'size': size,
    }


def resolve_ad_upload_temp_file_path(settings: Settings, temp_file_id: str) -> Path:
    path = settings.upload_root / '_ad_upload_tmp' / temp_file_id
    if path.exists() and path.is_file():
        return path
    raise FileNotFoundError(f'temp_file_id not found: {temp_file_id}')


def finalize_ad_upload_temp_file(
    settings: Settings,
    *,
    temp_file_id: str,
    original_filename: str,
    project_name: str,
    report_type: str,
) -> dict:
    source = resolve_ad_upload_temp_file_path(settings, temp_file_id)
    ext = source.suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        expected = ', '.join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unsupported extension: {ext} (expected: {expected})',
        )

    folder = (
        settings.upload_root
        / '_ad_upload'
        / _safe_project_folder_name(project_name)
        / (slugify(report_type)[:60] or 'ad-upload')
    )
    folder.mkdir(parents=True, exist_ok=True)

    unique_id = uuid.uuid4().hex
    safe_name = _safe_name(original_filename or source.name)
    stored_name = f'{unique_id}_{safe_name}'
    destination = folder / stored_name
    shutil.copy2(source, destination)

    return {
        'file_id': stored_name,
        'file_path': str(destination.resolve()),
        'filename': stored_name,
        'original_filename': original_filename or source.name,
        'size': destination.stat().st_size,
    }


def _detect_report_spec(df: DataFrameType, extension: str) -> ReportSpec:
    # Case-insensitive column matching (Amazon exports sometimes use mixed case,
    # e.g. "广告SKU" vs "广告sku"). Specs keep Amazon's official case; comparison
    # is done in lowercase.
    columns_lower = {str(c).strip().lower() for c in df.columns}
    for spec in REPORT_SPECS:
        if extension not in spec.extensions:
            continue
        required_lower = tuple(str(c).lower() for c in spec.required_columns)
        missing = [column for column in required_lower if column not in columns_lower]
        if not missing:
            return spec
        periodic_columns = _periodic_required_columns(spec)
        periodic_columns_lower = tuple(str(c).lower() for c in periodic_columns)
        missing_periodic = [column for column in periodic_columns_lower if column not in columns_lower]
        if not missing_periodic:
            return ReportSpec(
                report_type=spec.report_type,
                report_label=spec.report_label,
                extensions=spec.extensions,
                required_columns=periodic_columns,
                project_match_fields=spec.project_match_fields,
            )

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail='未命中广告报表识别规则，请检查文件格式或表头',
    )


def recognize_saved_ad_upload(
    db: Session,
    settings: Settings,
    *,
    temp_file_id: str,
    original_filename: str,
    country: str = 'US',
    operator: str | None = None,
    is_admin: bool = True,
) -> AdUploadRecognitionResponse:
    import pandas as pd

    path = resolve_ad_upload_temp_file_path(settings, temp_file_id)
    df = _read_dataframe(path)
    extension = path.suffix.lower()
    normalized_country = normalize_country(country)
    spec = _detect_report_spec(df, extension)

    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(
            db,
            operator=operator,
            is_admin=is_admin,
        )
    }

    detected_country = normalized_country
    if '国家/地区' in df.columns and not df['国家/地区'].dropna().empty:
        detected_country = normalize_country(df['国家/地区'].dropna().iloc[0])

    if '开始日期' in df.columns and '结束日期' in df.columns:
        detected_start_date = (
            _date_to_string(df['开始日期'].dropna().iloc[0])
            if not df['开始日期'].dropna().empty
            else None
        )
        detected_end_date = (
            _date_to_string(df['结束日期'].dropna().iloc[0])
            if not df['结束日期'].dropna().empty
            else None
        )
    elif '日期' in df.columns and not df['日期'].dropna().empty:
        parsed_dates = pd.to_datetime(df['日期'], errors='coerce').dropna()
        detected_start_date = (
            parsed_dates.min().strftime('%Y-%m-%d')
            if not parsed_dates.empty
            else None
        )
        detected_end_date = (
            parsed_dates.max().strftime('%Y-%m-%d')
            if not parsed_dates.empty
            else None
        )
    else:
        detected_start_date = None
        detected_end_date = None

    warnings_list: list[str] = []
    if len(df.index) == 0:
        warnings_list.append('报表已识别，但当前文件没有业务明细行')
    if detected_start_date and detected_end_date and detected_start_date != detected_end_date:
        if '日期' in df.columns:
            warnings_list.append('当前文件识别为周期报表，入库时将按日期拆分并覆盖对应单日数据')
        else:
            warnings_list.append('当前文件识别为非单日报表，系统将拒绝入库')

    project_match = _build_project_match(
        db,
        df=df,
        spec=spec,
        country=detected_country,
        allowed_projects=allowed_projects,
    )

    return AdUploadRecognitionResponse(
        temp_file_id=temp_file_id,
        original_filename=original_filename,
        extension=extension,
        report_type=spec.report_type,
        report_label=spec.report_label,
        matched_columns=list(spec.required_columns),
        reason=f'命中字段：{" / ".join(spec.required_columns[:6])}',
        status='recognized',
        country=detected_country,
        detected_report_date=detected_end_date or detected_start_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date or detected_start_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
    )
