"""DB persistence logic for return reports.

Extracted from return_analysis_service.py (phase 5 of backend refactor plan).
"""
from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from typing import Any

import pandas as pd
from sqlalchemy.orm import Session

from app.models import Project, ReturnAnalysisRecord, ReturnCustomerComment
from app.services.analysis.return_analysis.models import _convert_to_us_date, _split_customer_comments
from app.services.analysis.return_analysis.parsers import _parse_iso_datetime_with_timezone, _read_csv_with_encoding_fallback


def persist_return_report(
    db: Session,
    *,
    project_name: str,
    country: str,
    file_path: str,
    created_by: str | None = None,
) -> dict[str, Any]:
    """
    Parse and persist a return report.

    Returns:
        dict with keys: success (bool), source_id (int), report_start_date,
        report_end_date, message
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

        all_us_dates = []

        new_records_data = []
        for _, row in df.iterrows():
            original_dt_str = str(row.get("return-date", "")).strip()
            original_dt = _parse_iso_datetime_with_timezone(original_dt_str)
            if original_dt is None:
                continue

            us_date = _convert_to_us_date(original_dt)
            all_us_dates.append(us_date)

            order_id = str(row.get("order-id", "")).strip()
            sku = str(row.get("sku", "")).strip()
            asin = str(row.get("asin", "")) if pd.notna(row.get("asin")) else None
            fnsku = str(row.get("fnsku", "")) if pd.notna(row.get("fnsku")) else None
            product_name = (
                str(row.get("product-name", "")) if pd.notna(row.get("product-name")) else None
            )
            quantity = int(row.get("quantity", 1)) if pd.notna(row.get("quantity")) else 1
            fulfillment_center_id = (
                str(row.get("fulfillment-center-id", ""))
                if pd.notna(row.get("fulfillment-center-id"))
                else None
            )
            detailed_disposition = str(row.get("detailed-disposition", "")).strip()
            reason = str(row.get("reason", "")).strip()
            status = str(row.get("status", "")).strip()
            license_plate = (
                str(row.get("license-plate-number", ""))
                if pd.notna(row.get("license-plate-number"))
                else None
            )
            customer_comments = (
                str(row.get("customer-comments", ""))
                if pd.notna(row.get("customer-comments"))
                else ""
            )

            new_records_data.append(
                {
                    "project_id": project_id,
                    "country": country,
                    "return_date": us_date,
                    "order_id": order_id,
                    "sku": sku,
                    "asin": asin,
                    "fnsku": fnsku,
                    "product_name": product_name,
                    "quantity": quantity,
                    "fulfillment_center_id": fulfillment_center_id,
                    "detailed_disposition": detailed_disposition,
                    "reason": reason,
                    "status": status,
                    "license_plate_number": license_plate,
                    "original_return_datetime": original_dt_str,
                    "customer_comments": customer_comments,
                }
            )

        if not new_records_data:
            marker_date = (
                all_us_dates[0]
                if all_us_dates
                else date.today().isoformat()
            )
            existing = db.execute(
                ReturnAnalysisRecord.__table__.select().where(
                    ReturnAnalysisRecord.project_id == project_id,
                    ReturnAnalysisRecord.country == country,
                    ReturnAnalysisRecord.return_date == marker_date,
                    ReturnAnalysisRecord.order_id == "__MARKER__",
                )
            ).fetchone()
            if existing:
                return {
                    "success": True,
                    "source_id": existing.id,
                    "report_start_date": None,
                    "report_end_date": None,
                    "message": "无有效退货记录，已记录空上传",
                }
            marker = ReturnAnalysisRecord(
                project_id=project_id,
                country=country,
                return_date=marker_date,
                order_id="__MARKER__",
                sku="__MARKER__",
                asin=None,
                fnsku=None,
                product_name=None,
                quantity=0,
                fulfillment_center_id=None,
                detailed_disposition="__MARKER__",
                reason="__MARKER__",
                status="__MARKER__",
                license_plate_number=None,
                original_return_datetime="1970-01-01T00:00:00+00:00",
                is_current=True,
            )
            db.add(marker)
            db.commit()
            from app.models.report_upload_log import ReportUploadLog
            db.add(ReportUploadLog(
                project_id=project_id,
                report_type="return_report",
                country=country,
                upload_date=date.today(),
                has_real_data=False,
                row_count=0,
                source_file_id=None,
                original_filename=original_filename,
            ))
            db.commit()
            return {
                "success": True,
                "source_id": marker.id,
                "report_start_date": None,
                "report_end_date": None,
                "message": "无有效退货记录，已记录空上传",
            }

        seen_record_keys: set[tuple[Any, ...]] = set()

        inserted_ids = []
        for record_data in new_records_data:
            comments_text = record_data.pop("customer_comments")
            dedupe_key = (
                record_data["project_id"],
                record_data["country"],
                record_data["return_date"],
                record_data["order_id"],
                record_data["sku"],
                record_data["asin"],
                record_data["fnsku"],
                record_data["product_name"],
                record_data["quantity"],
                record_data["fulfillment_center_id"],
                record_data["detailed_disposition"],
                record_data["reason"],
                record_data["status"],
                record_data["license_plate_number"],
                record_data["original_return_datetime"],
                comments_text,
            )
            if dedupe_key in seen_record_keys:
                continue
            seen_record_keys.add(dedupe_key)

            record = ReturnAnalysisRecord(**record_data)
            db.add(record)
            db.flush()

            comment_parts = _split_customer_comments(comments_text)
            for comment_text in comment_parts:
                comment_record = ReturnCustomerComment(
                    return_record_id=record.id,
                    sku=record_data["sku"],
                    order_id=record_data["order_id"],
                    customer_comment=comment_text,
                )
                db.add(comment_record)

            inserted_ids.append(record.id)

        db.commit()

        from app.models.report_upload_log import ReportUploadLog
        db.add(ReportUploadLog(
            project_id=project_id,
            report_type="return_report",
            country=country,
            upload_date=date.today(),
            has_real_data=len(inserted_ids) > 0,
            row_count=len(inserted_ids),
            source_file_id=None,
            original_filename=original_filename,
        ))
        db.commit()

        report_start_date = min(all_us_dates) if all_us_dates else None
        report_end_date = max(all_us_dates) if all_us_dates else None

        return {
            "success": True,
            "source_id": inserted_ids[0] if inserted_ids else None,
            "report_start_date": report_start_date,
            "report_end_date": report_end_date,
            "message": f"成功入库 {len(inserted_ids)} 条退货记录",
        }

    except Exception as e:
        db.rollback()
        return {"success": False, "error_message": str(e)}


__all__ = [
    "persist_return_report",
]
