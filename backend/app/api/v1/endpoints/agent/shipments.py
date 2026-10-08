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
from app.services.infra.cache_decorator import invalidate_cache_on_commit_l1
from app.services.shipment import fba_box_export as fba_box_export_service
from app.services.shipment import fba_template as fba_template_service
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
        if detail and "货件编号已存在" in detail:
            return AgentApiError(ErrorCode.SHIPMENT_DUPLICATE_NO, human_message=detail)
        return AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail)
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


def _resolve_schedule(
    db: Session, project_id: int, shipment_no: str
) -> ShipmentSchedule:
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
                ErrorCode.VALIDATION_FAILED,
                human_message=f"第 {index} 行：明细必须是对象",
            )
        sku = str(item.get("sku") or "").strip()
        quantity = item.get("quantity")
        if not sku:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"第 {index} 行：sku 不能为空",
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
    """结构化 SKU 存在性 + 装箱信息前置校验（spec S6：details 逐行给出）。

    BLF-604：与前端「未维护单箱数」禁用口径一致——SKU 主数据
    ``units_per_carton <= 0`` 时拒绝建货件/替换明细，避免出现
    「只有总数量、没有箱数/体积/重量」的货件（数量 = 箱数 × 装箱率）。
    """
    missing = _find_missing_skus(
        db,
        project_name=project_name,
        country=country,
        skus=[str(item["sku"]) for item in normalized_items],
    )
    sku_to_row = {str(item["sku"]): int(item["row_no"]) for item in normalized_items}
    if missing:
        raise AgentApiError(
            ErrorCode.SHIPMENT_ITEMS_INVALID_SKU,
            human_message=f"明细里有 {len(missing)} 个 SKU 在本项目不存在",
            details=[
                {"row": sku_to_row[sku], "sku": sku, "reason": "not_found"}
                for sku in missing
            ],
        )

    # BLF-604：装箱信息先行——SKU 存在但 units_per_carton <= 0 时拒绝
    rows = db.execute(
        select(SkuRecord.sku, SkuRecord.units_per_carton).where(
            SkuRecord.project_name == project_name,
            SkuRecord.country == country,
            SkuRecord.sku.in_(list(sku_to_row)),
        )
    ).all()
    no_carton = [str(row[0]) for row in rows if int(row[1] or 0) <= 0]
    if no_carton:
        raise AgentApiError(
            ErrorCode.SHIPMENT_ITEMS_MISSING_CARTON_INFO,
            human_message=(
                f"明细里有 {len(no_carton)} 个 SKU 未维护装箱信息"
                "（units_per_carton ≤ 0），请先维护外箱尺寸/毛重/装箱率"
            ),
            details=[
                {"row": sku_to_row[sku], "sku": sku, "reason": "missing_carton_info"}
                for sku in no_carton
            ],
        )


# ============================================================
# 写路由公共 helper（Task 6-9 复用）
# ============================================================


def _audit_kwargs(request: Request) -> dict:
    """agent 写审计归因（设计稿 §4.2：operator=NULL，agent_id/idempotency_key 归因）。"""
    return {
        "agent_id": getattr(request.state, "agent_id", None),
        "agent_name": getattr(request.state, "agent_label", None),
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


@shipments_router.get(
    "/fba-box-details.xlsx",
    response_class=StreamingResponse,
    response_model=None,
    responses={
        200: {
            "description": "FBA 箱单明细 XLSX 文件流",
            "content": {
                fba_box_export_service.XLSX_CONTENT_TYPE: {
                    "schema": {"type": "string", "format": "binary"}
                }
            },
        }
    },
)
def export_shipment_fba_box_details(
    project_id: int,
    shipment_no: list[str] = Query(
        min_length=1,
        max_length=fba_box_export_service.MAX_SHIPMENT_NOS,
        description="可重复传入多个货件编号；至少 1 个，最多 100 个。",
    ),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> StreamingResponse:
    """导出一个项目内指定货件的 FBA 箱单明细（纯读 XLSX 文件流）。"""
    try:
        shipment_nos = fba_box_export_service.normalize_export_shipment_nos(
            shipment_no
        )
    except ValueError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message=str(exc)
        ) from None

    with _service_errors():
        schedules = [
            _resolve_schedule(db, project_id, requested_no)
            for requested_no in shipment_nos
        ]
        project = _get_project_or_shell_404(db, project_id)
        _, items = shipment_service.list_shipment_fba_box_details(
            db, shipment_nos=shipment_nos
        )

    if not items:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message="指定货件没有可导出的 FBA 箱单明细",
        )

    # 每个编号均先按 project_id 查验，且此 API 的明细查询严格限制在该编号集合。
    ordered_shipment_nos = [str(schedule.shipment_no) for schedule in schedules]
    artifact = fba_box_export_service.build_fba_box_details_export(
        project_name=str(project.project_name),
        shipment_nos=ordered_shipment_nos,
        items=items,
    )
    return agent_file_response(
        artifact.content,
        filename=artifact.filename,
        media_type=artifact.content_type,
    )


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


@shipments_router.get(
    "/{shipment_no}/fba-delivery-template",
    response_class=StreamingResponse,
    response_model=None,
    responses={
        200: {
            "description": "FBA 发货模板 XLSX 文件流",
            "content": {
                fba_template_service.XLSX_CONTENT_TYPE: {
                    "schema": {"type": "string", "format": "binary"}
                }
            },
        }
    },
)
def export_shipment_fba_delivery_template(
    project_id: int,
    shipment_no: str,
    db: Session = Depends(get_read_db_session),
) -> StreamingResponse:
    """导出 FBA 发货模板（纯读：不写库、不落审计、不走 confirm）。"""
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        artifact = fba_template_service.build_fba_delivery_template(db, schedule)
    return agent_file_response(
        artifact.content,
        filename=artifact.filename,
        media_type=artifact.content_type,
    )


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
# 写路由（confirm 两步确认；spec S3-S6）
# ============================================================


def _validate_create(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    shipment_no = str(body.get("shipment_no") or "").strip()
    shipping_method = str(body.get("shipping_method") or "").strip()
    shipment_status = str(body.get("shipment_status") or "").strip()
    if not shipment_no:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="shipment_no 不能为空"
        )
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
@invalidate_cache_on_commit_l1(
    domains=["shipment_schedules"],
    project_id_from="path",
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
        row = shipment_service.create_shipment_schedule(
            db, create_payload, operator=None
        )
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
@invalidate_cache_on_commit_l1(
    domains=["shipment_schedules"],
    project_id_from="path",
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

    data = {
        name: (patch[name] if name in patch else current(name))
        for name in _PATCHABLE_FIELDS
    }
    data["project_id"] = int(schedule.project_id)
    return ShipmentScheduleUpdate(**data)


def _validate_patch(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    if not isinstance(body, dict) or not body:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="请求体必须是非空对象"
        )
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
    if (
        "shipment_status" in body
        and body["shipment_status"] not in ALLOWED_SHIPMENT_STATUS
    ):
        raise AgentApiError(
            ErrorCode.SHIPMENT_STATUS_INVALID,
            details={"allowed": sorted(ALLOWED_SHIPMENT_STATUS)},
        )
    if (
        "shipping_method" in body
        and body["shipping_method"] not in ALLOWED_SHIPPING_METHOD
    ):
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
@invalidate_cache_on_commit_l1(
    domains=["shipment_schedules"],
    project_id_from="path",
)
async def patch_shipment(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        before = {
            name: getattr(schedule, name) for name in body if name in _PATCHABLE_FIELDS
        }
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


# ============================================================
# 状态推进路由（Task 8；spec S5）
# ============================================================


def _validate_status(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    to_status = body.get("to_status")
    if not isinstance(to_status, str) or not to_status.strip():
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="to_status 必填且为字符串"
        )
    if to_status.strip() not in ALLOWED_SHIPMENT_STATUS:
        raise AgentApiError(
            ErrorCode.SHIPMENT_STATUS_INVALID,
            details={"allowed": sorted(ALLOWED_SHIPMENT_STATUS)},
        )


def _preview_status(body: dict, request: Request) -> dict:
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    db = SessionLocal()
    try:
        schedule = _resolve_schedule(db, project_id, shipment_no)
        from_status = str(schedule.shipment_status)
    finally:
        db.close()
    return {
        "shipment_no": shipment_no,
        "from_status": from_status,
        "to_status": str(body["to_status"]).strip(),
    }


@shipments_router.post(
    "/{shipment_no}/status", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="shipment.status.transition",
    build_preview=_preview_status,
    validate=_validate_status,
)
@invalidate_cache_on_commit_l1(
    domains=["shipment_schedules"],
    project_id_from="path",
)
async def transition_shipment_status(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    to_status = str(body["to_status"]).strip()
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        from_status = str(schedule.shipment_status)
        payload = _build_update_payload(schedule, {"shipment_status": to_status})
        row = shipment_service.update_shipment_schedule(
            db, schedule.id, payload, operator=None
        )
        _invalidate_shipment_caches(row)
        append_operation_audit_log(
            db,
            action="shipment.status.transition",
            target_type="shipment_schedule",
            target_id=row.id,
            operator=None,
            before={"shipment_status": from_status},
            after={"shipment_status": to_status},
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


# ============================================================
# 重算费用路由（Task 9；spec S2）
# ============================================================


def _validate_recalculate(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    price = body.get("logistics_unit_price")
    if not isinstance(price, (int, float)) or isinstance(price, bool) or price < 0:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="logistics_unit_price 必须为非负数字",
        )
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    db = SessionLocal()
    try:
        schedule = _resolve_schedule(db, project_id, shipment_no)
        if not schedule.items:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message="请先导入 SKU 明细，再执行核算",
            )
    finally:
        db.close()


def _preview_recalculate(body: dict, request: Request) -> dict:
    return {
        "action": "shipment.recalculate_costs",
        "shipment_no": request.path_params["shipment_no"],
        "logistics_unit_price": body.get("logistics_unit_price"),
        "note": "将按 SKU 尺寸/重量重算体积重与计费重，并回写该货件的物流费用",
    }


@shipments_router.post(
    "/{shipment_no}/recalculate-costs",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
@require_confirmation(
    action="shipment.recalculate_costs",
    build_preview=_preview_recalculate,
    validate=_validate_recalculate,
)
@invalidate_cache_on_commit_l1(
    domains=["shipment_schedules"],
    project_id_from="path",
)
async def recalculate_shipment_costs(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        row, sku_count, total_quantity = (
            shipment_service.calculate_shipment_schedule_costs(
                db, schedule.id, logistics_unit_price=body["logistics_unit_price"]
            )
        )
        _invalidate_shipment_caches(row)
        append_operation_audit_log(
            db,
            action="shipment.recalculate_costs",
            target_type="shipment_schedule",
            target_id=row.id,
            operator=None,
            after={
                "shipment_no": row.shipment_no,
                "logistics_unit_price": float(row.logistics_unit_price or 0),
                "total_volume_m3": float(row.total_volume_m3 or 0),
                "total_chargeable_weight_kg": float(
                    row.total_chargeable_weight_kg or 0
                ),
                "logistics_total_price": float(row.logistics_total_price or 0),
                "sku_count": sku_count,
                "total_quantity": total_quantity,
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


# ============================================================
# 删除路由（confirm 两步；不可逆）
# ============================================================


def _validate_delete(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    db = SessionLocal()
    try:
        _resolve_schedule(db, project_id, shipment_no)
    finally:
        db.close()


def _preview_delete(body: dict, request: Request) -> dict:
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    db = SessionLocal()
    try:
        schedule = _resolve_schedule(db, project_id, shipment_no)
        items = list(schedule.items)
        preview = {
            "action": "shipment.delete",
            "shipment_no": shipment_no,
            "shipment_status": str(schedule.shipment_status),
            "items_count": len(items),
            "total_quantity": sum(int(item.quantity or 0) for item in items),
            "note": "将永久删除该货件及其 SKU 明细，并联动刷新 SKU 汇总与首段费用",
        }
    finally:
        db.close()
    return preview


@shipments_router.delete(
    "/{shipment_no}", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="shipment.delete",
    build_preview=_preview_delete,
    validate=_validate_delete,
)
@invalidate_cache_on_commit_l1(
    domains=["shipment_schedules"],
    project_id_from="path",
)
async def delete_shipment(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        # delete 前收集 before：删除后明细联动已被标记删除，读原值不再可靠
        before = {
            "shipment_no": schedule.shipment_no,
            "project_id": schedule.project_id,
            "status": schedule.shipment_status,
            "items_count": len(schedule.items),
        }
        row = shipment_service.delete_shipment_schedule(db, schedule.id)
        _invalidate_shipment_caches(row)
        append_operation_audit_log(
            db,
            action="shipment.delete",
            target_type="shipment_schedule",
            target_id=row.id,
            operator=None,
            before=before,
            **_audit_kwargs(request),
        )
        db.commit()
    return agent_ok(
        {"deleted": True, "shipment_no": shipment_no},
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
