from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import re

import pandas as pd
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.schemas.upload import (
    ReportProjectMatchSummary,
    ReportRecognitionResponse,
)
import app.services.project_service as project_service
import app.services.upload_service as upload_service
from app.utils.country import normalize_country as _normalize_country
from app.utils.recognition import (
    recognize_file,
    RecognitionResult,
    _normalize_identifier,
    _normalize_columns,
    _read_csv_with_encoding_fallback,
    _read_excel,
)
from app.utils.parsers import detect_countries_in_sales_file
from app.utils.payment_locale import read_payment_report_dataframe
from app.services.data.upload.project_match import _build_project_match


@dataclass
class RecognitionPayload:
    """Internal payload for recognition with project matching (backend-specific)."""
    report_type: str
    matched_columns: list[str]
    reason: str
    date_input_mode: str
    detected_date: str | None = None
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    project_match: ReportProjectMatchSummary | None = None
    row_count_preview: int | None = None
    warnings: list[str] | None = None
    country: str = "US"
    detected_countries: list[str] = field(default_factory=list)  # Multi-site detection
    primary_country: str | None = None


def _result_to_payload(result: RecognitionResult) -> RecognitionPayload:
    """Convert shared RecognitionResult to RecognitionPayload (adds project_match placeholder)."""
    return RecognitionPayload(
        report_type=result.report_type,
        matched_columns=result.matched_columns,
        reason=result.reason,
        date_input_mode=result.date_input_mode,
        detected_date=result.detected_date,
        detected_start_date=result.detected_start_date,
        detected_end_date=result.detected_end_date,
        project_match=None,
        row_count_preview=result.row_count_preview,
        warnings=result.warnings,
        country=result.country,
    )


def recognize_saved_report_upload(
    db: Session,
    settings: Settings,
    *,
    temp_file_id: str,
    original_filename: str,
    country: str = "US",
    operator: str | None = None,
    is_admin: bool = True,
) -> ReportRecognitionResponse:
    path = upload_service.resolve_report_upload_temp_file_path(settings, temp_file_id)
    extension = path.suffix.lower()
    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(
            db, operator=operator, is_admin=is_admin
        )
    }
    normalized_country = _normalize_country(country)

    result = recognize_file(path, country=normalized_country, original_filename=original_filename)

    if result is None:
        return ReportRecognitionResponse(
            temp_file_id=temp_file_id,
            original_filename=original_filename,
            extension=extension,
            report_type="unknown",
            matched_columns=[],
            reason="文件类型无法识别",
            status="error",
            country=normalized_country,
            date_input_mode="single_manual",
            project_match=ReportProjectMatchSummary(
                status="manual", message="未识别成功"
            ),
            warnings=[],
        )

    payload = _result_to_payload(result)
    effective_country = _normalize_country(payload.country or normalized_country)

    # Multi-country detection for sales reports
    if result.report_type == "sales_report":
        detected = detect_countries_in_sales_file(path)
        if detected:
            payload.detected_countries = detected
            payload.primary_country = detected[0] if len(detected) == 1 else None

    try:
        if result.report_type in {"inventory_report", "sales_report", "return_report"}:
            df = _normalize_columns(_read_csv_with_encoding_fallback(path))
            match_by = "sku"
            values = df[match_by].dropna().astype(str).tolist()
        elif result.report_type == "business_report":
            df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
            match_by = "asin"
            asin_col = next(
                (c for c in ["（子）asin", "(子)asin", "子asin", "asin"] if c in df.columns),
                None,
            )
            if asin_col:
                values = df[asin_col].dropna().astype(str).tolist()
            else:
                values = []
        elif result.report_type == "payment_report":
            df = read_payment_report_dataframe(path, country=effective_country)
            df = _normalize_columns(df)
            match_by = "sku"
            values = df["sku"].dropna().astype(str).tolist()
        else:
            # ad_product_report / ad_search_term_report 已下线，走 B 表
            # (app.services.ad.upload.specs)，不再经过 /api/v1/data-upload/commit
            values = []

        if values:
            payload.project_match = _build_project_match(
                db,
                values=values,
                match_by=match_by,
                country=effective_country,
                allowed_projects=allowed_projects,
            )
            if (
                payload.project_match.status == "unmatched"
                and result.report_type == "payment_report"
                and original_filename
            ):
                match = re.match(r"^\[([^\]]+)\]", original_filename)
                if match:
                    folder_name = match.group(1)
                    if folder_name in allowed_projects:
                        payload.project_match = ReportProjectMatchSummary(
                            status="matched",
                            project_name=folder_name,
                            matched_by="folder_name",
                            message=f"根据文件名 [{folder_name}] 匹配项目（SKU 匹配失败）",
                        )
        else:
            payload.project_match = ReportProjectMatchSummary(
                status="unmatched",
                matched_by=match_by,
                message="文件中未找到可用于匹配项目的标识",
            )

    except Exception as exc:
        payload.project_match = ReportProjectMatchSummary(
            status="manual", message=f"项目匹配失败: {exc}"
        )

    return ReportRecognitionResponse(
        temp_file_id=temp_file_id,
        original_filename=original_filename,
        extension=extension,
        report_type=payload.report_type,
        matched_columns=payload.matched_columns,
        reason=payload.reason,
        status="recognized",
        country=effective_country,
        detected_countries=payload.detected_countries,
        primary_country=payload.primary_country,
        date_input_mode=payload.date_input_mode,
        detected_date=payload.detected_date,
        detected_start_date=payload.detected_start_date,
        detected_end_date=payload.detected_end_date,
        project_match=payload.project_match or ReportProjectMatchSummary(status="manual"),
        row_count_preview=payload.row_count_preview,
        warnings=payload.warnings or [],
    )
