from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import logging
from pathlib import Path
import re


from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import MetaData, Table, case, func, inspect, or_, select, text
from sqlalchemy.engine.url import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import get_settings
from app.services.redis_service import (
    get_data_management_overview_cache,
    set_data_management_overview_cache,
    invalidate_data_management_overview_cache,
    clear_all_caches,
)
from app.models.commission_project_month import CommissionProjectMonth
from app.models.commission_record import CommissionRecord
from app.models.commission_ratio_override import CommissionRatioOverride
from app.models.exchange_rate import ExchangeRate
from app.models.monthly_report import MonthlyReport, MonthlyReportPT4Calculation
from app.models.operation_audit_log import OperationAuditLog
from app.models.operator_performance_record import OperatorPerformanceRecord
from app.models.project import Project
from app.models.project_role_assignment import ProjectRoleAssignment
from app.schemas.system_management import (
    ClearCacheResponse,
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
    OperationAuditLogItem,
    OperationAuditClientActionRequest,
    OperationAuditLogsResponse,
    OperationAuditLogsSummaryResponse,
    OperatorPerformanceItem,
    OperatorPerformanceResponse,
    OperationAuditLogModuleSummaryItem,
    OperationAuditLogActionSummaryItem,
    CommissionRecordItem,
    CommissionRecordsResponse,
    CommissionYearlyMonthlySummaryItem,
    CommissionYearlyMonthlySummaryResponse,
    UpdateCommissionProjectPaymentRequest,
    UpdateCommissionProjectPaymentResponse,
    RecomputeCommissionRequest,
    RecomputeCommissionResponse,
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
    UpsertOperatorPerformanceRequest,
)
from app.services.audit_log_service import (
    append_operation_audit_log,
    append_operation_view_log,
)

router = APIRouter(prefix="/system-management", dependencies=[Depends(protected)])
performance_logger = logging.getLogger("app.performance")

DATA_STATE_TABLE = "system_management_data_state"
STALE_WINDOW_HOURS = 72
REPORT_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
YEAR_RE = re.compile(r"^\d{4}$")
MULTI_NAME_SPLIT_RE = re.compile(r"[、,，;\n]+")
OPERATOR_BONUS_RATIO_TIERS: tuple[tuple[Decimal, Decimal], ...] = (
    (Decimal("10000"), Decimal("0.12")),
    (Decimal("50000"), Decimal("0.14")),
    (Decimal("150000"), Decimal("0.16")),
    (Decimal("450000"), Decimal("0.18")),
)
ASSISTANT_BONUS_RATIO = Decimal("0.02")
PASSIVE_AUDIT_ACTION_PATTERNS = (
    "%.list",
    "%.view",
)


@router.post("/operation-audit-logs/client-actions")
def create_client_operation_audit_log(
    payload: OperationAuditClientActionRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> dict[str, bool]:
    append_operation_audit_log(
        db,
        action=payload.action,
        target_type=payload.target_type,
        target_id=payload.target_id,
        operator=operator,
        result=payload.result,
        after=payload.after,
        error_message=payload.error_message,
        request=request,
    )
    db.commit()
    return {"ok": True}


def _resolve_database_source(database_url: str) -> tuple[str, str | None]:
    try:
        url = make_url(database_url)
    except Exception:
        return "unknown", None

    engine = url.get_backend_name()
    source: str | None = None
    if engine == "sqlite":
        raw_database = url.database or ""
        if raw_database and raw_database != ":memory:":
            source = str(Path(raw_database).resolve())
        else:
            source = raw_database or ":memory:"
    elif url.host:
        if url.database:
            source = f"{url.host}/{url.database}"
        else:
            source = url.host
    return engine, source


def _to_iso(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if value.tzinfo is None:
        return value.isoformat(timespec="seconds")
    return value.astimezone().isoformat(timespec="seconds")


def _now() -> datetime:
    return datetime.now().astimezone()


def _parse_report_month(value: str) -> str:
    normalized = value.strip()
    if not REPORT_MONTH_RE.match(normalized):
        raise ValueError("report_month must be in YYYY-MM format")
    return normalized


def _parse_year(value: str) -> str:
    normalized = value.strip()
    if not YEAR_RE.match(normalized):
        raise ValueError("year must be in YYYY format")
    return normalized


def _to_decimal(value: float | int | str, scale: str = "0.000000") -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError("invalid decimal value") from None
    return parsed.quantize(Decimal(scale), rounding=ROUND_HALF_UP)


def _normalize_rate_decimal(value: Decimal | None) -> Decimal:
    if value is None:
        return Decimal("0")
    if value <= 0:
        return Decimal("0")
    if value >= 1:
        return Decimal("1")
    return value


def _resolve_factory_commission(
    commission_basis: str | None,
    configured_commission_rate: Decimal | None,
    income_total_usd: Decimal,
    amazon_pay_back_usd: Decimal,
) -> tuple[Decimal, Decimal, Decimal]:
    normalized_income = max(income_total_usd, Decimal("0"))
    normalized_payback = max(amazon_pay_back_usd, Decimal("0"))

    if commission_basis == "cash_received":
        payback_ratio = (
            (normalized_payback / normalized_income)
            if normalized_income > 0
            else Decimal("0")
        )
        if payback_ratio < Decimal("0.4"):
            commission_rate = Decimal("0")
        elif payback_ratio < Decimal("0.5"):
            commission_rate = Decimal("0.07")
        elif payback_ratio < Decimal("0.6"):
            commission_rate = Decimal("0.10")
        elif payback_ratio < Decimal("0.7"):
            commission_rate = Decimal("0.13")
        else:
            commission_rate = Decimal("0.15")
        base_amount_usd = normalized_payback
    else:
        commission_rate = _normalize_rate_decimal(configured_commission_rate)
        base_amount_usd = normalized_income

    commission_usd = _to_decimal(base_amount_usd * commission_rate, "0.01")
    return commission_rate, base_amount_usd, commission_usd


def _resolve_operator_bonus_ratio(income_total_usd: Decimal) -> Decimal:
    normalized_income = max(income_total_usd, Decimal("0"))
    for max_inclusive, ratio in OPERATOR_BONUS_RATIO_TIERS:
        if normalized_income <= max_inclusive:
            return ratio
    return Decimal("0.20")


def _build_default_bonus_ratios(
    *,
    income_total_usd: Decimal,
    operator_names: list[str],
    assistant_names: list[str],
) -> dict[tuple[str, str], Decimal]:
    ratio_map: dict[tuple[str, str], Decimal] = {}
    operator_ratio = _resolve_operator_bonus_ratio(income_total_usd)
    assistant_ratio = ASSISTANT_BONUS_RATIO

    if operator_names:
        split_ratio = operator_ratio / Decimal(len(operator_names))
        for person_name in operator_names:
            ratio_map[(person_name, CommissionIncomeCategory.operator.value)] = (
                split_ratio
            )

    if assistant_names:
        split_ratio = assistant_ratio / Decimal(len(assistant_names))
        for person_name in assistant_names:
            ratio_map[(person_name, CommissionIncomeCategory.assistant.value)] = (
                split_ratio
            )

    return ratio_map


def _dedupe_names(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in values:
        normalized = item.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _split_role_names(value: str | None) -> list[str]:
    normalized = (value or "").strip()
    if not normalized:
        return []
    return [
        item.strip() for item in MULTI_NAME_SPLIT_RE.split(normalized) if item.strip()
    ]


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
        operator_bonus_ratio=float(row.operator_bonus_ratio),
        bonus_amount_usd=float(row.bonus_amount_usd),
        usd_to_rmb_rate=float(row.usd_to_rmb_rate),
        bonus_amount_rmb=float(row.bonus_amount_rmb),
        bonus_ratio_source=CommissionRatioSource(row.bonus_ratio_source),
        manual_bonus_ratio=float(row.manual_bonus_ratio)
        if row.manual_bonus_ratio is not None
        else None,
        payment_status=CommissionPaymentStatus(row.payment_status),
        payment_confirmed_at=_to_iso(row.payment_confirmed_at),
        payment_confirmed_by=row.payment_confirmed_by,
        is_locked=bool(row.is_locked),
        locked_at=_to_iso(row.locked_at),
        locked_by=row.locked_by,
        is_active=bool(row.is_active),
        deactivated_at=_to_iso(row.deactivated_at),
        computed_at=_to_iso(row.computed_at) or "",
        updated_at=_to_iso(row.updated_at) or "",
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
        computed_at=_to_iso(row.computed_at) or "",
        updated_at=_to_iso(row.updated_at) or "",
    )


def _serialize_ratio_override(
    row: CommissionRatioOverride,
) -> CommissionRatioOverrideItem:
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
        updated_at=_to_iso(row.updated_at) or "",
    )


def _serialize_role_assignment(row: ProjectRoleAssignment) -> ProjectRoleAssignmentItem:
    return ProjectRoleAssignmentItem(
        id=row.id,
        project_id=row.project_id,
        role_type=row.role_type,
        person_name=row.person_name,
        effective_from_month=row.effective_from_month,
        effective_to_month=row.effective_to_month,
        updated_at=_to_iso(row.updated_at) or "",
    )


def _serialize_operator_performance(
    row: OperatorPerformanceRecord,
) -> OperatorPerformanceItem:
    return OperatorPerformanceItem(
        id=row.id,
        report_month=row.report_month,
        week_index=row.week_index,
        project_id=row.project_id,
        project_name=row.project_name,
        person_name=row.person_name,
        role_type=row.role_type,
        score=int(row.score),
        note=row.note,
        updated_by=row.updated_by,
        updated_at=_to_iso(row.updated_at) or "",
    )


def _serialize_operation_audit_log(row: OperationAuditLog) -> OperationAuditLogItem:
    return OperationAuditLogItem(
        id=row.id,
        created_at=_to_iso(row.created_at) or "",
        operator=row.operator,
        action=row.action,
        target_type=row.target_type,
        target_id=row.target_id,
        result=row.result,
        trace_id=row.trace_id,
        request_method=row.request_method,
        request_path=row.request_path,
        ip_address=row.ip_address,
        user_agent=row.user_agent,
        before_json=row.before_json,
        after_json=row.after_json,
        error_message=row.error_message,
    )


def _apply_audit_log_filters(
    stmt,
    *,
    operator: str | None,
    action: str | None,
    target_type: str | None,
    result: str | None,
    keyword: str | None,
):
    for pattern in PASSIVE_AUDIT_ACTION_PATTERNS:
        stmt = stmt.where(~OperationAuditLog.action.ilike(pattern))

    normalized_operator = (operator or "").strip()
    if normalized_operator:
        stmt = stmt.where(OperationAuditLog.operator.ilike(f"%{normalized_operator}%"))

    normalized_action = (action or "").strip()
    if normalized_action:
        stmt = stmt.where(OperationAuditLog.action.ilike(f"%{normalized_action}%"))

    normalized_target_type = (target_type or "").strip()
    if normalized_target_type:
        stmt = stmt.where(
            OperationAuditLog.target_type.ilike(f"%{normalized_target_type}%")
        )

    normalized_result = (result or "").strip().lower()
    if normalized_result in {"success", "failure"}:
        stmt = stmt.where(OperationAuditLog.result == normalized_result)

    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        like_value = f"%{normalized_keyword}%"
        stmt = stmt.where(
            or_(
                OperationAuditLog.operator.ilike(like_value),
                OperationAuditLog.action.ilike(like_value),
                OperationAuditLog.target_type.ilike(like_value),
                OperationAuditLog.request_path.ilike(like_value),
                OperationAuditLog.target_id.ilike(like_value),
                OperationAuditLog.trace_id.ilike(like_value),
                OperationAuditLog.error_message.ilike(like_value),
            )
        )

    return stmt


def _ensure_data_state_table(db: Session) -> None:
    try:
        db.execute(
            text(
                f"""
                create table if not exists {DATA_STATE_TABLE} (
                    id integer primary key,
                    status varchar(32) not null,
                    note text,
                    updated_by varchar(255),
                    updated_at timestamp not null
                )
                """
            )
        )
        db.commit()
    except IntegrityError as exc:
        # PostgreSQL can still throw duplicate type/namespace on concurrent
        # CREATE TABLE IF NOT EXISTS. Roll back and continue.
        db.rollback()
        if "pg_type_typname_nsp_index" not in str(exc):
            raise


def _load_data_state(
    db: Session,
) -> tuple[DataLifecycleStatus, str | None, str | None, str | None]:
    _ensure_data_state_table(db)
    row = (
        db.execute(
            text(
                f"select status, note, updated_by, updated_at from {DATA_STATE_TABLE} where id = 1"
            )
        )
        .mappings()
        .first()
    )
    if not row:
        return DataLifecycleStatus.active, None, None, None

    raw_status = (row.get("status") or DataLifecycleStatus.active.value).lower()
    try:
        status = DataLifecycleStatus(raw_status)
    except ValueError:
        status = DataLifecycleStatus.active

    return (
        status,
        row.get("note"),
        row.get("updated_by"),
        _to_iso(row.get("updated_at")),
    )


def _check_database(db: Session) -> tuple[bool, str]:
    checked_at = _now().isoformat(timespec="seconds")
    healthy = True
    try:
        db.execute(text("select 1"))
    except Exception:
        healthy = False
    return healthy, checked_at


def _collect_table_statuses(db: Session) -> tuple[list[TableStatusItem], int, int]:
    inspector = inspect(db.bind)
    table_names = sorted(
        name for name in inspector.get_table_names() if name != "alembic_version"
    )
    statuses: list[TableStatusItem] = []
    total_rows = 0
    stale_tables = 0
    stale_threshold = _now() - timedelta(hours=STALE_WINDOW_HOURS)

    for table_name in table_names:
        try:
            table = Table(table_name, MetaData(), autoload_with=db.bind)
            row_count = int(
                db.execute(select(func.count()).select_from(table)).scalar() or 0
            )
            total_rows += row_count

            timestamp_col = None
            if "updated_at" in table.c:
                timestamp_col = table.c.updated_at
            elif "created_at" in table.c:
                timestamp_col = table.c.created_at

            last_updated_dt: datetime | str | None = None
            if timestamp_col is not None:
                last_updated_dt = db.execute(select(func.max(timestamp_col))).scalar()

            if row_count == 0:
                status = TableHealthStatus.empty
                note = "表中暂无数据"
            elif (
                isinstance(last_updated_dt, datetime)
                and last_updated_dt < stale_threshold
            ):
                status = TableHealthStatus.stale
                note = f"超过 {STALE_WINDOW_HOURS} 小时无更新"
                stale_tables += 1
            else:
                status = TableHealthStatus.healthy
                note = "运行正常"

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
                    note=f"读取失败: {exc.__class__.__name__}",
                )
            )

    return statuses, total_rows, stale_tables


def _collect_recent_statuses(
    db: Session, data_status: DataLifecycleStatus, checked_at: str
) -> list[RecentSystemStatusItem]:
    items: list[RecentSystemStatusItem] = [
        RecentSystemStatusItem(
            source="data-status",
            level="info",
            message=f"当前数据状态: {data_status.value}",
            occurred_at=checked_at,
        )
    ]

    inspector = inspect(db.bind)
    if inspector.has_table("jobs") and inspector.has_table("job_runs"):
        rows = (
            db.execute(
                text(
                    """
                select
                    j.job_type as source,
                    j.status as level,
                    coalesce(jr.error_message, jr.log_excerpt, '任务执行记录') as message,
                    coalesce(jr.finished_at, jr.started_at) as occurred_at
                from job_runs jr
                join jobs j on j.id = jr.job_id
                order by jr.started_at desc
                limit 8
                """
                )
            )
            .mappings()
            .all()
        )

        for row in rows:
            items.append(
                RecentSystemStatusItem(
                    source=row.get("source") or "job",
                    level=str(row.get("level") or "info"),
                    message=str(row.get("message") or "任务状态更新"),
                    occurred_at=_to_iso(row.get("occurred_at")) or checked_at,
                )
            )

    return items


def _get_cached_data_management_overview() -> DataManagementOverviewResponse | None:
    data = get_data_management_overview_cache()
    if data is None:
        return None
    try:
        return DataManagementOverviewResponse.model_validate(data)
    except Exception:
        return None


def _set_cached_data_management_overview(
    payload: DataManagementOverviewResponse,
) -> None:
    set_data_management_overview_cache(payload.model_dump(mode="json"))


def _clear_cached_data_management_overview() -> None:
    invalidate_data_management_overview_cache()


@router.get("/audit-logs", response_model=OperationAuditLogsResponse)
def list_operation_audit_logs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    operator: str | None = Query(default=None),
    action: str | None = Query(default=None),
    target_type: str | None = Query(default=None),
    result: str | None = Query(default=None),
    keyword: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
) -> OperationAuditLogsResponse:
    stmt = _apply_audit_log_filters(
        select(OperationAuditLog),
        operator=operator,
        action=action,
        target_type=target_type,
        result=result,
        keyword=keyword,
    )
    total_stmt = _apply_audit_log_filters(
        select(func.count(OperationAuditLog.id)),
        operator=operator,
        action=action,
        target_type=target_type,
        result=result,
        keyword=keyword,
    )

    total = int(db.execute(total_stmt).scalar() or 0)
    offset = (page - 1) * page_size
    rows = (
        db.execute(
            stmt.order_by(
                OperationAuditLog.created_at.desc(), OperationAuditLog.id.desc()
            )
            .offset(offset)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    has_next = offset + len(rows) < total

    return OperationAuditLogsResponse(
        items=[_serialize_operation_audit_log(row) for row in rows],
        total=total,
        page=page,
        page_size=page_size,
        has_next=has_next,
    )


@router.get("/audit-logs/summary", response_model=OperationAuditLogsSummaryResponse)
def get_operation_audit_logs_summary(
    operator: str | None = Query(default=None),
    action: str | None = Query(default=None),
    target_type: str | None = Query(default=None),
    result: str | None = Query(default=None),
    keyword: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
) -> OperationAuditLogsSummaryResponse:
    base_stmt = _apply_audit_log_filters(
        select(OperationAuditLog),
        operator=operator,
        action=action,
        target_type=target_type,
        result=result,
        keyword=keyword,
    ).subquery()

    total, success_count, failure_count, unique_operator_count = db.execute(
        select(
            func.count().label("total"),
            func.sum(case((base_stmt.c.result == "success", 1), else_=0)).label(
                "success_count"
            ),
            func.sum(case((base_stmt.c.result == "failure", 1), else_=0)).label(
                "failure_count"
            ),
            func.count(func.distinct(base_stmt.c.operator)).label(
                "unique_operator_count"
            ),
        )
    ).one()

    module_specs = (
        ("commission", "运营报表核算", "commission.%"),
        ("shipment_schedules", "编辑发货信息管理", "shipment_schedules.%"),
        ("projects", "项目信息维护", "projects.%"),
        ("users", "账号权限维护", "users.%"),
    )
    modules: list[OperationAuditLogModuleSummaryItem] = []
    for key, label, action_pattern in module_specs:
        count_value, success_value, failure_value = db.execute(
            select(
                func.count().label("count"),
                func.sum(case((base_stmt.c.result == "success", 1), else_=0)).label(
                    "success_count"
                ),
                func.sum(case((base_stmt.c.result == "failure", 1), else_=0)).label(
                    "failure_count"
                ),
            )
            .select_from(base_stmt)
            .where(base_stmt.c.action.like(action_pattern))
        ).one()
        modules.append(
            OperationAuditLogModuleSummaryItem(
                key=key,
                label=label,
                count=int(count_value or 0),
                success_count=int(success_value or 0),
                failure_count=int(failure_value or 0),
            )
        )

    top_action_rows = db.execute(
        select(base_stmt.c.action, func.count().label("count"))
        .select_from(base_stmt)
        .group_by(base_stmt.c.action)
        .order_by(func.count().desc(), base_stmt.c.action.asc())
        .limit(6)
    ).all()

    return OperationAuditLogsSummaryResponse(
        total=int(total or 0),
        success_count=int(success_count or 0),
        failure_count=int(failure_count or 0),
        unique_operator_count=int(unique_operator_count or 0),
        modules=modules,
        top_actions=[
            OperationAuditLogActionSummaryItem(
                action=str(action_name), count=int(count or 0)
            )
            for action_name, count in top_action_rows
        ],
    )


@router.get("/data-management/status", response_model=DataManagementStatusResponse)
def get_data_management_status(
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> DataManagementStatusResponse:
    settings = get_settings()
    db_healthy, checked_at = _check_database(db)
    db_engine, db_source = _resolve_database_source(settings.database_url)
    data_status, note, updated_by, updated_at = _load_data_state(db)
    append_operation_view_log(
        db,
        action="system.data_management.status.view",
        target_type="system_management",
        operator=operator,
        after={"data_status": data_status.value, "database_healthy": db_healthy},
        request=request,
    )
    db.commit()
    return DataManagementStatusResponse(
        server_time=checked_at,
        database=DatabaseStatus(
            engine=db_engine,
            source=db_source,
            healthy=db_healthy,
            checked_at=checked_at,
        ),
        cache_enabled=False,
        summary=DataSummary(
            total_tables=0,
            total_rows=0,
            stale_tables=0,
            data_status=data_status,
        ),
        data_status_note=note,
        data_status_updated_at=updated_at,
        data_status_updated_by=updated_by,
    )


@router.get("/data-management/overview", response_model=DataManagementOverviewResponse)
def get_data_management_overview(
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> DataManagementOverviewResponse:
    overall_started_at = _now()
    cached_payload = _get_cached_data_management_overview()
    if cached_payload is not None:
        performance_logger.info("data_management_overview cache=hit duration_ms=0")
        return cached_payload

    timing_started_at = _now()
    settings = get_settings()
    db_healthy, checked_at = _check_database(db)
    db_engine, db_source = _resolve_database_source(settings.database_url)
    database_check_ms = int((_now() - timing_started_at).total_seconds() * 1000)

    timing_started_at = _now()
    data_status, note, updated_by, updated_at = _load_data_state(db)
    data_state_ms = int((_now() - timing_started_at).total_seconds() * 1000)

    timing_started_at = _now()
    table_statuses, total_rows, stale_tables = _collect_table_statuses(db)
    table_scan_ms = int((_now() - timing_started_at).total_seconds() * 1000)

    timing_started_at = _now()
    recent_statuses = _collect_recent_statuses(db, data_status, checked_at)
    recent_statuses_ms = int((_now() - timing_started_at).total_seconds() * 1000)

    payload = DataManagementOverviewResponse(
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
    append_operation_view_log(
        db,
        action="system.data_management.overview.view",
        target_type="system_management",
        operator=operator,
        after={
            "total_tables": len(table_statuses),
            "total_rows": total_rows,
            "stale_tables": stale_tables,
            "recent_status_count": len(recent_statuses),
        },
        request=request,
    )
    db.commit()
    _set_cached_data_management_overview(payload)
    total_duration_ms = int((_now() - overall_started_at).total_seconds() * 1000)
    performance_logger.info(
        "data_management_overview cache=miss total_ms=%s db_check_ms=%s data_state_ms=%s table_scan_ms=%s recent_statuses_ms=%s tables=%s total_rows=%s",
        total_duration_ms,
        database_check_ms,
        data_state_ms,
        table_scan_ms,
        recent_statuses_ms,
        len(table_statuses),
        total_rows,
    )
    return payload


@router.patch("/data-management/data-status", response_model=UpdateDataStatusResponse)
def update_data_status(
    payload: UpdateDataStatusRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateDataStatusResponse:
    _ensure_data_state_table(db)
    now = _now().replace(microsecond=0)
    before_status, before_note, before_updated_by, before_updated_at = _load_data_state(
        db
    )

    existing = db.execute(
        text(f"select id from {DATA_STATE_TABLE} where id = 1")
    ).first()
    if existing:
        db.execute(
            text(
                f"""
                update {DATA_STATE_TABLE}
                set status = :status, note = :note, updated_by = :updated_by, updated_at = :updated_at
                where id = 1
                """
            ),
            {
                "status": payload.status.value,
                "note": payload.note,
                "updated_by": operator,
                "updated_at": now,
            },
        )
    else:
        db.execute(
            text(
                f"""
                insert into {DATA_STATE_TABLE} (id, status, note, updated_by, updated_at)
                values (1, :status, :note, :updated_by, :updated_at)
                """
            ),
            {
                "status": payload.status.value,
                "note": payload.note,
                "updated_by": operator,
                "updated_at": now,
            },
        )
    append_operation_audit_log(
        db,
        action="system.data_status.update",
        target_type="system_management_data_state",
        target_id="1",
        operator=operator,
        before={
            "status": before_status.value,
            "note": before_note,
            "updated_by": before_updated_by,
            "updated_at": before_updated_at,
        },
        after={
            "status": payload.status.value,
            "note": payload.note,
            "updated_by": operator,
            "updated_at": now.isoformat(timespec="seconds"),
        },
        request=request,
    )
    db.commit()
    _clear_cached_data_management_overview()

    return UpdateDataStatusResponse(
        status=payload.status,
        note=payload.note,
        updated_at=now.isoformat(timespec="seconds"),
        updated_by=operator,
    )


@router.post("/cache/clear-all", response_model=ClearCacheResponse)
def clear_all_cache(
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ClearCacheResponse:
    deleted_count = clear_all_caches()
    append_operation_audit_log(
        db,
        action="system.cache.clear_all",
        target_type="redis_cache",
        target_id="all",
        operator=operator,
        after={"deleted_count": deleted_count},
        request=request,
    )
    db.commit()
    return ClearCacheResponse(
        deleted_count=deleted_count,
        message=f"成功清理 {deleted_count} 个缓存键",
    )


@router.post(
    "/commission-management/records/upsert", response_model=CommissionRecordsResponse
)
def upsert_commission_records(
    payload: UpsertCommissionRecordsRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
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
                "project_name": item.project_name.strip(),
                "income_total_usd": item.income_total_usd,
                "factory_commission_rate": item.factory_commission_rate,
                "usd_to_rmb_rate": item.usd_to_rmb_rate,
            }
            continue
        project_items[item.project_id].update(
            {
                "project_name": item.project_name.strip(),
                "income_total_usd": item.income_total_usd,
                "factory_commission_rate": item.factory_commission_rate,
                "usd_to_rmb_rate": item.usd_to_rmb_rate,
            }
        )

    existing_project_months = (
        db.execute(
            select(CommissionProjectMonth).where(
                CommissionProjectMonth.report_month == report_month
            )
        )
        .scalars()
        .all()
    )
    project_month_map = {row.project_id: row for row in existing_project_months}

    for project_id, values in project_items.items():
        project_month_row = project_month_map.get(project_id)
        if project_month_row is None:
            project_month_row = CommissionProjectMonth(
                report_month=report_month,
                project_id=project_id,
                project_name=str(values["project_name"]).strip(),
                payment_status=CommissionProjectPaymentStatus.unpaid.value,
            )
            db.add(project_month_row)
            project_month_map[project_id] = project_month_row

        income_total_usd = _to_decimal(values["income_total_usd"], "0.01")
        factory_commission_rate = _to_decimal(
            values["factory_commission_rate"], "0.000001"
        )
        usd_to_rmb_rate = _to_decimal(values["usd_to_rmb_rate"], "0.00000001")
        factory_commission_usd = _to_decimal(
            income_total_usd * factory_commission_rate, "0.01"
        )
        factory_commission_rmb = _to_decimal(
            factory_commission_usd * usd_to_rmb_rate, "0.01"
        )

        project_month_row.project_name = str(values["project_name"]).strip()
        project_month_row.income_total_usd = income_total_usd
        project_month_row.factory_commission_rate = factory_commission_rate
        project_month_row.usd_to_rmb_rate = usd_to_rmb_rate
        project_month_row.factory_commission_usd = factory_commission_usd
        project_month_row.factory_commission_rmb = factory_commission_rmb
        project_month_row.computed_at = now

    db.flush()

    existing_rows = (
        db.execute(
            select(CommissionRecord).where(
                CommissionRecord.report_month == report_month
            )
        )
        .scalars()
        .all()
    )
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

        bonus_ratio_source = item.bonus_ratio_source
        manual_bonus_ratio_value: float | None = item.manual_bonus_ratio
        if manual_bonus_ratio_value is not None:
            bonus_ratio_source = CommissionRatioSource.manual
        try:
            row.income_total_usd = _to_decimal(item.income_total_usd, "0.01")
            row.factory_commission_rate = _to_decimal(
                item.factory_commission_rate, "0.000001"
            )
            row.operator_bonus_ratio = _to_decimal(
                item.operator_bonus_ratio, "0.000001"
            )
            row.bonus_amount_usd = _to_decimal(item.bonus_amount_usd, "0.01")
            row.usd_to_rmb_rate = _to_decimal(item.usd_to_rmb_rate, "0.00000001")
            row.bonus_amount_rmb = _to_decimal(item.bonus_amount_rmb, "0.01")
            row.bonus_ratio_source = bonus_ratio_source.value
            row.manual_bonus_ratio = (
                _to_decimal(manual_bonus_ratio_value, "0.000001")
                if manual_bonus_ratio_value is not None
                else None
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        row.computed_at = now

    stale_rows = [
        row
        for old_key, row in existing_map.items()
        if old_key not in incoming_keys and row.is_active
    ]
    for stale in stale_rows:
        stale.is_active = False
        stale.deactivated_at = now

    append_operation_audit_log(
        db,
        action="commission.bonus_records.upsert",
        target_type="commission_bonus_record",
        target_id=report_month,
        operator=operator,
        after={
            "report_month": report_month,
            "incoming_items": len(payload.items),
            "project_count": len(project_items),
            "stale_rows_deactivated": len(stale_rows),
        },
        request=request,
    )
    db.commit()
    invalidate_data_management_overview_cache()

    rows = (
        db.execute(
            select(CommissionRecord)
            .where(
                CommissionRecord.report_month == report_month,
                CommissionRecord.is_active.is_(True),
            )
            .order_by(
                CommissionRecord.person_name.asc(),
                CommissionRecord.project_name.asc(),
                CommissionRecord.income_category.asc(),
            )
        )
        .scalars()
        .all()
    )
    return CommissionRecordsResponse(
        report_month=report_month,
        items=[_serialize_commission_record(row) for row in rows],
    )


@router.post(
    "/commission-management/recompute", response_model=RecomputeCommissionResponse
)
def recompute_commission_records(
    payload: RecomputeCommissionRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> RecomputeCommissionResponse:
    try:
        report_month = _parse_report_month(payload.report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    now = _now().replace(microsecond=0)

    report_rows = db.execute(
        select(MonthlyReport, MonthlyReportPT4Calculation)
        .join(
            MonthlyReportPT4Calculation,
            MonthlyReportPT4Calculation.report_id == MonthlyReport.id,
        )
        .where(
            MonthlyReport.report_month == report_month,
            MonthlyReport.is_current.is_(True),
        )
        .order_by(MonthlyReport.project_id.asc())
    ).all()

    project_ids = [int(report.project_id) for report, _pt4 in report_rows]
    if not project_ids:
        append_operation_audit_log(
            db,
            action="commission.bonus.recompute",
            target_type="commission_bonus_record",
            target_id=report_month,
            operator=operator,
            after={
                "report_month": report_month,
                "project_month_count": 0,
                "record_count": 0,
            },
            request=request,
        )
        db.commit()
        return RecomputeCommissionResponse(
            report_month=report_month,
            project_month_count=0,
            record_count=0,
            locked_record_count=0,
            computed_at=_to_iso(now) or "",
        )

    projects = (
        db.execute(select(Project).where(Project.id.in_(project_ids))).scalars().all()
    )
    project_map = {int(project.id): project for project in projects}

    exchange_rate = (
        db.execute(
            select(ExchangeRate).where(
                ExchangeRate.currency == "USD",
                ExchangeRate.year_month == report_month,
            )
        )
        .scalars()
        .first()
    )
    if exchange_rate is None:
        raise HTTPException(
            status_code=422, detail=f"USD exchange rate for {report_month} not found"
        )
    usd_to_rmb_rate = exchange_rate.rate

    role_rows = (
        db.execute(
            select(ProjectRoleAssignment).where(
                ProjectRoleAssignment.project_id.in_(project_ids),
                ProjectRoleAssignment.effective_from_month <= report_month,
                (
                    ProjectRoleAssignment.effective_to_month.is_(None)
                    | (ProjectRoleAssignment.effective_to_month >= report_month)
                ),
            )
        )
        .scalars()
        .all()
    )
    roles_by_project: dict[int, dict[str, list[str]]] = {}
    for row in role_rows:
        project_roles = roles_by_project.setdefault(
            int(row.project_id), {"operator": [], "assistant": []}
        )
        project_roles[row.role_type].append(row.person_name.strip())

    override_rows = (
        db.execute(
            select(CommissionRatioOverride).where(
                CommissionRatioOverride.report_month == report_month
            )
        )
        .scalars()
        .all()
    )
    override_map = {
        (int(row.project_id), row.person_name.strip(), row.income_category): row
        for row in override_rows
    }

    existing_project_months = (
        db.execute(
            select(CommissionProjectMonth).where(
                CommissionProjectMonth.report_month == report_month
            )
        )
        .scalars()
        .all()
    )
    project_month_map = {int(row.project_id): row for row in existing_project_months}

    existing_records = (
        db.execute(
            select(CommissionRecord).where(
                CommissionRecord.report_month == report_month
            )
        )
        .scalars()
        .all()
    )
    record_map = {
        (int(row.project_id), row.person_name.strip(), row.income_category): row
        for row in existing_records
    }

    incoming_record_keys: set[tuple[int, str, str]] = set()
    locked_record_count = 0

    for report, pt4 in report_rows:
        project = project_map.get(int(report.project_id))
        if project is None:
            continue

        income_total_usd = _to_decimal(pt4.income_total, "0.01")
        amazon_pay_back = _to_decimal(pt4.amazon_pay_back, "0.01")
        factory_commission_rate, _base_amount_usd, factory_commission_usd = (
            _resolve_factory_commission(
                project.commission_basis,
                project.commission_rate,
                income_total_usd,
                amazon_pay_back,
            )
        )
        factory_commission_rmb = _to_decimal(
            factory_commission_usd * usd_to_rmb_rate, "0.01"
        )

        project_month_row = project_month_map.get(int(project.id))
        if project_month_row is None:
            project_month_row = CommissionProjectMonth(
                report_month=report_month,
                project_id=project.id,
                project_name=project.project_name,
                payment_status=CommissionProjectPaymentStatus.unpaid.value,
            )
            db.add(project_month_row)
            project_month_map[int(project.id)] = project_month_row

        project_month_row.project_name = project.project_name
        project_month_row.income_total_usd = income_total_usd
        project_month_row.factory_commission_rate = _to_decimal(
            factory_commission_rate, "0.000001"
        )
        project_month_row.usd_to_rmb_rate = _to_decimal(usd_to_rmb_rate, "0.00000001")
        project_month_row.factory_commission_usd = factory_commission_usd
        project_month_row.factory_commission_rmb = factory_commission_rmb
        project_month_row.computed_at = now

        fallback_roles = roles_by_project.get(
            int(project.id), {"operator": [], "assistant": []}
        )
        operator_names = _dedupe_names(fallback_roles["operator"]) or _dedupe_names(
            _split_role_names(project.project_operator)
        )
        assistant_names = _dedupe_names(fallback_roles["assistant"]) or _dedupe_names(
            [project.assistant_operator or ""]
        )
        default_ratio_map = _build_default_bonus_ratios(
            income_total_usd=income_total_usd,
            operator_names=operator_names,
            assistant_names=assistant_names,
        )

        for (person_name, income_category), default_ratio in default_ratio_map.items():
            incoming_record_keys.add((int(project.id), person_name, income_category))
            override_row = override_map.get(
                (int(project.id), person_name, income_category)
            )
            ratio_value = (
                override_row.override_ratio
                if override_row is not None
                else default_ratio
            )
            bonus_ratio_source = (
                CommissionRatioSource.manual
                if override_row is not None
                else CommissionRatioSource.rule
            )
            manual_bonus_ratio = (
                override_row.override_ratio if override_row is not None else None
            )
            bonus_amount_usd = _to_decimal(factory_commission_usd * ratio_value, "0.01")
            bonus_amount_rmb = _to_decimal(bonus_amount_usd * usd_to_rmb_rate, "0.01")

            record_key = (int(project.id), person_name, income_category)
            row = record_map.get(record_key)
            if row is None:
                row = CommissionRecord(
                    report_month=report_month,
                    project_id=project.id,
                    project_name=project.project_name,
                    project_month_id=project_month_row.id,
                    person_name=person_name,
                    income_category=income_category,
                    payment_status=CommissionPaymentStatus.unpaid.value,
                    is_active=True,
                )
                db.add(row)
                record_map[record_key] = row

            row.project_name = project.project_name
            row.project_month_id = project_month_row.id
            row.is_active = True
            row.deactivated_at = None
            if row.is_locked:
                locked_record_count += 1
                continue

            row.income_total_usd = income_total_usd
            row.factory_commission_rate = _to_decimal(
                factory_commission_rate, "0.000001"
            )
            row.operator_bonus_ratio = _to_decimal(ratio_value, "0.000001")
            row.bonus_amount_usd = bonus_amount_usd
            row.usd_to_rmb_rate = _to_decimal(usd_to_rmb_rate, "0.00000001")
            row.bonus_amount_rmb = bonus_amount_rmb
            row.bonus_ratio_source = bonus_ratio_source.value
            row.manual_bonus_ratio = (
                _to_decimal(manual_bonus_ratio, "0.000001")
                if manual_bonus_ratio is not None
                else None
            )
            row.computed_at = now

    db.flush()

    for row in project_month_map.values():
        if row.id is None:
            db.flush()
            break

    for record_key in incoming_record_keys:
        row = record_map.get(record_key)
        if row is not None and row.project_month_id is None:
            project_month_row = project_month_map.get(record_key[0])
            if project_month_row is not None:
                row.project_month_id = project_month_row.id

    stale_rows = [
        row
        for old_key, row in record_map.items()
        if old_key not in incoming_record_keys and row.is_active
    ]
    for stale in stale_rows:
        stale.is_active = False
        stale.deactivated_at = now

    append_operation_audit_log(
        db,
        action="commission.bonus.recompute",
        target_type="commission_bonus_record",
        target_id=report_month,
        operator=operator,
        after={
            "report_month": report_month,
            "project_month_count": len(project_ids),
            "record_count": len(incoming_record_keys),
            "locked_record_count": locked_record_count,
            "stale_rows_deactivated": len(stale_rows),
        },
        request=request,
    )
    db.commit()
    invalidate_data_management_overview_cache()

    return RecomputeCommissionResponse(
        report_month=report_month,
        project_month_count=len(project_ids),
        record_count=len(incoming_record_keys),
        locked_record_count=locked_record_count,
        computed_at=_to_iso(now) or "",
    )


@router.get("/commission-management/records", response_model=CommissionRecordsResponse)
def list_commission_records(
    report_month: str,
    request: Request,
    person_name: str | None = None,
    include_inactive: bool = False,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionRecordsResponse:
    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    stmt = select(CommissionRecord).where(CommissionRecord.report_month == month)
    if include_inactive is False:
        stmt = stmt.where(CommissionRecord.is_active.is_(True))
    normalized_person = (person_name or "").strip()
    if normalized_person:
        stmt = stmt.where(CommissionRecord.person_name == normalized_person)
    stmt = stmt.order_by(
        CommissionRecord.person_name.asc(),
        CommissionRecord.project_name.asc(),
        CommissionRecord.income_category.asc(),
    )

    rows = db.execute(stmt).scalars().all()
    append_operation_view_log(
        db,
        action="commission.bonus_records.view",
        target_type="commission_bonus_record",
        target_id=month,
        operator=operator,
        after={
            "report_month": month,
            "person_name": normalized_person or None,
            "include_inactive": include_inactive,
            "count": len(rows),
        },
        request=request,
    )
    db.commit()
    return CommissionRecordsResponse(
        report_month=month,
        items=[_serialize_commission_record(row) for row in rows],
    )


@router.patch(
    "/commission-management/records/{record_id}/payment-status",
    response_model=UpdateCommissionPaymentStatusResponse,
)
def update_commission_payment_status(
    record_id: int,
    payload: UpdateCommissionPaymentStatusRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateCommissionPaymentStatusResponse:
    row = (
        db.execute(select(CommissionRecord).where(CommissionRecord.id == record_id))
        .scalars()
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="record not found")

    before = _serialize_commission_record(row).model_dump()
    now = _now().replace(microsecond=0)
    row.payment_status = payload.payment_status.value
    if payload.payment_status == CommissionPaymentStatus.paid:
        row.payment_confirmed_at = now
        row.payment_confirmed_by = (operator or "").strip() or None
        row.is_locked = True
        row.locked_at = now
        row.locked_by = (operator or "").strip() or None
    else:
        row.payment_confirmed_at = None
        row.payment_confirmed_by = None
        row.is_locked = False
        row.locked_at = None
        row.locked_by = None
    row.updated_at = now
    after = _serialize_commission_record(row).model_dump()
    append_operation_audit_log(
        db,
        action="commission.bonus_record.payment_status.update",
        target_type="commission_bonus_record",
        target_id=record_id,
        operator=operator,
        before=before,
        after=after,
        request=request,
    )
    db.commit()
    invalidate_data_management_overview_cache()
    db.refresh(row)
    return UpdateCommissionPaymentStatusResponse(item=_serialize_commission_record(row))


@router.get(
    "/commission-management/project-months",
    response_model=CommissionProjectMonthsResponse,
)
def list_commission_project_months(
    report_month: str,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionProjectMonthsResponse:
    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    rows = (
        db.execute(
            select(CommissionProjectMonth)
            .where(CommissionProjectMonth.report_month == month)
            .order_by(CommissionProjectMonth.project_id.asc())
        )
        .scalars()
        .all()
    )
    append_operation_view_log(
        db,
        action="commission.project_months.view",
        target_type="commission_project_month",
        target_id=month,
        operator=operator,
        after={"report_month": month, "count": len(rows)},
        request=request,
    )
    db.commit()
    return CommissionProjectMonthsResponse(
        report_month=month, items=[_serialize_project_month(row) for row in rows]
    )


@router.get(
    "/commission-management/summary/monthly",
    response_model=CommissionYearlyMonthlySummaryResponse,
)
def list_commission_yearly_monthly_summary(
    year: str,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionYearlyMonthlySummaryResponse:
    try:
        normalized_year = _parse_year(year)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    month_start = f"{normalized_year}-01"
    month_end = f"{normalized_year}-12"
    rows = db.execute(
        select(
            CommissionProjectMonth.report_month,
            func.sum(CommissionProjectMonth.income_total_usd).label("income_total_usd"),
            func.sum(CommissionProjectMonth.factory_commission_usd).label(
                "factory_commission_usd"
            ),
            func.sum(CommissionProjectMonth.factory_commission_rmb).label(
                "factory_commission_rmb"
            ),
            func.sum(CommissionProjectMonth.received_rmb).label("received_rmb"),
        )
        .where(
            CommissionProjectMonth.report_month >= month_start,
            CommissionProjectMonth.report_month <= month_end,
        )
        .group_by(CommissionProjectMonth.report_month)
        .order_by(CommissionProjectMonth.report_month.asc())
    ).all()

    monthly_map: dict[str, tuple[float, float, float, float]] = {}
    for (
        report_month,
        income_total_usd,
        factory_commission_usd,
        factory_commission_rmb,
        received_rmb,
    ) in rows:
        monthly_map[str(report_month)] = (
            float(income_total_usd or 0),
            float(factory_commission_usd or 0),
            float(factory_commission_rmb or 0),
            float(received_rmb or 0),
        )

    items: list[CommissionYearlyMonthlySummaryItem] = []
    for month in range(1, 13):
        report_month = f"{normalized_year}-{month:02d}"
        (
            income_total_usd,
            factory_commission_usd,
            factory_commission_rmb,
            received_rmb,
        ) = monthly_map.get(
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

    append_operation_view_log(
        db,
        action="commission.summary.monthly.view",
        target_type="commission_summary",
        target_id=normalized_year,
        operator=operator,
        after={"year": normalized_year, "count": len(items)},
        request=request,
    )
    db.commit()
    return CommissionYearlyMonthlySummaryResponse(year=normalized_year, items=items)


@router.get(
    "/commission-management/summary/project",
    response_model=CommissionProjectYearlySummaryResponse,
)
def list_commission_project_yearly_summary(
    year: str,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionProjectYearlySummaryResponse:
    try:
        normalized_year = _parse_year(year)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    month_start = f"{normalized_year}-01"
    month_end = f"{normalized_year}-12"
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
        .order_by(
            CommissionProjectMonth.project_id.asc(),
            CommissionProjectMonth.report_month.asc(),
        )
    ).all()

    project_map: dict[int, CommissionProjectYearlySummaryItem] = {}
    for (
        project_id,
        project_name,
        report_month,
        income_total_usd,
        factory_commission_rmb,
        received_rmb,
    ) in rows:
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
        month_receive_rate = (
            (received_value / commission_value) if commission_value > 0 else 0
        )

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
        item.receive_rate = (
            (item.total_received_rmb / item.total_commission_rmb)
            if item.total_commission_rmb > 0
            else 0
        )

    items.sort(key=lambda item: item.project_id)
    append_operation_view_log(
        db,
        action="commission.summary.project.view",
        target_type="commission_summary",
        target_id=normalized_year,
        operator=operator,
        after={"year": normalized_year, "count": len(items)},
        request=request,
    )
    db.commit()
    return CommissionProjectYearlySummaryResponse(year=normalized_year, items=items)


@router.patch(
    "/commission-management/project-months/{project_month_id}/payment",
    response_model=UpdateCommissionProjectPaymentResponse,
)
def update_commission_project_payment(
    project_month_id: int,
    payload: UpdateCommissionProjectPaymentRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateCommissionProjectPaymentResponse:
    row = (
        db.execute(
            select(CommissionProjectMonth).where(
                CommissionProjectMonth.id == project_month_id
            )
        )
        .scalars()
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="project month record not found")

    before = _serialize_project_month(row).model_dump()
    now = _now().replace(microsecond=0)
    row.payment_status = payload.payment_status.value
    row.received_rmb = _to_decimal(payload.received_rmb, "0.01")
    row.note = (payload.note or "").strip() or None

    if payload.payment_status == CommissionProjectPaymentStatus.unpaid:
        row.payment_confirmed_at = None
        row.payment_confirmed_by = None
    else:
        row.payment_confirmed_at = now
        row.payment_confirmed_by = (operator or "").strip() or None
    row.updated_at = now

    if payload.payment_status == CommissionProjectPaymentStatus.paid:
        paid_rows = (
            db.execute(
                select(CommissionRecord).where(
                    CommissionRecord.project_month_id == project_month_id,
                    CommissionRecord.is_active.is_(True),
                )
            )
            .scalars()
            .all()
        )
        for commission_row in paid_rows:
            commission_row.payment_status = CommissionPaymentStatus.paid.value
            commission_row.payment_confirmed_at = now
            commission_row.payment_confirmed_by = row.payment_confirmed_by
            commission_row.is_locked = True
            commission_row.locked_at = now
            commission_row.locked_by = row.payment_confirmed_by
    else:
        unpaid_rows = (
            db.execute(
                select(CommissionRecord).where(
                    CommissionRecord.project_month_id == project_month_id,
                    CommissionRecord.is_active.is_(True),
                )
            )
            .scalars()
            .all()
        )
        for commission_row in unpaid_rows:
            commission_row.payment_status = CommissionPaymentStatus.unpaid.value
            commission_row.payment_confirmed_at = None
            commission_row.payment_confirmed_by = None
            commission_row.is_locked = False
            commission_row.locked_at = None
            commission_row.locked_by = None

    after = _serialize_project_month(row).model_dump()
    append_operation_audit_log(
        db,
        action="commission.project_commission.payment.update",
        target_type="commission_project_month",
        target_id=project_month_id,
        operator=operator,
        before=before,
        after=after,
        request=request,
    )
    db.commit()
    db.refresh(row)
    return UpdateCommissionProjectPaymentResponse(item=_serialize_project_month(row))


@router.post(
    "/commission-management/ratio-overrides/upsert",
    response_model=CommissionRatioOverridesResponse,
)
def upsert_commission_ratio_overrides(
    payload: UpsertCommissionRatioOverridesRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionRatioOverridesResponse:
    try:
        report_month = _parse_report_month(payload.report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    existing_rows = (
        db.execute(
            select(CommissionRatioOverride).where(
                CommissionRatioOverride.report_month == report_month
            )
        )
        .scalars()
        .all()
    )
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
            row = CommissionRatioOverride(
                report_month=report_month,
                project_id=item.project_id,
                project_name=item.project_name.strip(),
                person_name=item.person_name.strip(),
                income_category=item.income_category.value,
                override_ratio=_to_decimal(item.override_ratio, "0.000001"),
            )
            db.add(row)
            existing_map[key] = row
        else:
            row.project_name = item.project_name.strip()
            row.override_ratio = _to_decimal(item.override_ratio, "0.000001")
        row.reason = (item.reason or "").strip() or None
        row.updated_by = (operator or "").strip() or None

    stale_rows = [row for key, row in existing_map.items() if key not in incoming_keys]
    for stale in stale_rows:
        db.delete(stale)

    append_operation_audit_log(
        db,
        action="commission.ratio_overrides.upsert",
        target_type="commission_ratio_override",
        target_id=report_month,
        operator=operator,
        after={
            "report_month": report_month,
            "incoming_items": len(payload.items),
            "deleted_items": len(stale_rows),
        },
        request=request,
    )
    db.commit()
    invalidate_data_management_overview_cache()
    rows = (
        db.execute(
            select(CommissionRatioOverride)
            .where(CommissionRatioOverride.report_month == report_month)
            .order_by(
                CommissionRatioOverride.person_name.asc(),
                CommissionRatioOverride.project_name.asc(),
                CommissionRatioOverride.income_category.asc(),
            )
        )
        .scalars()
        .all()
    )
    return CommissionRatioOverridesResponse(
        report_month=report_month,
        items=[_serialize_ratio_override(row) for row in rows],
    )


@router.get(
    "/commission-management/ratio-overrides",
    response_model=CommissionRatioOverridesResponse,
)
def list_commission_ratio_overrides(
    report_month: str,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionRatioOverridesResponse:
    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    rows = (
        db.execute(
            select(CommissionRatioOverride)
            .where(CommissionRatioOverride.report_month == month)
            .order_by(
                CommissionRatioOverride.person_name.asc(),
                CommissionRatioOverride.project_name.asc(),
                CommissionRatioOverride.income_category.asc(),
            )
        )
        .scalars()
        .all()
    )
    append_operation_view_log(
        db,
        action="commission.ratio_overrides.view",
        target_type="commission_ratio_override",
        target_id=month,
        operator=operator,
        after={"report_month": month, "count": len(rows)},
        request=request,
    )
    db.commit()
    return CommissionRatioOverridesResponse(
        report_month=month, items=[_serialize_ratio_override(row) for row in rows]
    )


@router.get(
    "/commission-management/role-assignments",
    response_model=ProjectRoleAssignmentsResponse,
)
def list_project_role_assignments(
    request: Request,
    report_month: str | None = None,
    project_id: int | None = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProjectRoleAssignmentsResponse:
    stmt = select(ProjectRoleAssignment)
    if project_id is not None and project_id > 0:
        stmt = stmt.where(ProjectRoleAssignment.project_id == project_id)
    if report_month:
        month = _parse_report_month(report_month)
        stmt = stmt.where(
            ProjectRoleAssignment.effective_from_month <= month,
            (
                ProjectRoleAssignment.effective_to_month.is_(None)
                | (ProjectRoleAssignment.effective_to_month >= month)
            ),
        )
    stmt = stmt.order_by(
        ProjectRoleAssignment.project_id.asc(),
        ProjectRoleAssignment.role_type.asc(),
        ProjectRoleAssignment.effective_from_month.asc(),
        ProjectRoleAssignment.person_name.asc(),
    )
    rows = db.execute(stmt).scalars().all()
    append_operation_view_log(
        db,
        action="commission.role_assignments.view",
        target_type="project_role_assignment",
        target_id=project_id,
        operator=operator,
        after={
            "report_month": report_month,
            "project_id": project_id,
            "count": len(rows),
        },
        request=request,
    )
    db.commit()
    return ProjectRoleAssignmentsResponse(
        items=[_serialize_role_assignment(row) for row in rows]
    )


@router.post(
    "/commission-management/role-assignments/upsert",
    response_model=ProjectRoleAssignmentsResponse,
)
def upsert_project_role_assignments(
    payload: UpsertProjectRoleAssignmentsRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProjectRoleAssignmentsResponse:
    for item in payload.items:
        from_month = _parse_report_month(item.effective_from_month)
        to_month = (
            _parse_report_month(item.effective_to_month)
            if item.effective_to_month
            else None
        )
        role_type = item.role_type.strip()
        person_name = item.person_name.strip()
        if to_month is not None and to_month < from_month:
            raise HTTPException(
                status_code=422,
                detail="effective_to_month must be greater than or equal to effective_from_month",
            )
        if not role_type:
            raise HTTPException(status_code=422, detail="role_type is required")
        if not person_name:
            raise HTTPException(status_code=422, detail="person_name is required")

        row = None
        if item.id is not None:
            row = (
                db.execute(
                    select(ProjectRoleAssignment).where(
                        ProjectRoleAssignment.id == item.id
                    )
                )
                .scalars()
                .first()
            )
        if row is None:
            row = ProjectRoleAssignment(
                project_id=item.project_id,
                role_type=role_type,
                person_name=person_name,
                effective_from_month=from_month,
                effective_to_month=to_month,
            )
            db.add(row)
        else:
            row.project_id = item.project_id
            row.role_type = role_type
            row.person_name = person_name
            row.effective_from_month = from_month
            row.effective_to_month = to_month

    append_operation_audit_log(
        db,
        action="commission.role_assignments.upsert",
        target_type="project_role_assignment",
        operator=operator,
        after={"incoming_items": len(payload.items)},
        request=request,
    )
    db.commit()
    invalidate_data_management_overview_cache()
    rows = (
        db.execute(
            select(ProjectRoleAssignment).order_by(
                ProjectRoleAssignment.project_id.asc(),
                ProjectRoleAssignment.role_type.asc(),
                ProjectRoleAssignment.effective_from_month.asc(),
                ProjectRoleAssignment.person_name.asc(),
            )
        )
        .scalars()
        .all()
    )
    return ProjectRoleAssignmentsResponse(
        items=[_serialize_role_assignment(row) for row in rows]
    )


@router.get(
    "/operator-management/performance", response_model=OperatorPerformanceResponse
)
def list_operator_performance(
    request: Request,
    report_month: str,
    project_id: int | None = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> OperatorPerformanceResponse:
    month = _parse_report_month(report_month)
    stmt = select(OperatorPerformanceRecord).where(
        OperatorPerformanceRecord.report_month == month
    )
    if project_id is not None and project_id > 0:
        stmt = stmt.where(OperatorPerformanceRecord.project_id == project_id)
    stmt = stmt.order_by(
        OperatorPerformanceRecord.person_name.asc(),
        OperatorPerformanceRecord.project_name.asc(),
        OperatorPerformanceRecord.week_index.asc(),
    )
    rows = db.execute(stmt).scalars().all()
    append_operation_view_log(
        db,
        action="operator.performance.view",
        target_type="operator_performance_record",
        target_id=month,
        operator=operator,
        after={"report_month": month, "project_id": project_id, "count": len(rows)},
        request=request,
    )
    db.commit()
    return OperatorPerformanceResponse(
        report_month=month, items=[_serialize_operator_performance(row) for row in rows]
    )


@router.post(
    "/operator-management/performance/upsert",
    response_model=OperatorPerformanceResponse,
)
def upsert_operator_performance(
    payload: UpsertOperatorPerformanceRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> OperatorPerformanceResponse:
    touched_months: set[str] = set()
    for item in payload.items:
        month = _parse_report_month(item.report_month)
        touched_months.add(month)
        person_name = item.person_name.strip()
        role_type = item.role_type.strip()
        project_name = item.project_name.strip()

        if not person_name:
            raise HTTPException(status_code=422, detail="person_name is required")
        if not role_type:
            raise HTTPException(status_code=422, detail="role_type is required")
        if not project_name:
            raise HTTPException(status_code=422, detail="project_name is required")

        row = None
        if item.id is not None:
            row = (
                db.execute(
                    select(OperatorPerformanceRecord).where(
                        OperatorPerformanceRecord.id == item.id
                    )
                )
                .scalars()
                .first()
            )
        if row is None:
            row = (
                db.execute(
                    select(OperatorPerformanceRecord).where(
                        OperatorPerformanceRecord.report_month == month,
                        OperatorPerformanceRecord.week_index == item.week_index,
                        OperatorPerformanceRecord.project_id == item.project_id,
                        OperatorPerformanceRecord.person_name == person_name,
                        OperatorPerformanceRecord.role_type == role_type,
                    )
                )
                .scalars()
                .first()
            )

        if row is None:
            row = OperatorPerformanceRecord(
                report_month=month,
                week_index=item.week_index,
                project_id=item.project_id,
                project_name=project_name,
                person_name=person_name,
                role_type=role_type,
                score=item.score,
                note=(item.note or "").strip() or None,
                updated_by=operator,
            )
            db.add(row)
        else:
            row.report_month = month
            row.week_index = item.week_index
            row.project_id = item.project_id
            row.project_name = project_name
            row.person_name = person_name
            row.role_type = role_type
            row.score = item.score
            row.note = (item.note or "").strip() or None
            row.updated_by = operator

    append_operation_audit_log(
        db,
        action="operator.performance.upsert",
        target_type="operator_performance_record",
        operator=operator,
        after={"incoming_items": len(payload.items)},
        request=request,
    )
    db.commit()
    invalidate_data_management_overview_cache()

    target_month = sorted(touched_months)[-1] if touched_months else ""
    if not target_month:
        return OperatorPerformanceResponse(report_month="", items=[])

    rows = (
        db.execute(
            select(OperatorPerformanceRecord)
            .where(OperatorPerformanceRecord.report_month == target_month)
            .order_by(
                OperatorPerformanceRecord.person_name.asc(),
                OperatorPerformanceRecord.project_name.asc(),
                OperatorPerformanceRecord.week_index.asc(),
            )
        )
        .scalars()
        .all()
    )
    return OperatorPerformanceResponse(
        report_month=target_month,
        items=[_serialize_operator_performance(row) for row in rows],
    )
