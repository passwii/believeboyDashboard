from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import MetaData, Table, func, inspect, select, text
from sqlalchemy.engine.url import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import get_settings
from app.schemas.system_management import (
    DataLifecycleStatus,
    DataManagementOverviewResponse,
    DataManagementStatusResponse,
    DataSummary,
    DatabaseStatus,
    RecentSystemStatusItem,
    TableHealthStatus,
    TableStatusItem,
    UpdateDataStatusRequest,
    UpdateDataStatusResponse,
)

router = APIRouter(prefix='/system-management', dependencies=[Depends(protected)])

DATA_STATE_TABLE = 'system_management_data_state'
STALE_WINDOW_HOURS = 72


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
