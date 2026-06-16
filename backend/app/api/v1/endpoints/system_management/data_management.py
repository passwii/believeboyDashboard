"""
数据管理端点。
"""
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from sqlalchemy.engine.url import make_url
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, get_request_operator, protected
from app.core.config import get_settings

from app.schemas.system_management.data_management import (
    ClearCacheResponse,
    DataManagementStatusResponse,
    DataManagementOverviewResponse,
    DataSummary,
    DatabaseStatus,
    DataLifecycleStatus,
    TableStatusItem,
    RecentSystemStatusItem,
    UpdateDataStatusRequest,
    UpdateDataStatusResponse,
)

from app.services.audit_log_service import append_operation_view_log, append_operation_audit_log
from app.services.system_management import (
    _check_database,
    _load_data_state,
    _collect_table_statuses,
    _collect_recent_statuses,
    set_data_status,
)
from app.services.infra import (
    clear_all_caches,
    get_data_management_overview_cache,
    invalidate_data_management_overview_cache,
    set_data_management_overview_cache,
)


router = APIRouter(prefix="/data-management", tags=["数据管理"])
performance_logger = logging.getLogger("app.performance")


def _resolve_database_source(database_url: str) -> tuple[str, str | None]:
    try:
        url = make_url(database_url)
    except Exception:
        return "unknown", None
    source: str | None = None
    if url.host:
        source = f"{url.host}/{url.database}" if url.database else url.host
    return url.host or "unknown", source


@router.get("/status", response_model=DataManagementStatusResponse)
def get_data_management_status(
    request: Request,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
) -> DataManagementStatusResponse:
    from app.services.system_management import _load_data_state

    settings = get_settings()
    db_healthy, checked_at = _check_database(db)
    engine, source = _resolve_database_source(settings.database_url)
    data_status, note, updated_by, updated_at = _load_data_state(db)

    append_operation_view_log(
        db,
        action="system.data_management.status.view",
        target_type="system_management",
        operator=operator,
        after={"data_status": data_status, "database_healthy": db_healthy},
        request=request,
    )
    db.commit()

    return DataManagementStatusResponse(
        server_time=checked_at,
        database=DatabaseStatus(engine=engine, source=source, healthy=db_healthy, checked_at=checked_at),
        cache_enabled=False,
        summary=DataSummary(total_tables=0, total_rows=0, stale_tables=0, data_status=DataLifecycleStatus(data_status)),
        data_status_note=note,
        data_status_updated_at=updated_at,
        data_status_updated_by=updated_by,
    )


@router.get("/overview", response_model=DataManagementOverviewResponse)
def get_data_management_overview(
    request: Request,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
) -> DataManagementOverviewResponse:
    from app.services.system_management import (
        _load_data_state,
        _collect_table_statuses,
        _collect_recent_statuses,
        _check_database,
    )
    from app.schemas.system_management.data_management import TableHealthStatus

    overall_started_at = datetime.now().astimezone()
    cached = get_data_management_overview_cache()
    if cached is not None:
        performance_logger.info("data_management_overview cache=hit duration_ms=0")
        return DataManagementOverviewResponse(**cached)

    t0 = datetime.now().astimezone()
    settings = get_settings()
    db_healthy, checked_at = _check_database(db)
    engine, source = _resolve_database_source(settings.database_url)
    db_check_ms = int((datetime.now().astimezone() - t0).total_seconds() * 1000)

    t0 = datetime.now().astimezone()
    data_status, note, updated_by, updated_at = _load_data_state(db)
    data_state_ms = int((datetime.now().astimezone() - t0).total_seconds() * 1000)

    t0 = datetime.now().astimezone()
    table_statuses, total_rows, stale_tables = _collect_table_statuses(db)
    table_scan_ms = int((datetime.now().astimezone() - t0).total_seconds() * 1000)

    t0 = datetime.now().astimezone()
    recent_statuses = _collect_recent_statuses(db, data_status, checked_at)
    recent_ms = int((datetime.now().astimezone() - t0).total_seconds() * 1000)

    # Build typed table items
    typed_tables = [
        TableStatusItem(
            table_name=s["table_name"],
            table_name_cn=s["table_name_cn"],
            row_count=s["row_count"],
            last_updated_at=s["last_updated_at"],
            status=TableHealthStatus(s["status"]),
            note=s["note"],
        )
        for s in table_statuses
    ]
    typed_recent = [
        RecentSystemStatusItem(source=r["source"], level=r["level"], message=r["message"], occurred_at=r["occurred_at"])
        for r in recent_statuses
    ]

    payload = DataManagementOverviewResponse(
        server_time=checked_at,
        database=DatabaseStatus(engine=engine, source=source, healthy=db_healthy, checked_at=checked_at),
        cache_enabled=False,
        summary=DataSummary(total_tables=len(table_statuses), total_rows=total_rows, stale_tables=stale_tables, data_status=DataLifecycleStatus(data_status)),
        data_status_note=note,
        data_status_updated_at=updated_at,
        data_status_updated_by=updated_by,
        tables=typed_tables,
        recent_statuses=typed_recent,
    )
    append_operation_view_log(
        db,
        action="system.data_management.overview.view",
        target_type="system_management",
        operator=operator,
        after={"total_tables": len(table_statuses), "total_rows": total_rows, "stale_tables": stale_tables, "recent_status_count": len(recent_statuses)},
        request=request,
    )
    db.commit()
    set_data_management_overview_cache(payload.model_dump(mode="json"))

    perf_ms = int((datetime.now().astimezone() - overall_started_at).total_seconds() * 1000)
    performance_logger.info(
        "data_management_overview cache=miss total_ms=%s db_check_ms=%s data_state_ms=%s table_scan_ms=%s recent_statuses_ms=%s tables=%s total_rows=%s",
        perf_ms, db_check_ms, data_state_ms, table_scan_ms, recent_ms, len(table_statuses), total_rows,
    )
    return payload


@router.patch("/data-status", response_model=UpdateDataStatusResponse)
def update_data_status(
    payload: UpdateDataStatusRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateDataStatusResponse:
    from app.services.system_management import _load_data_state, set_data_status

    before_status, before_note, before_updated_by, before_updated_at = _load_data_state(db)

    new_status, note, updated_by, updated_at = set_data_status(
        db,
        status=payload.status.value,
        note=payload.note,
        updated_by=operator,
    )

    append_operation_audit_log(
        db,
        action="system.data_status.update",
        target_type="system_management_data_state",
        target_id="1",
        operator=operator,
        before={"status": before_status, "note": before_note, "updated_by": before_updated_by, "updated_at": before_updated_at},
        after={"status": new_status, "note": note, "updated_by": updated_by, "updated_at": updated_at},
        request=request,
    )
    invalidate_data_management_overview_cache()

    return UpdateDataStatusResponse(
        status=payload.status,
        note=payload.note,
        updated_at=updated_at,
        updated_by=operator,
    )


# Cache 端点单独处理
cache_router = APIRouter(prefix="/cache", tags=["缓存管理"])


@cache_router.post("/clear-all", response_model=ClearCacheResponse)
def clear_all_cache(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ClearCacheResponse:
    from app.services.audit_log_service import append_operation_audit_log

    deleted_count = clear_all_caches()
    append_operation_audit_log(db, action="system.cache.clear_all", target_type="redis_cache", target_id="all", operator=operator, after={"deleted_count": deleted_count}, request=request)
    db.commit()
    return ClearCacheResponse(deleted_count=deleted_count, message=f"成功清理 {deleted_count} 个缓存键")