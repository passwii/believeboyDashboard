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
]

SERVICE_PERFORMANCE_FIELDS = [
    InspectionTemplateField(
        key="negative_feedback", label="负面反馈", label_en="Negative Feedback",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="a2z_claims", label="亚马逊 A-to-Z", label_en="A-to-Z Claims",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="chargeback_claims", label="信用卡拒付", label_en="Chargeback Claims",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
]

SHIPPING_PERFORMANCE_FIELDS = [
    InspectionTemplateField(
        key="late_shipment_rate", label="迟发率", label_en="Late Shipment Rate",
        type="number", unit="%", threshold_warning=2.0, threshold_critical=4.0, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="pre_fulfillment_cancel_rate", label="配送前取消率", label_en="Pre-fulfillment Cancel Rate",
        type="number", unit="%",
    ),
    InspectionTemplateField(
        key="valid_tracking_rate", label="有效追踪率", label_en="Valid Tracking Rate",
        type="number", unit="%", threshold_warning=97.0, threshold_critical=95.0, threshold_direction="below",
    ),
    InspectionTemplateField(
        key="on_time_delivery_rate", label="准时交付率", label_en="On-time Delivery Rate",
        type="number", unit="%", threshold_warning=97.0, threshold_critical=95.0, threshold_direction="below",
    ),
]

COMPLIANCE_FIELDS = [
    InspectionTemplateField(
        key="ip_infringement", label="涉嫌侵犯知识产权", label_en="Suspected IP Infringement",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="ip_complaints", label="知识产权投诉", label_en="IP Complaints",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="product_authenticity_complaints", label="商品真实性买家投诉", label_en="Product Authenticity Complaints",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="product_condition_complaints", label="商品状况买家投诉", label_en="Product Condition Complaints",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="food_product_safety", label="食品和商品安全问题", label_en="Food & Product Safety",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="listing_policy_violations", label="上架政策违规", label_en="Listing Policy Violations",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="restricted_product_violations", label="违反受限商品政策", label_en="Restricted Product Violations",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="review_policy_violations", label="违反买家商品评论政策", label_en="Review Policy Violations",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="other_policy_violations", label="其他违反政策", label_en="Other Policy Violations",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="regulatory_compliance", label="监管合规性", label_en="Regulatory Compliance",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
]


@router.get("/template", response_model=InspectionTemplateResponse)
def get_template():
    return InspectionTemplateResponse(
        health_fields=HEALTH_FIELDS,
        service_performance_fields=SERVICE_PERFORMANCE_FIELDS,
        shipping_performance_fields=SHIPPING_PERFORMANCE_FIELDS,
        compliance_fields=COMPLIANCE_FIELDS,
    )


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
        compliance = report.compliance_data or {}
        compliance_total = sum(
            compliance.get(k, 0) or 0
            for k in (
                "ip_infringement", "ip_complaints", "product_authenticity_complaints",
                "product_condition_complaints", "food_product_safety",
                "listing_policy_violations", "restricted_product_violations",
                "review_policy_violations", "other_policy_violations", "regulatory_compliance",
            )
        ) if compliance else None
        items.append(InspectionHistoryItem(
            id=report.id,
            period_id=period.id,
            week_start=period.week_start,
            week_end=period.week_end,
            project_id=project.id,
            project_name=project.project_name,
            status=report.status,
            account_health_rating=health.get("account_health_rating"),
            compliance_total=compliance_total,
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
