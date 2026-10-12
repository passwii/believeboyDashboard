"""Agent 新品测算域路由（BLF-451；spec §4-§6）。

在 ``/api/v1/agent/projects/{project_id}/new-product-calculations/*`` 开放 5 条路由：

* R1 列表 / R2 SKU 详情 / R3 SKU 审计 —— 读路由，不落审计；
* W1 快照写（confirm 两步：``new_product_calculation.upsert``）+ 写桶限流 + 审计归因；
* C1 试算（4 模式：profit_calc / profit_reverse / cost_reverse / fbm_calc，
  包装引擎纯计算函数，不落库不落审计）。

与店铺测算域（shop_calculations.py）的差异：W1 是 **upsert**（``(project_id, sku,
calculation_type)`` 唯一键覆盖，无历史）而非 append；C1 双字段
``{calculation, snapshot}`` 中 snapshot 可直接加 ``source`` 后 POST W1（D3 拍板）。

所有路由统一挂 ``Depends(require_project_scope)``（BLF-441 硬前置）。
写操作审计行 ``target_type="new_product_calculation"``、``target_id=<row.id>``
（行 id 稳定，可追溯该键全部 upsert 痕迹）、agent_id/idempotency_key 归因、
operator=NULL、created_by 保持 NULL。
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.agent.confirm import require_confirmation
from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.file_response import agent_file_response
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_primary_db_session, get_read_db_session
from app.db.session import SessionLocal
from app.models import Project
from app.models.new_product_calculation import NewProductCalculation
from app.models.sku_info import SkuRecord
from app.schemas.new_product_calculation import NewProductCalculationCreateRequest
from app.schemas.new_product_calculation_agent import (
    AgentCalculationSource,
    AgentNewProductCalculationComputeRequest,
    AgentNewProductCalculationUpsertRequest,
)
from app.services import new_product_calculation_service
from app.services.audit_log_service import (
    append_operation_audit_log,
    query_operation_audit_log_for_targets,
)
from app.services.new_product_calculation_export import (
    MAX_COMPARISON_SNAPSHOTS,
    XLSX_MEDIA_TYPE,
    build_new_product_comparison_export,
)
from app.services.pricing import _build_create_payload
from app.services.pricing.anchor import _anchor_from_computed
from app.services.pricing.computation import _compute_pricing
from app.services.pricing.cost_reverse import _solve_fob_cost_for_profit_rate
from app.services.pricing.fbm import _compute_fbm_pricing
from app.services.pricing.reverse import _solve_sale_price_for_profit_rate

new_product_calculations_router = APIRouter(
    prefix="/projects/{project_id}/new-product-calculations",
    tags=["agent-new-product-calculations"],
)

# Agent 写入允许的采集渠道（与 schema 枚举一致；validate 回调用）。
ALLOWED_AGENT_SOURCES: tuple[str, ...] = tuple(
    AgentCalculationSource.__args__  # type: ignore[attr-defined]
)


# ============================================================
# 壳翻译与解析 helper（对齐店铺域 shop_calculations.py 模式）
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


def _audit_kwargs(request: Request) -> dict:
    """agent 写审计归因（设计稿 §4.2：operator=NULL，agent_id/idempotency_key 归因）。"""
    return {
        "agent_id": getattr(request.state, "agent_id", None),
        "agent_name": getattr(request.state, "agent_label", None),
        "idempotency_key": request.headers.get("idempotency-key") or None,
        "request": request,
    }


def _parse_snapshot_ids(snapshot_ids: list[int] | None) -> list[int]:
    if not snapshot_ids:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="snapshot_ids 必填"
        )
    if len(snapshot_ids) > MAX_COMPARISON_SNAPSHOTS:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=f"snapshot_ids 最多 {MAX_COMPARISON_SNAPSHOTS} 条",
        )
    if any(snapshot_id <= 0 for snapshot_id in snapshot_ids):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="snapshot_ids 必须为正整数",
        )
    if len(set(snapshot_ids)) != len(snapshot_ids):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="snapshot_ids 不允许重复",
        )
    return snapshot_ids


def _check_idempotency_header(request: Request) -> None:
    """Idempotency-Key 可缺失；出现则必须非空且 ≤64 字符（spec §3）。"""
    value = request.headers.get("idempotency-key")
    if value is not None and (len(value) == 0 or len(value) > 64):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="Idempotency-Key 必须为非空字符串且不超过 64 字符",
        )


def _parse_upsert_request(body: dict) -> AgentNewProductCalculationUpsertRequest:
    """把原始 body 解析成 W1 请求模型；结构错误抛壳异常（对齐店铺域 _parse_append_request）。"""
    try:
        return AgentNewProductCalculationUpsertRequest(**body)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details=[
                {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg")}
                for err in exc.errors()
            ],
        ) from None


# ============================================================
# 读路由
# ============================================================


@new_product_calculations_router.get("")
def list_new_product_calculations(
    project_id: int,
    db: Session = Depends(get_read_db_session),
    calculation_type: str | None = Query(default=None),
    country: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    _scope=Depends(require_project_scope),
) -> dict:
    """R1 新品测算快照列表（calculation_type / country 过滤 + 分页，updated_at 倒序）。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        items, total = new_product_calculation_service.list_snapshots(
            db,
            project_id=project_id,
            calculation_type=calculation_type,
            country=country,
            page=page,
            page_size=page_size,
        )
    return agent_ok(
        {
            "items": [item.model_dump(mode="json") for item in items],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    )


@new_product_calculations_router.get(
    "/export.xlsx",
    response_class=StreamingResponse,
    response_model=None,
    responses={
        200: {
            "description": "新品测算对比矩阵 XLSX 文件流",
            "content": {
                XLSX_MEDIA_TYPE: {
                    "schema": {"type": "string", "format": "binary"}
                }
            },
        }
    },
)
def export_new_product_comparison(
    project_id: int,
    request: Request,
    snapshot_ids: list[int] | None = Query(default=None),
    db: Session = Depends(get_primary_db_session),
    _scope=Depends(require_project_scope),
) -> StreamingResponse:
    """按快照记录 ID 导出新品测算对比矩阵（XLSX 二进制流）。"""
    selected_ids = _parse_snapshot_ids(snapshot_ids)
    project = _get_project_or_shell_404(db, project_id)
    rows = list(
        db.scalars(
            select(NewProductCalculation).where(
                NewProductCalculation.project_id == project_id,
                NewProductCalculation.id.in_(selected_ids),
            )
        )
    )
    by_id = {row.id: row for row in rows}
    missing = [
        snapshot_id for snapshot_id in selected_ids if snapshot_id not in by_id
    ]
    if missing:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details={"missing_snapshot_ids": missing},
        )

    result = build_new_product_comparison_export(
        [by_id[snapshot_id] for snapshot_id in selected_ids],
        project_name=str(project.project_name),
        snapshot_ids=selected_ids,
    )
    append_operation_audit_log(
        db,
        action="new_product_calculation.export",
        target_type="new_product_calculation",
        target_id=project_id,
        operator=None,
        after={
            "snapshot_ids": selected_ids,
            "row_count": len(selected_ids),
            "column_count": result.column_count,
        },
        **_audit_kwargs(request),
    )
    db.commit()
    return agent_file_response(
        result.content,
        filename=result.filename,
        media_type=XLSX_MEDIA_TYPE,
    )


@new_product_calculations_router.get("/skus/{sku}")
def get_new_product_calculation_sku(
    project_id: int,
    sku: str,
    db: Session = Depends(get_read_db_session),
    calculation_type: str = Query(default="profit_calc"),
    _scope=Depends(require_project_scope),
) -> dict:
    """R2 SKU 详情：当前行（calculation_type 缺省 profit_calc）；不存在 → 404 壳。

    country 不在唯一键内（upsert 键为 (project_id, sku, calculation_type)），
    天然无歧义——与店铺域 R2 的 AMBIGUOUS_COUNTRY 不同。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        item = new_product_calculation_service.get_snapshot(
            db,
            project_id=project_id,
            sku=sku,
            calculation_type=calculation_type,
        )
    if item is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"SKU {sku} 在本项目不存在 {calculation_type} 新品测算记录",
        )
    return agent_ok(item.model_dump(mode="json"))


@new_product_calculations_router.get("/skus/{sku}/audit")
def get_new_product_calculation_audit(
    project_id: int,
    sku: str,
    db: Session = Depends(get_read_db_session),
    limit: int = Query(default=50, ge=1, le=200),
    _scope=Depends(require_project_scope),
) -> dict:
    """R3 SKU 审计：先拿该 SKU 全部快照行 id（upsert 行 id 稳定），再按行 id 聚合审计轨迹。

    upsert 覆盖语义下，同一 (project, sku, calculation_type) 的每次覆盖都挂在
    同一行 id 上——该 id 的审计行即该键全部 upsert 痕迹（含历史覆盖）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        rows = db.scalars(
            select(NewProductCalculation).where(
                NewProductCalculation.project_id == project_id,
                NewProductCalculation.sku == sku,
            )
        ).all()
    if not rows:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"SKU {sku} 在本项目不存在新品测算记录",
        )
    target_ids = [row.id for row in rows]
    audit_rows = query_operation_audit_log_for_targets(
        db,
        target_type="new_product_calculation",
        target_ids=target_ids,
        limit=limit,
    )
    return agent_ok(
        {
            "sku": sku,
            "items": [
                {
                    "id": row.id,
                    "created_at": row.created_at.isoformat()
                    if row.created_at
                    else None,
                    "action": row.action,
                    "agent_id": row.agent_id,
                    "operator": row.operator,
                    "idempotency_key": row.idempotency_key,
                    "result": row.result,
                    "before": row.before_json,
                    "after": row.after_json,
                    "error_message": row.error_message,
                }
                for row in audit_rows
            ],
        }
    )


# ============================================================
# W1 快照写（confirm 两步；spec §6）
# ============================================================


def _validate_upsert(body: dict, request: Request) -> None:
    """W1 业务校验（先于 confirm 签发 token；短路不生成 token）。"""
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])

    source = body.get("source")
    if source not in ALLOWED_AGENT_SOURCES:
        raise AgentApiError(
            ErrorCode.NEW_PRODUCT_CALCULATION_INVALID_SOURCE,
            details={"allowed": list(ALLOWED_AGENT_SOURCES)},
        )

    req = _parse_upsert_request(body)

    # SKU 存在性校验（spec §6.2 #2：按 (project_id, country, sku) 严格粒度，与店铺域一致）
    db = SessionLocal()
    try:
        _get_project_or_shell_404(db, project_id)
        exists = (
            db.execute(
                select(SkuRecord.sku).where(
                    SkuRecord.project_id == project_id,
                    SkuRecord.country == req.country,
                    SkuRecord.sku == req.sku,
                )
            ).first()
            is not None
        )
    finally:
        db.close()
    if not exists:
        raise AgentApiError(
            ErrorCode.NEW_PRODUCT_CALCULATION_INVALID_SKU,
            details=[{"sku": req.sku, "reason": "not_found"}],
        )

    # observed_at 不晚于 now()+24h（容忍时区偏差）
    if req.observed_at is not None:
        observed = req.observed_at
        if observed.tzinfo is None:
            observed = observed.replace(tzinfo=timezone.utc)
        if observed > datetime.now(timezone.utc) + timedelta(hours=24):
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message="observed_at 不能晚于当前时间 24 小时",
            )

    # 售价与总费用必须为正；利润允许为零或负数，以保留真实经营结果。
    if req.sale_price_usd <= 0 or req.total_fee_usd <= 0:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="sale_price_usd / total_fee_usd 必须为正数",
        )
    if not (-1 < req.profit_rate < 1):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="profit_rate 必须在 (-1, 1) 区间",
        )


def _preview_upsert(body: dict, request: Request) -> dict:
    """W1 confirm 预览摘要：is_new / previous（upsert 覆盖语义下的影响面）。"""
    project_id = int(request.path_params["project_id"])
    req = _parse_upsert_request(body)

    db = SessionLocal()
    try:
        current = new_product_calculation_service.get_snapshot(
            db,
            project_id=project_id,
            sku=req.sku,
            calculation_type=req.calculation_type,
        )
    finally:
        db.close()

    is_new = current is None
    previous = (
        {
            "sale_price_usd": current.sale_price_usd,
            "profit_usd": current.profit.profit_usd,
            "profit_rate": current.profit.profit_rate,
            "updated_at": current.updated_at.isoformat(),
        }
        if current is not None
        else None
    )
    note = (
        "首次写入：将新增该 (项目, SKU, 核算类型) 的快照行"
        if is_new
        else "upsert 语义：将覆盖该 (项目, SKU, 核算类型) 的当前行，历史不保留"
    )
    return {
        "action": "new_product_calculation.upsert",
        "sku": req.sku,
        "country": req.country,
        "calculation_type": req.calculation_type,
        "source": req.source,
        "sale_price_usd": req.sale_price_usd,
        "profit_usd": req.profit_usd,
        "profit_rate": req.profit_rate,
        "observed_at": req.observed_at.isoformat() if req.observed_at else None,
        "is_new": is_new,
        "previous": previous,
        "warnings_count": len(req.warnings),
        "note": note,
    }


@new_product_calculations_router.post(
    "", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="new_product_calculation.upsert",
    build_preview=_preview_upsert,
    validate=_validate_upsert,
)
async def upsert_new_product_calculation(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """W1 快照写：confirm 两步后按 (project_id, sku, calculation_type) upsert + 审计归因。"""
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    with _service_errors():
        project = _get_project_or_shell_404(db, project_id)
        req = _parse_upsert_request(body)
        payload = NewProductCalculationCreateRequest(
            project_id=project_id,
            project_name=str(project.project_name),
            **req.model_dump(),
        )
        item = new_product_calculation_service.upsert_snapshot(
            db, payload, operator=None
        )
        append_operation_audit_log(
            db,
            action="new_product_calculation.upsert",
            target_type="new_product_calculation",
            target_id=item.id,
            operator=None,
            after={
                "id": item.id,
                "project_id": item.project_id,
                "project_name": item.project_name,
                "sku": item.sku,
                "country": item.country,
                "calculation_type": item.calculation_type,
                "source": item.source,
                "observed_at": item.observed_at.isoformat()
                if item.observed_at
                else None,
            },
            **_audit_kwargs(request),
        )
        db.commit()
    return agent_ok(
        item.model_dump(mode="json"),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ============================================================
# C1 试算（不落库；spec §5.3）
# ============================================================


def _anchor_for_request(
    computed: dict[str, Any], request: AgentNewProductCalculationComputeRequest
):
    """新品域的 ``anchor``：目标净利率取请求上已有的 ``target_profit_rate``。

    profit_reverse / cost_reverse 模式下售价 / 成本是输出，引擎解出的值保证
    目标利润达成，因此 ``target_advertising_rate`` 会收束到请求输入的
    ``advertising_rate``（可当自洽断言用）。
    """
    return _anchor_from_computed(computed, target_net_margin=request.target_profit_rate)


def _engine_to_run_item(
    computed: dict[str, Any],
    request: AgentNewProductCalculationComputeRequest,
    mode: str,
) -> dict[str, Any]:
    """把引擎试算结果整形为 ``PricingCalculationRunItem`` 同构 dict（id=0 试算占位）。"""
    inputs = computed["inputs"]
    dims = computed["dimensions_decimal"]
    weights = computed["weights_decimal"]
    fees = computed["fees_decimal"]
    profit = computed["profit_decimal"]
    return {
        "id": 0,
        "country": request.country,
        "product_name": request.product_name,
        "calculation_type": mode,
        "project_id": None,
        "sku": request.sku,
        "package_length_cm": float(inputs["package_length_cm"]),
        "package_width_cm": float(inputs["package_width_cm"]),
        "package_height_cm": float(inputs["package_height_cm"]),
        "weight_kg": float(inputs["weight_kg"]),
        "fob_product_cost_rmb": float(inputs["fob_product_cost_rmb"]),
        "first_leg_cost_rmb": float(inputs["first_leg_cost_rmb"]),
        "first_leg_unit_price_rmb_per_kg": None,
        "sale_price_usd": float(inputs["sale_price_usd"]),
        "commission_rate": float(computed.get("commission_rate", 0.15)),
        "advertising_rate": float(inputs["advertising_rate"]),
        "return_loss_rate": float(inputs["return_loss_rate"]),
        "storage_months": float(inputs["storage_months"]),
        "inbound_placement_mode": inputs["inbound_placement_mode"],
        "size_tier": computed["size_tier"],
        "size_tier_label": computed["size_tier_label"],
        "price_band": computed["price_band"],
        "price_band_label": computed["price_band_label"],
        "usd_to_rmb_rate": float(computed["usd_to_rmb_rate"]),
        "usd_to_rmb_rate_source": computed["usd_to_rmb_rate_source"],
        "fulfillment_fee_rule_label": computed["fulfillment_fee_rule_label"],
        "inbound_config_fee_rule_label": computed["inbound_config_fee_rule_label"],
        "storage_fee_rule_label": computed["storage_fee_rule_label"],
        "dimensions": {key: float(value) for key, value in dims.items()},
        "weights": {
            **{key: float(value) for key, value in weights.items()},
            "chargeable_weight_rule": computed["weights"]["chargeable_weight_rule"],
        },
        "fees": {key: float(value) for key, value in fees.items()},
        "profit": {
            key: (float(value) if value is not None else None)
            for key, value in profit.items()
        },
        "warnings": computed["warnings"],
        "created_by": None,
        "created_at": None,
        "updated_at": None,
        "delivery_fee_usd": float(fees.get("delivery_fee_usd", 0) or 0),
        "full_container_quantity": float(request.full_container_quantity or 0),
        "full_container_price_rmb": float(request.full_container_price_rmb or 0),
        "competitor_url": None,
        # BLF-1043：派生块（本域的 target 即 target_profit_rate，即「给目标利润 →
        # 反算广告费率」）。成本已高过售价时 breakeven 为负，原样返回不 clamp。
        "anchor": _anchor_for_request(computed, request).model_dump(mode="json"),
    }


def _engine_to_snapshot(
    computed: dict[str, Any],
    request: AgentNewProductCalculationComputeRequest,
    mode: str,
) -> dict[str, Any]:
    """把引擎试算结果整形为 ``AgentNewProductCalculationUpsertRequest`` 同构快照。

    镜像前端 ``buildSnapshotPayload``（new-product-client.tsx:473）映射
    （profit.ddp_cost_rmb → ddp_cost_rmb、dimensions/weights/fees/profit 展开）；
    project_id/project_name 由 W1 路由层派生，故此处不出现；source/observed_at
    留占位（agent 填 source 后可直接 POST W1，D3 零字段映射）。
    """
    inputs = computed["inputs"]
    dims = computed["dimensions_decimal"]
    weights = computed["weights_decimal"]
    fees = computed["fees_decimal"]
    profit = computed["profit_decimal"]

    snapshot: dict[str, Any] = {
        "sku": request.sku,
        "asin": None,
        "country": request.country,
        "calculation_type": mode,
        "package_length_cm": float(inputs["package_length_cm"]),
        "package_width_cm": float(inputs["package_width_cm"]),
        "package_height_cm": float(inputs["package_height_cm"]),
        "weight_kg": float(inputs["weight_kg"]),
        "fob_product_cost_rmb": float(inputs["fob_product_cost_rmb"]),
        "first_leg_cost_rmb": float(inputs["first_leg_cost_rmb"]),
        "ddp_cost_rmb": float(profit["ddp_cost_rmb"]),
        "ddp_cost_usd": float(profit["ddp_cost_usd"]),
        "sale_price_usd": float(inputs["sale_price_usd"]),
        "target_profit_rate": request.target_profit_rate,
        "advertising_rate": float(inputs["advertising_rate"]),
        "return_loss_rate": float(inputs["return_loss_rate"]),
        "storage_months": float(inputs["storage_months"]),
        "inbound_placement_mode": inputs["inbound_placement_mode"],
        "usd_to_rmb_rate": float(computed["usd_to_rmb_rate"]),
        "usd_to_rmb_rate_source": computed["usd_to_rmb_rate_source"],
        "size_tier": computed["size_tier"],
        "size_tier_label": computed["size_tier_label"],
        "price_band": computed["price_band"],
        "price_band_label": computed["price_band_label"],
        "longest_side_in": float(dims["longest_side_in"]),
        "middle_side_in": float(dims["middle_side_in"]),
        "shortest_side_in": float(dims["shortest_side_in"]),
        "length_plus_girth_in": float(dims["length_plus_girth_in"]),
        "volume_cubic_in": float(dims["volume_cubic_in"]),
        "volume_cubic_ft": float(dims["volume_cubic_ft"]),
        "product_weight_lb": float(weights["product_weight_lb"]),
        "product_weight_oz": float(weights["product_weight_oz"]),
        "dimensional_weight_lb": float(weights["dimensional_weight_lb"]),
        "chargeable_weight_lb": float(weights["chargeable_weight_lb"]),
        "chargeable_weight_oz": float(weights["chargeable_weight_oz"]),
        "chargeable_weight_rule": computed["weights"]["chargeable_weight_rule"],
        "fulfillment_fee_rule_label": computed["fulfillment_fee_rule_label"],
        "inbound_config_fee_rule_label": computed["inbound_config_fee_rule_label"],
        "storage_fee_rule_label": computed["storage_fee_rule_label"],
        "referral_fee_usd": float(fees["referral_fee_usd"]),
        "advertising_fee_usd": float(fees["advertising_fee_usd"]),
        "return_loss_usd": float(fees["return_loss_usd"]),
        "fba_fulfillment_fee_usd": float(fees.get("fba_fulfillment_fee_usd", 0) or 0),
        "inbound_config_fee_usd": float(fees.get("inbound_config_fee_usd", 0) or 0),
        "storage_fee_usd": float(fees.get("storage_fee_usd", 0) or 0),
        "total_fee_usd": float(fees["total_fee_usd"]),
        "delivery_fee_usd": float(fees.get("delivery_fee_usd", 0) or 0),
        "inbound_config_fee_manual_usd": 0.0,
        "storage_fee_manual_usd": 0.0,
        "payout_usd": float(profit["payout_usd"]),
        "profit_usd": float(profit["profit_usd"]),
        "profit_rate": float(profit["profit_rate"]),
        "vat_usd": float(profit.get("vat_usd", 0) or 0),
        "profit_after_vat_usd": (
            float(profit["profit_after_vat_usd"])
            if profit.get("profit_after_vat_usd") is not None
            else None
        ),
        "profit_after_vat_rate": (
            float(profit["profit_after_vat_rate"])
            if profit.get("profit_after_vat_rate") is not None
            else None
        ),
        "warnings": computed["warnings"],
        "notes": None,
        "source": None,
        "observed_at": None,
    }
    # BLF-1043：snapshot 同样带 anchor（多余的键在 POST W1 时被
    # ``AgentNewProductCalculationUpsertRequest`` 忽略，extra=ignore）。
    snapshot["anchor"] = _anchor_for_request(computed, request).model_dump(mode="json")
    return snapshot


@new_product_calculations_router.post("/compute")
def compute_new_product_calculation(
    project_id: int,
    payload: AgentNewProductCalculationComputeRequest,
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """C1 试算：包装 4 个引擎纯计算函数（不落库、不落审计），返回 {calculation, snapshot} 双字段。

    profit_reverse / cost_reverse 的引擎函数只解出单一数值（建议售价 / 最大 FOB
    成本），再用解出的值跑一遍 ``_compute_pricing`` 拿完整派生快照（与内部
    create_pricing_reverse_run / create_pricing_cost_reverse_run 同构，但不落 run）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        try:
            if payload.mode == "profit_reverse":
                resolved_price = _solve_sale_price_for_profit_rate(payload, db)
                create_payload = _build_create_payload(
                    payload, sale_price_usd=float(resolved_price)
                )
                computed = _compute_pricing(create_payload, db)
            elif payload.mode == "cost_reverse":
                resolved_cost = _solve_fob_cost_for_profit_rate(payload, db)
                create_payload = _build_create_payload(
                    payload, fob_cost_rmb=float(resolved_cost)
                )
                computed = _compute_pricing(create_payload, db)
            elif payload.mode == "fbm_calc":
                computed = _compute_fbm_pricing(payload, db)
            else:
                computed = _compute_pricing(payload, db)
        except ValueError as exc:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=str(exc),
                details=[{"engine": str(exc)}],
            ) from None
    anchor = _anchor_for_request(computed, payload)
    return agent_ok(
        {
            "mode": payload.mode,
            "calculation": _engine_to_run_item(computed, payload, payload.mode),
            "snapshot": _engine_to_snapshot(computed, payload, payload.mode),
            # 汇率同一份来源：从 anchor.basis 取，避免散落的 float() 窄化
            "usd_to_rmb_rate": anchor.basis.usd_to_rmb_rate,
            "usd_to_rmb_rate_source": anchor.basis.usd_to_rmb_rate_source,
        }
    )
