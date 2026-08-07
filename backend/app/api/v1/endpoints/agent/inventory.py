"""Agent 库存信息域路由（BLF-478）。

在 ``/api/v1/agent/projects/{project_id}/inventory`` 开放 1 条纯读路由：

* R1 inventory —— 当前库存信息：summary + items + report_date。与补货
  （replenishment-analysis）/ 库存台账（inventory-ledger）分析**独立**——
  只读库存快照（总量 / 库龄 / 缺货 / 单 SKU 数量），服务于简短的临时性
  数量查看。复用内部 ``/api/v1/inventory-analysis`` 的 service 与 Redis
  缓存（同一 key，Agent 读与 UI 读共享、天然一致、成本为 0）。

参数：``?country=``（默认 US）；``?sku=`` 单 SKU 数量查看（大小写不敏感
子串，summary / action_options / shipment 列重算为过滤集，轻量返回）；
``?report_date=`` 历史快照（取该日或之前最近一份，默认最新业务日期）。

库存信息是纯读 / 简单域（快照来自 Amazon 报表，不可变事实）——1 条路由、
无 confirm、不落审计。路由挂 ``Depends(require_project_scope)``（BLF-441
硬前置）；域级 ``require_business_scope("inventory")`` 在 ``agent/__init__.py``
装配时挂载。
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_read_db_session
from app.models import Project
from app.services import inventory_analysis_service
from app.services.infra.inventory_cache import (
    get_inventory_analysis_cache,
    set_inventory_analysis_cache,
)

logger = logging.getLogger(__name__)

inventory_router = APIRouter(
    prefix="/projects/{project_id}",
    tags=["agent-inventory"],
)


# ============================================================
# 壳翻译与解析 helper（对齐退货分析/店铺域模板）
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


def _to_json_date(value) -> str | None:
    """date → ISO 字符串；None 原样返回（service 返回原生 date，壳需 JSON-safe）。"""
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _filter_inventory_payload(payload: dict, sku: str) -> dict:
    """``?sku=`` 过滤：items 按 SKU 子串（大小写不敏感）过滤。

    summary / action_options / shipment 列同步重算为过滤集——单 SKU 数量查看
    返回的就是那一两个 SKU 的贡献，而不是整项目大盘（轻量、口径自洽）。
    """
    needle = sku.strip().lower()
    items = [
        item
        for item in payload["items"]
        if needle in str(item.get("sku") or "").lower()
    ]
    action_options = sorted(
        {
            item["recommended_action"]
            for item in items
            if item.get("recommended_action")
        }
    )
    summary = {
        "sku_count": len(items),
        "out_of_stock_count": sum(
            1 for i in items if i.get("stock_status") == "out_of_stock"
        ),
        "aging_sku_count": sum(
            1 for i in items if i.get("aging_status") in ("aging", "over_aged")
        ),
        "over_aged_sku_count": sum(
            1 for i in items if i.get("aging_status") == "over_aged"
        ),
        "total_available_qty": sum(i.get("available_qty", 0) for i in items),
        "total_age_0_90_qty": sum(i.get("age_0_90_qty", 0) for i in items),
        "total_age_91_180_qty": sum(i.get("age_91_180_qty", 0) for i in items),
        "total_age_181_270_qty": sum(i.get("age_181_270_qty", 0) for i in items),
        "total_age_271_365_qty": sum(i.get("age_271_365_qty", 0) for i in items),
        "total_age_365_plus_qty": sum(i.get("age_365_plus_qty", 0) for i in items),
        "action_type_count": len(action_options),
    }
    shipment_nos = sorted(
        {sno for i in items for sno in i.get("shipment_quantities", {})}
    )
    shipment_columns = [
        c
        for c in payload.get("shipment_columns", [])
        if c.get("shipment_no") in shipment_nos
    ]
    shipment_column_totals = {
        sno: sum(i.get("shipment_quantities", {}).get(sno, 0) for i in items)
        for sno in shipment_nos
    }
    return {
        **payload,
        "summary": summary,
        "action_options": action_options,
        "items": items,
        "shipment_columns": shipment_columns,
        "shipment_column_totals": shipment_column_totals,
    }


# ============================================================
# R1 当前库存信息
# ============================================================


@inventory_router.get("/inventory")
def get_inventory(
    project_id: int,
    country: str = "US",
    sku: str | None = None,
    report_date: Annotated[
        date | None,
        Query(
            description=(
                "业务日期（YYYY-MM-DD），取该日或之前最近的库存快照；"
                "缺省返回最新业务日期"
            )
        ),
    ] = None,
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R1 当前库存信息：与内部 ``/api/v1/inventory-analysis`` 同构。

    ``?sku=`` 可查单个 SKU 数量（summary/action_options/shipment 列重算为
    过滤集）；``?report_date=`` 可查历史快照。响应含 report_date，Agent
    可据此判断数据新鲜度。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        report_date_str = str(report_date) if report_date else None
        cached = get_inventory_analysis_cache(project_id, country, report_date_str)
        if cached is not None:
            payload = cached
        else:
            payload = inventory_analysis_service.list_inventory_analysis(
                db,
                project_id=project_id,
                country=country,
                report_date=report_date,
            )
            payload["report_date"] = _to_json_date(payload.get("report_date"))
            set_inventory_analysis_cache(
                project_id, country, report_date_str, payload
            )

        if sku:
            payload = _filter_inventory_payload(payload, sku)

    return agent_ok(payload)
