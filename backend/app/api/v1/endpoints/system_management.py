from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import MetaData, Table, func, inspect, select, text
from sqlalchemy.engine.url import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import get_settings
from app.models.commission_project_month import CommissionProjectMonth
from app.models.commission_record import CommissionRecord
from app.models.commission_ratio_override import CommissionRatioOverride
from app.models.project_role_assignment import ProjectRoleAssignment
from app.schemas.system_management import (
    CommissionIncomeCategory,
    CommissionPaymentStatus,
    CommissionProjectMonthItem,
    CommissionProjectMonthsResponse,
    CommissionProjectMonthlySummaryMonthItem,
    CommissionProjectYearlySummaryItem,
    CommissionProjectYearlySummaryResponse,
    CommissionProjectPaymentStatus,
    CommissionRatioOverrideItem,
    CommissionRatioOverridesResponse,
    CommissionRatioSource,
    CommissionRecordItem,
    CommissionRecordsResponse,
    CommissionYearlyMonthlySummaryItem,
    CommissionYearlyMonthlySummaryResponse,
    UpdateCommissionProjectPaymentRequest,
    UpdateCommissionProjectPaymentResponse,
    DataLifecycleStatus,
    DataManagementOverviewResponse,
    DataManagementStatusResponse,
    DataSummary,
    DatabaseStatus,
    ProjectRoleAssignmentItem,
    ProjectRoleAssignmentsResponse,
    RecentSystemStatusItem,
    TableHealthStatus,
    TableStatusItem,
    UpdateCommissionPaymentStatusRequest,
    UpdateCommissionPaymentStatusResponse,
    UpdateDataStatusRequest,
    UpdateDataStatusResponse,
    UpsertCommissionRatioOverridesRequest,
    UpsertCommissionRecordsRequest,
    UpsertProjectRoleAssignmentsRequest,
)

router = APIRouter(prefix='/system-management', dependencies=[Depends(protected)])

DATA_STATE_TABLE = 'system_management_data_state'
STALE_WINDOW_HOURS = 72
REPORT_MONTH_RE = re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')
YEAR_RE = re.compile(r'^\d{4}$')


def _resolve_database_source(database_url: str) -> tuple[str, str | None]:
    try:
        url = make_url(database_url)
    except Exception:
        return 'unknown', None

    engine = url.get_backend_name()
    source: str | None = None
    if engine == 'sqlite':
        raw_database = url.database or ''
        if raw_database and raw_database != ':memory:':
            source = str(Path(raw_database).resolve())
        else:
            source = raw_database or ':memory:'
    elif url.host:
        if url.database:
            source = f'{url.host}/{url.database}'
        else:
            source = url.host
    return engine, source


def _to_iso(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if value.tzinfo is None:
        return value.isoformat(timespec='seconds')
    return value.astimezone().isoformat(timespec='seconds')


def _now() -> datetime:
    return datetime.now().astimezone()


def _parse_report_month(value: str) -> str:
    normalized = value.strip()
    if not REPORT_MONTH_RE.match(normalized):
        raise ValueError('report_month must be in YYYY-MM format')
    return normalized


def _parse_year(value: str) -> str:
    normalized = value.strip()
    if not YEAR_RE.match(normalized):
        raise ValueError('year must be in YYYY format')
    return normalized


def _to_decimal(value: float | int | str, scale: str = '0.000000') -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError('invalid decimal value') from None
    return parsed.quantize(Decimal(scale), rounding=ROUND_HALF_UP)


def _serialize_commission_record(row: CommissionRecord) -> CommissionRecordItem:
    return CommissionRecordItem(
        id=row.id,
        report_month=row.report_month,
        project_id=row.project_id,
        project_name=row.project_name,
        project_month_id=row.project_month_id,
        person_name=row.person_name,
        income_category=CommissionIncomeCategory(row.income_category),
        income_total_usd=float(row.income_total_usd),
        factory_commission_rate=float(row.factory_commission_rate),
        public_commission_ratio=float(row.public_commission_ratio),
        commission_amount_usd=float(row.commission_amount_usd),
        usd_to_rmb_rate=float(row.usd_to_rmb_rate),
        commission_amount_rmb=float(row.commission_amount_rmb),
        ratio_source=CommissionRatioSource(row.ratio_source),
        manual_ratio=float(row.manual_ratio) if row.manual_ratio is not None else None,
        payment_status=CommissionPaymentStatus(row.payment_status),
        payment_confirmed_at=_to_iso(row.payment_confirmed_at),
        payment_confirmed_by=row.payment_confirmed_by,
        is_locked=bool(row.is_locked),
        locked_at=_to_iso(row.locked_at),
        locked_by=row.locked_by,
        is_active=bool(row.is_active),
        deactivated_at=_to_iso(row.deactivated_at),
        computed_at=_to_iso(row.computed_at) or '',
        updated_at=_to_iso(row.updated_at) or '',
    )


def _serialize_project_month(row: CommissionProjectMonth) -> CommissionProjectMonthItem:
    return CommissionProjectMonthItem(
        id=row.id,
        report_month=row.report_month,
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
        computed_at=_to_iso(row.computed_at) or '',
        updated_at=_to_iso(row.updated_at) or '',
    )


def _serialize_ratio_override(row: CommissionRatioOverride) -> CommissionRatioOverrideItem:
    return CommissionRatioOverrideItem(
        id=row.id,
        report_month=row.report_month,
        project_id=row.project_id,
        project_name=row.project_name,
        person_name=row.person_name,
        income_category=CommissionIncomeCategory(row.income_category),
        override_ratio=float(row.override_ratio),
        reason=row.reason,
        updated_by=row.updated_by,
        updated_at=_to_iso(row.updated_at) or '',
    )


def _serialize_role_assignment(row: ProjectRoleAssignment) -> ProjectRoleAssignmentItem:
    return ProjectRoleAssignmentItem(
        id=row.id,
        project_id=row.project_id,
        role_type=CommissionIncomeCategory(row.role_type),
        person_name=row.person_name,
        effective_from_month=row.effective_from_month,
        effective_to_month=row.effective_to_month,
        updated_at=_to_iso(row.updated_at) or '',
    )


def _ensure_data_state_table(db: Session) -> None:
    try:
        db.execute(
            text(
                f'''
                create table if not exists {DATA_STATE_TABLE} (
                    id integer primary key,
                    status varchar(32) not null,
                    note text,
                    updated_by varchar(255),
                    updated_at timestamp not null
                )
                '''
            )
        )
        db.commit()
    except IntegrityError as exc:
        # PostgreSQL can still throw duplicate type/namespace on concurrent
        # CREATE TABLE IF NOT EXISTS. Roll back and continue.
        db.rollback()
        if 'pg_type_typname_nsp_index' not in str(exc):
            raise


def _load_data_state(db: Session) -> tuple[DataLifecycleStatus, str | None, str | None, str | None]:
    _ensure_data_state_table(db)
    row = db.execute(
        text(f'select status, note, updated_by, updated_at from {DATA_STATE_TABLE} where id = 1')
    ).mappings().first()
    if not row:
        return DataLifecycleStatus.active, None, None, None

    raw_status = (row.get('status') or DataLifecycleStatus.active.value).lower()
    try:
        status = DataLifecycleStatus(raw_status)
    except ValueError:
        status = DataLifecycleStatus.active

    return status, row.get('note'), row.get('updated_by'), _to_iso(row.get('updated_at'))


def _check_database(db: Session) -> tuple[bool, str]:
    checked_at = _now().isoformat(timespec='seconds')
    healthy = True
    try:
        db.execute(text('select 1'))
    except Exception:
        healthy = False
    return healthy, checked_at


def _collect_table_statuses(db: Session) -> tuple[list[TableStatusItem], int, int]:
    inspector = inspect(db.bind)
    table_names = sorted(name for name in inspector.get_table_names() if name != 'alembic_version')
    statuses: list[TableStatusItem] = []
    total_rows = 0
    stale_tables = 0
    stale_threshold = _now() - timedelta(hours=STALE_WINDOW_HOURS)

    for table_name in table_names:
        try:
            table = Table(table_name, MetaData(), autoload_with=db.bind)
            row_count = int(db.execute(select(func.count()).select_from(table)).scalar() or 0)
            total_rows += row_count

            timestamp_col = None
            if 'updated_at' in table.c:
                timestamp_col = table.c.updated_at
            elif 'created_at' in table.c:
                timestamp_col = table.c.created_at

            last_updated_dt: datetime | str | None = None
            if timestamp_col is not None:
                last_updated_dt = db.execute(select(func.max(timestamp_col))).scalar()

            if row_count == 0:
                status = TableHealthStatus.empty
                note = '表中暂无数据'
            elif isinstance(last_updated_dt, datetime) and last_updated_dt < stale_threshold:
                status = TableHealthStatus.stale
                note = f'超过 {STALE_WINDOW_HOURS} 小时无更新'
                stale_tables += 1
            else:
                status = TableHealthStatus.healthy
                note = '运行正常'

            statuses.append(
                TableStatusItem(
                    table_name=table_name,
                    row_count=row_count,
                    last_updated_at=_to_iso(last_updated_dt),
                    status=status,
                    note=note,
                )
            )
        except Exception as exc:
            statuses.append(
                TableStatusItem(
                    table_name=table_name,
                    row_count=None,
                    last_updated_at=None,
                    status=TableHealthStatus.error,
                    note=f'读取失败: {exc.__class__.__name__}',
                )
            )

    return statuses, total_rows, stale_tables


def _collect_recent_statuses(db: Session, data_status: DataLifecycleStatus, checked_at: str) -> list[RecentSystemStatusItem]:
    items: list[RecentSystemStatusItem] = [
        RecentSystemStatusItem(
            source='data-status',
            level='info',
            message=f'当前数据状态: {data_status.value}',
            occurred_at=checked_at,
        )
    ]

    inspector = inspect(db.bind)
    if inspector.has_table('jobs') and inspector.has_table('job_runs'):
        rows = db.execute(
            text(
                '''
                select
                    j.job_type as source,
                    j.status as level,
                    coalesce(jr.error_message, jr.log_excerpt, '任务执行记录') as message,
                    coalesce(jr.finished_at, jr.started_at) as occurred_at
                from job_runs jr
                join jobs j on j.id = jr.job_id
                order by jr.started_at desc
                limit 8
                '''
            )
        ).mappings().all()

        for row in rows:
            items.append(
                RecentSystemStatusItem(
                    source=row.get('source') or 'job',
                    level=str(row.get('level') or 'info'),
                    message=str(row.get('message') or '任务状态更新'),
                    occurred_at=_to_iso(row.get('occurred_at')) or checked_at,
                )
            )

    return items


@router.get('/data-management/status', response_model=DataManagementStatusResponse)
def get_data_management_status(db: Session = Depends(get_db_session)) -> DataManagementStatusResponse:
    settings = get_settings()
    db_healthy, checked_at = _check_database(db)
    db_engine, db_source = _resolve_database_source(settings.database_url)
    return DataManagementStatusResponse(
        server_time=checked_at,
        database=DatabaseStatus(
            engine=db_engine,
            source=db_source,
            healthy=db_healthy,
            checked_at=checked_at,
        ),
        cache_enabled=False,
    )


@router.get('/data-management/overview', response_model=DataManagementOverviewResponse)
def get_data_management_overview(db: Session = Depends(get_db_session)) -> DataManagementOverviewResponse:
    settings = get_settings()
    db_healthy, checked_at = _check_database(db)
    db_engine, db_source = _resolve_database_source(settings.database_url)

    data_status, note, updated_by, updated_at = _load_data_state(db)
    table_statuses, total_rows, stale_tables = _collect_table_statuses(db)
    recent_statuses = _collect_recent_statuses(db, data_status, checked_at)

    return DataManagementOverviewResponse(
        server_time=checked_at,
        database=DatabaseStatus(
            engine=db_engine,
            source=db_source,
            healthy=db_healthy,
            checked_at=checked_at,
        ),
        cache_enabled=False,
        summary=DataSummary(
            total_tables=len(table_statuses),
            total_rows=total_rows,
            stale_tables=stale_tables,
            data_status=data_status,
        ),
        data_status_note=note,
        data_status_updated_at=updated_at,
        data_status_updated_by=updated_by,
        tables=table_statuses,
        recent_statuses=recent_statuses,
    )


@router.patch('/data-management/data-status', response_model=UpdateDataStatusResponse)
def update_data_status(
    payload: UpdateDataStatusRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateDataStatusResponse:
    _ensure_data_state_table(db)
    now = _now().replace(microsecond=0)

    existing = db.execute(text(f'select id from {DATA_STATE_TABLE} where id = 1')).first()
    if existing:
        db.execute(
            text(
                f'''
                update {DATA_STATE_TABLE}
                set status = :status, note = :note, updated_by = :updated_by, updated_at = :updated_at
                where id = 1
                '''
            ),
            {
                'status': payload.status.value,
                'note': payload.note,
                'updated_by': operator,
                'updated_at': now,
            },
        )
    else:
        db.execute(
            text(
                f'''
                insert into {DATA_STATE_TABLE} (id, status, note, updated_by, updated_at)
                values (1, :status, :note, :updated_by, :updated_at)
                '''
            ),
            {
                'status': payload.status.value,
                'note': payload.note,
                'updated_by': operator,
                'updated_at': now,
            },
        )
    db.commit()

    return UpdateDataStatusResponse(
        status=payload.status,
        note=payload.note,
        updated_at=now.isoformat(timespec='seconds'),
        updated_by=operator,
    )


@router.post('/commission-management/records/upsert', response_model=CommissionRecordsResponse)
def upsert_commission_records(
    payload: UpsertCommissionRecordsRequest,
    db: Session = Depends(get_db_session),
) -> CommissionRecordsResponse:
    try:
        report_month = _parse_report_month(payload.report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    now = _now().replace(microsecond=0)
    project_items: dict[int, dict[str, str | float | int]] = {}
    for item in payload.items:
        if item.project_id not in project_items:
            project_items[item.project_id] = {
                'project_name': item.project_name.strip(),
                'income_total_usd': item.income_total_usd,
                'factory_commission_rate': item.factory_commission_rate,
                'usd_to_rmb_rate': item.usd_to_rmb_rate,
            }
            continue
        project_items[item.project_id].update(
            {
                'project_name': item.project_name.strip(),
                'income_total_usd': item.income_total_usd,
                'factory_commission_rate': item.factory_commission_rate,
                'usd_to_rmb_rate': item.usd_to_rmb_rate,
            }
        )

    existing_project_months = db.execute(
        select(CommissionProjectMonth).where(CommissionProjectMonth.report_month == report_month)
    ).scalars().all()
    project_month_map = {row.project_id: row for row in existing_project_months}

    for project_id, values in project_items.items():
        project_month_row = project_month_map.get(project_id)
        if project_month_row is None:
            project_month_row = CommissionProjectMonth(
                report_month=report_month,
                project_id=project_id,
                project_name=str(values['project_name']).strip(),
                payment_status=CommissionProjectPaymentStatus.unpaid.value,
            )
            db.add(project_month_row)
            project_month_map[project_id] = project_month_row

        income_total_usd = _to_decimal(values['income_total_usd'], '0.01')
        factory_commission_rate = _to_decimal(values['factory_commission_rate'], '0.000001')
        usd_to_rmb_rate = _to_decimal(values['usd_to_rmb_rate'], '0.00000001')
        factory_commission_usd = _to_decimal(income_total_usd * factory_commission_rate, '0.01')
        factory_commission_rmb = _to_decimal(factory_commission_usd * usd_to_rmb_rate, '0.01')

        project_month_row.project_name = str(values['project_name']).strip()
        project_month_row.income_total_usd = income_total_usd
        project_month_row.factory_commission_rate = factory_commission_rate
        project_month_row.usd_to_rmb_rate = usd_to_rmb_rate
        project_month_row.factory_commission_usd = factory_commission_usd
        project_month_row.factory_commission_rmb = factory_commission_rmb
        project_month_row.computed_at = now

    db.flush()

    existing_rows = db.execute(
        select(CommissionRecord).where(CommissionRecord.report_month == report_month)
    ).scalars().all()
    existing_map = {
        (row.project_id, row.person_name, row.income_category): row
        for row in existing_rows
    }
    incoming_keys: set[tuple[int, str, str]] = set()

    for item in payload.items:
        key = (item.project_id, item.person_name.strip(), item.income_category.value)
        if not key[1]:
            continue
        incoming_keys.add(key)

        project_month_row = project_month_map.get(item.project_id)
        row = existing_map.get(key)
        if row is None:
            row = CommissionRecord(
                report_month=report_month,
                project_id=item.project_id,
                project_name=item.project_name.strip(),
                project_month_id=project_month_row.id if project_month_row else None,
                person_name=item.person_name.strip(),
                income_category=item.income_category.value,
                payment_status=CommissionPaymentStatus.unpaid.value,
                is_active=True,
            )
            db.add(row)
            existing_map[key] = row

        row.project_name = item.project_name.strip()
        row.project_month_id = project_month_row.id if project_month_row else None
        row.is_active = True
        row.deactivated_at = None
        if row.is_locked:
            continue

        ratio_source = item.ratio_source
        manual_ratio_value: float | None = item.manual_ratio
        if manual_ratio_value is not None:
            ratio_source = CommissionRatioSource.manual
        try:
            row.income_total_usd = _to_decimal(item.income_total_usd, '0.01')
            row.factory_commission_rate = _to_decimal(item.factory_commission_rate, '0.000001')
            row.public_commission_ratio = _to_decimal(item.public_commission_ratio, '0.000001')
            row.commission_amount_usd = _to_decimal(item.commission_amount_usd, '0.01')
            row.usd_to_rmb_rate = _to_decimal(item.usd_to_rmb_rate, '0.00000001')
            row.commission_amount_rmb = _to_decimal(item.commission_amount_rmb, '0.01')
            row.ratio_source = ratio_source.value
            row.manual_ratio = _to_decimal(manual_ratio_value, '0.000001') if manual_ratio_value is not None else None
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        row.computed_at = now

    stale_rows = [row for old_key, row in existing_map.items() if old_key not in incoming_keys and row.is_active]
    for stale in stale_rows:
        stale.is_active = False
        stale.deactivated_at = now

    db.commit()

    rows = db.execute(
        select(CommissionRecord)
        .where(CommissionRecord.report_month == report_month, CommissionRecord.is_active.is_(True))
        .order_by(
            CommissionRecord.person_name.asc(),
            CommissionRecord.project_name.asc(),
            CommissionRecord.income_category.asc(),
        )
    ).scalars().all()
    return CommissionRecordsResponse(
        report_month=report_month,
        items=[_serialize_commission_record(row) for row in rows],
    )


@router.get('/commission-management/records', response_model=CommissionRecordsResponse)
def list_commission_records(
    report_month: str,
    person_name: str | None = None,
    include_inactive: bool = False,
    db: Session = Depends(get_db_session),
) -> CommissionRecordsResponse:
    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    stmt = select(CommissionRecord).where(CommissionRecord.report_month == month)
    if include_inactive is False:
        stmt = stmt.where(CommissionRecord.is_active.is_(True))
    normalized_person = (person_name or '').strip()
    if normalized_person:
        stmt = stmt.where(CommissionRecord.person_name == normalized_person)
    stmt = stmt.order_by(
        CommissionRecord.person_name.asc(),
        CommissionRecord.project_name.asc(),
        CommissionRecord.income_category.asc(),
    )

    rows = db.execute(stmt).scalars().all()
    return CommissionRecordsResponse(
        report_month=month,
        items=[_serialize_commission_record(row) for row in rows],
    )


@router.patch('/commission-management/records/{record_id}/payment-status', response_model=UpdateCommissionPaymentStatusResponse)
def update_commission_payment_status(
    record_id: int,
    payload: UpdateCommissionPaymentStatusRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateCommissionPaymentStatusResponse:
    row = db.execute(select(CommissionRecord).where(CommissionRecord.id == record_id)).scalars().first()
    if row is None:
        raise HTTPException(status_code=404, detail='record not found')

    now = _now().replace(microsecond=0)
    row.payment_status = payload.payment_status.value
    if payload.payment_status == CommissionPaymentStatus.paid:
        row.payment_confirmed_at = now
        row.payment_confirmed_by = (operator or '').strip() or None
        row.is_locked = True
        row.locked_at = now
        row.locked_by = (operator or '').strip() or None
    else:
        row.payment_confirmed_at = None
        row.payment_confirmed_by = None
        row.is_locked = False
        row.locked_at = None
        row.locked_by = None
    row.updated_at = now
    db.commit()
    db.refresh(row)
    return UpdateCommissionPaymentStatusResponse(item=_serialize_commission_record(row))


@router.get('/commission-management/project-months', response_model=CommissionProjectMonthsResponse)
def list_commission_project_months(
    report_month: str,
    db: Session = Depends(get_db_session),
) -> CommissionProjectMonthsResponse:
    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    rows = db.execute(
        select(CommissionProjectMonth)
        .where(CommissionProjectMonth.report_month == month)
        .order_by(CommissionProjectMonth.project_id.asc())
    ).scalars().all()
    return CommissionProjectMonthsResponse(report_month=month, items=[_serialize_project_month(row) for row in rows])


@router.get('/commission-management/summary/monthly', response_model=CommissionYearlyMonthlySummaryResponse)
def list_commission_yearly_monthly_summary(
    year: str,
    db: Session = Depends(get_db_session),
) -> CommissionYearlyMonthlySummaryResponse:
    try:
        normalized_year = _parse_year(year)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    month_start = f'{normalized_year}-01'
    month_end = f'{normalized_year}-12'
    rows = db.execute(
        select(
            CommissionProjectMonth.report_month,
            func.sum(CommissionProjectMonth.income_total_usd).label('income_total_usd'),
            func.sum(CommissionProjectMonth.factory_commission_usd).label('factory_commission_usd'),
            func.sum(CommissionProjectMonth.factory_commission_rmb).label('factory_commission_rmb'),
            func.sum(CommissionProjectMonth.received_rmb).label('received_rmb'),
        )
        .where(
            CommissionProjectMonth.report_month >= month_start,
            CommissionProjectMonth.report_month <= month_end,
        )
        .group_by(CommissionProjectMonth.report_month)
        .order_by(CommissionProjectMonth.report_month.asc())
    ).all()

    monthly_map: dict[str, tuple[float, float, float, float]] = {}
    for report_month, income_total_usd, factory_commission_usd, factory_commission_rmb, received_rmb in rows:
        monthly_map[str(report_month)] = (
            float(income_total_usd or 0),
            float(factory_commission_usd or 0),
            float(factory_commission_rmb or 0),
            float(received_rmb or 0),
        )

    items: list[CommissionYearlyMonthlySummaryItem] = []
    for month in range(1, 13):
        report_month = f'{normalized_year}-{month:02d}'
        income_total_usd, factory_commission_usd, factory_commission_rmb, received_rmb = monthly_map.get(
            report_month,
            (0.0, 0.0, 0.0, 0.0),
        )
        receive_rate = 0.0
        if factory_commission_rmb > 0:
            receive_rate = received_rmb / factory_commission_rmb
        items.append(
            CommissionYearlyMonthlySummaryItem(
                report_month=report_month,
                income_total_usd=income_total_usd,
                factory_commission_usd=factory_commission_usd,
                factory_commission_rmb=factory_commission_rmb,
                received_rmb=received_rmb,
                receive_rate=receive_rate,
            )
        )

    return CommissionYearlyMonthlySummaryResponse(year=normalized_year, items=items)


@router.get('/commission-management/summary/project', response_model=CommissionProjectYearlySummaryResponse)
def list_commission_project_yearly_summary(
    year: str,
    db: Session = Depends(get_db_session),
) -> CommissionProjectYearlySummaryResponse:
    try:
        normalized_year = _parse_year(year)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    month_start = f'{normalized_year}-01'
    month_end = f'{normalized_year}-12'
    rows = db.execute(
        select(
            CommissionProjectMonth.project_id,
            CommissionProjectMonth.project_name,
            CommissionProjectMonth.report_month,
            CommissionProjectMonth.income_total_usd,
            CommissionProjectMonth.factory_commission_rmb,
            CommissionProjectMonth.received_rmb,
        )
        .where(
            CommissionProjectMonth.report_month >= month_start,
            CommissionProjectMonth.report_month <= month_end,
        )
        .order_by(CommissionProjectMonth.project_id.asc(), CommissionProjectMonth.report_month.asc())
    ).all()

    project_map: dict[int, CommissionProjectYearlySummaryItem] = {}
    for project_id, project_name, report_month, income_total_usd, factory_commission_rmb, received_rmb in rows:
        normalized_project_id = int(project_id)
        item = project_map.get(normalized_project_id)
        if item is None:
            item = CommissionProjectYearlySummaryItem(
                project_id=normalized_project_id,
                project_name=str(project_name),
                months={},
                total_income_usd=0,
                total_commission_rmb=0,
                total_received_rmb=0,
                receive_rate=0,
            )
            project_map[normalized_project_id] = item

        income_value = float(income_total_usd or 0)
        commission_value = float(factory_commission_rmb or 0)
        received_value = float(received_rmb or 0)
        month_receive_rate = (received_value / commission_value) if commission_value > 0 else 0

        item.months[str(report_month)] = CommissionProjectMonthlySummaryMonthItem(
            report_month=str(report_month),
            income_total_usd=income_value,
            factory_commission_rmb=commission_value,
            received_rmb=received_value,
            receive_rate=month_receive_rate,
        )
        item.total_income_usd += income_value
        item.total_commission_rmb += commission_value
        item.total_received_rmb += received_value

    items = list(project_map.values())
    for item in items:
        item.receive_rate = (item.total_received_rmb / item.total_commission_rmb) if item.total_commission_rmb > 0 else 0

    items.sort(key=lambda item: item.project_id)
    return CommissionProjectYearlySummaryResponse(year=normalized_year, items=items)


@router.patch(
    '/commission-management/project-months/{project_month_id}/payment',
    response_model=UpdateCommissionProjectPaymentResponse,
)
def update_commission_project_payment(
    project_month_id: int,
    payload: UpdateCommissionProjectPaymentRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateCommissionProjectPaymentResponse:
    row = db.execute(select(CommissionProjectMonth).where(CommissionProjectMonth.id == project_month_id)).scalars().first()
    if row is None:
        raise HTTPException(status_code=404, detail='project month record not found')

    now = _now().replace(microsecond=0)
    row.payment_status = payload.payment_status.value
    row.received_rmb = _to_decimal(payload.received_rmb, '0.01')
    row.note = (payload.note or '').strip() or None

    if payload.payment_status == CommissionProjectPaymentStatus.unpaid:
        row.payment_confirmed_at = None
        row.payment_confirmed_by = None
    else:
        row.payment_confirmed_at = now
        row.payment_confirmed_by = (operator or '').strip() or None
    row.updated_at = now

    if payload.payment_status == CommissionProjectPaymentStatus.paid:
        paid_rows = db.execute(
            select(CommissionRecord).where(
                CommissionRecord.project_month_id == project_month_id,
                CommissionRecord.is_active.is_(True),
            )
        ).scalars().all()
        for commission_row in paid_rows:
            commission_row.payment_status = CommissionPaymentStatus.paid.value
            commission_row.payment_confirmed_at = now
            commission_row.payment_confirmed_by = row.payment_confirmed_by
            commission_row.is_locked = True
            commission_row.locked_at = now
            commission_row.locked_by = row.payment_confirmed_by
    else:
        unpaid_rows = db.execute(
            select(CommissionRecord).where(
                CommissionRecord.project_month_id == project_month_id,
                CommissionRecord.is_active.is_(True),
            )
        ).scalars().all()
        for commission_row in unpaid_rows:
            commission_row.payment_status = CommissionPaymentStatus.unpaid.value
            commission_row.payment_confirmed_at = None
            commission_row.payment_confirmed_by = None
            commission_row.is_locked = False
            commission_row.locked_at = None
            commission_row.locked_by = None

    db.commit()
    db.refresh(row)
    return UpdateCommissionProjectPaymentResponse(item=_serialize_project_month(row))


@router.post('/commission-management/ratio-overrides/upsert', response_model=CommissionRatioOverridesResponse)
def upsert_commission_ratio_overrides(
    payload: UpsertCommissionRatioOverridesRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionRatioOverridesResponse:
    try:
        report_month = _parse_report_month(payload.report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    existing_rows = db.execute(
        select(CommissionRatioOverride).where(CommissionRatioOverride.report_month == report_month)
    ).scalars().all()
    existing_map = {(row.project_id, row.person_name, row.income_category): row for row in existing_rows}

    incoming_keys: set[tuple[int, str, str]] = set()
    for item in payload.items:
        key = (item.project_id, item.person_name.strip(), item.income_category.value)
        if not key[1]:
            continue
        incoming_keys.add(key)
        row = existing_map.get(key)
        if row is None:
            row = CommissionRatioOverride(
                report_month=report_month,
                project_id=item.project_id,
                project_name=item.project_name.strip(),
                person_name=item.person_name.strip(),
                income_category=item.income_category.value,
                override_ratio=_to_decimal(item.override_ratio, '0.000001'),
            )
            db.add(row)
            existing_map[key] = row
        else:
            row.project_name = item.project_name.strip()
            row.override_ratio = _to_decimal(item.override_ratio, '0.000001')
        row.reason = (item.reason or '').strip() or None
        row.updated_by = (operator or '').strip() or None

    stale_rows = [row for key, row in existing_map.items() if key not in incoming_keys]
    for stale in stale_rows:
        db.delete(stale)

    db.commit()
    rows = db.execute(
        select(CommissionRatioOverride)
        .where(CommissionRatioOverride.report_month == report_month)
        .order_by(
            CommissionRatioOverride.person_name.asc(),
            CommissionRatioOverride.project_name.asc(),
            CommissionRatioOverride.income_category.asc(),
        )
    ).scalars().all()
    return CommissionRatioOverridesResponse(
        report_month=report_month,
        items=[_serialize_ratio_override(row) for row in rows],
    )


@router.get('/commission-management/ratio-overrides', response_model=CommissionRatioOverridesResponse)
def list_commission_ratio_overrides(
    report_month: str,
    db: Session = Depends(get_db_session),
) -> CommissionRatioOverridesResponse:
    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    rows = db.execute(
        select(CommissionRatioOverride)
        .where(CommissionRatioOverride.report_month == month)
        .order_by(
            CommissionRatioOverride.person_name.asc(),
            CommissionRatioOverride.project_name.asc(),
            CommissionRatioOverride.income_category.asc(),
        )
    ).scalars().all()
    return CommissionRatioOverridesResponse(report_month=month, items=[_serialize_ratio_override(row) for row in rows])


@router.get('/commission-management/role-assignments', response_model=ProjectRoleAssignmentsResponse)
def list_project_role_assignments(
    report_month: str | None = None,
    project_id: int | None = None,
    db: Session = Depends(get_db_session),
) -> ProjectRoleAssignmentsResponse:
    stmt = select(ProjectRoleAssignment)
    if project_id is not None and project_id > 0:
        stmt = stmt.where(ProjectRoleAssignment.project_id == project_id)
    if report_month:
        month = _parse_report_month(report_month)
        stmt = stmt.where(
            ProjectRoleAssignment.effective_from_month <= month,
            (ProjectRoleAssignment.effective_to_month.is_(None) | (ProjectRoleAssignment.effective_to_month >= month)),
        )
    stmt = stmt.order_by(
        ProjectRoleAssignment.project_id.asc(),
        ProjectRoleAssignment.role_type.asc(),
        ProjectRoleAssignment.effective_from_month.asc(),
        ProjectRoleAssignment.person_name.asc(),
    )
    rows = db.execute(stmt).scalars().all()
    return ProjectRoleAssignmentsResponse(items=[_serialize_role_assignment(row) for row in rows])


@router.post('/commission-management/role-assignments/upsert', response_model=ProjectRoleAssignmentsResponse)
def upsert_project_role_assignments(
    payload: UpsertProjectRoleAssignmentsRequest,
    db: Session = Depends(get_db_session),
) -> ProjectRoleAssignmentsResponse:
    for item in payload.items:
        from_month = _parse_report_month(item.effective_from_month)
        to_month = _parse_report_month(item.effective_to_month) if item.effective_to_month else None
        if to_month is not None and to_month < from_month:
            raise HTTPException(status_code=422, detail='effective_to_month must be greater than or equal to effective_from_month')

        row = None
        if item.id is not None:
            row = db.execute(select(ProjectRoleAssignment).where(ProjectRoleAssignment.id == item.id)).scalars().first()
        if row is None:
            row = ProjectRoleAssignment(
                project_id=item.project_id,
                role_type=item.role_type.value,
                person_name=item.person_name.strip(),
                effective_from_month=from_month,
                effective_to_month=to_month,
            )
            db.add(row)
        else:
            row.project_id = item.project_id
            row.role_type = item.role_type.value
            row.person_name = item.person_name.strip()
            row.effective_from_month = from_month
            row.effective_to_month = to_month

    db.commit()
    rows = db.execute(
        select(ProjectRoleAssignment).order_by(
            ProjectRoleAssignment.project_id.asc(),
            ProjectRoleAssignment.role_type.asc(),
            ProjectRoleAssignment.effective_from_month.asc(),
            ProjectRoleAssignment.person_name.asc(),
        )
    ).scalars().all()
    return ProjectRoleAssignmentsResponse(items=[_serialize_role_assignment(row) for row in rows])
