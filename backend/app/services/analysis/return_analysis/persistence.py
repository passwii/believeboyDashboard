"""DB persistence logic for return reports.

Writes to ``analysis_return_rows`` via ``INSERT ON CONFLICT DO UPDATE``
on the ``uq_return_event`` unique constraint, matching the autoReportUpload
pipeline.  The old ``return_analysis_records`` table is no longer used for
new writes.

Row parsing is delegated to ``app.utils.parsers.parse_return_rows`` — the
single source of truth shared with ``autoReportUpload.processor``.
"""
from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

# BLF-1036: pandas imported lazily (boot chain: endpoints.return_analysis);
# only _build_sub_dataframe needs it at runtime.
if TYPE_CHECKING:
    import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models import AnalysisReturnRow, AnalysisSalesOrderRow, AnalysisSourceFile, Project
from app.services.analysis.return_analysis.models import _convert_to_us_date
from app.services.analysis.return_analysis.parsers import (
    _read_csv_with_encoding_fallback,
)
from app.utils.parsers import parse_return_rows
from app.utils.persist_helpers import (
    next_version,
    replace_current_pointer,
    write_report_upload_log,
)


def persist_return_report(
    db: Session,
    *,
    project_name: str,
    country: str,
    file_path: str,
    created_by: str | None = None,
    detected_countries: list[str] | None = None,
) -> dict[str, Any]:
    """Parse and persist a return report into analysis_return_rows.

    Supports European mixed reports: when ``detected_countries`` contains
    multiple countries (e.g. ['DE', 'UK']), the file is assumed to contain a
    mix of returns with no explicit country column. We look up each
    ``order-id`` against ``analysis_sales_order_rows`` to determine the
    marketplace country, then split the file and persist one source file per
    detected country.

    Uses ON CONFLICT DO UPDATE on uq_return_event so re-uploads of the same
    return event update metadata rather than creating duplicates.

    Returns:
        dict with keys: success, source_id, report_start_date,
        report_end_date, message / error_message
    """
    try:
        original_filename = Path(file_path).name
        project = db.execute(
            Project.__table__.select().where(Project.project_name == project_name)
        ).fetchone()
        if not project:
            return {"success": False, "error_message": f"项目 {project_name} 不存在"}
        project_id = project.id

        df = _read_csv_with_encoding_fallback(file_path)
        df.columns = [str(col).strip() for col in df.columns]

        required_cols = ["return-date", "sku"]
        missing = [c for c in required_cols if c not in df.columns]
        if missing:
            return {"success": False, "error_message": f"缺少必要字段: {missing}"}

        # -- Multi-country mixed report: split by order-id lookup ------------
        if detected_countries and len(detected_countries) > 1:
            return _persist_mixed_return_report(
                db,
                project_id=project_id,
                project_name=project_name,
                file_path=file_path,
                df=df,
                detected_countries=detected_countries,
                created_by=created_by,
            )

        # -- Single-country report (existing behaviour) ------------------------
        return _persist_single_country_return_report(
            db,
            project_id=project_id,
            project_name=project_name,
            country=country,
            file_path=file_path,
            df=df,
            created_by=created_by,
        )

    except Exception as e:
        db.rollback()
        return {"success": False, "error_message": str(e)}


def _persist_mixed_return_report(
    db: Session,
    *,
    project_id: int,
    project_name: str,
    file_path: str,
    df: pd.DataFrame,
    detected_countries: list[str],
    created_by: str | None = None,
) -> dict[str, Any]:
    """Split a mixed-country return report by order-id lookup and persist per country."""
    try:
        parsed_rows, _ = parse_return_rows(df)
    except ValueError as exc:
        return {"success": False, "error_message": str(exc)}

    if not parsed_rows:
        return {"success": True, "message": "无有效退货记录"}

    # Collect order-ids for lookup
    order_ids = [p["order_id"] for p in parsed_rows if p.get("order_id")]
    order_ids = list(set(order_ids))

    # Query sales orders to map order-id -> country.
    # AnalysisSalesOrderRow does not have a project_id column; we join through
    # AnalysisSourceFile to scope the lookup to the current project.
    order_to_country: dict[str, str] = {}
    if order_ids:
        rows = db.execute(
            select(AnalysisSalesOrderRow.amazon_order_id, AnalysisSalesOrderRow.country)
            .join(AnalysisSourceFile, AnalysisSalesOrderRow.source_file_id == AnalysisSourceFile.id)
            .where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSalesOrderRow.amazon_order_id.in_(order_ids),
            )
            .distinct()
        ).all()
        for amazon_order_id, sales_country in rows:
            if amazon_order_id not in order_to_country:
                order_to_country[amazon_order_id] = sales_country

    # Fallback: for unmatched order-ids, infer country from Amazon order-id prefix.
    # 0xx → UK, 3xx → DE, 1xx → US. This is less reliable than DB lookup
    # (e.g. 028-xxx can be German), so we only use it as fallback.
    _PREFIX_TO_COUNTRY = {
        **{p: "UK" for p in range(0, 100)},
        **{p: "DE" for p in range(300, 400)},
        **{p: "US" for p in range(100, 200)},
    }
    for parsed in parsed_rows:
        oid = parsed.get("order_id", "")
        if oid not in order_to_country:
            first = oid.split("-")[0] if "-" in oid else ""
            if first:
                try:
                    prefix = int(first)
                    if prefix in _PREFIX_TO_COUNTRY:
                        country = _PREFIX_TO_COUNTRY[prefix]
                        if country in detected_countries:
                            order_to_country[oid] = country
                except ValueError:
                    pass

    # Group parsed rows by detected country.
    # Unmatched rows are dropped rather than falling back to a default country,
    # ensuring we never attribute a return to the wrong marketplace.
    grouped: dict[str, list[dict[str, Any]]] = {}
    unmatched_orders: list[str] = []
    for parsed in parsed_rows:
        oid = parsed.get("order_id", "")
        detected_country = order_to_country.get(oid)
        if detected_country and detected_country in detected_countries:
            grouped.setdefault(detected_country, []).append(parsed)
        else:
            unmatched_orders.append(oid)

    # Persist each country subgroup
    results: list[dict[str, Any]] = []
    all_source_ids: list[int] = []
    total_rows = 0

    for sub_country, sub_parsed_rows in grouped.items():
        sub_df = _build_sub_dataframe(df, sub_parsed_rows)
        result = _persist_single_country_return_report(
            db,
            project_id=project_id,
            project_name=project_name,
            country=sub_country,
            file_path=file_path,
            df=sub_df,
            created_by=created_by,
        )
        if not result.get("success"):
            return result
        results.append(result)
        if result.get("source_id"):
            all_source_ids.append(result["source_id"])
        total_rows += result.get("row_count", 0)

    # Build summary message
    country_details = ", ".join(
        f"{c}: {len(r)}条" for c, r in grouped.items()
    )
    warning_msg = ""
    if unmatched_orders:
        unique_unmatched = len(set(unmatched_orders))
        warning_msg = f"（其中 {unique_unmatched} 条订单未在 sales 中找到匹配，已丢弃）"

    # Return first source_id as primary, plus list of all
    first_result = results[0] if results else {}
    return {
        "success": True,
        "source_id": first_result.get("source_id"),
        "source_ids": all_source_ids,
        "row_count": total_rows,
        "report_start_date": first_result.get("report_start_date"),
        "report_end_date": first_result.get("report_end_date"),
        "message": f"退货报表已按国家拆分入库：{country_details}{warning_msg}",
    }


def _build_sub_dataframe(
    original_df: pd.DataFrame,
    parsed_rows: list[dict[str, Any]],
) -> pd.DataFrame:
    """Build a sub-DataFrame containing only rows that match the given parsed rows.

    We match by order-id and return-date since those are the natural keys.
    """
    import pandas as pd

    if not parsed_rows:
        return original_df.iloc[0:0]  # Empty df with same columns

    # Build a set of (order_id, return_date_raw) for matching
    target_keys = set()
    for p in parsed_rows:
        raw_dt = p.get("return_date_raw")
        dt_str = raw_dt.isoformat() if raw_dt else ""
        target_keys.add((p.get("order_id", ""), dt_str))

    mask = []
    for _, row in original_df.iterrows():
        oid = str(row.get("order-id", "")).strip()
        dt = str(row.get("return-date", "")).strip()
        # Parse the date to UTC isoformat for comparison
        try:
            parsed_dt = pd.to_datetime(dt, utc=True)
            dt_iso = parsed_dt.isoformat()
        except Exception:
            dt_iso = dt
        mask.append((oid, dt_iso) in target_keys)

    return original_df[mask].copy()


def _persist_single_country_return_report(
    db: Session,
    *,
    project_id: int,
    project_name: str,
    country: str,
    file_path: str,
    df: pd.DataFrame,
    created_by: str | None = None,
) -> dict[str, Any]:
    """Persist a return report for a single country.

    This is the original persist logic extracted into a helper so that
    European mixed reports can reuse it per-country.
    """
    original_filename = Path(file_path).name
    now = datetime.now(UTC)
    upload_date = now.date()

    # -- Parse CSV rows FIRST so we know the report's actual data span -----
    # BEL-127: ``period_start_date`` / ``period_end_date`` must reflect the
    # CSV's return-date range, NOT the upload date. ``return_report`` is in
    # ``PERIODIC_REPORT_TYPES`` and ``replace_current_pointer`` /
    # ``next_version`` are scoped on period — using ``upload_date`` caused
    # two uploads of non-overlapping date ranges to collide on the same
    # (project, type, country, period) slot and silently overwrite each
    # other.
    try:
        parsed_rows, raw_datetimes = parse_return_rows(df)
    except ValueError as exc:
        return {"success": False, "error_message": str(exc)}

    # Compute the period from the parsed return-date range. Empty CSV
    # (no rows) falls back to ``upload_date`` so the source_file still
    # has a valid period key — match the convention used by the other
    # PERIODIC report persistence paths (see
    # ``autoReportUpload/processor.py:_persist_single_source``).
    #
    # NB: ``_convert_to_us_date`` returns a ``"%Y-%m-%d"`` STRING — we
    # convert back to ``date`` so SQLAlchemy binds ``Date`` correctly
    # when ``next_version`` / ``replace_current_pointer`` compare on
    # ``period_start_date`` / ``period_end_date``.
    all_us_dates: list[date] = []
    for parsed in parsed_rows:
        raw_dt = parsed["return_date_raw"]
        iso_str = _convert_to_us_date(raw_dt)
        all_us_dates.append(date.fromisoformat(iso_str))

    period_start = min(all_us_dates) if all_us_dates else upload_date
    period_end = max(all_us_dates) if all_us_dates else upload_date

    # -- Create AnalysisSourceFile ------------------------------------------
    version = next_version(
        db,
        project_id=project_id,
        report_type="return_report",
        country=country,
        period_start_date=period_start,
        period_end_date=period_end,
    )
    file_id = f"{uuid.uuid4().hex}_{original_filename}"
    source = AnalysisSourceFile(
        project_id=project_id,
        report_type="return_report",
        country=country,
        report_date=None,
        period_start_date=period_start,
        period_end_date=period_end,
        snapshot_at=None,
        version=version,
        is_current=False,
        superseded_at=None,
        upload_file_id=file_id,
        upload_file_path=file_path,
        original_filename=original_filename,
        stored_filename=file_id,
        logical_filename=f"{project_name}_return_report_{period_start}_v{version}",
        storage_key=f"web_upload/return_report/{project_id}/{period_start}/{version}/{file_id}",
        file_size_bytes=Path(file_path).stat().st_size,
        file_sha256=None,
        ingestion_status="running",
        row_count_total=0,
        row_count_included=0,
        created_by=created_by,
    )
    db.add(source)
    db.flush()

    rows: list[dict] = []

    for idx, parsed in enumerate(parsed_rows):
        raw_dt = parsed["return_date_raw"]
        us_date = _convert_to_us_date(raw_dt)

        row_dict = {
            "project_id": project_id,
            "country": country,
            "source_file_id": source.id,
            "source_row_no": idx + 1,
            "return_date": us_date,
        }
        for k, v in parsed.items():
            if k != "return_date_raw":
                row_dict[k] = v
        rows.append(row_dict)

    # -- Upsert with ON CONFLICT DO UPDATE ----------------------------------
    if rows:
        stmt = pg_insert(AnalysisReturnRow).values(rows)
        stmt = stmt.on_conflict_do_update(
            constraint="uq_return_event",
            set_={
                "return_date": stmt.excluded.return_date,
                "license_plate_number": stmt.excluded.license_plate_number,
                "status": stmt.excluded.status,
                "reason": stmt.excluded.reason,
                "detailed_disposition": stmt.excluded.detailed_disposition,
                "source_file_id": stmt.excluded.source_file_id,
                "source_row_no": stmt.excluded.source_row_no,
                "asin": stmt.excluded.asin,
                "fnsku": stmt.excluded.fnsku,
                "product_name": stmt.excluded.product_name,
                "quantity": stmt.excluded.quantity,
                "fulfillment_center_id": stmt.excluded.fulfillment_center_id,
                "original_return_datetime": stmt.excluded.original_return_datetime,
                "customer_comments": stmt.excluded.customer_comments,
                "raw_row": stmt.excluded.raw_row,
            },
        )
        db.execute(stmt)

    # -- Finalize source file -----------------------------------------------
    source.row_count_total = len(rows)
    source.row_count_included = len(rows)
    source.ingestion_status = "success"

    replace_current_pointer(db, source)
    source.is_current = True
    source.superseded_at = None
    db.flush()

    # -- Upload log ---------------------------------------------------------
    write_report_upload_log(
        db,
        project_id=project_id,
        country=country,
        report_type="return_report",
        upload_date=upload_date,
        source_file_id=source.id,
        has_real_data=len(rows) > 0,
        row_count=len(rows),
        original_filename=original_filename,
    )
    db.commit()

    report_start_date = min(all_us_dates) if all_us_dates else None
    report_end_date = max(all_us_dates) if all_us_dates else None

    return {
        "success": True,
        "source_id": source.id,
        "row_count": len(rows),
        "report_start_date": report_start_date,
        "report_end_date": report_end_date,
        "message": f"成功入库 {len(rows)} 条退货记录" if rows else "无有效退货记录",
    }


__all__ = [
    "persist_return_report",
]
