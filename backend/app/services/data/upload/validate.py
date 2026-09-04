"""Agent 报表上传 dry-run 校验服务（BLF-975）。

校验文件列匹配度、检测国家、行数估算，不入库。

BLF-975 复测扩展：
* 识别器双引擎回退——核心引擎（``app.utils.recognition``）不覆盖广告 B 表
  的中文表头 xlsx（.xlsx 在核心引擎恒返回 None），未命中时回退广告 specs
  识别器（``app.services.ad.upload`` 的 superset 中文列匹配）。
* validate 响应必返回 ``temp_file_id``——validate 即临时文件登记步骤，
  commit 用它两段式衔接。
* 未识别（invalid）响应也带 temp_file_id，方便换 report_type 复测同一文件。
* 复测第 3 项：广告分支补日期探测（开始/结束日期列，Excel serial 数字
  单元格经 _date_to_string 兜底）与行数，agent 免手工传 report_date。
"""

from __future__ import annotations

import logging

import pandas as pd
from fastapi import HTTPException, UploadFile
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


def _match_ad_spec(path, report_type: str) -> dict | None:
    """广告 B 表识别回退（BLF-975 问题 1 + 复测第 3 项）。

    核心引擎对 .xlsx 恒返回 None（广告域迁到独立 specs 体系），这里复用
    ``app.services.ad.upload`` 的中文列 superset 匹配做 dry-run 判定。

    返回 dict（report_type / matched / missing / ratio / row_count_preview /
    detected_date / detected_start_date / detected_end_date）；未命中 specs
    返回 None。识别成功即视为 valid——specs 是**强签名全列匹配**（required
    全命中才算命中），不存在"部分命中"。
    """
    from app.services.ad.upload.recognition import _detect_report_spec
    from app.services.ad.upload.utils import _date_to_string, _read_dataframe

    try:
        df = _read_dataframe(path)
    except HTTPException:
        return None

    try:
        spec = _detect_report_spec(df, path.suffix.lower())
    except HTTPException:
        return None

    required = [str(c) for c in spec.required_columns]
    columns_lower = {str(c).strip().lower() for c in df.columns}
    matched = [c for c in required if c.lower() in columns_lower]
    missing = [c for c in required if c.lower() not in columns_lower]
    ratio = len(matched) / len(required) if required else 1.0

    # 日期探测（对齐 recognize_saved_ad_upload：开始/结束日期列）。
    detected_start = detected_end = None
    if "开始日期" in df.columns and not df["开始日期"].dropna().empty:
        detected_start = _date_to_string(df["开始日期"].dropna().iloc[0])
    if "结束日期" in df.columns and not df["结束日期"].dropna().empty:
        detected_end = _date_to_string(df["结束日期"].dropna().iloc[0])
    elif "日期" in df.columns and not df["日期"].dropna().empty:
        parsed = pd.to_datetime(df["日期"], errors="coerce").dropna()
        if not parsed.empty:
            detected_start = parsed.min().strftime("%Y-%m-%d")
            detected_end = parsed.max().strftime("%Y-%m-%d")

    # 声明类型兼容：ad_report 旧值 → ad_product_report 之外的 B 表子类型
    # 直接按识别出的 spec 类型为准（agent 声明只做提示，不强校验）。
    return {
        "report_type": spec.report_type,
        "matched": matched,
        "missing": missing,
        "ratio": ratio,
        "row_count_preview": len(df.index),
        "detected_start_date": detected_start,
        "detected_end_date": detected_end,
        "detected_date": detected_end or detected_start,
    }


def validate_upload(
    db: Session,
    settings: Settings,
    file: UploadFile,
    report_type: str,
    country: str,
    operator: str | None = None,
    is_admin: bool = True,
) -> AgentUploadValidateResponse:
    """Dry-run 校验：返回列匹配度、检测国家、行数估算，不入库。

    validate 同时承担临时文件登记（temp_file_id 必返回），commit 两段式
    用它衔接。
    """
    # 保存临时文件（与正式流程共用临时目录）
    saved = save_report_upload_temp_file(file=file, settings=settings)
    temp_file_id = str(saved["temp_file_id"])
    original_filename = str(saved["original_filename"])
    path = resolve_report_upload_temp_file_path(settings, temp_file_id)
    normalized_country = _normalize_country(country)

    def _invalid_response(
        warnings: list[str],
        *,
        missing: list[str] | None = None,
        detected_countries: list[str] | None = None,
    ) -> AgentUploadValidateResponse:
        return AgentUploadValidateResponse(
            temp_file_id=temp_file_id,
            original_filename=original_filename,
            report_type="unknown",
            status="invalid",
            missing_columns=missing or REPORT_REQUIRED_COLUMNS.get(report_type, []),
            column_match_ratio=0.0,
            detected_countries=detected_countries or [],
            primary_country=normalized_country,
            warnings=warnings,
        )

    try:
        result = recognize_file(
            path, country=normalized_country, original_filename=original_filename
        )
    except LedgerRecognitionError as exc:
        return _invalid_response([str(exc)])

    # BLF-975 问题 1 + 复测第 3 项：核心引擎不认识（None）→ 回退广告
    # specs 识别器（日期/行数随探测一并返回，agent 免手工传 report_date）。
    if result is None:
        ad_match = _match_ad_spec(path, report_type)
        if ad_match is not None:
            spec_status = "valid" if not ad_match["missing"] else "invalid"
            warnings: list[str] = []
            if ad_match["missing"]:
                warnings.append(
                    f"列不匹配：声明 {report_type} 但缺少 {ad_match['missing']}"
                )
            return AgentUploadValidateResponse(
                temp_file_id=temp_file_id,
                original_filename=original_filename,
                report_type=ad_match["report_type"],  # type: ignore[arg-type]
                status=spec_status,  # type: ignore[arg-type]
                matched_columns=ad_match["matched"],
                missing_columns=ad_match["missing"],
                column_match_ratio=ad_match["ratio"],
                primary_country=normalized_country,
                row_count_preview=ad_match["row_count_preview"],
                detected_date=ad_match["detected_date"],
                detected_start_date=ad_match["detected_start_date"],
                detected_end_date=ad_match["detected_end_date"],
                warnings=warnings,
            )
        return _invalid_response([f"文件类型无法识别（声明类型: {report_type})"])

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
    status_value = "valid"
    suggested_type: ReportUploadType | None = None
    warnings = list(result.warnings or [])

    if missing:
        if ratio >= 0.5:
            status_value = "warning"
        else:
            status_value = "invalid"
        suggested_type = _suggest_report_type(result)
        warnings.append(f"列不匹配：声明 {report_type} 但缺少 {missing}")

    return AgentUploadValidateResponse(
        temp_file_id=temp_file_id,
        original_filename=original_filename,
        report_type=result.report_type,  # type: ignore[arg-type]
        status=status_value,  # type: ignore[arg-type]
        matched_columns=matched,
        missing_columns=missing,
        column_match_ratio=ratio,
        detected_countries=detected_countries,
        primary_country=primary_country,
        row_count_preview=result.row_count_preview,
        date_input_mode=result.date_input_mode,  # type: ignore[arg-type]
        detected_date=result.detected_date,
        detected_start_date=result.detected_start_date,
        detected_end_date=result.detected_end_date,
        suggested_report_type=suggested_type,
        warnings=warnings,
    )
