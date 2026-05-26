from __future__ import annotations

import io
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.inspection import InspectionPeriod, InspectionReport, InspectionScreenshot
from app.models.project import Project
from app.services.r2_service import (
    delete_file_from_r2,
    generate_presigned_url,
    upload_bytes_to_r2,
)
from app.services.upload_service import _safe_project_folder_name

_TZ_CN = timezone(timedelta(hours=8))

THRESHOLDS: list[dict[str, Any]] = [
    {"metric": "inspection_negative_feedback", "key": "negative_feedback", "source": "health_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_a2z_claims", "key": "a2z_claims", "source": "health_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_chargeback_claims", "key": "chargeback_claims", "source": "health_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_late_shipment", "key": "late_shipment_rate", "source": "health_data", "direction": "above", "warning": 2.0, "critical": 4.0},
    {"metric": "inspection_vtr", "key": "valid_tracking_rate", "source": "health_data", "direction": "below", "warning": 97.0, "critical": 95.0},
    {"metric": "inspection_on_time_delivery", "key": "on_time_delivery_rate", "source": "health_data", "direction": "below", "warning": 97.0, "critical": 95.0},
    {"metric": "inspection_ip_infringement", "key": "ip_infringement", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_ip_complaints", "key": "ip_complaints", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_product_authenticity", "key": "product_authenticity_complaints", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_product_condition", "key": "product_condition_complaints", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_food_safety", "key": "food_product_safety", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_listing_violations", "key": "listing_policy_violations", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_restricted_product", "key": "restricted_product_violations", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_review_violations", "key": "review_policy_violations", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_other_violations", "key": "other_policy_violations", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
    {"metric": "inspection_regulatory", "key": "regulatory_compliance", "source": "compliance_data", "direction": "above", "warning": 1, "critical": 3},
]

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024
_COMPRESS_MAX_WIDTH = 1920
_COMPRESS_QUALITY = 80
_THUMB_MAX_WIDTH = 320
_THUMB_QUALITY = 70


def _compute_week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def get_or_create_current_period(db: Session) -> InspectionPeriod:
    today = datetime.now(_TZ_CN).date()
    week_start = _compute_week_start(today)

    period = db.execute(
        select(InspectionPeriod).where(InspectionPeriod.week_start == week_start),
    ).scalar_one_or_none()

    if period:
        return period

    week_end = week_start + timedelta(days=6)
    deadline = datetime(
        week_end.year, week_end.month, week_end.day, 9, 0, 0, tzinfo=_TZ_CN,
    ) + timedelta(days=1)

    period = InspectionPeriod(week_start=week_start, week_end=week_end, deadline=deadline)
    db.add(period)
    db.commit()
    db.refresh(period)
    return period


def get_period(db: Session, period_id: int) -> InspectionPeriod | None:
    return db.get(InspectionPeriod, period_id)


def list_periods(
    db: Session, limit: int = 20, offset: int = 0,
) -> tuple[list[InspectionPeriod], int]:
    total = db.execute(
        select(func.count()).select_from(InspectionPeriod),
    ).scalar_one()

    items = list(db.execute(
        select(InspectionPeriod)
        .order_by(InspectionPeriod.week_start.desc())
        .limit(limit)
        .offset(offset),
    ).scalars().all())

    return items, total


def get_overview(
    db: Session, period_id: int, settings: Settings,
    operator: str | None = None, is_admin: bool = True,
) -> dict:
    period = db.get(InspectionPeriod, period_id)
    if not period:
        return {"period": None, "items": [], "counts": {}}

    now = datetime.now(_TZ_CN)
    past_deadline = now >= period.deadline

    if past_deadline:
        mark_overdue_reports(db, period)

    # 根据权限过滤项目
    from app.services.project_service import list_project_items
    projects = list_project_items(db, operator=operator, is_admin=is_admin)

    reports = list(db.execute(
        select(InspectionReport).where(InspectionReport.period_id == period_id),
    ).scalars().all())
    report_map: dict[int, InspectionReport] = {r.project_id: r for r in reports}

    items: list[dict[str, Any]] = []
    counts = {"submitted": 0, "overdue": 0, "draft": 0, "pending": 0}

    for proj in projects:
        report = report_map.get(proj.id)
        if report and report.status == "submitted":
            status = "submitted"
        elif report and report.status == "overdue":
            status = "overdue"
        elif report:
            status = "draft"
        else:
            status = "overdue" if past_deadline else "pending"
        counts[status] += 1
        health = (report.health_data or {}) if report else {}
        compliance = (report.compliance_data or {}) if report else {}

        # Build screenshots with presigned URLs (thumbnail for grid, original for preview)
        screenshots_list = []
        if report and report.screenshots:
            for s in report.screenshots[:4]:  # Limit to 4 for preview
                screenshots_list.append({
                    "id": s.id,
                    "url": generate_presigned_url(settings, s.r2_key),
                    "thumbnail_url": generate_presigned_url(settings, s.thumbnail_key) if s.thumbnail_key else None,
                    "caption": s.caption,
                })

        items.append({
            "project_id": proj.id,
            "project_name": proj.project_name,
            "status": status,
            "account_health_rating": health.get("account_health_rating"),
            "negative_feedback": health.get("negative_feedback"),
            "a2z_claims": health.get("a2z_claims"),
            "chargeback_claims": health.get("chargeback_claims"),
            "late_shipment_rate": health.get("late_shipment_rate"),
            "valid_tracking_rate": health.get("valid_tracking_rate"),
            "on_time_delivery_rate": health.get("on_time_delivery_rate"),
            "compliance_total": sum(
                compliance.get(k, 0) or 0
                for k in (
                    "ip_infringement", "ip_complaints", "product_authenticity_complaints",
                    "product_condition_complaints", "food_product_safety",
                    "listing_policy_violations", "restricted_product_violations",
                    "review_policy_violations", "other_policy_violations", "regulatory_compliance",
                )
            ) if compliance else None,
            "status_summary": report.status_summary if report else None,
            "submitted_by": report.submitted_by if report else None,
            "submitted_at": report.submitted_at if report and report.submitted_at else None,
            "screenshots": screenshots_list,
        })

    return {
        "period": {
            "id": period.id,
            "week_start": period.week_start,
            "week_end": period.week_end,
            "deadline": period.deadline,
            "created_at": period.created_at,
        },
        "items": items,
        "counts": counts,
    }


def get_report(
    db: Session, period_id: int, project_id: int, settings: Settings,
) -> InspectionReport | None:
    report = db.execute(
        select(InspectionReport).where(
            InspectionReport.period_id == period_id,
            InspectionReport.project_id == project_id,
        ),
    ).scalar_one_or_none()

    if report and report.screenshots:
        for s in report.screenshots:
            s._presigned_url = generate_presigned_url(settings, s.r2_key)

    return report


def create_or_update_report(
    db: Session,
    period_id: int,
    project_id: int,
    data: dict[str, Any],
    operator: str | None,
) -> InspectionReport:
    report = db.execute(
        select(InspectionReport).where(
            InspectionReport.period_id == period_id,
            InspectionReport.project_id == project_id,
        ),
    ).scalar_one_or_none()

    if not report:
        report = InspectionReport(
            period_id=period_id,
            project_id=project_id,
            status="draft",
        )
        db.add(report)
        db.flush()

    if "health_data" in data:
        report.health_data = data["health_data"]
    if "compliance_data" in data:
        report.compliance_data = data["compliance_data"]
    if "status_summary" in data:
        report.status_summary = data["status_summary"]

    screenshot_ids = data.get("screenshot_ids")
    if screenshot_ids is not None:
        db.execute(
            select(InspectionScreenshot).where(
                InspectionScreenshot.id.in_(screenshot_ids),
                InspectionScreenshot.report_id == report.id,
            ),
        )

    db.commit()
    db.refresh(report)
    return report


def submit_report(
    db: Session, report_id: int, operator: str | None,
) -> tuple[InspectionReport, list[dict[str, Any]]]:
    report = db.get(InspectionReport, report_id)
    if not report:
        raise ValueError(f"Report {report_id} not found")

    report.status = "submitted"
    report.submitted_by = operator
    report.submitted_at = datetime.now(_TZ_CN)

    warnings = check_thresholds(report)

    db.commit()
    db.refresh(report)
    return report, warnings


def check_thresholds(report: InspectionReport) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    source_map = {
        "health_data": report.health_data or {},
        "compliance_data": report.compliance_data or {},
    }

    for t in THRESHOLDS:
        source = source_map.get(t["source"], {})
        value = source.get(t["key"])
        if value is None:
            continue

        severity = None
        threshold_value = None

        if t["direction"] == "above":
            if value >= t["critical"]:
                severity, threshold_value = "critical", t["critical"]
            elif value >= t["warning"]:
                severity, threshold_value = "warning", t["warning"]
        elif t["direction"] == "below":
            if value <= t["critical"]:
                severity, threshold_value = "critical", t["critical"]
            elif value <= t["warning"]:
                severity, threshold_value = "warning", t["warning"]
        elif t["direction"] == "equals":
            if value == t["critical"]:
                severity, threshold_value = "critical", t["critical"]
            elif value == t["warning"]:
                severity, threshold_value = "warning", t["warning"]

        if severity:
            warnings.append({
                "metric": t["metric"],
                "value": value,
                "threshold": threshold_value,
                "severity": severity,
                "message": f"{t['key']} is {value} ({severity}: threshold {threshold_value})",
            })

    return warnings


def mark_overdue_reports(db: Session, period: InspectionPeriod) -> int:
    now = datetime.now(_TZ_CN)
    if now < period.deadline:
        return 0

    projects = list(db.execute(
        select(Project.id).where(Project.is_active.is_(True)),
    ).scalars().all())

    reports = list(db.execute(
        select(InspectionReport).where(InspectionReport.period_id == period.id),
    ).scalars().all())
    report_map: dict[int, InspectionReport] = {r.project_id: r for r in reports}

    count = 0
    for pid in projects:
        report = report_map.get(pid)
        if report and report.status == "submitted":
            continue
        if report:
            if report.status != "overdue":
                report.status = "overdue"
                count += 1
        else:
            db.add(InspectionReport(
                period_id=period.id,
                project_id=pid,
                status="overdue",
            ))
            count += 1

    if count:
        db.commit()
    return count


def _compress_image(
    file_bytes: bytes,
    max_width: int = _COMPRESS_MAX_WIDTH,
    quality: int = _COMPRESS_QUALITY,
) -> tuple[bytes, str]:
    """Compress image: resize if wider than max_width, convert to JPEG."""
    from PIL import Image

    img = Image.open(io.BytesIO(file_bytes))
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue(), "image/jpeg"


def _generate_thumbnail(
    file_bytes: bytes,
    max_width: int = _THUMB_MAX_WIDTH,
    quality: int = _THUMB_QUALITY,
) -> bytes:
    """Generate a JPEG thumbnail limited to max_width."""
    from PIL import Image

    img = Image.open(io.BytesIO(file_bytes))
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def upload_screenshot(
    db: Session,
    settings: Settings,
    file: UploadFile,
    report_id: int,
    project_slug: str,
) -> InspectionScreenshot:
    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise ValueError(f"Unsupported image type: {file.content_type}")

    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)

    if size > _MAX_SCREENSHOT_BYTES:
        raise ValueError(f"File too large: {size} bytes (max {_MAX_SCREENSHOT_BYTES})")

    raw_bytes = file.file.read()
    project_folder = _safe_project_folder_name(project_slug)

    # 1. 压缩原图
    compressed_bytes, compressed_ct = _compress_image(raw_bytes)
    uid = uuid.uuid4()
    compressed_filename = f"{uid}.jpg"
    compressed_result = upload_bytes_to_r2(
        settings,
        compressed_bytes,
        compressed_filename,
        project_folder,
        "inspection-screenshots",
        compressed_ct,
    )

    # 2. 生成并上传缩略图
    thumb_bytes = _generate_thumbnail(raw_bytes)
    thumb_filename = f"{uid}_thumb.jpg"
    thumb_result = upload_bytes_to_r2(
        settings,
        thumb_bytes,
        thumb_filename,
        project_folder,
        "inspection-screenshots",
        "image/jpeg",
    )

    # 3. 记录入库
    existing_count = db.execute(
        select(func.count()).select_from(InspectionScreenshot).where(
            InspectionScreenshot.report_id == report_id,
        ),
    ).scalar_one()

    screenshot = InspectionScreenshot(
        report_id=report_id,
        r2_key=compressed_result["key"],
        thumbnail_key=thumb_result["key"],
        filename=file.filename or compressed_filename,
        content_type=compressed_ct,
        file_size=compressed_result["size"],
        sort_order=existing_count,
    )
    db.add(screenshot)
    db.commit()
    db.refresh(screenshot)
    return screenshot


def get_report_by_id(db: Session, report_id: int) -> InspectionReport | None:
    return db.get(InspectionReport, report_id)


def get_screenshot_by_id(db: Session, screenshot_id: int) -> InspectionScreenshot | None:
    return db.get(InspectionScreenshot, screenshot_id)


def delete_screenshot(db: Session, settings: Settings, screenshot_id: int) -> bool:
    screenshot = db.get(InspectionScreenshot, screenshot_id)
    if not screenshot:
        return False

    delete_file_from_r2(settings, screenshot.r2_key)
    if screenshot.thumbnail_key:
        delete_file_from_r2(settings, screenshot.thumbnail_key)
    db.delete(screenshot)
    db.commit()
    return True


def get_report_screenshot_urls(
    settings: Settings, screenshots: list[InspectionScreenshot],
) -> list[dict[str, Any]]:
    return [
        {
            "id": s.id,
            "url": generate_presigned_url(settings, s.r2_key),
            "thumbnail_url": generate_presigned_url(settings, s.thumbnail_key) if s.thumbnail_key else None,
            "filename": s.filename,
            "caption": s.caption,
            "content_type": s.content_type,
            "file_size": s.file_size,
            "sort_order": s.sort_order,
        }
        for s in screenshots
    ]
