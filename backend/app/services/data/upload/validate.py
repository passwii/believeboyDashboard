"""Agent 报表上传 dry-run 校验服务（BLF-975）。

校验文件列匹配度、检测国家、行数估算，不入库。
"""

from __future__ import annotations

import logging

from fastapi import UploadFile
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.schemas.upload import AgentUploadValidateResponse, ReportUploadType
from app.services.upload_service import (
    resolve_report_upload_temp_file_path,
    save_report_upload_temp_file,
)
from app.utils.country import normalize_country as _normalize_country
from app.utils.parsers import detect_countries_in_sales_file
from app.utils.recognition import (
    LedgerRecognitionError,
    recognize_file,
    RecognitionResult,
)

logger = logging.getLogger(__name__)

# 各报表类型所需的核心列（用于计算列匹配度）
REPORT_REQUIRED_COLUMNS: dict[str, list[str]] = {
    "sales_report": ["purchase-date", "sku", "asin"],
    "inventory_report": ["snapshot-date", "sku", "asin"],
    "business_report": ["asin"],
    "return_report": ["return-date", "sku"],
    "payment_report": ["sku", "asin"],
    "inventory_ledger_summary": [
        "starting warehouse balance",
        "ending warehouse balance",
    ],
    "inventory_ledger_detail": [
        "fulfillment-center",
        "quantity",
    ],
}


def _compute_column_match(
    result: RecognitionResult,
    recognized_type: str,
) -> tuple[list[str], list[str], float]:
    """计算列匹配度。

    返回 (matched_columns, missing_columns, match_ratio)。
    """
    required = REPORT_REQUIRED_COLUMNS.get(recognized_type, [])
    if not required:
        return result.matched_columns, [], 1.0

    matched_lower = {c.strip().lower() for c in result.matched_columns}
    matched = [c for c in required if c.lower() in matched_lower]
    missing = [c for c in required if c.lower() not in matched_lower]
    ratio = len(matched) / len(required) if required else 1.0
    return matched, missing, ratio


def _suggest_report_type(result: RecognitionResult) -> ReportUploadType | None:
    """列不匹配时，根据已匹配列建议最可能的报表类型。"""
    matched_set = {c.strip().lower() for c in result.matched_columns}
    if not matched_set:
        return None

    best_type: ReportUploadType | None = None
    best_score: float = 0.0

    for rtype, required in REPORT_REQUIRED_COLUMNS.items():
        if not required:
            continue
        hits = sum(1 for c in required if c.lower() in matched_set)
        score = hits / len(required)
        if score > best_score:
            best_score = score
            best_type = rtype  # type: ignore[assignment]

    return best_type if best_score >= 0.5 else None


def validate_upload(
    db: Session,
    settings: Settings,
    file: UploadFile,
    report_type: str,
    country: str,
    operator: str | None = None,
    is_admin: bool = True,
) -> AgentUploadValidateResponse:
    """Dry-run 校验：返回列匹配度、检测国家、行数估算，不入库。"""
    # 保存临时文件（与正式流程共用临时目录）
    saved = save_report_upload_temp_file(file=file, settings=settings)
    temp_file_id = str(saved["temp_file_id"])
    original_filename = str(saved["original_filename"])
    path = resolve_report_upload_temp_file_path(settings, temp_file_id)
    normalized_country = _normalize_country(country)

    try:
        result = recognize_file(
            path, country=normalized_country, original_filename=original_filename
        )
    except LedgerRecognitionError as exc:
        return AgentUploadValidateResponse(
            report_type="unknown",
            status="invalid",
            missing_columns=REPORT_REQUIRED_COLUMNS.get(report_type, []),
            column_match_ratio=0.0,
            warnings=[str(exc)],
            primary_country=normalized_country,
        )

    if result is None:
        return AgentUploadValidateResponse(
            report_type="unknown",
            status="invalid",
            missing_columns=REPORT_REQUIRED_COLUMNS.get(report_type, []),
            column_match_ratio=0.0,
            warnings=[f"文件类型无法识别（声明类型: {report_type})"],
            primary_country=normalized_country,
        )

    # 列匹配度计算
    matched, missing, ratio = _compute_column_match(result, report_type)

    # 多站点检测
    detected_countries: list[str] = []
    primary_country = result.country or normalized_country
    if result.report_type == "sales_report":
        detected = detect_countries_in_sales_file(path)
        if detected:
            detected_countries = detected
            primary_country = detected[0] if len(detected) == 1 else primary_country

    # 状态判定
    status: AgentUploadValidateResponse.status = "valid"
    suggested_type: ReportUploadType | None = None
    warnings: list[str] = list(result.warnings or [])

    if missing:
        if ratio >= 0.5:
            status = "warning"
        else:
            status = "invalid"
        suggested_type = _suggest_report_type(result)
        warnings.append(f"列不匹配：声明 {report_type} 但缺少 {missing}")

    return AgentUploadValidateResponse(
        report_type=result.report_type,
        status=status,
        matched_columns=matched,
        missing_columns=missing,
        column_match_ratio=ratio,
        detected_countries=detected_countries,
        primary_country=primary_country,
        row_count_preview=result.row_count_preview,
        date_input_mode=result.date_input_mode,
        detected_date=result.detected_date,
        detected_start_date=result.detected_start_date,
        detected_end_date=result.detected_end_date,
        suggested_report_type=suggested_type,
        warnings=warnings,
    )
