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
from typing import Any

import pandas as pd
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models import AnalysisReturnRow, AnalysisSourceFile, Project
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
) -> dict[str, Any]:
    """Parse and persist a return report into analysis_return_rows.

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

        now = datetime.now(UTC)
        upload_date = now.date()

        # -- Create AnalysisSourceFile ------------------------------------------
        version = next_version(
            db,
            project_id=project_id,
            report_type="return_report",
            country=country,
            period_start_date=upload_date,
            period_end_date=upload_date,
        )
        file_id = f"{uuid.uuid4().hex}_{original_filename}"
        source = AnalysisSourceFile(
            project_id=project_id,
            report_type="return_report",
            country=country,
            report_date=None,
            period_start_date=upload_date,
            period_end_date=upload_date,
            snapshot_at=None,
            version=version,
            is_current=False,
            superseded_at=None,
            upload_file_id=file_id,
            upload_file_path=file_path,
            original_filename=original_filename,
            stored_filename=file_id,
            logical_filename=f"{project_name}_return_report_{upload_date}_v{version}",
            storage_key=f"web_upload/return_report/{project_id}/{upload_date}/{version}/{file_id}",
            file_size_bytes=Path(file_path).stat().st_size,
            file_sha256=None,
            ingestion_status="running",
            row_count_total=0,
            row_count_included=0,
            created_by=created_by,
        )
        db.add(source)
        db.flush()

        # -- Parse CSV rows (delegated to shared parser) ----------------------
        try:
            parsed_rows, raw_datetimes = parse_return_rows(df)
        except ValueError as exc:
            return {"success": False, "error_message": str(exc)}

        all_us_dates: list[date] = []
        rows: list[dict] = []

        for idx, parsed in enumerate(parsed_rows):
            raw_dt = parsed["return_date_raw"]
            us_date = _convert_to_us_date(raw_dt)
            all_us_dates.append(us_date)

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

    except Exception as e:
        db.rollback()
        return {"success": False, "error_message": str(e)}


__all__ = [
    "persist_return_report",
]
