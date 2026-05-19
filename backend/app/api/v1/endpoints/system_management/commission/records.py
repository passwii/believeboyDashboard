"""
佣金记录端点。
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.models.commission_record import CommissionRecord

from app.schemas.system_management.commission.records import (
    CommissionRecordItem,
    CommissionRecordsResponse,
    UpsertCommissionRecordsRequest,
    UpdateCommissionPaymentStatusRequest,
    UpdateCommissionPaymentStatusResponse,
)

from app.schemas.system_management.commission.project_months import (
    CommissionProjectMonthItem,
    CommissionProjectMonthsResponse,
    UpdateCommissionProjectPaymentRequest,
    UpdateCommissionProjectPaymentResponse,
)

from app.schemas.system_management.commission._enums import (
    CommissionIncomeCategory,
    CommissionPaymentStatus,
    CommissionProjectPaymentStatus,
    CommissionRatioSource,
)

from app.services.audit_log_service import append_operation_view_log, append_operation_audit_log
from app.services.system_management import (
    _parse_report_month,
    _to_iso,
    upsert_commission_records,
    update_commission_payment_status,
    update_commission_project_payment,
)


router = APIRouter(prefix="/commission-management", tags=["佣金管理"])


def _serialize_commission_record_row(row: CommissionRecord) -> CommissionRecordItem:
    return CommissionRecordItem(
        id=row.id, report_month=row.report_month, country=row.country, project_id=row.project_id,
        project_name=row.project_name, project_month_id=row.project_month_id,
        person_name=row.person_name, income_category=CommissionIncomeCategory(row.income_category),
        income_total_usd=float(row.income_total_usd), factory_commission_rate=float(row.factory_commission_rate),
        operator_bonus_ratio=float(row.operator_bonus_ratio), bonus_amount_usd=float(row.bonus_amount_usd),
        usd_to_rmb_rate=float(row.usd_to_rmb_rate), bonus_amount_rmb=float(row.bonus_amount_rmb),
        bonus_ratio_source=CommissionRatioSource(row.bonus_ratio_source),
        manual_bonus_ratio=float(row.manual_bonus_ratio) if row.manual_bonus_ratio is not None else None,
        payment_status=CommissionPaymentStatus(row.payment_status),
        payment_confirmed_at=_to_iso(row.payment_confirmed_at), payment_confirmed_by=row.payment_confirmed_by,
        is_locked=bool(row.is_locked), locked_at=_to_iso(row.locked_at), locked_by=row.locked_by,
        is_active=bool(row.is_active), deactivated_at=_to_iso(row.deactivated_at),
        computed_at=_to_iso(row.computed_at) or "", updated_at=_to_iso(row.updated_at) or "",
    )


@router.post("/records/upsert", response_model=CommissionRecordsResponse)
def upsert_commission_records_endpoint(
    payload: UpsertCommissionRecordsRequest,
    request: Request,
    country: str = "US",
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionRecordsResponse:
    try:
        report_month = _parse_report_month(payload.report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    now = datetime.now().astimezone().replace(microsecond=0)

    rows = upsert_commission_records(
        db,
        report_month=report_month,
        country=country,
        items=payload.items,
        now=now,
    )

    append_operation_audit_log(db, action="commission.bonus_records.upsert", target_type="commission_bonus_record", target_id=report_month, operator=operator, after={"report_month": report_month, "country": country, "incoming_items": len(payload.items)}, request=request)

    from app.services.infra import invalidate_data_management_overview_cache
    invalidate_data_management_overview_cache()

    return CommissionRecordsResponse(report_month=report_month, items=[_serialize_commission_record_row(r) for r in rows])


@router.get("/records", response_model=CommissionRecordsResponse)
def list_commission_records(
    report_month: str,
    request: Request,
    country: str = "US",
    person_name: str | None = None,
    include_inactive: bool = False,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionRecordsResponse:
    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    stmt = select(CommissionRecord).where(
        CommissionRecord.report_month == month,
        CommissionRecord.country == country,
    )
    if not include_inactive:
        stmt = stmt.where(CommissionRecord.is_active.is_(True))
    normalized_person = (person_name or "").strip()
    if normalized_person:
        stmt = stmt.where(CommissionRecord.person_name == normalized_person)
    stmt = stmt.order_by(CommissionRecord.person_name.asc(), CommissionRecord.project_name.asc(), CommissionRecord.income_category.asc())

    rows = db.execute(stmt).scalars().all()
    append_operation_view_log(db, action="commission.bonus_records.view", target_type="commission_bonus_record", target_id=month, operator=operator, after={"report_month": month, "country": country, "person_name": normalized_person or None, "include_inactive": include_inactive, "count": len(rows)}, request=request)
    db.commit()
    return CommissionRecordsResponse(report_month=month, items=[_serialize_commission_record_row(r) for r in rows])


@router.patch("/records/{record_id}/payment-status", response_model=UpdateCommissionPaymentStatusResponse)
def update_commission_payment_status_endpoint(
    record_id: int,
    payload: UpdateCommissionPaymentStatusRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateCommissionPaymentStatusResponse:
    from app.services.infra import invalidate_data_management_overview_cache

    now = datetime.now().astimezone().replace(microsecond=0)

    row = db.execute(select(CommissionRecord).where(CommissionRecord.id == record_id)).scalars().first()
    if row is None:
        raise HTTPException(status_code=404, detail="record not found")
    before = _serialize_commission_record_row(row)

    row = update_commission_payment_status(
        db,
        record_id=record_id,
        payment_status=payload.payment_status.value,
        now=now,
        operator=operator,
    )
    db.refresh(row)

    after = _serialize_commission_record_row(row)
    append_operation_audit_log(db, action="commission.bonus_record.payment_status.update", target_type="commission_bonus_record", target_id=record_id, operator=operator, before=before, after=after, request=request)
    invalidate_data_management_overview_cache()

    return UpdateCommissionPaymentStatusResponse(item=_serialize_commission_record_row(row))


@router.get("/project-months", response_model=CommissionProjectMonthsResponse)
def list_commission_project_months(
    report_month: str,
    request: Request,
    country: str = "US",
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionProjectMonthsResponse:
    from app.models.commission_project_month import CommissionProjectMonth

    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    rows = db.execute(
        select(CommissionProjectMonth).where(
            CommissionProjectMonth.report_month == month,
            CommissionProjectMonth.country == country,
        )
        .order_by(CommissionProjectMonth.project_id.asc())
    ).scalars().all()

    append_operation_view_log(db, action="commission.project_months.view", target_type="commission_project_month", target_id=month, operator=operator, after={"report_month": month, "country": country, "count": len(rows)}, request=request)
    db.commit()

    items = [
        CommissionProjectMonthItem(
            id=r.id,
            report_month=r.report_month,
            country=r.country,
            project_id=r.project_id,
            project_name=r.project_name,
            income_total_usd=float(r.income_total_usd),
            factory_commission_rate=float(r.factory_commission_rate),
            usd_to_rmb_rate=float(r.usd_to_rmb_rate),
            factory_commission_usd=float(r.factory_commission_usd),
            factory_commission_rmb=float(r.factory_commission_rmb),
            payment_status=CommissionProjectPaymentStatus(r.payment_status),
            received_rmb=float(r.received_rmb),
            payment_confirmed_at=_to_iso(r.payment_confirmed_at),
            payment_confirmed_by=r.payment_confirmed_by,
            note=r.note,
            computed_at=_to_iso(r.computed_at) or "",
            updated_at=_to_iso(r.updated_at) or "",
        )
        for r in rows
    ]

    return CommissionProjectMonthsResponse(report_month=month, items=items)


@router.patch("/project-months/{project_month_id}/payment", response_model=UpdateCommissionProjectPaymentResponse)
def update_commission_project_payment_endpoint(
    project_month_id: int,
    payload: UpdateCommissionProjectPaymentRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateCommissionProjectPaymentResponse:
    from app.models.commission_project_month import CommissionProjectMonth
    from app.services.infra import invalidate_data_management_overview_cache

    now = datetime.now().astimezone().replace(microsecond=0)

    row = db.execute(select(CommissionProjectMonth).where(CommissionProjectMonth.id == project_month_id)).scalars().first()
    if row is None:
        raise HTTPException(status_code=404, detail="project month record not found")

    before_data = {
        "id": row.id,
        "report_month": row.report_month,
        "country": row.country,
        "project_id": row.project_id,
        "project_name": row.project_name,
        "income_total_usd": float(row.income_total_usd),
        "factory_commission_rate": float(row.factory_commission_rate),
        "usd_to_rmb_rate": float(row.usd_to_rmb_rate),
        "factory_commission_usd": float(row.factory_commission_usd),
        "factory_commission_rmb": float(row.factory_commission_rmb),
        "payment_status": row.payment_status,
        "received_rmb": float(row.received_rmb),
    }

    row = update_commission_project_payment(
        db,
        project_month_id=project_month_id,
        payment_status=payload.payment_status.value,
        received_rmb=payload.received_rmb,
        note=payload.note,
        now=now,
        operator=operator,
    )
    db.refresh(row)

    after_data = {
        "id": row.id,
        "report_month": row.report_month,
        "country": row.country,
        "project_id": row.project_id,
        "project_name": row.project_name,
        "income_total_usd": float(row.income_total_usd),
        "factory_commission_rate": float(row.factory_commission_rate),
        "usd_to_rmb_rate": float(row.usd_to_rmb_rate),
        "factory_commission_usd": float(row.factory_commission_usd),
        "factory_commission_rmb": float(row.factory_commission_rmb),
        "payment_status": row.payment_status,
        "received_rmb": float(row.received_rmb),
    }

    append_operation_audit_log(db, action="commission.project_commission.payment.update", target_type="commission_project_month", target_id=project_month_id, operator=operator, before=before_data, after=after_data, request=request)
    invalidate_data_management_overview_cache()

    return UpdateCommissionProjectPaymentResponse(
        item=CommissionProjectMonthItem(
            id=row.id,
            report_month=row.report_month,
            country=row.country,
            project_id=row.project_id,
            project_name=row.project_name,
            income_total_usd=float(row.income_total_usd),
            factory_commission_rate=float(row.factory_commission_rate),
            usd_to_rmb_rate=float(row.usd_to_rmb_rate),
            factory_commission_usd=float(row.factory_commission_usd),
            factory_commission_rmb=float(row.factory_commission_rmb),
            payment_status=CommissionProjectPaymentStatus(row.payment_status),
            received_rmb=float(row.received_rmb),
            payment_confirmed_at=_to_iso(row.payment_confirmed_at),
            payment_confirmed_by=row.payment_confirmed_by,
            note=row.note,
            computed_at=_to_iso(row.computed_at) or "",
            updated_at=_to_iso(row.updated_at) or "",
        )
    )