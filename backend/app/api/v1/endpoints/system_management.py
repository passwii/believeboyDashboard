from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.engine.url import make_url
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.core.config import get_settings
from app.schemas.system_management import CacheClearResponse, CacheStatus, DataManagementStatusResponse, DatabaseStatus
from app.services import product_cost_cache_service

router = APIRouter(prefix='/system-management', dependencies=[Depends(protected)])


def _format_unix_ts(timestamp: int | None) -> str | None:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp).astimezone().isoformat(timespec='seconds')


def _coerce_optional_int(value: object) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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


@router.get('/data-management/status', response_model=DataManagementStatusResponse)
def get_data_management_status(db: Session = Depends(get_db_session)) -> DataManagementStatusResponse:
    settings = get_settings()
    checked_at = datetime.now().astimezone().isoformat(timespec='seconds')

    db_healthy = True
    try:
        db.execute(text('select 1'))
    except Exception:
        db_healthy = False

    db_engine, db_source = _resolve_database_source(settings.database_url)
    cache_raw_status = product_cost_cache_service.get_cache_status(settings)
    cache_status = CacheStatus(
        sqlite_path=str(cache_raw_status['sqlite_path']),
        exists=bool(cache_raw_status['exists']),
        file_size_bytes=int(cache_raw_status['file_size_bytes']),
        ttl_seconds=int(cache_raw_status['ttl_seconds']),
        total_entries=int(cache_raw_status['total_entries']),
        expired_entries=int(cache_raw_status['expired_entries']),
        active_entries=int(cache_raw_status['active_entries']),
        latest_updated_at=_format_unix_ts(_coerce_optional_int(cache_raw_status.get('latest_updated_at'))),
        nearest_expire_at=_format_unix_ts(_coerce_optional_int(cache_raw_status.get('nearest_expire_at'))),
    )
    return DataManagementStatusResponse(
        server_time=checked_at,
        database=DatabaseStatus(
            engine=db_engine,
            source=db_source,
            healthy=db_healthy,
            checked_at=checked_at,
        ),
        cache=cache_status,
    )


@router.post('/data-management/cache/clear', response_model=CacheClearResponse)
def clear_data_management_cache() -> CacheClearResponse:
    settings = get_settings()
    removed_entries = product_cost_cache_service.clear_all_cache(settings)
    return CacheClearResponse(
        cleared_at=datetime.now().astimezone().isoformat(timespec='seconds'),
        removed_entries=removed_entries,
    )
