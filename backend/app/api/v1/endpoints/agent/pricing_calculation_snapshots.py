"""Agent 定价快照读路由（BLF-582 原生化：非 ad 域之一）。

在 ``/api/v1/agent/projects/{project_id}/pricing-snapshots`` 开放 1 条纯读
路由（**原生替换 external 镜像**，external/pricing_calculation_snapshots.py
端点模块已删除，BLF-582）：

* ``?as_of=YYYY-MM-DD`` 返回 ``pricing_calculation_snapshots`` 中
  ``snapshot_date`` ≤ ``as_of`` 的最近一次目录冻结（无 as_of → 最近一份）；
  无快照 → 404 壳。响应与 shop-calculation 端点同构（扁平 15 列 BI 形状，
  ``ShopCalculationSnapshotsResponse``）。
* **域归属（BLF-582 边界核查）**：定价快照 = 店铺测算的「定价目录冻结」
  （从 ``shop_calculation`` 当前态复制，``pricing_calculation_snapshot_service``
  内部文档即「提供店铺定价历史快照」）——挂**既有 ``shop_calculations``
  business_scope**，不新增域 code（前端 agent-domains.ts 无对应条目，避免
  无 UI 的孤儿 scope；审计映射同步从陈旧的 new_product_calculations 修正为
  shop_calculations）。
* **服务层复用**：``app.services.external._pricing_calculation_snapshot``
  （``find_pricing_snapshot_as_of`` → ``get_snapshot_detail`` + BI 拍平），
  0 存量调用方影响。
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
from app.api.v1.endpoints.external._helpers import parse_country
from app.schemas.external.common import PeriodParseError
from app.schemas.external.shop_calculation import (
    ShopCalculationSnapshotsResponse,
)
from app.services.external import projects_query
from app.services.external import (
    _pricing_calculation_snapshot as pricing_snap_svc,
)

pricing_snapshots_router = APIRouter(
    prefix="/projects/{project_id}",
    tags=["agent-pricing-snapshots"],
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


# ============================================================
# /pricing-snapshots — 目录冻结 as-of
# ============================================================


@pricing_snapshots_router.get("/pricing-snapshots")
def get_agent_pricing_snapshot_as_of(
    project_id: int = Path(..., ge=1),
    as_of: str | None = Query(
        default=None,
        description=(
            "Inclusive upper bound (YYYY-MM-DD). Defaults to no upper bound "
            "(most recent snapshot)."
        ),
    ),
    country: str = Query(default="US"),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """定价目录冻结：最近一次 ``snapshot_date ≤ as_of`` 的全 SKU 经济账。"""
    with _service_errors():
        try:
            normalized_country = parse_country(country)
            as_of_date = _parse_iso_date(as_of, field="as_of")
        except PeriodParseError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if not projects_query.project_exists(db, project_id):
            raise HTTPException(
                status_code=404, detail=f"project {project_id} not found"
            )

        snapshot_id, rows = pricing_snap_svc.find_pricing_snapshot_as_of(
            db,
            project_id=project_id,
            country=normalized_country,
            as_of=as_of_date,
        )
        if snapshot_id is None:
            if as_of_date is not None:
                detail = (
                    f"no pricing snapshot for project {project_id} in "
                    f"{normalized_country} on or before {as_of_date.isoformat()}"
                )
            else:
                detail = f"no pricing snapshot for project {project_id} in {normalized_country}"
            raise HTTPException(status_code=404, detail=detail)

        resp = ShopCalculationSnapshotsResponse(
            project_id=project_id,
            from_date=None,
            to_date=as_of,
            sku=None,
            country=normalized_country,
            total=len(rows),
            data=rows,
        )
    return agent_ok(_to_json(resp))
