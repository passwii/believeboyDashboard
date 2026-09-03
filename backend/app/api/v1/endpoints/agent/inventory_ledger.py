"""Agent 库存台账域路由（BLF-582 原生化：非 ad 域之一）。

在 ``/api/v1/agent/projects/{project_id}/inventory-ledger/*`` 开放 10 条纯读
路由（months / snapshot / events / receipt-clusters / integrity / trend /
detail / summary / batches / consistency），**原生替换 external 镜像**
（external/inventory_ledger.py 端点模块已删除，BLF-582）：

* **查询契约与删除前的 external handler 完全一致**（``?period=`` 约定见
  ``backend/docs/inventory-ledger-api.md``；响应模型同构），parity 测试锁定
  （agent 通道 == service 直调）。
* **服务层复用**：``app.services.inventory.ledger`` 各查询函数 +
  ``inventory_ledger_common.resolve_period_inputs``（共享层保留，原生 handler
  显式调用），0 存量调用方影响。
* **与 BLF-478 的边界**：``agent/inventory.py``（``/inventory`` 1 条路由，
  business_scope("inventory")）是**当前库存快照**（总量/库龄/缺货/单 SKU
  数量，复用 inventory-analysis 的 service 与 Redis 缓存）；本域是**库存台账**
  （月度盘点/事件/收货簇/完整性/趋势，Detailed + Summary 视图，直查
  inventory_ledger 表族）——业务定位与路径均独立，无重叠。域 code
  ``inventory_ledger``（前端 agent-domains.ts 注册表已有 live 条目，routeCount 10）。
* **项目不存在 → 404 壳**（对齐其它原生域模板；镜像时代无此检查）。
"""

from __future__ import annotations

import calendar
from contextlib import contextmanager
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_read_db_session
from app.api.v1.endpoints.agent._helpers import parse_country
from app.api.v1.endpoints.inventory_ledger_common import (
    resolve_period_inputs,
)
from app.models import Project
from app.schemas.inventory_ledger import (
    ConsistencyCheckResult,
    EventsResponse,
    IngestBatchInfo,
    IngestBatchesResponse,
    IntegrityCheckResult,
    LedgerDetailResponse,
    LedgerSummaryResponse,
    MonthlySnapshotResponse,
    MonthsResponse,
    ReceiptClustersResponse,
    TrendResponse,
)
from app.services.inventory.ledger import (
    check_ledger_consistency,
    check_ledger_integrity,
    get_available_months,
    get_ledger_detail_rows,
    get_ledger_summary_rows,
    get_month_disposition_summary,
    get_receipt_clusters,
    get_sku_month_eom,
    get_sku_month_events,
    get_trend,
    list_ingest_batches,
)

inventory_ledger_router = APIRouter(
    prefix="/projects/{project_id}/inventory-ledger",
    tags=["agent-inventory-ledger"],
)


# ============================================================
# 壳翻译与解析 helper（对齐各原生域模板）
# ============================================================


@contextmanager
def _service_errors():
    """把 service 层 HTTPException 翻译成 agent 响应壳（设计稿 §5）。"""
    try:
        yield
    except AgentApiError:
        raise
    except HTTPException as exc:
        detail = str(exc.detail) if exc.detail else None
        if exc.status_code == 404:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND, human_message=detail
            ) from None
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail) from None


def _get_project_or_shell_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"项目 {project_id} 不存在",
        )
    return project


def _to_json(value) -> dict:
    """pydantic 模型 → JSON-safe dict。"""
    return value.model_dump(mode="json")


def _parse_country_param(country: str) -> str | None:
    """``country`` 查询参数归一化（对齐 account_health 域 BLF-956 约定）。

    空串 → None（不过滤，向后兼容——老调用方不传 country 行为不变）；
    非空 → :func:`parse_country` 严格归一化 + 校验（非法值 → 400
    VALIDATION_FAILED 壳，与既有 agent 约定一致）。
    """
    if not country or not country.strip():
        return None
    try:
        return parse_country(country)
    except Exception as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message=str(exc)
        ) from None


def _prev_period(report_month: date) -> tuple[date, date]:
    if report_month.month == 1:
        prev = date(report_month.year - 1, 12, 1)
    else:
        prev = date(report_month.year, report_month.month - 1, 1)
    last_day = calendar.monthrange(prev.year, prev.month)[1]
    return prev, date(prev.year, prev.month, last_day)


# ============================================================
# 10 条纯读路由（与原 external handler 同契约）
# ============================================================


@inventory_ledger_router.get("/months")
def get_agent_inventory_ledger_months(
    project_id: int,
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """月度盘点：有台账数据的月份列表（YYYY-MM-DD，每月 1 号）。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        months = get_available_months(db, project_id, country=normalized_country)
        resp = MonthsResponse(
            project_id=project_id,
            country=normalized_country,
            months=months,
        )
    return agent_ok(_to_json(resp))


@inventory_ledger_router.get("/snapshot")
def get_agent_inventory_ledger_snapshot(
    project_id: int,
    period: str = Query(
        ...,
        description="REQUIRED. Period selector — see backend/docs/inventory-ledger-api.md.",
    ),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """月度快照：SKU EOM + 处置汇总 + 完整性（整月窗口跑跨月完整性校验）。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        start, end, report_month = resolve_period_inputs(
            period,
            start_date,
            end_date,
        )

        prev_start: date | None = None
        prev_end: date | None = None
        if report_month:
            prev_start, prev_end = _prev_period(report_month)

        skus = get_sku_month_eom(
            db, project_id, start, end, prev_start, prev_end, country=normalized_country
        )
        disposition_summary = get_month_disposition_summary(
            db, project_id, start, end, country=normalized_country
        )

        integrity = None
        if report_month:
            integrity = check_ledger_integrity(
                db, project_id, report_month, country=normalized_country
            )

        total_qty = sum(s.qty_eom for s in skus)
        resp = MonthlySnapshotResponse(
            report_month=start,
            country=normalized_country,
            sku_count=len(skus),
            total_qty=total_qty,
            disposition_summary=disposition_summary,
            skus=skus,
            integrity=integrity,
        )
    return agent_ok(_to_json(resp))


@inventory_ledger_router.get("/events")
def get_agent_inventory_ledger_events(
    project_id: int,
    period: str = Query(
        ...,
        description="REQUIRED. Period selector — see backend/docs/inventory-ledger-api.md.",
    ),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """SKU 事件流：周期内每 SKU 各事件列合计。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        start, end, _report_month = resolve_period_inputs(
            period,
            start_date,
            end_date,
        )
        skus = get_sku_month_events(db, project_id, start, end, country=normalized_country)
        resp = EventsResponse(report_month=start, country=normalized_country, skus=skus)
    return agent_ok(_to_json(resp))


@inventory_ledger_router.get("/receipt-clusters")
def get_agent_inventory_ledger_receipt_clusters(
    project_id: int,
    period: str = Query(
        ...,
        description="REQUIRED. Period selector — see backend/docs/inventory-ledger-api.md.",
    ),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """收货簇：按（日期 × 仓库）归组收货。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        start, end, _report_month = resolve_period_inputs(
            period,
            start_date,
            end_date,
        )
        clusters = get_receipt_clusters(db, project_id, start, end, country=normalized_country)
        resp = ReceiptClustersResponse(report_month=start, country=normalized_country, clusters=clusters)
    return agent_ok(_to_json(resp))


@inventory_ledger_router.get("/integrity")
def get_agent_inventory_ledger_integrity(
    project_id: int,
    period: str = Query(
        ...,
        description=(
            "REQUIRED. Must resolve to a full calendar month (last_month, "
            "this_month, ytd, YYYY-MM, YYYY-MM-DD)."
        ),
    ),
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """跨月完整性校验：上月期末 vs 本月期初（每 SKU × 库位 × 处置）。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        start, end, report_month_date = resolve_period_inputs(
            period,
            None,
            None,
        )
        if report_month_date is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"period={period!r} does not resolve to a full calendar "
                    "month; integrity check requires a complete ledger "
                    "partition (use last_month, this_month, ytd, YYYY-MM, or "
                    "YYYY-MM-DD)"
                ),
            )
        resp = check_ledger_integrity(
            db, project_id, report_month_date, country=normalized_country
        )
    return agent_ok(_to_json(resp))


@inventory_ledger_router.get("/trend")
def get_agent_inventory_ledger_trend(
    project_id: int,
    months: int = Query(6, ge=1, le=24, description="Number of recent months"),
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """多月度趋势：最近 N 个月（默认 6，最大 24）聚合序列。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        items = get_trend(db, project_id, months=months, country=normalized_country)
        resp = TrendResponse(
            project_id=project_id, country=normalized_country, months=items
        )
    return agent_ok(_to_json(resp))


@inventory_ledger_router.get("/detail")
def get_agent_inventory_ledger_detail(
    project_id: int,
    period: str = Query(
        ...,
        description="REQUIRED. Period selector — see backend/docs/inventory-ledger-api.md.",
    ),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    msku: str | None = Query(default=None),
    fulfillment_center: str | None = Query(default=None),
    event_type: str | None = Query(default=None),
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """事件级明细行（Detailed 视图）+ msku/fulfillment_center/event_type 过滤。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        start, end, _report_month = resolve_period_inputs(
            period,
            start_date,
            end_date,
        )
        rows = get_ledger_detail_rows(
            db,
            project_id,
            start,
            end,
            msku=msku,
            fulfillment_center=fulfillment_center,
            event_type=event_type,
            country=normalized_country,
        )
        resp = LedgerDetailResponse(
            report_month=start, country=normalized_country, rows=rows
        )
    return agent_ok(_to_json(resp))


@inventory_ledger_router.get("/summary")
def get_agent_inventory_ledger_summary(
    project_id: int,
    period: str = Query(
        ...,
        description="REQUIRED. Period selector — see backend/docs/inventory-ledger-api.md.",
    ),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    msku: str | None = Query(default=None),
    location: str | None = Query(default=None),
    disposition: str | None = Query(default=None),
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """日水位行（Summary 视图）+ msku/location/disposition/country 过滤。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        start, end, _report_month = resolve_period_inputs(
            period,
            start_date,
            end_date,
        )
        rows = get_ledger_summary_rows(
            db,
            project_id,
            start,
            end,
            msku=msku,
            location=location,
            disposition=disposition,
            country=normalized_country,
        )
        resp = LedgerSummaryResponse(
            report_month=start, country=normalized_country, rows=rows
        )
    return agent_ok(_to_json(resp))


@inventory_ledger_router.get("/batches")
def get_agent_inventory_ledger_batches(
    project_id: int,
    limit: int = Query(100, ge=1, le=500, description="Max batches to return"),
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """CSV 导入批次（溯源）：文件标识 + 行数 + 状态 + 跨表一致性结果。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        batches = list_ingest_batches(
            db, project_id, limit=limit, country=normalized_country
        )
        resp = IngestBatchesResponse(
            project_id=project_id,
            country=normalized_country,
            batches=[IngestBatchInfo.model_validate(b) for b in batches],
        )
    return agent_ok(_to_json(resp))


@inventory_ledger_router.get("/consistency")
def get_agent_inventory_ledger_consistency(
    project_id: int,
    period: str = Query(
        ...,
        description="REQUIRED. Must resolve to a full calendar month.",
    ),
    country: str = Query(
        default="",
        description="OPTIONAL. 站点国家（US/DE/UK，归一化）；缺省不过滤。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """跨表一致性校验（Detail vs Summary 真值表）：OK / MISMATCH / PENDING。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        normalized_country = _parse_country_param(country)
        _start, _end, report_month = resolve_period_inputs(period, None, None)
        if report_month is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"period={period!r} does not resolve to a full calendar month; "
                    "consistency check requires a complete ledger partition"
                ),
            )
        resp = check_ledger_consistency(
            db, project_id, report_month, country=normalized_country
        )
    return agent_ok(_to_json(resp))
