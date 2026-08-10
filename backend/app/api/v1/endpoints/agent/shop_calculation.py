"""Agent 店铺测算历史/快照读路由（BLF-582 原生化：非 ad 域之一）。

在 ``/api/v1/agent/projects/{project_id}`` 开放 2 条纯读路由（**原生替换
external 镜像**，external/shop_calculation.py 端点模块已删除，BLF-582）：

* ``/shop-calculation-history`` — 当前态列表（每 SKU 最新非删行），
  ``?country=`` 过滤 + 分页；
* ``/shop-calculation/snapshots`` — append-only 时间序列，
  ``?from=&to=&sku=&country=`` 过滤。

* **与原生 shop-calculations 域的边界（BLF-582 边界核查）**：agent 已有
  ``/projects/{project_id}/shop-calculations/*`` 原生域（BLF-442，6 条路由，
  R1-R4 读 + W1 写 + C1 试算）——**本域 2 条路由是 BI 友好的扁平 15 列契约**
  （``ShopCalculationHistoryRow``，剔除 created_by/deleted_at/warnings_json/
  fee-rule 标签），响应形状与原生 rich item 不同；按「同域不同契约」处理：
  **独立保留本路由，挂同一个 ``business_scope("shop_calculations")``**（不并入
  原生域路由、不改原生域响应，避免双契约互相污染）。后续若统一契约可再合并，
  需用户拍板。
* **服务层复用**：``app.services.external._shop_calculation``（list 当前态 /
  snapshots 时间序列），0 存量调用方影响；``parse_country`` /
  ``parse_order_by``（external._helpers / _whitelist）共享保留。
* **项目不存在 → 404 壳**（对齐其它原生域模板）。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date as date_t

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_read_db_session
from app.api.v1.endpoints.agent._helpers import parse_country
from app.api.v1.endpoints.agent._whitelist import parse_order_by
from app.models import ShopCalculation
from app.schemas.external.common import PeriodParseError
from app.schemas.external.shop_calculation import (
    ShopCalculationHistoryResponse,
    ShopCalculationSnapshotsResponse,
)
from app.services.external import projects_query
from app.services.external import _shop_calculation as shop_calc_svc

shop_calculation_router = APIRouter(
    prefix="/projects/{project_id}",
    tags=["agent-shop-calculation"],
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


def _to_json(value) -> dict:
    """pydantic 模型 → JSON-safe dict。"""
    return value.model_dump(mode="json")


def _parse_iso_date(value: str | None, *, field: str) -> date_t | None:
    """Parse a YYYY-MM-DD string. None / empty returns None.

    Raises ``PeriodParseError`` on malformed input.
    """
    if not value or not value.strip():
        return None
    try:
        return date_t.fromisoformat(value.strip()[:10])
    except ValueError as exc:
        raise PeriodParseError(f"{field} must be YYYY-MM-DD, got {value!r}") from exc


def _apply_in_page_sort(rows, order_column, direction: str) -> None:
    """Sort a Python list of ``ShopCalculationHistoryRow`` by a column.

    The whitelist guarantees ``order_column`` is a ``ColumnElement``
    whose ``.key`` attribute maps back to one of the 15 Pydantic fields
    (e.g. ``observed_at``, ``profit_usd``). Non-numeric columns
    (notably ``observed_at``) sort by the natural Python order; ``None``
    values always sink to the bottom regardless of direction.
    """
    if not rows:
        return
    sort_key_name = getattr(order_column, "key", None)
    if not sort_key_name or not hasattr(rows[0], sort_key_name):
        return
    reverse = direction == "desc"

    def _key(row):
        v = getattr(row, sort_key_name)
        if v is None:
            # Push None to the end regardless of direction.
            return (1, 0)
        return (0, v)

    rows.sort(key=_key, reverse=reverse)


# ============================================================
# /shop-calculation-history — 当前态列表
# ============================================================


@shop_calculation_router.get("/shop-calculation-history")
def get_agent_shop_calculation_history(
    project_id: int = Path(..., ge=1),
    country: str = Query(default=""),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    order_by: str = Query(default="observed_at"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """当前态列表：每 ``(project_id, sku, country)`` 组最新非删行，扁平 15 列。"""
    with _service_errors():
        try:
            normalized_country = parse_country(country) if country else None
            order_column, direction = parse_order_by(
                order_by, order_dir, model=ShopCalculation
            )
        except PeriodParseError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if not projects_query.project_exists(db, project_id):
            raise HTTPException(
                status_code=404, detail=f"project {project_id} not found"
            )

        rows, total = shop_calc_svc.list_shop_calculation_history(
            db,
            project_id=project_id,
            country=normalized_country,
            page=page,
            page_size=page_size,
        )

        # Service already orders by ``observed_at DESC, id DESC``; if the
        # caller requested a different sort, reorder in Python. The result
        # set is bounded by ``page_size`` so the cost is negligible.
        if order_by != "observed_at" or order_dir != "desc":
            _apply_in_page_sort(rows, order_column, direction)

        resp = ShopCalculationHistoryResponse(
            project_id=project_id,
            country=normalized_country,
            total=total,
            data=rows,
        )
    return agent_ok(_to_json(resp))


# ============================================================
# /shop-calculation/snapshots — append-only 时间序列
# ============================================================


@shop_calculation_router.get("/shop-calculation/snapshots")
def get_agent_shop_calculation_snapshots(
    project_id: int = Path(..., ge=1),
    from_date: str | None = Query(
        default=None,
        description="Inclusive lower bound (YYYY-MM-DD). Defaults to no lower bound.",
    ),
    to_date: str | None = Query(
        default=None,
        description="Inclusive upper bound (YYYY-MM-DD). Defaults to no upper bound.",
    ),
    sku: str | None = Query(
        default=None,
        description="Exact-match SKU filter (case-sensitive).",
    ),
    country: str = Query(default=""),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """append-only 时间序列：同一 SKU/country 组可能跨多个 observed_at 快照。"""
    with _service_errors():
        try:
            from_d = _parse_iso_date(from_date, field="from_date")
            to_d = _parse_iso_date(to_date, field="to_date")
            normalized_country = parse_country(country) if country else None
            if from_d is not None and to_d is not None and from_d > to_d:
                raise PeriodParseError(
                    f"from_date must be <= to_date, got {from_d} > {to_d}"
                )
        except PeriodParseError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if not projects_query.project_exists(db, project_id):
            raise HTTPException(
                status_code=404, detail=f"project {project_id} not found"
            )

        rows = shop_calc_svc.list_shop_calculation_snapshots(
            db,
            project_id=project_id,
            from_date=from_d,
            to_date=to_d,
            sku=sku,
            country=normalized_country,
        )

        resp = ShopCalculationSnapshotsResponse(
            project_id=project_id,
            from_date=from_date,
            to_date=to_date,
            sku=sku,
            country=normalized_country,
            total=len(rows),
            data=rows,
        )
    return agent_ok(_to_json(resp))
