from __future__ import annotations

from fastapi import APIRouter, Depends, Form, Header, HTTPException, Query, Request, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.models.inspection import InspectionScreenshot
from app.models.project import Project
from app.schemas.inspection import (
    ComplianceData,
    HealthData,
    InspectionHistoryItem,
    InspectionHistoryResponse,
    InspectionOverviewItem,
    InspectionOverviewResponse,
    InspectionPeriodItem,
    InspectionPeriodListResponse,
    InspectionReportCreate,
    InspectionReportItem,
    InspectionReportUpdate,
    InspectionScreenshotItem,
    InspectionTemplateField,
    InspectionTemplateResponse,
)
from app.services import inspection_service, project_service
from app.services.audit_log_service import append_operation_audit_log
from app.services.r2_service import generate_presigned_url

router = APIRouter(prefix="/inspections", tags=["inspections"], dependencies=[Depends(protected)])


HEALTH_FIELDS = [
    InspectionTemplateField(
        key="account_health_rating", label="账户健康评级", label_en="Account Health Rating",
        type="select", options=["Healthy", "Good", "At Risk", "Critical"],
    ),
    InspectionTemplateField(
        key="odr", label="订单缺陷率", label_en="Order Defect Rate",
        type="number", unit="%", threshold_warning=0.5, threshold_critical=1.0, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="late_shipment_rate", label="迟发率", label_en="Late Shipment Rate",
        type="number", unit="%", threshold_warning=2.0, threshold_critical=4.0, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="pre_fulfillment_cancel_rate", label="预履行取消率", label_en="Pre-fulfillment Cancel Rate",
        type="number", unit="%",
    ),
    InspectionTemplateField(
        key="valid_tracking_rate", label="有效追踪率", label_en="Valid Tracking Rate",
        type="number", unit="%", threshold_warning=97.0, threshold_critical=95.0, threshold_direction="below",
    ),
    InspectionTemplateField(
        key="on_time_delivery_rate", label="准时送达率", label_en="On-time Delivery Rate",
        type="number", unit="%",
    ),
]

COMPLIANCE_FIELDS = [
    InspectionTemplateField(
        key="policy_violations", label="政策违规数", label_en="Policy Violations",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="ip_complaints", label="知识产权投诉", label_en="IP Complaints",
        type="number",
    ),
    InspectionTemplateField(
        key="restricted_product_warnings", label="受限商品警告", label_en="Restricted Product Warnings",
        type="number",
    ),
    InspectionTemplateField(
        key="listing_suppressed_count", label="被抑制 Listing 数", label_en="Listing Suppressed Count",
        type="number",
    ),
    InspectionTemplateField(
        key="account_deactivation_risk", label="账户停用风险", label_en="Account Deactivation Risk",
        type="boolean",
    ),
]


@router.get("/template", response_model=InspectionTemplateResponse)
def get_template():
    return InspectionTemplateResponse(health_fields=HEALTH_FIELDS, compliance_fields=COMPLIANCE_FIELDS)


@router.get("/periods", response_model=InspectionPeriodListResponse)
def list_periods(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db_session),
):
    items, total = inspection_service.list_periods(db, limit=limit, offset=offset)
    return InspectionPeriodListResponse(
        items=[InspectionPeriodItem.model_validate(p) for p in items],
        total=total,
    )


@router.get("/periods/current", response_model=InspectionPeriodItem)
def get_current_period(db: Session = Depends(get_db_session)):
    period = inspection_service.get_or_create_current_period(db)
    return InspectionPeriodItem.model_validate(period)


@router.get("/periods/{period_id}/overview", response_model=InspectionOverviewResponse)
def get_period_overview(
    period_id: int,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    result = inspection_service.get_overview(db, period_id, settings, operator=operator, is_admin=bool(is_admin))
    if not result["period"]:
        raise HTTPException(status_code=404, detail="Period not found")

    return InspectionOverviewResponse(
        period=InspectionPeriodItem(**result["period"]),
        items=[InspectionOverviewItem(**item) for item in result["items"]],
        total_projects=sum(result["counts"].values()),
        submitted_count=result["counts"]["submitted"],
        overdue_count=result["counts"]["overdue"],
    )


@router.get("/periods/{period_id}/projects/{project_id}", response_model=InspectionReportItem | None)
def get_report(
    period_id: int,
    project_id: int,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    report = inspection_service.get_report(db, period_id, project_id, settings)
    if not report:
        return None
    return _serialize_report(report, settings)


@router.post("/periods/{period_id}/projects/{project_id}", response_model=InspectionReportItem, status_code=201)
def create_or_update_report(
    period_id: int,
    project_id: int,
    body: InspectionReportCreate,
    request: Request,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    period = inspection_service.get_period(db, period_id)
    if not period:
        raise HTTPException(status_code=404, detail="Period not found")

    data = body.model_dump(exclude_unset=True)
    if "health_data" in data and data["health_data"]:
        data["health_data"] = body.health_data.model_dump() if body.health_data else None
    if "compliance_data" in data and data["compliance_data"]:
        data["compliance_data"] = body.compliance_data.model_dump() if body.compliance_data else None

    report = inspection_service.create_or_update_report(db, period_id, project_id, data, operator)
    append_operation_audit_log(
        db, action="inspection.save", target_type="inspection_report",
        target_id=report.id, operator=operator, after=data, request=request,
    )
    return _serialize_report(report, settings)


@router.patch("/periods/{period_id}/projects/{project_id}", response_model=InspectionReportItem)
def update_report(
    period_id: int,
    project_id: int,
    body: InspectionReportUpdate,
    request: Request,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    data = body.model_dump(exclude_unset=True)
    if "health_data" in data and data["health_data"]:
        data["health_data"] = body.health_data.model_dump() if body.health_data else None
    if "compliance_data" in data and data["compliance_data"]:
        data["compliance_data"] = body.compliance_data.model_dump() if body.compliance_data else None

    report = inspection_service.create_or_update_report(db, period_id, project_id, data, operator)
    append_operation_audit_log(
        db, action="inspection.update", target_type="inspection_report",
        target_id=report.id, operator=operator, after=data, request=request,
    )
    return _serialize_report(report, settings)


@router.post("/periods/{period_id}/projects/{project_id}/submit", response_model=InspectionReportItem)
def submit_report(
    period_id: int,
    project_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    report = inspection_service.get_report(db, period_id, project_id, settings)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found. Create a draft first.")

    report, warnings = inspection_service.submit_report(db, report.id, operator)
    append_operation_audit_log(
        db, action="inspection.submit", target_type="inspection_report",
        target_id=report.id, operator=operator,
        after={"warnings": warnings} if warnings else None,
        request=request,
    )
    return _serialize_report(report, settings)


@router.post("/screenshots/upload", response_model=InspectionScreenshotItem, status_code=201)
def upload_screenshot(
    file: UploadFile,
    report_id_form: int | None = Form(default=None, alias="report_id"),
    report_id_query: int | None = Query(default=None, alias="report_id"),
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    report_id = report_id_query if report_id_query is not None else report_id_form
    if report_id is None:
        raise HTTPException(status_code=422, detail="report_id is required")

    report = inspection_service.get_report_by_id(db, report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    project_service.ensure_project_access(db, report.project_id, operator=operator, is_admin=bool(is_admin))
    project = db.get(Project, report.project_id)
    project_slug = project.project_name if project else "unknown"

    try:
        screenshot = inspection_service.upload_screenshot(db, settings, file, report_id, project_slug)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return InspectionScreenshotItem(
        id=screenshot.id,
        r2_key=screenshot.r2_key,
        filename=screenshot.filename,
        content_type=screenshot.content_type,
        file_size=screenshot.file_size,
        caption=screenshot.caption,
        sort_order=screenshot.sort_order,
        url=generate_presigned_url(settings, screenshot.r2_key),
        thumbnail_url=generate_presigned_url(settings, screenshot.thumbnail_key) if screenshot.thumbnail_key else None,
        created_at=screenshot.created_at,
    )


@router.delete("/screenshots/{screenshot_id}", status_code=204)
def delete_screenshot(
    screenshot_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    screenshot = inspection_service.get_screenshot_by_id(db, screenshot_id)
    if not screenshot:
        raise HTTPException(status_code=404, detail="Screenshot not found")

    report = inspection_service.get_report_by_id(db, screenshot.report_id)
    if report:
        project_service.ensure_project_access(db, report.project_id, operator=operator, is_admin=bool(is_admin))

    success = inspection_service.delete_screenshot(db, settings, screenshot_id)
    if not success:
        raise HTTPException(status_code=404, detail="Screenshot not found")
    append_operation_audit_log(
        db, action="inspection.delete_screenshot", target_type="inspection_screenshot",
        target_id=screenshot_id, operator=operator, request=request,
    )


@router.get("/history", response_model=InspectionHistoryResponse)
def get_history(
    period_id: int | None = Query(default=None),
    project_id: int | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    from sqlalchemy import select, func
    from app.models.inspection import InspectionReport, InspectionPeriod
    from app.models.project import Project

    # If a specific project is requested, check access
    if project_id:
        project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))

    query = (
        select(InspectionReport, InspectionPeriod, Project)
        .join(InspectionPeriod, InspectionReport.period_id == InspectionPeriod.id)
        .join(Project, InspectionReport.project_id == Project.id)
    )

    # Filter by accessible projects for non-admin users
    if not bool(is_admin):
        accessible_ids = project_service.list_accessible_project_ids(db, operator=operator, is_admin=False)
        if not accessible_ids:
            return InspectionHistoryResponse(items=[], total=0)
        query = query.where(InspectionReport.project_id.in_(accessible_ids))

    if period_id:
        query = query.where(InspectionReport.period_id == period_id)
    if project_id:
        query = query.where(InspectionReport.project_id == project_id)

    count_query = select(func.count()).select_from(query.subquery())
    total = db.execute(count_query).scalar_one()

    query = query.order_by(InspectionPeriod.week_start.desc(), Project.sort_order)
    query = query.limit(limit).offset(offset)

    rows = db.execute(query).all()
    items = []
    for report, period, project in rows:
        health = report.health_data or {}
        items.append(InspectionHistoryItem(
            id=report.id,
            period_id=period.id,
            week_start=period.week_start,
            week_end=period.week_end,
            project_id=project.id,
            project_name=project.project_name,
            status=report.status,
            account_health_rating=health.get("account_health_rating"),
            odr=health.get("odr"),
            submitted_by=report.submitted_by,
            submitted_at=report.submitted_at,
        ))

    return InspectionHistoryResponse(items=items, total=total)


def _serialize_report(report, settings: Settings) -> InspectionReportItem:
    screenshots = []
    for s in (report.screenshots or []):
        url = getattr(s, "_presigned_url", None) or generate_presigned_url(settings, s.r2_key)
        thumb_url = generate_presigned_url(settings, s.thumbnail_key) if s.thumbnail_key else None
        screenshots.append(InspectionScreenshotItem(
            id=s.id, r2_key=s.r2_key, filename=s.filename,
            content_type=s.content_type, file_size=s.file_size,
            caption=s.caption, sort_order=s.sort_order,
            url=url, thumbnail_url=thumb_url, created_at=s.created_at,
        ))

    health_data = HealthData(**report.health_data) if report.health_data else None
    compliance_data = ComplianceData(**report.compliance_data) if report.compliance_data else None

    return InspectionReportItem(
        id=report.id, period_id=report.period_id, project_id=report.project_id,
        status=report.status, health_data=health_data, compliance_data=compliance_data,
        status_summary=report.status_summary, submitted_by=report.submitted_by,
        submitted_at=report.submitted_at, screenshots=screenshots,
        created_at=report.created_at, updated_at=report.updated_at,
    )
