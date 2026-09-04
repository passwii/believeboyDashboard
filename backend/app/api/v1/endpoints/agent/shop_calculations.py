"""Agent 店铺测算域路由（BLF-442；spec §2-§5）。

在 ``/api/v1/agent/projects/{project_id}/shop-calculations/*`` 开放 6 条路由：

* R1 列表 / R2 SKU 详情（country 消歧）/ R3 历史 / R4 审计 —— 读路由，
  不落审计、绕过 Redis 读缓存直查 DB；
* W1 追加写（confirm 两步：``shop_calculation.append``）+ 写桶限流 + 审计归因；
* C1 试算（profit_calc / eu_accounting，包装引擎纯计算函数，不落库）。

所有路由统一挂 ``Depends(require_project_scope)``（BLF-441 L2 硬前置，
spec §6.2）。写操作审计行 ``target_type="shop_calculation"``、
``target_id=<row.id>``、agent_id/idempotency_key 归因、operator=NULL。
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.agent.confirm import require_confirmation
from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_primary_db_session, get_read_db_session
from app.db.session import SessionLocal
from app.models import Project
from app.models.shop_calculation import ShopCalculation
from app.models.sku_info import SkuRecord
from app.schemas.shop_calculation import ShopCalculationCreateRequest
from app.schemas.shop_calculation_agent import (
    AgentCalculationSource,
    AgentShopCalculationAppendRequest,
    AgentShopCalculationComputeRequest,
    ComputeMode,
)
from app.services import shop_calculation_service
from app.services.audit_log_service import (
    append_operation_audit_log,
    query_operation_audit_log_for_targets,
)
from app.services.pricing.computation import _compute_eu_pricing, _compute_pricing

shop_calculations_router = APIRouter(
    prefix="/projects/{project_id}/shop-calculations",
    tags=["agent-shop-calculations"],
)

# Agent 写入允许的采集渠道（与 schema 枚举一致；validate 回调用）。
ALLOWED_AGENT_SOURCES: tuple[str, ...] = tuple(
    AgentCalculationSource.__args__  # type: ignore[attr-defined]
)


# ============================================================
# 壳翻译与解析 helper（对齐货件域 shipments.py 模式）
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


def _check_idempotency_header(request: Request) -> None:
    """Idempotency-Key 可缺失；出现则必须非空且 ≤64 字符（spec §3）。"""
    value = request.headers.get("idempotency-key")
    if value is not None and (len(value) == 0 or len(value) > 64):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="Idempotency-Key 必须为非空字符串且不超过 64 字符",
        )


def _parse_append_request(body: dict) -> AgentShopCalculationAppendRequest:
    """把原始 body 解析成追加请求模型；结构错误抛壳异常（对齐货件 _validate_patch）。"""
    try:
        return AgentShopCalculationAppendRequest(**body)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details=[
                {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg")}
                for err in exc.errors()
            ],
        ) from None


def _parse_datetime(value: str | None) -> datetime | None:
    """解析 ISO 日期/时间（容忍 ``YYYY-MM-DD`` 与缺失时区），归一为 UTC。"""
    if value is None:
        return None
    raw = value.strip()
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message=f"无效的时间格式: {value}"
        ) from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ============================================================
# 读路由
# ============================================================


@shop_calculations_router.get("")
def list_shop_calculations(
    project_id: int,
    db: Session = Depends(get_read_db_session),
    country: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    _scope=Depends(require_project_scope),
) -> dict:
    """R1 店铺测算「当前态」列表（每 SKU 最新有效行，软删过滤）。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        items, total = shop_calculation_service.list_by_project(
            db,
            project_id=project_id,
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


def _current_rows_for_sku(
    db: Session, *, project_id: int, sku: str, country: str | None
) -> list[ShopCalculation]:
    stmt = shop_calculation_service.latest_stmt().where(
        ShopCalculation.project_id == project_id,
        ShopCalculation.sku == sku,
    )
    if country is not None:
        stmt = stmt.where(ShopCalculation.country == country)
    return list(db.scalars(stmt.order_by(ShopCalculation.country)))


@shop_calculations_router.get("/skus/{sku}")
def get_shop_calculation_sku(
    project_id: int,
    sku: str,
    db: Session = Depends(get_read_db_session),
    country: str | None = Query(default=None),
    _scope=Depends(require_project_scope),
) -> dict:
    """R2 SKU 详情：当前态最新行；country 缺省时多国家 → 400 AMBIGUOUS。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        rows = _current_rows_for_sku(
            db, project_id=project_id, sku=sku, country=country
        )
    if not rows:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"SKU {sku} 在本项目不存在店铺测算记录",
        )
    if country is None and len(rows) > 1:
        raise AgentApiError(
            ErrorCode.SHOP_CALCULATION_AMBIGUOUS_COUNTRY,
            details=[{"country": str(row.country)} for row in rows],
        )
    return agent_ok(shop_calculation_service._to_item(rows[0]).model_dump(mode="json"))


@shop_calculations_router.get("/skus/{sku}/history")
def list_shop_calculation_history(
    project_id: int,
    sku: str,
    db: Session = Depends(get_read_db_session),
    country: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _scope=Depends(require_project_scope),
) -> dict:
    """R3 SKU 历史：append-only 全部版本（observed_at 倒序）+ from/to/分页薄壳。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        from_dt = _parse_datetime(from_)
        to_dt = _parse_datetime(to)
        history = shop_calculation_service.list_history(
            db,
            project_id=project_id,
            sku=sku,
            country=country,
            include_deleted=False,
        )
    filtered = [
        item
        for item in history
        if (from_dt is None or item.observed_at >= from_dt)
        and (to_dt is None or item.observed_at <= to_dt)
    ]
    total = len(filtered)
    page_items = filtered[offset : offset + limit]
    return agent_ok(
        {
            "items": [item.model_dump(mode="json") for item in page_items],
            "total": total,
        }
    )


@shop_calculations_router.get("/skus/{sku}/audit")
def get_shop_calculation_audit(
    project_id: int,
    sku: str,
    db: Session = Depends(get_read_db_session),
    limit: int = Query(default=50, ge=1, le=200),
    _scope=Depends(require_project_scope),
) -> dict:
    """R4 SKU 审计：按 SKU 聚合多行 target_id 的操作审计轨迹（id 倒序）。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        history = shop_calculation_service.list_history(
            db,
            project_id=project_id,
            sku=sku,
            include_deleted=True,
        )
    if not history:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"SKU {sku} 在本项目不存在店铺测算记录",
        )
    target_ids = [row.id for row in history]
    rows = query_operation_audit_log_for_targets(
        db,
        target_type="shop_calculation",
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
                for row in rows
            ],
        }
    )


# ============================================================
# W1 追加写（confirm 两步；spec §4）
# ============================================================


def _validate_append(body: dict, request: Request) -> None:
    """W1 业务校验（先于 confirm 签发 token；短路不生成 token）。"""
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])

    source = body.get("source")
    if source not in ALLOWED_AGENT_SOURCES:
        raise AgentApiError(
            ErrorCode.SHOP_CALCULATION_INVALID_SOURCE,
            details={"allowed": list(ALLOWED_AGENT_SOURCES)},
        )

    req = _parse_append_request(body)

    # SKU 存在性校验（D2 拍板：按 (project_id, country, sku) 严格粒度，与货件域一致）
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
            ErrorCode.SHOP_CALCULATION_INVALID_SKU,
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

    # 金额防脏数据（pydantic 已兜结构，这里是业务兜底）
    if req.sale_price_usd <= 0 or req.profit_usd <= 0 or req.total_fee_usd <= 0:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="sale_price_usd / profit_usd / total_fee_usd 必须为正数",
        )
    if not (-1 < req.profit_rate < 1):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="profit_rate 必须在 (-1, 1) 区间",
        )


def _preview_append(body: dict, request: Request) -> dict:
    """W1 confirm 预览摘要：overwrites_current / previous_sale_price_usd。"""
    project_id = int(request.path_params["project_id"])
    req = _parse_append_request(body)

    db = SessionLocal()
    try:
        current = db.scalars(
            shop_calculation_service.latest_stmt()
            .where(
                ShopCalculation.project_id == project_id,
                ShopCalculation.sku == req.sku,
                ShopCalculation.country == req.country,
            )
            .order_by(ShopCalculation.id.desc())
        ).first()
        overwrites = current is not None
        previous_price = float(current.sale_price_usd) if current is not None else None
    finally:
        db.close()

    note = (
        "将新增一条当前快照（append-only 保留历史）；该 SKU 已有当前价 "
        f"{previous_price}，追加后当前态变为 {req.sale_price_usd}"
        if overwrites
        else "将新增一条当前快照（append-only 保留历史）"
    )
    return {
        "action": "shop_calculation.append",
        "sku": req.sku,
        "country": req.country,
        "accounting_type": req.accounting_type,
        "source": req.source,
        "sale_price_usd": req.sale_price_usd,
        "profit_usd": req.profit_usd,
        "profit_rate": req.profit_rate,
        "observed_at": req.observed_at.isoformat() if req.observed_at else None,
        "overwrites_current": overwrites,
        "previous_sale_price_usd": previous_price,
        "warnings_count": len(req.warnings),
        "note": note,
    }


@shop_calculations_router.post(
    "", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="shop_calculation.append",
    build_preview=_preview_append,
    validate=_validate_append,
)
async def append_shop_calculation(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """W1 追加快照：confirm 两步后 append-only 落一行 + 审计归因。"""
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    with _service_errors():
        project = _get_project_or_shell_404(db, project_id)
        req = _parse_append_request(body)
        payload = ShopCalculationCreateRequest(
            project_id=project_id,
            project_name=str(project.project_name),
            **req.model_dump(),
        )
        item = shop_calculation_service.append_calculation(db, payload, operator=None)
        append_operation_audit_log(
            db,
            action="shop_calculation.append",
            target_type="shop_calculation",
            target_id=item.id,
            operator=None,
            after={
                "id": item.id,
                "project_id": item.project_id,
                "project_name": item.project_name,
                "sku": item.sku,
                "country": item.country,
                "accounting_type": item.accounting_type,
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
# C1 试算（不落库；spec §3.4）
# ============================================================


def _engine_to_run_item(
    computed: dict[str, Any], request: AgentShopCalculationComputeRequest, mode: str
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
        "delivery_fee_usd": float(inputs.get("delivery_fee_usd", 0) or 0),
        "full_container_quantity": 0.0,
        "full_container_price_rmb": 0.0,
        "competitor_url": None,
    }


def _engine_to_snapshot(
    computed: dict[str, Any], request: AgentShopCalculationComputeRequest, mode: str
) -> dict[str, Any]:
    """把引擎试算结果整形为 ``AgentShopCalculationAppendRequest`` 同构快照。

    镜像前端 ``ShopCalculationPayload`` 映射（``frontend/lib/pricing-calculation-api.ts``
    与 EU section 的 ``requestSaveSnapshot``）；project_id/project_name 由 W1
    路由层派生，故此处不出现；source/observed_at 留占位（agent 填 source 后可直接 POST W1）。
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
        "accounting_type": mode,
        "package_length_cm": float(inputs["package_length_cm"]),
        "package_width_cm": float(inputs["package_width_cm"]),
        "package_height_cm": float(inputs["package_height_cm"]),
        "weight_kg": float(inputs["weight_kg"]),
        "fob_product_cost_rmb": float(inputs["fob_product_cost_rmb"]),
        "first_leg_cost_rmb": float(inputs["first_leg_cost_rmb"]),
        "ddp_cost_rmb": float(profit["ddp_cost_rmb"]),
        "ddp_cost_usd": float(profit["ddp_cost_usd"]),
        "sale_price_usd": float(inputs["sale_price_usd"]),
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
        "fba_fulfillment_fee_usd": float(fees["fba_fulfillment_fee_usd"]),
        "inbound_config_fee_usd": float(fees["inbound_config_fee_usd"]),
        "storage_fee_usd": float(fees["storage_fee_usd"]),
        "total_fee_usd": float(fees["total_fee_usd"]),
        "payout_usd": float(profit["payout_usd"]),
        "profit_usd": float(profit["profit_usd"]),
        "profit_rate": float(profit["profit_rate"]),
        "warnings": computed["warnings"],
        "notes": None,
        "source": None,
        "observed_at": None,
    }
    # EU / 全模式可选字段（镜像前端保存 payload）
    snapshot["delivery_fee_usd"] = float(inputs.get("delivery_fee_usd", 0) or 0)
    snapshot["inbound_config_fee_manual_usd"] = float(
        inputs.get("inbound_config_fee_manual_usd", 0) or 0
    )
    snapshot["storage_fee_manual_usd"] = float(
        inputs.get("storage_fee_manual_usd", 0) or 0
    )
    snapshot["platform_fee_usd"] = float(fees.get("platform_fee_usd", 0) or 0)
    snapshot["vat_usd"] = float(profit.get("vat_usd", 0) or 0)
    snapshot["profit_after_vat_usd"] = (
        float(profit["profit_after_vat_usd"])
        if profit.get("profit_after_vat_usd") is not None
        else None
    )
    snapshot["profit_after_vat_rate"] = (
        float(profit["profit_after_vat_rate"])
        if profit.get("profit_after_vat_rate") is not None
        else None
    )
    return snapshot


@shop_calculations_router.post("/compute")
def compute_shop_calculation(
    project_id: int,
    payload: AgentShopCalculationComputeRequest,
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """C1 试算：包装引擎纯计算（不落库、不落审计），返回 {calculation, snapshot} 双字段。"""
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        try:
            if payload.mode == "eu_accounting":
                computed = _compute_eu_pricing(payload, db)
            else:
                computed = _compute_pricing(payload, db)
        except ValueError as exc:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=str(exc),
                details=[{"engine": str(exc)}],
            ) from None
    return agent_ok(
        {
            "mode": payload.mode,
            "calculation": _engine_to_run_item(computed, payload, payload.mode),
            "snapshot": _engine_to_snapshot(computed, payload, payload.mode),
            "usd_to_rmb_rate": float(computed["usd_to_rmb_rate"]),
            "usd_to_rmb_rate_source": computed["usd_to_rmb_rate_source"],
        }
    )
