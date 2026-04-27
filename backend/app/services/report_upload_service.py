from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
import warnings
from zoneinfo import ZoneInfo

import pandas as pd
from fastapi import HTTPException, status
from sqlalchemy import inspect, select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.schemas.upload import (
    ReportCommitRequest,
    ReportCommitResponse,
    ProjectReportStatusItem,
    ReportProjectMatchSummary,
    ReportRecognitionResponse,
    ReportStatusCell,
    ReportStatusResponse,
)
from app.tasks.scripts import product_analysis as product_analysis_script
import app.services.upload_service as upload_service
import app.services.product_cost_service as product_cost_service
import app.services.product_analysis_source_service as product_analysis_source_service
import app.services.project_service as project_service
import app.services.redis_service as redis_service
from app.services.report_type_service import AD_PRODUCT_REPORT, normalize_report_type
from app.models import AnalysisSourceFile, ProductCost, ReportUploadStatus

OPENPYXL_MISSING_DEFAULT_STYLE_WARNING = (
    "Workbook contains no default style, apply openpyxl's default"
)
SUPPORTED_REPORT_TYPES = {
    "inventory_report",
    "business_report",
    AD_PRODUCT_REPORT,
    "ad_search_term_report",
    "sales_report",
    "payment_report",
    "return_report",
}
STATUS_REPORT_TYPES = [
    "inventory_report",
    "business_report",
    AD_PRODUCT_REPORT,
    "ad_search_term_report",
    "sales_report",
    "payment_report",
    "return_report",
]
COUNTRY_TIMEZONE = {
    "US": ZoneInfo("America/Los_Angeles"),
    "DE": ZoneInfo("Europe/Berlin"),
    "UK": ZoneInfo("Europe/London"),
}


@dataclass
class RecognitionPayload:
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


def _read_excel(path: Path) -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=OPENPYXL_MISSING_DEFAULT_STYLE_WARNING,
            category=UserWarning,
        )
        return pd.read_excel(path, engine="openpyxl")


def _read_csv_with_encoding_fallback(path: Path, sep: str = "\t") -> pd.DataFrame:
    """Try UTF-8 first, fall back to CP1252 (Windows-1252) if decode fails."""
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return pd.read_csv(path, sep=sep, encoding=encoding)
        except UnicodeDecodeError:
            continue
    # Last resort: latin-1 which never fails
    return pd.read_csv(path, sep=sep, encoding="latin-1")


def _read_text_with_encoding_fallback(path: Path) -> str:
    """Try UTF-8 first, fall back to CP1252 if decode fails."""
    raw_bytes = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw_bytes.decode("latin-1", errors="replace")


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df.columns = [str(column).strip() for column in df.columns]
    return df


def _normalize_identifier(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() == "nan":
        return ""
    return text.upper()


def _detect_country_from_sales_channel(df: pd.DataFrame) -> str | None:
    """Detect country from sales-channel column. Returns None if not found or ambiguous."""
    col_candidates = [c for c in df.columns if "sales" in c.lower() and "channel" in c.lower()]
    if not col_candidates:
        return None
    val = str(df[col_candidates[0]].dropna().iloc[0]).strip().lower()
    if "amazon.de" in val:
        return "DE"
    if "amazon.com" in val:
        return "US"
    if "amazon.co.uk" in val:
        return "UK"  # 🔶 Reserved for UK站点
    return None


def _detect_country_from_currency(df: pd.DataFrame) -> str | None:
    """Detect country from currency column. USD→US, EUR→DE, GBP→UK."""
    col_candidates = [c for c in df.columns if "currency" in c.lower() or "币种" in c]
    if not col_candidates:
        return None
    val = str(df[col_candidates[0]].dropna().iloc[0]).strip().upper()
    if val in {"USD", "US"}:
        return "US"
    if val in {"EUR", "EURO"}:
        return "DE"
    if val in {"GBP", "UK"}:
        return "UK"  # 🔶 Reserved
    return None


def _detect_country_from_marketplace(df: pd.DataFrame) -> str | None:
    """Detect country from marketplace column. DE→DE, UK/GB→UK."""
    col_candidates = [c for c in df.columns if "marketplace" in c.lower()]
    if not col_candidates:
        return None
    val = str(df[col_candidates[0]].dropna().iloc[0]).strip().upper()
    if val in {"DE", "GERMANY"}:
        return "DE"
    if val in {"UK", "GB", "UNITED KINGDOM"}:
        return "UK"  # 🔶 Reserved
    return None


def _detect_country_from_sales_amount_symbol(df: pd.DataFrame) -> str | None:
    """Detect country from currency symbol in sales amount columns (业务报告). € → DE, £ → UK."""
    sales_col_candidates = [
        c for c in df.columns
        if "销售额" in c or "sales" in c.lower()
    ]
    for col in sales_col_candidates:
        sample = (
            str(df[col].dropna().iloc[0])
            if not df[col].dropna().empty
            else ""
        )
        if "€" in sample:
            return "DE"
        if "£" in sample:
            return "UK"  # 🔶 Reserved
    return None


def _normalize_country(value: object) -> str:
    """Wrapper that accepts object (e.g. pandas scalars) and delegates to the shared utility."""
    from app.utils.country import _normalize_country as _normalize
    return _normalize(str(value) if value is not None else None)


def _date_to_string(value: object) -> str | None:
    if value is None or value == "":
        return None
    try:
        parsed = pd.to_datetime(value, errors="coerce")
    except Exception:  # noqa: BLE001
        return None
    if parsed is None or pd.isna(parsed):
        return None
    return parsed.strftime("%Y-%m-%d")


def _date_to_string_by_country(value: object, country: str) -> str | None:
    if value is None or value == "":
        return None
    try:
        parsed = pd.to_datetime(value, errors="coerce")
    except Exception:  # noqa: BLE001
        return None
    if parsed is None or pd.isna(parsed):
        return None

    if parsed.tzinfo is None:
        return parsed.strftime("%Y-%m-%d")

    timezone = COUNTRY_TIMEZONE.get(country, COUNTRY_TIMEZONE["US"])
    return parsed.tz_convert(timezone).strftime("%Y-%m-%d")


def _build_project_match(
    db: Session,
    *,
    values: list[str],
    match_by: str,
    country: str = "US",
    allowed_projects: set[str] | None = None,
) -> ReportProjectMatchSummary:
    normalized_values = sorted(
        {
            _normalize_identifier(value)
            for value in values
            if _normalize_identifier(value)
        }
    )
    if not normalized_values:
        return ReportProjectMatchSummary(
            status="unmatched",
            matched_by=match_by,
            message="文件中未找到可用于匹配项目的标识",
        )

    matched_map = product_cost_service.match_projects_by_identifiers(
        db,
        identifiers=normalized_values,
        match_by=match_by,
        country=country,
    )
    if allowed_projects is not None:
        matched_map = {
            key: [project for project in projects if project in allowed_projects]
            for key, projects in matched_map.items()
        }
    all_projects = sorted(
        {project for projects in matched_map.values() for project in projects}
    )
    matched_values = [key for key, projects in matched_map.items() if projects]

    if len(all_projects) == 1:
        message = f"已根据{match_by.upper()}自动匹配项目"
        if len(matched_values) != len(normalized_values):
            message = f"已根据部分{match_by.upper()}自动匹配项目"
        return ReportProjectMatchSummary(
            status="matched",
            project_name=all_projects[0],
            candidate_projects=all_projects,
            matched_by=match_by,
            matched_values=matched_values[:8],
            message=message,
        )

    if len(all_projects) > 1:
        return ReportProjectMatchSummary(
            status="conflict",
            candidate_projects=all_projects,
            matched_by=match_by,
            matched_values=matched_values[:8],
            message=f"检测到多个项目，请手动确认（{len(all_projects)} 个候选项目）",
        )

    return ReportProjectMatchSummary(
        status="unmatched",
        matched_by=match_by,
        matched_values=[],
        message="未匹配到项目，请手动选择",
    )


def _recognize_inventory_report(
    db: Session,
    path: Path,
    *,
    country: str = "US",
    allowed_projects: set[str] | None = None,
) -> RecognitionPayload:
    df = _normalize_columns(_read_csv_with_encoding_fallback(path))
    required = ["snapshot-date", "sku", "asin"]
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise ValueError(f"Inventory report missing required columns: {missing}")
    detected_snapshot_date = _date_to_string_by_country(
        df["snapshot-date"].dropna().iloc[0]
        if not df["snapshot-date"].dropna().empty
        else None,
        country,
    )

    project_match = _build_project_match(
        db,
        values=df["sku"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
        allowed_projects=allowed_projects,
    )
    warnings_list: list[str] = []
    detected_country = _detect_country_from_currency(df)
    if not detected_country:
        detected_country = _detect_country_from_marketplace(df)
    if detected_country and detected_country != country:
        warnings_list.append(
            f"文件内 currency/marketplace 为 {detected_country}，当前按所选站点 {country} 处理"
        )
    return RecognitionPayload(
        report_type="inventory_report",
        matched_columns=required,
        reason="命中 snapshot-date / sku / asin",
        date_input_mode="single_detected"
        if detected_snapshot_date
        else "single_manual",
        detected_date=detected_snapshot_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def _extract_date_from_filename(filename: str) -> str | None:
    """从文件名中提取 YYYYMMDD 格式的日期，例如 BusinessReport-15-4-26_20260413.csv → 2026-04-13"""
    import re
    m = re.search(r'(\d{4})(\d{2})(\d{2})', filename)
    if not m:
        return None
    year, month, day = m.group(1), m.group(2), m.group(3)
    try:
        datetime(int(year), int(month), int(day))
        return f"{year}-{month}-{day}"
    except ValueError:
        return None


def _recognize_business_report(
    db: Session,
    path: Path,
    *,
    country: str = "US",
    allowed_projects: set[str] | None = None,
    original_filename: str = "",
) -> RecognitionPayload:
    df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
    asin_column = next(
        (
            column
            for column in ["（子）ASIN", "(子)ASIN", "子ASIN", "ASIN"]
            if column in df.columns
        ),
        None,
    )
    if not asin_column:
        raise ValueError("Business report missing child ASIN column")

    project_match = _build_project_match(
        db,
        values=df[asin_column].dropna().astype(str).tolist(),
        match_by="asin",
        country=country,
        allowed_projects=allowed_projects,
    )
    detected_date = _extract_date_from_filename(original_filename)
    warnings_list: list[str] = []
    if detected_date:
        warnings_list.append(f"从文件名识别日期：{detected_date}")

    # Detect country from sales amount currency symbol (€ for DE, £ for UK)
    detected_country = _detect_country_from_sales_amount_symbol(df)
    if detected_country and detected_country != country:
        warnings_list.append(
            f"文件内销售额符号检测为 {detected_country}，当前按所选站点 {country} 处理"
        )

    return RecognitionPayload(
        report_type="business_report",
        matched_columns=[asin_column],
        reason="命中（子）ASIN字段",
        date_input_mode="single_detected" if detected_date else "single_manual",
        detected_date=detected_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def _recognize_payment_report(
    db: Session,
    path: Path,
    *,
    country: str = "US",
    allowed_projects: set[str] | None = None,
) -> RecognitionPayload:
    df = product_analysis_script._read_payment_report(path)
    df = _normalize_columns(df)
    if "sku" not in df.columns:
        raise ValueError("Payment report missing sku column")

    project_match = _build_project_match(
        db,
        values=df["sku"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
        allowed_projects=allowed_projects,
    )
    return RecognitionPayload(
        report_type="payment_report",
        matched_columns=["sku"],
        reason="命中付款报告表头与 sku 字段",
        date_input_mode="range_manual",
        project_match=project_match,
        row_count_preview=len(df.index),
    )


def _recognize_sales_report(
    db: Session,
    path: Path,
    *,
    country: str = "US",
    allowed_projects: set[str] | None = None,
) -> RecognitionPayload:
    df = _normalize_columns(_read_csv_with_encoding_fallback(path))
    required = ["purchase-date", "sku", "asin"]
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise ValueError(f"Sales report missing required columns: {missing}")
    purchase_dates = pd.to_datetime(
        df["purchase-date"], utc=True, errors="coerce"
    ).dropna()
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    if not purchase_dates.empty:
        local_tz = COUNTRY_TIMEZONE.get(country, COUNTRY_TIMEZONE["US"])
        local_dates = purchase_dates.dt.tz_convert(local_tz).dt.strftime("%Y-%m-%d")
        detected_start_date = str(local_dates.min())
        detected_end_date = str(local_dates.max())
    is_periodic_range = bool(
        detected_start_date
        and detected_end_date
        and detected_start_date != detected_end_date
    )

    project_match = _build_project_match(
        db,
        values=df["sku"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
        allowed_projects=allowed_projects,
    )
    warnings_list: list[str] = []
    detected_country = _detect_country_from_sales_channel(df)
    if detected_country and detected_country != country:
        warnings_list.append(
            f"文件内 sales-channel 为 {detected_country}，当前按所选站点 {country} 处理"
        )
    return RecognitionPayload(
        report_type="sales_report",
        matched_columns=required,
        reason="命中 purchase-date / sku / asin",
        date_input_mode="multi_auto" if is_periodic_range else "single_detected",
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def _recognize_ad_product_report(
    db: Session,
    path: Path,
    *,
    country: str = "US",
    allowed_projects: set[str] | None = None,
) -> RecognitionPayload:
    df = _normalize_columns(_read_excel(path))
    required = ["开始日期", "结束日期", "广告SKU", "广告ASIN"]
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise ValueError(f"Ad report missing required columns: {missing}")

    project_match = _build_project_match(
        db,
        values=df["广告SKU"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
        allowed_projects=allowed_projects,
    )
    detected_end_date = _date_to_string_by_country(
        df["结束日期"].dropna().iloc[0] if not df["结束日期"].dropna().empty else None,
        country,
    )
    warnings_list: list[str] = []
    if "国家/地区" in df.columns and not df["国家/地区"].dropna().empty:
        file_country = _normalize_country(df["国家/地区"].dropna().iloc[0])
        if file_country != country:
            warnings_list.append(
                f"文件内国家/地区为 {file_country}，当前按所选站点 {country} 处理"
            )
    return RecognitionPayload(
        report_type=AD_PRODUCT_REPORT,
        matched_columns=required,
        reason="命中开始日期 / 结束日期 / 广告SKU / 广告ASIN",
        date_input_mode="single_detected",
        detected_date=detected_end_date,
        detected_start_date=_date_to_string_by_country(
            df["开始日期"].dropna().iloc[0]
            if not df["开始日期"].dropna().empty
            else None,
            country,
        ),
        detected_end_date=detected_end_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=country,
    )


def _recognize_ad_search_term_report(
    path: Path, *, country: str = "US"
) -> RecognitionPayload:
    df = _normalize_columns(_read_excel(path))
    required = ["开始日期", "结束日期"]
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise ValueError(f"Ad search term report missing required columns: {missing}")

    return RecognitionPayload(
        report_type="ad_search_term_report",
        matched_columns=required,
        reason="命中开始日期 / 结束日期，识别为商品推广搜索词报表",
        date_input_mode="single_detected",
        detected_date=_date_to_string(
            df["结束日期"].dropna().iloc[0]
            if not df["结束日期"].dropna().empty
            else None
        ),
        detected_start_date=_date_to_string(
            df["开始日期"].dropna().iloc[0]
            if not df["开始日期"].dropna().empty
            else None
        ),
        detected_end_date=_date_to_string(
            df["结束日期"].dropna().iloc[0]
            if not df["结束日期"].dropna().empty
            else None
        ),
        project_match=ReportProjectMatchSummary(
            status="manual", message="该报表项目需手动选择"
        ),
        row_count_preview=len(df.index),
        country=country,
    )


def _recognize_return_report(
    db: Session,
    path: Path,
    *,
    country: str = "US",
    allowed_projects: set[str] | None = None,
) -> RecognitionPayload:
    """识别退货报告 - 通过 return-date 字段判断"""
    df = _normalize_columns(_read_csv_with_encoding_fallback(path))
    required = ["return-date", "sku"]
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise ValueError(f"Return report missing required columns: {missing}")

    # 检测日期范围
    return_dates = pd.to_datetime(
        df["return-date"], utc=True, errors="coerce"
    ).dropna()
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    if not return_dates.empty:
        local_tz = COUNTRY_TIMEZONE.get(country, COUNTRY_TIMEZONE["US"])
        local_dates = return_dates.dt.tz_convert(local_tz).dt.strftime("%Y-%m-%d")
        detected_start_date = str(local_dates.min())
        detected_end_date = str(local_dates.max())

    project_match = _build_project_match(
        db,
        values=df["sku"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
        allowed_projects=allowed_projects,
    )

    return RecognitionPayload(
        report_type="return_report",
        matched_columns=required,
        reason="命中 return-date / sku 字段",
        date_input_mode="multi_auto"
        if detected_start_date and detected_end_date and detected_start_date != detected_end_date
        else "single_detected",
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        country=country,
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

    try:
        if extension == ".txt":
            header = (
                _read_text_with_encoding_fallback(path)
                .splitlines()[0]
                .strip()
                .lower()
            )
            if "snapshot-date" in header and "\tsku\t" in header:
                payload = _recognize_inventory_report(
                    db,
                    path,
                    country=normalized_country,
                    allowed_projects=allowed_projects,
                )
            elif "purchase-date" in header and "\tsku\t" in header:
                payload = _recognize_sales_report(
                    db,
                    path,
                    country=normalized_country,
                    allowed_projects=allowed_projects,
                )
            elif "return-date" in header and "\tsku\t" in header:
                payload = _recognize_return_report(
                    db,
                    path,
                    country=normalized_country,
                    allowed_projects=allowed_projects,
                )
            else:
                raise ValueError("未命中 txt 报表识别规则")
        elif extension == ".csv":
            first_lines = (
                _read_text_with_encoding_fallback(path)
                .splitlines()[:8]
            )
            joined = "\n".join(first_lines)
            if "Includes Amazon Marketplace" in joined:
                payload = _recognize_payment_report(
                    db,
                    path,
                    country=normalized_country,
                    allowed_projects=allowed_projects,
                )
            else:
                payload = _recognize_business_report(
                    db,
                    path,
                    country=normalized_country,
                    allowed_projects=allowed_projects,
                    original_filename=original_filename,
                )
        elif extension == ".xlsx":
            df = _normalize_columns(_read_excel(path))
            columns = set(df.columns)
            if {"广告SKU", "广告ASIN"}.issubset(columns):
                payload = _recognize_ad_product_report(
                    db,
                    path,
                    country=normalized_country,
                    allowed_projects=allowed_projects,
                )
            elif {"开始日期", "结束日期", "投放", "客户搜索词"}.issubset(columns):
                payload = _recognize_ad_search_term_report(
                    path, country=normalized_country
                )
            else:
                raise ValueError("未命中 xlsx 报表识别规则")
        else:
            raise ValueError(f"暂不支持的文件格式: {extension or 'unknown'}")

        return ReportRecognitionResponse(
            temp_file_id=temp_file_id,
            original_filename=original_filename,
            extension=extension,
            report_type=payload.report_type,  # type: ignore[arg-type]
            matched_columns=payload.matched_columns,
            reason=payload.reason,
            status="recognized",
            country=normalized_country,
            date_input_mode=payload.date_input_mode,  # type: ignore[arg-type]
            detected_date=payload.detected_date,
            detected_start_date=payload.detected_start_date,
            detected_end_date=payload.detected_end_date,
            project_match=payload.project_match
            or ReportProjectMatchSummary(status="manual"),
            row_count_preview=payload.row_count_preview,
            warnings=payload.warnings or [],
        )
    except Exception as exc:  # noqa: BLE001
        return ReportRecognitionResponse(
            temp_file_id=temp_file_id,
            original_filename=original_filename,
            extension=extension,
            report_type="unknown",
            matched_columns=[],
            reason=str(exc),
            status="error",
            country=normalized_country,
            date_input_mode="single_manual",
            project_match=ReportProjectMatchSummary(
                status="manual", message="未识别成功"
            ),
            warnings=[],
        )


def commit_report_upload(
    db: Session,
    settings: Settings,
    *,
    payload: ReportCommitRequest,
    operator: str | None = None,
    is_admin: bool = True,
) -> ReportCommitResponse:
    # Typed declarations so they can be referenced after the if/else branches
    recognition: ReportRecognitionResponse | None = None  # type: ignore[valid-type]
    project_match: ReportProjectMatchSummary | None = None
    report_type = normalize_report_type(payload.report_type)
    if report_type not in SUPPORTED_REPORT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported report_type: {report_type}",
        )

    country = _normalize_country(payload.country)
    raw_project_name = (payload.project_name or "").strip()

    # For auto-commit (project_name not provided), recognition runs first to derive the project.
    # For manual commit, project_name is validated upfront before recognition.
    is_auto_commit = not raw_project_name

    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(db, operator=operator, is_admin=is_admin)
    }

    # Auto-commit path: run recognition first to get the detected project, skip upfront project_name validation.
    # Manual commit path: validate project_name upfront, then re-use the recognition result below.
    if is_auto_commit:
        # Run recognition first so we can derive project_name from the result
        if report_type != "ad_search_term_report":
            auto_recognition = recognize_saved_report_upload(
                db,
                settings,
                temp_file_id=payload.temp_file_id,
                original_filename=(
                    payload.original_filename or payload.temp_file_id
                ).strip(),
                country=country,
                operator=operator,
                is_admin=is_admin,
            )
            if auto_recognition.status != "recognized":
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"文件识别失败，无法确认项目归属：{auto_recognition.reason}",
                )
            recognized_type = normalize_report_type(auto_recognition.report_type)
            if recognized_type != report_type:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="report_type does not match recognized report",
                )
            if report_type in {"sales_report", "inventory_report"} and auto_recognition.country != country:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"文件站点（{auto_recognition.country}）与所选站点（{country}）不一致，"
                        "请确认后重新上传到对应站点"
                    ),
                )
            auto_project_match = auto_recognition.project_match
            if auto_project_match.status != "matched" or not auto_project_match.project_name:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="文件未匹配到唯一项目，请先确认文件归属后再入库",
                )
            project_name = auto_project_match.project_name
            if project_name not in allowed_projects:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN, detail="无权限访问该项目"
                )
            # Re-use auto_recognition for the rest of the function
            recognition = auto_recognition
            project_match = auto_project_match

    # ── Manual commit path: project_name provided ───────────────────────────────
    else:
        project_name = raw_project_name
        if project_name not in allowed_projects:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="无权限访问该项目"
            )
        # File-level project validation: each committed file must match the selected project.
        if report_type != "ad_search_term_report":
            recognition = recognize_saved_report_upload(
                db,
                settings,
                temp_file_id=payload.temp_file_id,
                original_filename=(
                    payload.original_filename or payload.temp_file_id
                ).strip(),
                country=country,
                operator=operator,
                is_admin=is_admin,
            )
            if recognition.status != "recognized":
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"文件识别失败，无法确认项目归属：{recognition.reason}",
                )
            recognized_type = normalize_report_type(recognition.report_type)
            if recognized_type != report_type:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="report_type does not match recognized report",
                )
            if report_type in {"sales_report", "inventory_report"} and recognition.country != country:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"文件站点（{recognition.country}）与所选站点（{country}）不一致，"
                        "请确认后重新上传到对应站点"
                    ),
                )
            project_match = recognition.project_match
            if project_match.status != "matched" or not project_match.project_name:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="文件未匹配到唯一项目，请先确认文件归属后再入库",
                )
            if project_match.project_name != project_name:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=(
                        "文件匹配项目与当前选择不一致："
                        f"文件匹配为 {project_match.project_name}，当前选择为 {project_name}"
                    ),
                )

    original_filename = (
        payload.original_filename or ""
    ).strip() or payload.temp_file_id
    file_meta = upload_service.finalize_report_upload_temp_file(
        settings,
        temp_file_id=payload.temp_file_id,
        original_filename=original_filename,
        project_name=project_name,
        file_type=report_type,
    )

    persisted_source_id: int | None = None
    persisted_table: str | None = None
    response_status: str = "saved"
    message = "文件已保存"

    if report_type == "inventory_report":
        report_date = (payload.report_date or "").strip()
        if not report_date:
            recognized = _recognize_inventory_report(
                db, Path(str(file_meta["file_path"])), country=country
            )
            report_date = (recognized.detected_date or "").strip()
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        outcome = product_analysis_source_service.persist_single_analysis_source(
            db,
            project_name=project_name,
            report_type="inventory_report",
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            report_date=report_date,
            created_by=operator,
        )
        if not outcome.success:
            raise HTTPException(
                status_code=400, detail=outcome.error_message or "库存报表入库失败"
            )
        persisted_source_id = outcome.source_id
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        message = "库存报表已保存并写入库存源数据"
        # Invalidate daily-analysis cache so next query picks up the new data
        project = product_analysis_source_service._get_project_by_name(db, project_name)
        redis_service.invalidate_daily_analysis_cache(project.id)
    elif report_type == "business_report":
        report_date = (payload.report_date or "").strip()
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        outcome = product_analysis_source_service.persist_single_analysis_source(
            db,
            project_name=project_name,
            report_type="business_report",
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            report_date=report_date,
            report_start_date=report_date,
            report_end_date=report_date,
            created_by=operator,
        )
        if not outcome.success:
            raise HTTPException(
                status_code=400, detail=outcome.error_message or "业务报表入库失败"
            )
        persisted_source_id = outcome.source_id
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        message = "业务报表已保存并写入业务源数据"
        project = product_analysis_source_service._get_project_by_name(db, project_name)
        redis_service.invalidate_daily_analysis_cache(project.id)
    elif report_type == AD_PRODUCT_REPORT:
        report_date = (payload.report_date or "").strip()
        if not report_date:
            recognized = _recognize_ad_product_report(
                db, Path(str(file_meta["file_path"])), country=country
            )
            report_date = (recognized.detected_date or "").strip()
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        outcome = product_analysis_source_service.persist_single_analysis_source(
            db,
            project_name=project_name,
            report_type=AD_PRODUCT_REPORT,
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            report_date=report_date,
            report_start_date=report_date,
            report_end_date=report_date,
            created_by=operator,
        )
        if not outcome.success:
            raise HTTPException(
                status_code=400, detail=outcome.error_message or "广告报表入库失败"
            )
        persisted_source_id = outcome.source_id
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        message = "广告报表已保存并写入分析广告源数据"
        project = product_analysis_source_service._get_project_by_name(db, project_name)
        redis_service.invalidate_daily_analysis_cache(project.id)
    elif report_type == "sales_report":
        outcome = product_analysis_source_service.persist_sales_report_by_purchase_date(
            db,
            project_name=project_name,
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            created_by=operator,
        )
        if not outcome["success"]:
            raise HTTPException(
                status_code=400,
                detail=str(outcome.get("error_message") or "销售报表入库失败"),
            )
        persisted_source_id = outcome.get("latest_source_id")
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        payload.report_start_date = outcome.get("report_start_date")
        payload.report_end_date = outcome.get("report_end_date")
        message = (
            outcome.get("message") or "销售报表已按购买日期拆分并写入分析销售源数据"
        )
        project = product_analysis_source_service._get_project_by_name(db, project_name)
        redis_service.invalidate_daily_analysis_cache(project.id)
    elif report_type == "payment_report":
        start_date = (payload.report_start_date or "").strip()
        end_date = (payload.report_end_date or "").strip()
        if not start_date or not end_date:
            raise HTTPException(
                status_code=422,
                detail="report_start_date and report_end_date are required",
            )
        outcome = product_analysis_source_service.persist_single_analysis_source(
            db,
            project_name=project_name,
            report_type="payment_report",
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            report_start_date=start_date,
            report_end_date=end_date,
            created_by=operator,
        )
        if not outcome.success:
            raise HTTPException(
                status_code=400, detail=outcome.error_message or "付款报告入库失败"
            )
        persisted_source_id = outcome.source_id
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        message = "付款报告已保存并写入付款源数据"
        project = product_analysis_source_service._get_project_by_name(db, project_name)
        redis_service.invalidate_daily_analysis_cache(project.id)
    elif report_type == "ad_search_term_report":
        report_date = (payload.report_date or "").strip()
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        persisted_source_id = upsert_file_only_report_status(
            db,
            project_name=project_name,
            report_type="ad_search_term_report",
            report_date=report_date,
            country=country,
            file_id=str(file_meta["file_id"]),
            file_path=str(file_meta["file_path"]),
            original_filename=str(file_meta["original_filename"]),
            created_by=operator,
        )
        persisted_table = "report_upload_statuses"
        message = "搜索词报表已保存，本期不拆行落库"
    elif report_type == "return_report":
        # 退货报告使用独立的入库逻辑
        import app.services.return_analysis_service as return_analysis_service

        outcome = return_analysis_service.persist_return_report(
            db,
            project_name=project_name,
            country=country,
            file_path=str(file_meta["file_path"]),
            created_by=operator,
        )
        if not outcome["success"]:
            raise HTTPException(
                status_code=400,
                detail=str(outcome.get("error_message") or "退货报表入库失败"),
            )
        persisted_source_id = outcome.get("source_id")
        persisted_table = "return_analysis_records"
        response_status = "persisted"
        payload.report_start_date = outcome.get("report_start_date")
        payload.report_end_date = outcome.get("report_end_date")
        message = outcome.get("message") or "退货报表已保存并写入退货数据"

    return ReportCommitResponse(
        report_type=report_type,  # type: ignore[arg-type]
        status=response_status,  # type: ignore[arg-type]
        project_name=project_name,
        country=country,
        report_date=payload.report_date,
        report_start_date=payload.report_start_date,
        report_end_date=payload.report_end_date,
        file_id=str(file_meta["file_id"]),
        file_path=str(file_meta["file_path"]),
        persisted_source_id=persisted_source_id,
        persisted_table=persisted_table,
        message=message,
    )


def upsert_file_only_report_status(
    db: Session,
    *,
    project_name: str,
    report_type: str,
    report_date: str,
    country: str,
    file_id: str,
    file_path: str,
    original_filename: str,
    created_by: str | None,
) -> int:
    if report_type != "ad_search_term_report":
        raise ValueError(f"Unsupported file-only report_type: {report_type}")

    ReportUploadStatus.__table__.create(bind=db.get_bind(), checkfirst=True)
    project = product_analysis_source_service._get_project_by_name(db, project_name)  # noqa: SLF001
    target_date = product_analysis_source_service._parse_yyyy_mm_dd(
        report_date, "report_date"
    )  # noqa: SLF001
    row = (
        db.execute(
            select(ReportUploadStatus).where(
                ReportUploadStatus.project_id == project.id,
                ReportUploadStatus.report_type == report_type,
                ReportUploadStatus.country == country,
                ReportUploadStatus.report_date == target_date,
            )
        )
        .scalars()
        .first()
    )
    if row is None:
        row = ReportUploadStatus(
            project_id=project.id,
            report_type=report_type,
            country=country,
            report_date=target_date,
            upload_file_id=file_id,
            upload_file_path=file_path,
            original_filename=original_filename,
            stored_filename=file_id,
            file_size_bytes=Path(file_path).stat().st_size
            if Path(file_path).exists()
            else None,
            created_by=(created_by or "").strip()[:255] or None,
        )
        db.add(row)
    else:
        row.upload_file_id = file_id
        row.upload_file_path = file_path
        row.original_filename = original_filename
        row.stored_filename = file_id
        row.file_size_bytes = (
            Path(file_path).stat().st_size if Path(file_path).exists() else None
        )
        row.created_by = (created_by or "").strip()[:255] or row.created_by

    db.commit()
    db.refresh(row)
    return int(row.id)


def _status_cell(
    *,
    report_type: str,
    status: str = "missing",
    display_date: str | None = None,
    report_start_date: str | None = None,
    report_end_date: str | None = None,
    source_table: str | None = None,
    updated_at: datetime | None = None,
    original_filename: str | None = None,
    message: str | None = None,
) -> ReportStatusCell:
    return ReportStatusCell(
        report_type=report_type,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        display_date=display_date,
        report_start_date=report_start_date,
        report_end_date=report_end_date,
        source_table=source_table,
        updated_at=updated_at.isoformat(timespec="seconds") if updated_at else None,
        original_filename=original_filename,
        message=message,
    )


def list_report_upload_statuses(
    db: Session,
    *,
    report_date: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
    country: str = "US",
) -> ReportStatusResponse:
    projects = project_service.list_project_items(
        db, operator=operator, is_admin=is_admin
    )
    project_map = {int(project.id): project.project_name for project in projects}
    project_sort_orders = {int(project.id): project.sort_order for project in projects}
    normalized_country = _normalize_country(country)
    if not project_map:
        return ReportStatusResponse(country=normalized_country, items=[])

    project_ids = list(project_map.keys())
    eligible_project_names = {
        str(name)
        for name in db.execute(
            select(ProductCost.project_name)
            .where(ProductCost.country == normalized_country)
            .where(ProductCost.is_active.is_(True))
            .distinct()
        )
        .scalars()
        .all()
        if name
    }
    if eligible_project_names:
        project_ids = [
            project_id
            for project_id in project_ids
            if project_map[project_id] in eligible_project_names
        ]
    else:
        project_ids = []
    target_report_date: date | None = None
    if report_date:
        try:
            target_report_date = datetime.strptime(report_date, "%Y-%m-%d").date()
        except ValueError as error:
            raise HTTPException(
                status_code=400, detail="report_date must be YYYY-MM-DD"
            ) from error

    analysis_stmt = (
        select(AnalysisSourceFile)
        .where(AnalysisSourceFile.project_id.in_(project_ids))
        .where(AnalysisSourceFile.country == normalized_country)
    )
    if target_report_date is not None:
        analysis_stmt = analysis_stmt.where(
            (AnalysisSourceFile.report_date == target_report_date)
            | (
                (AnalysisSourceFile.report_type == "payment_report")
                & (AnalysisSourceFile.report_date.is_(None))
                & (AnalysisSourceFile.period_start_date.is_not(None))
                & (AnalysisSourceFile.period_end_date.is_not(None))
                & (AnalysisSourceFile.period_start_date <= target_report_date)
                & (AnalysisSourceFile.period_end_date >= target_report_date)
            )
        )
        analysis_stmt = analysis_stmt.order_by(
            AnalysisSourceFile.updated_at.desc(),
            AnalysisSourceFile.id.desc(),
        )
    else:
        analysis_stmt = analysis_stmt.where(AnalysisSourceFile.is_current.is_(True))
    analysis_rows = db.execute(analysis_stmt).scalars().all()
    file_only_rows: list[ReportUploadStatus] = []
    try:
        if inspect(db.get_bind()).has_table("report_upload_statuses"):
            file_only_stmt = (
                select(ReportUploadStatus)
                .where(ReportUploadStatus.project_id.in_(project_ids))
                .where(ReportUploadStatus.country == normalized_country)
            )
            if target_report_date is not None:
                file_only_stmt = file_only_stmt.where(
                    ReportUploadStatus.report_date == target_report_date
                )
            file_only_rows = db.execute(file_only_stmt).scalars().all()
    except ProgrammingError:
        db.rollback()
        file_only_rows = []

    status_by_project: dict[int, dict[str, ReportStatusCell]] = {
        project_id: {
            report_type: _status_cell(report_type=report_type)
            for report_type in STATUS_REPORT_TYPES
        }
        for project_id in project_ids
    }

    seen_status_keys: set[tuple[int, str]] = set()
    for row in analysis_rows:
        status_key = (int(row.project_id), str(row.report_type))
        if status_key in seen_status_keys:
            continue
        seen_status_keys.add(status_key)
        display_date = (
            (target_report_date or row.report_date or row.period_end_date).isoformat()
            if (target_report_date or row.report_date or row.period_end_date)
            else None
        )
        is_period_match = (
            target_report_date is not None
            and row.report_type == "payment_report"
            and row.report_date is None
            and row.period_start_date is not None
            and row.period_end_date is not None
            and row.period_start_date <= target_report_date <= row.period_end_date
        )
        message = (
            "历史周期数据已入库"
            if is_period_match
            else ("当日已入库" if target_report_date is not None else "当前版本")
        )
        status_by_project[int(row.project_id)][row.report_type] = _status_cell(
            report_type=row.report_type,
            status="available",
            display_date=display_date,
            report_start_date=(row.report_date or row.period_start_date).isoformat()
            if (row.report_date or row.period_start_date)
            else None,
            report_end_date=(row.report_date or row.period_end_date).isoformat()
            if (row.report_date or row.period_end_date)
            else None,
            source_table="analysis_source_files",
            updated_at=row.updated_at,
            original_filename=row.original_filename,
            message=message,
        )

    for row in file_only_rows:
        display_date = row.report_date.isoformat()
        status_by_project[int(row.project_id)][row.report_type] = _status_cell(
            report_type=row.report_type,
            status="saved_only",
            display_date=display_date,
            report_start_date=display_date,
            report_end_date=display_date,
            source_table="report_upload_statuses",
            updated_at=row.updated_at,
            original_filename=row.original_filename,
            message="当日仅保存文件，未拆分明细"
            if target_report_date is not None
            else "仅保存文件，未拆分明细",
        )

    items = [
        ProjectReportStatusItem(
            project_id=project_id,
            project_name=project_map[project_id],
            statuses=status_by_project[project_id],
        )
        for project_id in sorted(project_ids, key=lambda item: (project_sort_orders.get(item, 0), project_map[item]))
    ]
    return ReportStatusResponse(country=normalized_country, items=items)
