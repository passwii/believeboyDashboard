"""Agent 货件域路由（设计稿 P2；spec §5）。

读路由不落审计、绕过 Redis 读缓存直查 DB；写路由全部走 confirm 两步确认，
审计归因走 agent_id / idempotency_key（operator=NULL）。
service 层抛出的裸 HTTPException 在 ``_service_errors`` 里统一翻译成响应壳。
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import date as date_type
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.agent.confirm import require_confirmation
from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.deps import get_primary_db_session, get_read_db_session
from app.db.session import SessionLocal
from app.models import Project
from app.models.shipment_schedule import ShipmentSchedule
from app.models.sku_info import SkuRecord
from app.schemas.shipment_schedule import (
    ShipmentFbaBoxDetailItem,
    ShipmentFbaBoxDetailResponse,
    ShipmentScheduleCreate,
    ShipmentScheduleListResponse,
    ShipmentScheduleUpdate,
)
from app.services import infra as redis_service
from app.services import shipment as shipment_service
from app.services.audit_log_service import (
    append_operation_audit_log,
    query_operation_audit_log,
)
from app.services.shipment import summary as shipment_summary_service
from app.services.shipment.item import replace_shipment_schedule_items
from app.services.shipment.serialization import (
    build_shipment_schedule_detail,
    serialize_schedule_list_item,
)
from app.services.shipment.validation import (
    ALLOWED_SHIPMENT_STATUS,
    ALLOWED_SHIPPING_METHOD,
)

shipments_router = APIRouter(
    prefix="/projects/{project_id}/shipments",
    tags=["agent-shipments"],
)


# ============================================================
# 壳翻译与解析 helper（后续写任务继续追加）
# ============================================================


def _translate_http_exception(exc: HTTPException) -> AgentApiError:
    detail = str(exc.detail) if exc.detail else None
    if exc.status_code == 404:
        return AgentApiError(ErrorCode.RESOURCE_NOT_FOUND, human_message=detail)
    if exc.status_code == 409:
        return AgentApiError(ErrorCode.SHIPMENT_DUPLICATE_NO, human_message=detail)
    if exc.status_code == 400 and "SKU" in (detail or ""):
        return AgentApiError(ErrorCode.SHIPMENT_ITEMS_INVALID_SKU, human_message=detail)
    return AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail)


@contextmanager
def _service_errors():
    """把 service 层 HTTPException 翻译成 agent 响应壳（设计稿 §5）。"""
    try:
        yield
    except AgentApiError:
        raise
    except HTTPException as exc:
        raise _translate_http_exception(exc) from None


def _get_project_or_shell_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"项目 {project_id} 不存在",
        )
    return project


def _resolve_schedule(db: Session, project_id: int, shipment_no: str) -> ShipmentSchedule:
    row = db.scalars(
        select(ShipmentSchedule).where(
            ShipmentSchedule.project_id == project_id,
            ShipmentSchedule.shipment_no == shipment_no,
        )
    ).first()
    if row is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"货件 {shipment_no} 不存在或不属于该项目",
        )
    return row


def _check_idempotency_header(request: Request) -> None:
    """Idempotency-Key 可缺失；出现则必须非空且 ≤64 字符（spec §3）。"""
    value = request.headers.get("idempotency-key")
    if value is not None and (len(value) == 0 or len(value) > 64):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="Idempotency-Key 必须为非空字符串且不超过 64 字符",
        )


def _normalize_items_body(body: dict) -> list[dict]:
    """把请求体里的 items 规范化为 service 层明细 dict；结构错误抛壳异常。"""
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="items 必须为非空数组"
        )
    normalized: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_items, start=1):
        if not isinstance(item, dict):
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED, human_message=f"第 {index} 行：明细必须是对象"
            )
        sku = str(item.get("sku") or "").strip()
        quantity = item.get("quantity")
        if not sku:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED, human_message=f"第 {index} 行：sku 不能为空"
            )
        if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"第 {index} 行：quantity 必须为正整数",
            )
        if sku in seen:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"SKU 明细中存在重复 SKU: {sku}",
            )
        seen.add(sku)
        carton_count = item.get("carton_count")
        if carton_count is not None and (
            not isinstance(carton_count, int)
            or isinstance(carton_count, bool)
            or carton_count < 0
        ):
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"第 {index} 行：carton_count 必须为非负整数",
            )
        normalized.append(
            {
                "row_no": index,
                "project_name": None,
                "shipment_no": None,
                "item_date": item.get("item_date"),
                "sku": sku,
                "quantity": int(quantity),
                "carton_count": carton_count,
                "remark": item.get("remark"),
            }
        )
    return normalized


def _find_missing_skus(
    db: Session, *, project_name: str, country: str, skus: list[str]
) -> list[str]:
    found = set(
        db.scalars(
            select(SkuRecord.sku).where(
                SkuRecord.project_name == project_name,
                SkuRecord.country == country,
                SkuRecord.sku.in_(skus),
            )
        ).all()
    )
    return [sku for sku in skus if sku not in found]


def _validate_items_skus(
    db: Session,
    *,
    project_name: str,
    country: str,
    normalized_items: list[dict],
) -> None:
    """结构化 SKU 存在性校验（spec S6：details 逐行给出）。"""
    missing = _find_missing_skus(
        db,
        project_name=project_name,
        country=country,
        skus=[str(item["sku"]) for item in normalized_items],
    )
    if not missing:
        return
    sku_to_row = {str(item["sku"]): int(item["row_no"]) for item in normalized_items}
    raise AgentApiError(
        ErrorCode.SHIPMENT_ITEMS_INVALID_SKU,
        human_message=f"明细里有 {len(missing)} 个 SKU 在本项目不存在",
        details=[
            {"row": sku_to_row[sku], "sku": sku, "reason": "not_found"}
            for sku in missing
        ],
    )


# ============================================================
# 写路由公共 helper（Task 6-9 复用）
# ============================================================


def _audit_kwargs(request: Request) -> dict:
    """agent 写审计归因（设计稿 §4.2：operator=NULL，agent_id/idempotency_key 归因）。"""
    return {
        "agent_id": getattr(request.state, "agent_id", None),
        "idempotency_key": request.headers.get("idempotency-key") or None,
        "request": request,
    }


def _invalidate_shipment_caches(row) -> None:
    """写后缓存失效，对齐内部端点（backend/app/api/v1/endpoints/shipment_schedules.py）。"""
    redis_service.invalidate_shipment_schedule_detail_cache(row.id)
    redis_service.invalidate_shipment_schedules_list_cache()
    redis_service.invalidate_shipment_schedules_cost_summary_cache()
    redis_service.invalidate_shipment_sku_summary_cache()
    redis_service.invalidate_shipment_fba_box_details_cache()
    redis_service.invalidate_shipment_in_transit_qty_cache(row.project_id)
    redis_service.invalidate_daily_analysis_cache(row.project_id)


# ============================================================
# 读路由
# ============================================================


@shipments_router.get("")
def list_shipments(
    project_id: int,
    db: Session = Depends(get_read_db_session),
    country: str | None = Query(default=None),
    shipment_status: str | None = Query(default=None),
    shipping_method: str | None = Query(default=None),
    shipment_no: str | None = Query(default=None),
    created_date_from: str | None = Query(default=None),
    created_date_to: str | None = Query(default=None),
    etd_from: str | None = Query(default=None),
    etd_to: str | None = Query(default=None),
    eta_from: str | None = Query(default=None),
    eta_to: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> dict:
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        rows, total, has_next = shipment_service.list_shipment_schedules(
            db,
            project_id=project_id,
            country=country,
            shipment_status=shipment_status,
            shipping_method=shipping_method,
            shipment_no=shipment_no,
            created_date_from=created_date_from,
            created_date_to=created_date_to,
            etd_from=etd_from,
            etd_to=etd_to,
            eta_from=eta_from,
            eta_to=eta_to,
            page=page,
            page_size=page_size,
            include_total=True,
        )
    payload = ShipmentScheduleListResponse(
        items=[
            serialize_schedule_list_item(row, sku_count, total_quantity)
            for row, sku_count, total_quantity in rows
        ],
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )
    return agent_ok(payload.model_dump())


@shipments_router.get("/{shipment_no}")
def get_shipment(
    project_id: int,
    shipment_no: str,
    db: Session = Depends(get_read_db_session),
) -> dict:
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, schedule.id
        )
    detail = build_shipment_schedule_detail(row, sku_count, total_quantity)
    return agent_ok(detail.model_dump())


@shipments_router.get("/{shipment_no}/sku-summary")
def get_shipment_sku_summary(
    project_id: int,
    shipment_no: str,
    db: Session = Depends(get_read_db_session),
) -> dict:
    with _service_errors():
        _resolve_schedule(db, project_id, shipment_no)
        rows = shipment_summary_service.list_shipment_sku_summary(
            db,
            project_id=project_id,
            shipment_nos=[shipment_no],
            include_only_history_calc=False,
            shipment_status=None,
        )
    return agent_ok({"items": rows})


@shipments_router.get("/{shipment_no}/fba-box-detail")
def get_shipment_fba_box_detail(
    project_id: int,
    shipment_no: str,
    db: Session = Depends(get_read_db_session),
) -> dict:
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        rows, items = shipment_service.list_shipment_fba_box_details(
            db, shipment_nos=[shipment_no]
        )
    response = ShipmentFbaBoxDetailResponse(
        project_ids=[int(row.project_id) for row in rows],
        project_names=[str(row.project_name_snapshot) for row in rows],
        countries=[str(row.country) for row in rows],
        shipment_nos=[str(row.shipment_no) for row in rows],
        items=[ShipmentFbaBoxDetailItem(**item) for item in items],
    )
    return agent_ok(response.model_dump())


@shipments_router.get("/{shipment_no}/audit")
def get_shipment_audit(
    project_id: int,
    shipment_no: str,
    db: Session = Depends(get_read_db_session),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict:
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        rows = query_operation_audit_log(
            db,
            target_type="shipment_schedule",
            target_id=str(schedule.id),
            limit=limit,
        )
    return agent_ok(
        {
            "shipment_no": shipment_no,
            "items": [
                {
                    "id": row.id,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
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
# 写路由（confirm 两步确认；spec S3-S6）
# ============================================================


def _validate_create(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    shipment_no = str(body.get("shipment_no") or "").strip()
    shipping_method = str(body.get("shipping_method") or "").strip()
    shipment_status = str(body.get("shipment_status") or "").strip()
    if not shipment_no:
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message="shipment_no 不能为空")
    if shipping_method not in ALLOWED_SHIPPING_METHOD:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(
                f"shipping_method 必须是: {', '.join(sorted(ALLOWED_SHIPPING_METHOD))}"
            ),
        )
    if shipment_status not in ALLOWED_SHIPMENT_STATUS:
        raise AgentApiError(
            ErrorCode.SHIPMENT_STATUS_INVALID,
            details={"allowed": sorted(ALLOWED_SHIPMENT_STATUS)},
        )
    items = _normalize_items_body(body)

    db = SessionLocal()
    try:
        project = _get_project_or_shell_404(db, project_id)
        duplicate = db.scalars(
            select(ShipmentSchedule).where(ShipmentSchedule.shipment_no == shipment_no)
        ).first()
        if duplicate is not None:
            raise AgentApiError(
                ErrorCode.SHIPMENT_DUPLICATE_NO,
                human_message=f"货件编号 {shipment_no} 已存在",
            )
        _validate_items_skus(
            db,
            project_name=str(project.project_name),
            country=str(body.get("country") or "US"),
            normalized_items=items,
        )
    finally:
        db.close()


def _preview_create(body: dict, request: Request) -> dict:
    items = body.get("items") or []
    return {
        "shipment_no": body.get("shipment_no"),
        "shipment_status": body.get("shipment_status"),
        "shipping_method": body.get("shipping_method"),
        "items_count": len(items),
        "total_quantity": sum(
            int(item.get("quantity") or 0) for item in items if isinstance(item, dict)
        ),
    }


@shipments_router.post("", dependencies=[Depends(require_agent_write_rate_limit)])
@require_confirmation(
    action="shipment.create",
    build_preview=_preview_create,
    validate=_validate_create,
)
async def create_shipment(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    items = _normalize_items_body(body)
    create_payload = ShipmentScheduleCreate(
        project_id=project_id,
        country=str(body.get("country") or "US"),
        shipment_no=str(body["shipment_no"]).strip(),
        tracking_no=body.get("tracking_no"),
        warehouse_code=body.get("warehouse_code"),
        forwarder_name=body.get("forwarder_name"),
        shipping_method=str(body["shipping_method"]).strip(),
        created_date=body.get("created_date"),
        etd_date=body.get("etd_date"),
        eta_date=body.get("eta_date"),
        actual_inbound_date=body.get("actual_inbound_date"),
        logistics_unit_price=float(body.get("logistics_unit_price") or 0),
        include_in_history_shipping_calc=bool(
            body.get("include_in_history_shipping_calc", True)
        ),
        remark=body.get("remark"),
        shipment_status=str(body["shipment_status"]).strip(),
        shipment_batch=body.get("shipment_batch"),
    )
    with _service_errors():
        row = shipment_service.create_shipment_schedule(db, create_payload, operator=None)
        replace_shipment_schedule_items(db, row, items, source_type="manual")
        _invalidate_shipment_caches(row)
        append_operation_audit_log(
            db,
            action="shipment.create",
            target_type="shipment_schedule",
            target_id=row.id,
            operator=None,
            after={
                "shipment_no": row.shipment_no,
                "project_id": row.project_id,
                "status": row.shipment_status,
                "items_count": len(items),
            },
            **_audit_kwargs(request),
        )
        db.commit()
        # commit 后该 session 仅用于读：get_shipment_schedule_detail 不再触发写入
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, row.id
        )
        detail = build_shipment_schedule_detail(row, sku_count, total_quantity)
        return agent_ok(
            detail.model_dump(),
            idempotency_key=request.headers.get("idempotency-key") or None,
        )


def _validate_replace_items(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    items = _normalize_items_body(body)
    db = SessionLocal()
    try:
        schedule = _resolve_schedule(db, project_id, shipment_no)
        _validate_items_skus(
            db,
            project_name=str(schedule.project_name_snapshot),
            country=str(schedule.country),
            normalized_items=items,
        )
    finally:
        db.close()


def _preview_replace_items(body: dict, request: Request) -> dict:
    items = body.get("items") or []
    return {
        "shipment_no": request.path_params["shipment_no"],
        "items_count": len(items),
        "total_quantity": sum(
            int(item.get("quantity") or 0) for item in items if isinstance(item, dict)
        ),
        "note": "将完全替换该货件的现有明细（非追加）",
    }


@shipments_router.put(
    "/{shipment_no}/items", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="shipment.items.replace",
    build_preview=_preview_replace_items,
    validate=_validate_replace_items,
)
async def replace_shipment_items(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    items = _normalize_items_body(body)
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        before_count = len(schedule.items)
        replace_shipment_schedule_items(db, schedule, items, source_type="manual")
        db.flush()
        _invalidate_shipment_caches(schedule)
        append_operation_audit_log(
            db,
            action="shipment.items.replace",
            target_type="shipment_schedule",
            target_id=schedule.id,
            operator=None,
            before={"items_count": before_count},
            after={
                "items_count": len(items),
                "total_quantity": sum(int(item["quantity"]) for item in items),
            },
            **_audit_kwargs(request),
        )
        db.commit()
        # commit 后该 session 仅用于读：get_shipment_schedule_detail 不再触发写入
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, schedule.id
        )
    return agent_ok(
        build_shipment_schedule_detail(row, sku_count, total_quantity).model_dump(),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ============================================================
# PATCH 字段更新（Task 7；spec S5）
# ============================================================


_PATCHABLE_FIELDS = (
    "country",
    "shipment_no",
    "tracking_no",
    "warehouse_code",
    "forwarder_name",
    "shipping_method",
    "created_date",
    "etd_date",
    "eta_date",
    "actual_inbound_date",
    "logistics_unit_price",
    "include_in_history_shipping_calc",
    "remark",
    "shipment_status",
    "shipment_batch",
)


def _build_update_payload(schedule, patch: dict) -> ShipmentScheduleUpdate:
    """把部分 patch 合并成 update_shipment_schedule 需要的全量 payload。"""

    def current(name: str):
        value = getattr(schedule, name)
        if isinstance(value, date_type):
            return value.isoformat()
        if isinstance(value, Decimal):
            return float(value)
        return value

    data = {name: (patch[name] if name in patch else current(name)) for name in _PATCHABLE_FIELDS}
    data["project_id"] = int(schedule.project_id)
    return ShipmentScheduleUpdate(**data)


def _validate_patch(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    if not isinstance(body, dict) or not body:
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message="请求体必须是非空对象")
    if "items" in body:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="PATCH 不支持 items 字段；请改用 PUT .../items 替换明细",
        )
    unknown = sorted(set(body) - set(_PATCHABLE_FIELDS))
    if unknown:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=f"不支持的字段: {', '.join(unknown)}",
        )
    if "shipment_status" in body and body["shipment_status"] not in ALLOWED_SHIPMENT_STATUS:
        raise AgentApiError(
            ErrorCode.SHIPMENT_STATUS_INVALID,
            details={"allowed": sorted(ALLOWED_SHIPMENT_STATUS)},
        )
    if "shipping_method" in body and body["shipping_method"] not in ALLOWED_SHIPPING_METHOD:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(
                f"shipping_method 必须是: {', '.join(sorted(ALLOWED_SHIPPING_METHOD))}"
            ),
        )
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    db = SessionLocal()
    try:
        schedule = _resolve_schedule(db, project_id, shipment_no)
        try:
            _build_update_payload(schedule, body)
        except ValidationError as exc:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                details=[
                    {"loc": [str(p) for p in e["loc"]], "msg": e["msg"]}
                    for e in exc.errors()
                ],
            ) from None
    finally:
        db.close()


def _preview_patch(body: dict, request: Request) -> dict:
    return {
        "shipment_no": request.path_params["shipment_no"],
        "changed": sorted(body.keys()),
    }


@shipments_router.patch(
    "/{shipment_no}", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="shipment.update", build_preview=_preview_patch, validate=_validate_patch
)
async def patch_shipment(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        before = {name: getattr(schedule, name) for name in body if name in _PATCHABLE_FIELDS}
        payload = _build_update_payload(schedule, body)
        row = shipment_service.update_shipment_schedule(
            db, schedule.id, payload, operator=None
        )
        _invalidate_shipment_caches(row)
        append_operation_audit_log(
            db,
            action="shipment.update",
            target_type="shipment_schedule",
            target_id=row.id,
            operator=None,
            before={
                k: (v.isoformat() if isinstance(v, date_type) else v)
                for k, v in before.items()
            },
            after={
                "shipment_no": row.shipment_no,
                "project_id": row.project_id,
                "status": row.shipment_status,
            },
            **_audit_kwargs(request),
        )
        db.commit()
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, row.id
        )
    return agent_ok(
        build_shipment_schedule_detail(row, sku_count, total_quantity).model_dump(),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
