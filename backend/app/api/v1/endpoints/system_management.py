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
from app.models.commission_record import CommissionRecord
from app.schemas.system_management import (
    CommissionIncomeCategory,
    CommissionPaymentStatus,
    CommissionRecordItem,
    CommissionRecordsResponse,
    DataLifecycleStatus,
    DataManagementOverviewResponse,
    DataManagementStatusResponse,
    DataSummary,
    DatabaseStatus,
    RecentSystemStatusItem,
    TableHealthStatus,
    TableStatusItem,
    UpdateCommissionPaymentStatusRequest,
    UpdateCommissionPaymentStatusResponse,
    UpdateDataStatusRequest,
    UpdateDataStatusResponse,
    UpsertCommissionRecordsRequest,
)

router = APIRouter(prefix='/system-management', dependencies=[Depends(protected)])

DATA_STATE_TABLE = 'system_management_data_state'
STALE_WINDOW_HOURS = 72
REPORT_MONTH_RE = re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')


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
        person_name=row.person_name,
        income_category=CommissionIncomeCategory(row.income_category),
        income_total_usd=float(row.income_total_usd),
        factory_commission_rate=float(row.factory_commission_rate),
        public_commission_ratio=float(row.public_commission_ratio),
        commission_amount_usd=float(row.commission_amount_usd),
        usd_to_rmb_rate=float(row.usd_to_rmb_rate),
        commission_amount_rmb=float(row.commission_amount_rmb),
        payment_status=CommissionPaymentStatus(row.payment_status),
        payment_confirmed_at=_to_iso(row.payment_confirmed_at),
        payment_confirmed_by=row.payment_confirmed_by,
        computed_at=_to_iso(row.computed_at) or '',
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

        row = existing_map.get(key)
        if row is None:
            row = CommissionRecord(
                report_month=report_month,
                project_id=item.project_id,
                project_name=item.project_name.strip(),
                person_name=item.person_name.strip(),
                income_category=item.income_category.value,
                payment_status=CommissionPaymentStatus.unpaid.value,
            )
            db.add(row)
            existing_map[key] = row

        row.project_name = item.project_name.strip()
        try:
            row.income_total_usd = _to_decimal(item.income_total_usd, '0.01')
            row.factory_commission_rate = _to_decimal(item.factory_commission_rate, '0.000001')
            row.public_commission_ratio = _to_decimal(item.public_commission_ratio, '0.000001')
            row.commission_amount_usd = _to_decimal(item.commission_amount_usd, '0.01')
            row.usd_to_rmb_rate = _to_decimal(item.usd_to_rmb_rate, '0.00000001')
            row.commission_amount_rmb = _to_decimal(item.commission_amount_rmb, '0.01')
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        row.computed_at = now

    stale_rows = [row for old_key, row in existing_map.items() if old_key not in incoming_keys]
    for stale in stale_rows:
        db.delete(stale)

    db.commit()

    rows = db.execute(
        select(CommissionRecord)
        .where(CommissionRecord.report_month == report_month)
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
    db: Session = Depends(get_db_session),
) -> CommissionRecordsResponse:
    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    stmt = select(CommissionRecord).where(CommissionRecord.report_month == month)
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
    else:
        row.payment_confirmed_at = None
        row.payment_confirmed_by = None
    row.updated_at = now
    db.commit()
    db.refresh(row)
    return UpdateCommissionPaymentStatusResponse(item=_serialize_commission_record(row))
