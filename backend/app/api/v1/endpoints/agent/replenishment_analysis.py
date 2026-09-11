"""Agent 补货分析域路由（BLF-502；spec v0.2）。

在 ``/api/v1/agent/projects/{project_id}/replenishment-analysis*`` 开放
6 条路由（v1，Agent 任务模型驱动，spec §2）：

* R1 决策清单 —— ``GET /replenishment-analysis``：全量逐 SKU 分析
  （三段式：5 state + 6 action + signals + 季节性）。external §6 契约保留
  （country/keyword/risk_status/in_transit_only/report_date/page/page_size）
  + 新增 ``inventory_state`` / ``replenishment_action`` 多值过滤 +
  ``order_by`` 白名单 + ``?detail=summary|full`` 响应瘦身（D2）；
* R2 单 SKU 深挖 —— ``GET /replenishment-analysis/skus/{sku}``：完整行 +
  signals + decision_path（G1 解释性）；无该 SKU → 200 + ``data: null``；
* R3 项目总览 —— ``GET /replenishment-analysis/summary``：state×action
  分布矩阵 + 关键指标（无 items，轻量）；
* R4 覆盖度 —— ``GET /replenishment-analysis/coverage``：库存快照新鲜度
  + 销售跨度 + 设置覆盖 + unknown_rate（G4/G7）；
* R5 设置列表 —— ``GET /replenishment-analysis/settings``：补货设置审计（G8）；
* R6 设置写 —— ``PUT /replenishment-analysis/settings/{sku}``：confirm 流
  + agent 审计归因（operator=NULL + agent_id）。

补货分析是读为主的实时分析域（无物化表）：读路由无 confirm、无写桶、
不落审计（对齐全仓决策）；R6 写走 confirm。全部路由挂
``Depends(require_project_scope)``（BLF-441 硬前置）；域级
``require_business_scope("replenishment_analysis")`` 在
``agent/__init__.py`` 装配时挂载。
"""

from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.api.agent.confirm import require_confirmation
from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_primary_db_session, get_read_db_session
from app.models import Project
from app.schemas.inventory_replenishment import (
    InventoryReplenishmentSettingUpdate,
)
from app.services.audit_log_service import append_operation_audit_log
from app.services.infra.cache_decorator import invalidate_cache_on_commit
from app.services.infra.inventory_cache import (
    get_inventory_replenishment_cache,
    set_inventory_replenishment_cache,
)
from app.services.inventory.replenishment import (
    REPLENISHMENT_ORDER_BY_FIELDS,
    ACTION_VALUES,
    STATE_VALUES,
    count_replenishment_base_skus,
    count_replenishment_configured_settings,
    get_sales_data_span,
    list_inventory_replenishment_analysis,
    list_inventory_replenishment_settings,
    list_snapshot_options,
    upsert_inventory_replenishment_setting,
)
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

replenishment_analysis_router = APIRouter(
    prefix="/projects/{project_id}",
    tags=["agent-replenishment-analysis"],
)

# R1 detail 两档（D2：默认轻量，LLM token 优化）
DETAIL_SUMMARY = "summary"
DETAIL_FULL = "full"

# detail=summary 时 items 保留的核心决策字段（spec §4.2）
_LIGHT_ROW_FIELDS = (
    "sku",
    "asin",
    "product_name",
    "available_inventory",
    "in_transit_quantity",
    "weighted_dms",
    "sellable_days",
    "estimated_replenishment_quantity",
    "inventory_state",
    "replenishment_action",
    "risk_status",
    "replenishment_order_date",
    # BLF-630: 补货周期/覆盖时间线核心决策字段
    "order_buffer_days",
    "coverage_end_date",
)

_VALID_STATES = set(STATE_VALUES)
_VALID_ACTIONS = set(ACTION_VALUES)
_VALID_DETAILS = {DETAIL_SUMMARY, DETAIL_FULL}


# ============================================================
# 壳翻译与解析 helper（对齐退货分析/库存域模板）
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


def _check_idempotency_header(request: Request) -> None:
    """Idempotency-Key 可缺失；出现则必须非空且 ≤64 字符（spec §3）。"""
    value = request.headers.get("idempotency-key")
    if value is not None and (len(value) == 0 or len(value) > 64):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="Idempotency-Key 必须为非空字符串且不超过 64 字符",
        )


def _audit_kwargs(request: Request) -> dict:
    """agent 写审计归因（设计稿 §4.2：operator=NULL，agent_id/idempotency_key 归因）。"""
    return {
        "agent_id": getattr(request.state, "agent_id", None),
        "agent_name": getattr(request.state, "agent_label", None),
        "idempotency_key": request.headers.get("idempotency-key") or None,
        "request": request,
    }


def _parse_multi_filter(value: str | None, valid: set[str], label: str) -> str | None:
    """逗号分隔多值白名单校验；非法值 → 400 VALIDATION_FAILED。"""
    if not value:
        return None
    parts = [v.strip() for v in value.split(",") if v.strip()]
    bad = [p for p in parts if p not in valid]
    if bad:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(f"{label} 含非法值: {bad}；合法值: {sorted(valid)}"),
        )
    return ",".join(parts)


def _validate_query_params(
    *,
    inventory_state: str | None,
    replenishment_action: str | None,
    order_by: str | None,
    order_dir: str,
    detail: str,
) -> None:
    _parse_multi_filter(inventory_state, _VALID_STATES, "inventory_state")
    _parse_multi_filter(replenishment_action, _VALID_ACTIONS, "replenishment_action")
    if order_by and order_by not in REPLENISHMENT_ORDER_BY_FIELDS:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(
                f"order_by 非法: {order_by!r}；合法值: {list(REPLENISHMENT_ORDER_BY_FIELDS)}"
            ),
        )
    if detail not in _VALID_DETAILS:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=f"detail 非法: {detail!r}；合法值: summary|full",
        )


def _to_json_safe_rows(rows: list[dict]) -> list[dict]:
    """把 service 行转 JSON-safe。

    BLF-1016 起 ``signals`` 由 service 侧 ``model_dump(mode="json")`` 输出为
    dict，这里只做兜底（仍是 pydantic 值时归一化），不承担转换职责。
    """
    out = []
    for row in rows:
        item = dict(row)
        signals = item.get("signals")
        if signals is not None and hasattr(signals, "model_dump"):
            item["signals"] = signals.model_dump(mode="json")
        out.append(item)
    return out


def _light_rows(rows: list[dict]) -> list[dict]:
    """detail=summary：只保留核心决策字段（D2 瘦身）。"""
    return [{k: row.get(k) for k in _LIGHT_ROW_FIELDS if k in row} for row in rows]


def _build_payload(
    rows: list[dict],
    summary: dict,
    *,
    page: int,
    page_size: int,
    total: int,
    has_next: bool,
    detail: str,
) -> dict:
    json_rows = _to_json_safe_rows(rows)
    items = _light_rows(json_rows) if detail == DETAIL_SUMMARY else json_rows
    return {
        "items": items,
        "summary": summary,
        "page": page,
        "page_size": page_size,
        "total": total,
        "has_next": has_next,
    }


# ============================================================
# R1 决策清单
# ============================================================


@replenishment_analysis_router.get("/replenishment-analysis")
def get_replenishment_analysis(
    project_id: int,
    country: str = "US",
    keyword: str | None = Query(
        default=None,
        description="SKU/ASIN 子串过滤（大小写不敏感）",
    ),
    inventory_state: str | None = Query(
        default=None,
        description=(
            "三段式状态过滤（逗号分隔多值）：critical/deteriorating/watch/"
            "healthy/unknown"
        ),
    ),
    replenishment_action: str | None = Query(
        default=None,
        description=(
            "三段式行动过滤（逗号分隔多值）：REPLENISH_NOW/REPLENISH_NORMAL/"
            "HOLD/REDUCE_PRICE/REMOVE/NO_ACTION"
        ),
    ),
    risk_status: str | None = Query(
        default=None,
        description=(
            "老 4 类风险过滤（兼容既有消费者，新消费者优先用 inventory_state/"
            "replenishment_action）：断货风险|短期断货|长期断货|健康库存|滞销|"
            "严重滞销|待补数据"
        ),
    ),
    in_transit_only: bool = False,
    report_date: date | None = Query(
        default=None,
        description="业务日期（YYYY-MM-DD），取该日或之前最近的库存快照；缺省最新",
    ),
    order_by: str | None = Query(
        default=None,
        description="排序字段（白名单）：sku/available_inventory/in_transit_quantity/weighted_dms/sellable_days/estimated_replenishment_quantity/risk_status/inventory_state/replenishment_action",
    ),
    order_dir: str = Query(default="asc", pattern="^(asc|desc)$"),
    detail: str = Query(
        default=DETAIL_SUMMARY,
        description="summary（默认，轻量决策字段）/ full（完整行 + signals + decision_path）",
    ),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R1 决策清单：全量逐 SKU 分析（Agent 任务 T1）。

    与 internal/external 同源 service；默认路径（无新过滤/排序、detail=summary）
    与 detail=full 共享 5min Redis 缓存（key 含全部新参数，D10）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        _validate_query_params(
            inventory_state=inventory_state,
            replenishment_action=replenishment_action,
            order_by=order_by,
            order_dir=order_dir,
            detail=detail,
        )
        normalized_state = _parse_multi_filter(
            inventory_state, _VALID_STATES, "inventory_state"
        )
        normalized_action = _parse_multi_filter(
            replenishment_action, _VALID_ACTIONS, "replenishment_action"
        )
        report_date_str = str(report_date) if report_date else None

        cached = get_inventory_replenishment_cache(
            project_id,
            country,
            keyword,
            risk_status,
            in_transit_only,
            page,
            page_size,
            inventory_state=normalized_state,
            replenishment_action=normalized_action,
            order_by=order_by,
            order_dir=order_dir,
            detail=detail,
            report_date=report_date_str,
        )
        if cached is not None:
            return agent_ok(cached)

        rows, summary, total, has_next = list_inventory_replenishment_analysis(
            db,
            project_id=project_id,
            country=country,
            keyword=keyword,
            risk_status=risk_status,
            in_transit_only=in_transit_only,
            report_date=report_date,
            inventory_state=normalized_state,
            replenishment_action=normalized_action,
            order_by=order_by,
            order_dir=order_dir,
            page=page,
            page_size=page_size,
        )
        payload = _build_payload(
            rows,
            summary,
            page=page,
            page_size=page_size,
            total=total,
            has_next=has_next,
            detail=detail,
        )
        set_inventory_replenishment_cache(
            project_id,
            country,
            keyword,
            risk_status,
            in_transit_only,
            page,
            page_size,
            payload,
            inventory_state=normalized_state,
            replenishment_action=normalized_action,
            order_by=order_by,
            order_dir=order_dir,
            detail=detail,
            report_date=report_date_str,
        )
    return agent_ok(payload)


# ============================================================
# R2 单 SKU 深挖
# ============================================================


@replenishment_analysis_router.get("/replenishment-analysis/skus/{sku}")
def get_replenishment_analysis_sku(
    project_id: int,
    sku: str,
    country: str = "US",
    report_date: date | None = Query(
        default=None,
        description="业务日期（YYYY-MM-DD），取该日或之前最近的库存快照；缺省最新",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R2 单 SKU 深挖（Agent 任务 T2）：完整行 + signals + decision_path。

    无该 SKU → 200 + ``data: null``（D5：查询结果为空 ≠ 资源不存在）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        rows, _summary, _total, _has_next = list_inventory_replenishment_analysis(
            db,
            project_id=project_id,
            country=country,
            keyword=sku,
            risk_status=None,
            in_transit_only=False,
            report_date=report_date,
            page=1,
            page_size=200,
        )
        needle = sku.strip().lower()
        match = next(
            (r for r in rows if str(r.get("sku") or "").lower() == needle), None
        )
        if match is None:
            return agent_ok(None)
        json_row = _to_json_safe_rows([match])[0]
    return agent_ok(json_row)


# ============================================================
# R3 项目总览
# ============================================================


@replenishment_analysis_router.get("/replenishment-analysis/summary")
def get_replenishment_analysis_summary(
    project_id: int,
    country: str = "US",
    report_date: date | None = Query(
        default=None,
        description="业务日期（YYYY-MM-DD），取该日或之前最近的库存快照；缺省最新",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R3 项目总览（Agent 任务 T3）：state/action 分布 + 交叉矩阵，无 items。

    与 R1 同计算源（service summary 已含 state_distribution /
    action_distribution / state_action_matrix，S6/G5）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        _rows, summary, _total, _has_next = list_inventory_replenishment_analysis(
            db,
            project_id=project_id,
            country=country,
            keyword=None,
            risk_status=None,
            in_transit_only=False,
            report_date=report_date,
            page=1,
            page_size=1,
        )
    return agent_ok(
        {
            "project_id": project_id,
            "country": country,
            "as_of_date": (
                report_date.isoformat()
                if report_date is not None
                else date.today().isoformat()
            ),
            "summary": summary,
        }
    )


# ============================================================
# R4 数据覆盖度 / 新鲜度
# ============================================================


@replenishment_analysis_router.get("/replenishment-analysis/coverage")
def get_replenishment_analysis_coverage(
    project_id: int,
    country: str = "US",
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R4 数据覆盖度 / 新鲜度（Agent 任务 T4）：快照 report_date + 销售跨度
    + 设置覆盖 + unknown_rate（G4/G7）。Agent 判断「这份分析是否可信」。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        as_of = date.today()
        options = list_snapshot_options(db, project_id=project_id, country=country)
        latest = options[0] if options else None
        if latest is not None:
            snapshot_report_date = latest["report_date"]
            freshness_days = max(0, (as_of - snapshot_report_date).days)
            snapshot = {
                "report_date": snapshot_report_date.isoformat(),
                "freshness_days": freshness_days,
                "is_current": bool(latest["is_current"]),
                "available_options_count": len(options),
            }
        else:
            snapshot = {
                "report_date": None,
                "freshness_days": None,
                "is_current": False,
                "available_options_count": 0,
            }
        # unknown_rate：复用分析 service 的无过滤 summary（一次全量计算）
        _rows, summary, _total, _has_next = list_inventory_replenishment_analysis(
            db,
            project_id=project_id,
            country=country,
            keyword=None,
            risk_status=None,
            in_transit_only=False,
            page=1,
            page_size=1,
        )
        sku_count = int(summary.get("sku_count") or 0)
        unknown_rate = (
            round(int(summary.get("unknown_count") or 0) / sku_count, 4)
            if sku_count > 0
            else 0.0
        )
    return agent_ok(
        {
            "project_id": project_id,
            "country": country,
            "as_of_date": as_of.isoformat(),
            "inventory_snapshot": snapshot,
            "sales_data": get_sales_data_span(
                db, project_id=project_id, country=country
            ),
            "base_skus": {
                "total_count": count_replenishment_base_skus(
                    db, project_id=project_id, country=country
                ),
                "configured_count": count_replenishment_configured_settings(
                    db, project_id=project_id, country=country
                ),
            },
            "unknown_rate": unknown_rate,
        }
    )


# ============================================================
# R5 设置列表
# ============================================================


@replenishment_analysis_router.get("/replenishment-analysis/settings")
def get_replenishment_analysis_settings(
    project_id: int,
    country: str = "US",
    sku: str | None = Query(
        default=None,
        description="SKU 子串过滤（可选）",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R5 设置列表（Agent 任务 T5 读侧，G8 配置审计）。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        items = list_inventory_replenishment_settings(
            db, project_id=project_id, country=country, sku=sku
        )
    return agent_ok({"items": items})


# ============================================================
# R6 设置写（confirm 流）
# ============================================================


def _validate_setting_body(body: dict, request: Request) -> None:
    """confirm 预览前的校验（token 签发前失败，spec S6）。"""
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    db = SessionLocal()
    try:
        _get_project_or_shell_404(db, project_id)
    finally:
        db.close()
    if not isinstance(body, dict):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="请求体必须是 JSON 对象"
        )
    try:
        InventoryReplenishmentSettingUpdate(
            asin=body.get("asin"),
            production_lead_days=int(body["production_lead_days"]),
            shipping_days=int(body["shipping_days"]),
            safety_factor=float(body["safety_factor"]),
            target_days=(
                int(body["target_days"])
                if body.get("target_days") is not None
                else None
            ),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(
                "请求体必须包含 production_lead_days / shipping_days / "
                f"safety_factor（非负数字）：{exc}"
            ),
        ) from None


def _preview_setting(body: dict, request: Request) -> dict:
    """confirm 预览摘要：动作 + 影响（旧值由 upsert 覆盖语义隐含）。"""
    return {
        "action": "replenishment_settings.upsert",
        "summary": {
            "project_id": int(request.path_params["project_id"]),
            "sku": request.path_params["sku"],
            "country": request.query_params.get("country") or "US",
            "new": {
                "asin": body.get("asin"),
                "production_lead_days": body.get("production_lead_days"),
                "shipping_days": body.get("shipping_days"),
                "safety_factor": body.get("safety_factor"),
                "target_days": body.get("target_days"),
            },
            "note": "将覆盖该 SKU 的补货设置（生产周期/海运周期/安全系数/目标覆盖天数），影响后续补货建议",
        },
    }


@replenishment_analysis_router.put(
    "/replenishment-analysis/settings/{sku}",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
@require_confirmation(
    action="replenishment_settings.upsert",
    build_preview=_preview_setting,
    validate=_validate_setting_body,
)
@invalidate_cache_on_commit(domains=["inventory_replenishment"], project_id_from="path")
async def update_replenishment_analysis_setting(
    request: Request,
    db: Session = Depends(get_primary_db_session),
) -> dict:
    """R6 设置写（Agent 任务 T5 写侧）：confirm 预览 → 重放落库。

    审计 action ``inventory_replenishment_settings.upsert``（operator=NULL +
    agent_id 归因，对齐内部端点审计动作名）。
    """
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    sku = str(request.path_params["sku"])
    country = request.query_params.get("country") or "US"
    payload = InventoryReplenishmentSettingUpdate(
        asin=body.get("asin"),
        production_lead_days=int(body["production_lead_days"]),
        shipping_days=int(body["shipping_days"]),
        safety_factor=float(body["safety_factor"]),
        target_days=(
            int(body["target_days"]) if body.get("target_days") is not None else None
        ),
    )
    with _service_errors():
        row = upsert_inventory_replenishment_setting(
            db,
            project_id=project_id,
            sku=sku,
            country=country,
            asin=payload.asin,
            production_lead_days=payload.production_lead_days,
            shipping_days=payload.shipping_days,
            safety_factor=payload.safety_factor,
            target_days=payload.target_days,
            operator=None,
        )
        append_operation_audit_log(
            db,
            action="inventory_replenishment_settings.upsert",
            target_type="inventory_replenishment_setting",
            target_id=row.id,
            operator=None,
            after={
                "project_id": row.project_id,
                "sku": row.sku,
                "country": row.country,
                "asin": row.asin,
                "production_lead_days": row.production_lead_days,
                "shipping_days": row.shipping_days,
                "safety_factor": float(row.safety_factor),
                "target_days": int(row.target_days),
            },
            **_audit_kwargs(request),
        )
        db.commit()
    return agent_ok(
        {
            "project_id": int(row.project_id),
            "project_name": str(row.project_name),
            "sku": str(row.sku),
            "country": str(row.country),
            "asin": row.asin,
            "production_lead_days": int(row.production_lead_days),
            "shipping_days": int(row.shipping_days),
            "safety_factor": float(row.safety_factor),
            "target_days": int(row.target_days),
        },
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
