"""Agent SKU Info（商品主数据）域路由（BLF-579 S2 + BLF-628 W4；spec §4/§5）。

在 ``/api/v1/agent/projects/{project_id}/sku-info/*`` 开放 8 条路由：

* R1 列表 / R2 单 SKU 详情 / R3 审计 —— 读路由，不落审计；
* W1 upsert（新建+更新同路由，confirm 两步：``sku_info.upsert``）+ 写桶限流
  + 审计归因；``source`` 溯源枚举必填（禁 manual，D4），``source_file``
  服务端派生 ``agent:<agent_id>``；
* W2 局部更新（PATCH 语义，confirm：``sku_info.update``）——**读-改-写合并**：
  只更新 Agent 显式提供的字段（spec §9 #2 默认值陷阱规避），身份字段
  （sku/asin/country）禁改（extra=forbid → VALIDATION_FAILED）；
* W3 上/下架（``sku_info.status.transition``）——is_active 软切换（D8），
  目标值与当前一致时幂等直接返回当前态（不重复审计）；
* W4 FNSKU 标签 PDF 上传（BLF-628，multipart confirm：``sku_info.upload_fnsku_label``）
  ——表单字段 + 文件上传 R2，**不做 FNSKU 内容验证**（D10 用户拍板），
  multipart 兼容 confirm（D9 Option A：指纹绑定 source+filename+文件字节）。
* W5 删除（confirm：``sku_info.delete``）——硬删除（crud ``delete_sku_record``），
  不清理 R2 文件（fnsku-label / product-image，对齐内部删除语义）。

所有路由统一挂 ``Depends(require_project_scope)``（BLF-441 硬前置）。
写操作审计行 ``target_type="sku_info"``、``target_id=<row.id>``、
operator=NULL、agent_id/idempotency_key 归因；写后失效 PT4 财务汇总缓存
（D7，``invalidate_sku_financial_cache``；W4 标签仅展示用途，不失效）。
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.api.agent.confirm import (
    require_confirmation,
    require_multipart_confirmation,
)
from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_primary_db_session, get_read_db_session
from app.db.session import SessionLocal
from app.models import Project
from app.models.sku_info import SkuRecord
from app.schemas.agent_sku_info import (
    AgentSkuRecordStatusRequest,
    AgentSkuRecordUpdateRequest,
    AgentSkuRecordUpsertRequest,
    AgentSkuSource,
)
from app.schemas.sku_info import SkuRecordCreate, SkuRecordUpdate
from app.services.audit_log_service import (
    append_operation_audit_log,
    query_operation_audit_log_for_targets,
)
from app.services.data.sku_info import (
    list_sku_records,
    update_sku_record_by_id,
    upsert_sku_record,
    delete_sku_record,
)
from app.services.data.sku_info.cache import invalidate_sku_financial_cache
from app.utils.country import normalize_country
from app.utils.marketplace_url import build_marketplace_url

sku_info_router = APIRouter(
    prefix="/projects/{project_id}/sku-info",
    tags=["agent-sku-info"],
)

#: W4 FNSKU 标签 PDF 上限（对齐内部 ``upload_fnsku_label`` 的 20MB）。
MAX_FNSKU_LABEL_SIZE = 20 * 1024 * 1024

# Agent 写入允许的采集渠道（与 schema 枚举一致；validate 回调用）。
ALLOWED_AGENT_SOURCES: tuple[str, ...] = tuple(
    AgentSkuSource.__args__  # type: ignore[attr-defined]
)


# ============================================================
# 壳翻译与解析 helper（对齐新品测算/店铺域模板）
# ============================================================


@contextmanager
def _service_errors():
    """把 service 层 HTTPException 翻译成 agent 响应壳（spec §5）。

    409 → ``SKU_INFO_DUPLICATE``（W2 更新后唯一键冲突，对齐
    ``SHIPMENT_DUPLICATE_NO`` 409 语义）；404 → ``RESOURCE_NOT_FOUND``；
    其余（422 校验）→ ``VALIDATION_FAILED``。
    """
    try:
        yield
    except AgentApiError:
        raise
    except HTTPException as exc:
        detail = str(exc.detail) if exc.detail else None
        if exc.status_code == 409:
            raise AgentApiError(
                ErrorCode.SKU_INFO_DUPLICATE, human_message=detail
            ) from None
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


def _get_record_or_shell_404(
    db: Session, project_id: int, sku_record_id: int
) -> SkuRecord:
    row = db.get(SkuRecord, sku_record_id)
    if row is None or row.project_id != project_id:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"SKU 记录 {sku_record_id} 不存在或不属于该项目",
        )
    return row


def _audit_kwargs(request: Request) -> dict:
    """agent 写审计归因（spec §4.2：operator=NULL，agent_id/idempotency_key 归因）。"""
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


def _parse_upsert_request(body: dict) -> AgentSkuRecordUpsertRequest:
    try:
        return AgentSkuRecordUpsertRequest(**body)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details=[
                {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg")}
                for err in exc.errors()
            ],
        ) from None


def _parse_update_request(body: dict) -> AgentSkuRecordUpdateRequest:
    try:
        return AgentSkuRecordUpdateRequest(**body)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details=[
                {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg")}
                for err in exc.errors()
            ],
        ) from None


def _parse_status_request(body: dict) -> AgentSkuRecordStatusRequest:
    try:
        return AgentSkuRecordStatusRequest(**body)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details=[
                {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg")}
                for err in exc.errors()
            ],
        ) from None


def _check_source(source: Any) -> None:
    """source 溯源枚举校验（D4）：缺失/非法 → SKU_INFO_INVALID_SOURCE（400）。"""
    if source not in ALLOWED_AGENT_SOURCES:
        raise AgentApiError(
            ErrorCode.SKU_INFO_INVALID_SOURCE,
            details={"allowed": list(ALLOWED_AGENT_SOURCES)},
        )


def _normalize_country_or_400(country: str | None) -> str:
    """country 归一；非法 → VALIDATION_FAILED（spec §5.4 #3）。"""
    try:
        return normalize_country(country)
    except ValueError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message=str(exc)
        ) from None


def _serialize_sku_record(row: SkuRecord) -> dict[str, Any]:
    """Agent 侧序列化：同构行**不含** ``*_r2_key`` / ``source_file``（spec §4
    公共约定：不暴露内部存储键），含 created_at/updated_at。
    """
    return {
        "id": int(row.id),
        "project_name": str(row.project_name),
        "sku": str(row.sku),
        "asin": str(row.asin),
        "fnsku": str(row.fnsku) if row.fnsku else None,
        "product_name": str(row.product_name) if row.product_name else None,
        "fob_unit_cost": float(row.fob_unit_cost),
        "first_leg_cost_rmb": float(row.first_leg_cost_rmb),
        "package_length_cm": float(row.package_length_cm),
        "package_width_cm": float(row.package_width_cm),
        "package_height_cm": float(row.package_height_cm),
        "weight_kg": float(row.weight_kg),
        "carton_length_cm": float(row.carton_length_cm),
        "carton_width_cm": float(row.carton_width_cm),
        "carton_height_cm": float(row.carton_height_cm),
        "carton_weight_kg": float(row.carton_weight_kg),
        "units_per_carton": int(row.units_per_carton),
        "currency": str(row.currency),
        "country": str(row.country),
        "sort_order": int(row.sort_order),
        "is_active": bool(row.is_active),
        "sku_factory_info": row.sku_factory_info
        if hasattr(row, "sku_factory_info")
        else None,
        "sku_factory_info_updated_at": str(row.sku_factory_info_updated_at)
        if row.sku_factory_info_updated_at
        else None,
        "sku_factory_info_updated_by": str(row.sku_factory_info_updated_by)
        if row.sku_factory_info_updated_by
        else None,
        "fnsku_label_r2_url": getattr(row, "fnsku_label_r2_url", None),
        "product_image_r2_url": getattr(row, "product_image_r2_url", None),
        "product_image_thumbnail_r2_url": getattr(
            row, "product_image_thumbnail_r2_url", None
        ),
        "product_image_uploaded_at": str(row.product_image_uploaded_at)
        if getattr(row, "product_image_uploaded_at", None)
        else None,
        "product_image_uploaded_by": getattr(row, "product_image_uploaded_by", None),
        "marketplace_url": build_marketplace_url(row.country, row.asin),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _find_existing_by_key(
    db: Session, project_id: int, *, sku: str, asin: str, country: str
) -> SkuRecord | None:
    """按 upsert 唯一键 ``(project_id, sku, asin, country)`` 查现有行。"""
    return db.scalars(
        select(SkuRecord).where(
            SkuRecord.project_id == project_id,
            SkuRecord.sku == sku,
            SkuRecord.asin == asin,
            SkuRecord.country == country,
        )
    ).first()


# ============================================================
# 读路由（不落审计）
# ============================================================


@sku_info_router.get("")
def list_sku_info(
    project_id: int,
    db: Session = Depends(get_read_db_session),
    country: str | None = Query(default=None),
    is_active: bool | None = Query(default=True),
    sku: str | None = Query(default=None),
    asin: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    include_total: bool = Query(default=False),
    _scope=Depends(require_project_scope),
) -> dict:
    """R1 SKU 列表：country/is_active/sku/asin 筛选 + 分页（spec §4 R1）。

    ``is_active`` 默认 ``true``（对齐镜像）；显式 ``false`` 查下架。
    ``managed_project_ids=[project_id]`` 复用服务层项目白名单过滤（0 改造）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        if country is not None:
            country = _normalize_country_or_400(country)
        rows, total, has_next = list_sku_records(
            db,
            None,
            sku,
            asin,
            country,
            is_active,
            page,
            page_size,
            include_total=include_total,
            managed_project_ids=[project_id],
        )
    return agent_ok(
        {
            "items": [_serialize_sku_record(row) for row in rows],
            "page": page,
            "page_size": page_size,
            "total": total,
            "has_next": has_next,
        }
    )


@sku_info_router.get("/{sku_record_id}")
def get_sku_info_detail(
    project_id: int,
    sku_record_id: int,
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R2 单 SKU 详情（全字段含工厂信息 / 图片 url / marketplace_url + 时间戳）。"""
    row = _get_record_or_shell_404(db, project_id, sku_record_id)
    return agent_ok(_serialize_sku_record(row))


@sku_info_router.get("/{sku_record_id}/audit")
def get_sku_info_audit(
    project_id: int,
    sku_record_id: int,
    db: Session = Depends(get_read_db_session),
    limit: int = Query(default=50, ge=1, le=200),
    _scope=Depends(require_project_scope),
) -> dict:
    """R3 SKU 审计：按 record id 聚合 operation_audit_logs（spec §4 R3）。"""
    _get_record_or_shell_404(db, project_id, sku_record_id)
    audit_rows = query_operation_audit_log_for_targets(
        db,
        target_type="sku_info",
        target_ids=[sku_record_id],
        limit=limit,
    )
    return agent_ok(
        {
            "sku_record_id": sku_record_id,
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
# W1 新建 / upsert（confirm 两步；spec §4 W1）
# ============================================================


def _validate_upsert(body: dict, request: Request) -> None:
    """W1 业务校验（先于 confirm 签发 token；短路不生成 token）。"""
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])

    _check_source(body.get("source"))
    req = _parse_upsert_request(body)
    _normalize_country_or_400(req.country)

    db = SessionLocal()
    try:
        _get_project_or_shell_404(db, project_id)
    finally:
        db.close()


def _preview_upsert(body: dict, request: Request) -> dict:
    """W1 confirm 预览摘要：is_new / previous（upsert 覆盖语义下的影响面）。"""
    project_id = int(request.path_params["project_id"])
    req = _parse_upsert_request(body)
    country = _normalize_country_or_400(req.country)

    db = SessionLocal()
    try:
        current = _find_existing_by_key(
            db, project_id, sku=req.sku, asin=req.asin, country=country
        )
    finally:
        db.close()

    is_new = current is None
    previous = _serialize_sku_record(current) if current is not None else None
    note = (
        "首次写入：将新增该 (项目, SKU, ASIN, 国家) 的 SKU 主数据行"
        if is_new
        else "upsert 语义：将覆盖该 (项目, SKU, ASIN, 国家) 的当前主数据行，"
        "成本字段影响 PT4 财务汇总/补货/报表，请确认"
    )
    return {
        "action": "sku_info.upsert",
        "sku": req.sku,
        "asin": req.asin,
        "country": country,
        "is_new": is_new,
        "previous": previous,
        "source": req.source,
        "note": note,
    }


@sku_info_router.post("", dependencies=[Depends(require_agent_write_rate_limit)])
@require_confirmation(
    action="sku_info.upsert",
    build_preview=_preview_upsert,
    validate=_validate_upsert,
)
async def upsert_sku_info(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """W1 upsert：confirm 两步后按唯一键 upsert + 审计归因 + 缓存失效。"""
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    agent_id = getattr(request.state, "agent_id", None)
    with _service_errors():
        project = _get_project_or_shell_404(db, project_id)
        req = _parse_upsert_request(body)
        country = _normalize_country_or_400(req.country)

        # 只透传 Agent 显式提供的字段（+ 必填身份键），避免 SkuRecordCreate
        # 默认值把未提供的字段写坏（对齐内部 upsert 的 model_fields_set 语义）。
        dump = req.model_dump(exclude={"source"})
        payload = SkuRecordCreate(
            project_name=str(project.project_name),
            **{
                key: value for key, value in dump.items() if key in req.model_fields_set
            },
        )
        before_row = _find_existing_by_key(
            db, project_id, sku=req.sku, asin=req.asin, country=country
        )
        row, action = upsert_sku_record(db, payload, source_file=f"agent:{agent_id}")
        append_operation_audit_log(
            db,
            action="sku_info.upsert",
            target_type="sku_info",
            target_id=row.id,
            operator=None,
            before=_serialize_sku_record(before_row)
            if before_row is not None
            else None,
            after=_serialize_sku_record(row),
            **_audit_kwargs(request),
        )
        invalidate_sku_financial_cache(project_id)
        db.commit()
    return agent_ok(
        _serialize_sku_record(row),
        action=action,
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ============================================================
# W2 局部更新（confirm；读-改-写合并；spec §4 W2 / §9 #2）
# ============================================================


def _validate_update(body: dict, request: Request) -> None:
    """W2 业务校验：source 合法 + record 存在且属于该项目。"""
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])

    _check_source(body.get("source"))
    req = _parse_update_request(body)  # extra=forbid：身份字段传值 → VALIDATION_FAILED

    db = SessionLocal()
    try:
        _get_record_or_shell_404(db, project_id, sku_record_id)
    finally:
        db.close()


def _merge_update_payload(
    row: SkuRecord, req: AgentSkuRecordUpdateRequest
) -> SkuRecordUpdate:
    """读-改-写合并（spec §9 #2 默认值陷阱规避）。

    内部 ``SkuRecordUpdate`` 对 asin/country/is_active 是**无条件覆盖**
    （``asin=""`` / ``country="US"`` / ``is_active=True`` 缺失即回填）——
    这里把 Agent **显式提供**的字段（``model_fields_set``）合并进当前行值，
    构造完整 payload 再调服务：未提供字段保持当前值，身份字段恒为当前值
    （W2 禁改身份）。只传 ``fob_unit_cost`` 不得重置 asin/country/is_active
    （测试锁契约，spec §7 #3）。
    """
    provided = set(req.model_fields_set)
    data: dict[str, Any] = {
        # 身份字段：恒为当前值（W2 禁改）
        "sku": str(row.sku),
        "asin": str(row.asin),
        "country": str(row.country),
        # is_active 服务层**无条件覆盖**（``row.is_active = bool(payload.is_active)``）——
        # 未提供时必须带当前值，否则 SkuRecordUpdate 默认 True 会误上架（§9 #2 陷阱）
        "is_active": (
            bool(req.is_active) if "is_active" in provided else bool(row.is_active)
        ),
    }
    # 可更新字段：仅显式提供的合并进去；未提供的不进 payload → 服务层保持当前值
    for field in (
        "fnsku",
        "product_name",
        "fob_unit_cost",
        "first_leg_cost_rmb",
        "package_length_cm",
        "package_width_cm",
        "package_height_cm",
        "weight_kg",
        "carton_length_cm",
        "carton_width_cm",
        "carton_height_cm",
        "carton_weight_kg",
        "units_per_carton",
        "sort_order",
        "sku_factory_info",
    ):
        if field in provided:
            data[field] = getattr(req, field)
    return SkuRecordUpdate(**data)


def _preview_update(body: dict, request: Request) -> dict:
    """W2 confirm 预览摘要：changed（字段级 from/to diff）。"""
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])
    req = _parse_update_request(body)

    db = SessionLocal()
    try:
        row = _get_record_or_shell_404(db, project_id, sku_record_id)
    finally:
        db.close()

    provided = set(req.model_fields_set)
    changed: dict[str, dict[str, Any]] = {}
    for field in provided:
        if field == "source":
            continue
        current = getattr(row, field, None)
        if isinstance(current, Decimal):
            current = float(current)
        elif current is not None and not isinstance(
            current, (str, int, float, bool, dict, list)
        ):
            current = str(current)
        changed[field] = {"from": current, "to": getattr(req, field)}

    note = "修改成本/规格将影响下游计算（PT4 财务汇总/货件费用核算/补货/报表），请确认"
    return {
        "action": "sku_info.update",
        "sku_record_id": sku_record_id,
        "sku": str(row.sku),
        "changed": changed,
        "source": req.source,
        "note": note,
    }


@sku_info_router.patch(
    "/{sku_record_id}", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="sku_info.update",
    build_preview=_preview_update,
    validate=_validate_update,
)
async def update_sku_info(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """W2 局部更新：读-改-写合并 + 审计 before/after + 缓存失效。"""
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])
    agent_id = getattr(request.state, "agent_id", None)
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        row = _get_record_or_shell_404(db, project_id, sku_record_id)
        before = _serialize_sku_record(row)
        req = _parse_update_request(body)
        merged = _merge_update_payload(row, req)
        updated = update_sku_record_by_id(
            db,
            sku_record_id,
            merged,
            source_file=f"agent:{agent_id}",
            operator=agent_id,
        )
        append_operation_audit_log(
            db,
            action="sku_info.update",
            target_type="sku_info",
            target_id=sku_record_id,
            operator=None,
            before=before,
            after=_serialize_sku_record(updated),
            **_audit_kwargs(request),
        )
        invalidate_sku_financial_cache(project_id)
        db.commit()
    return agent_ok(
        _serialize_sku_record(updated),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ============================================================
# W3 上/下架（confirm；is_active 软切换；spec §4 W3 / §3 D8）
# ============================================================


def _validate_status(body: dict, request: Request) -> None:
    """W3 业务校验：source 合法 + record 存在且属于该项目 + is_active 为 bool。"""
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])

    _check_source(body.get("source"))
    _parse_status_request(body)  # 结构校验（is_active bool）；短路不生成 token

    db = SessionLocal()
    try:
        _get_record_or_shell_404(db, project_id, sku_record_id)
    finally:
        db.close()


def _preview_status(body: dict, request: Request) -> dict:
    """W3 confirm 预览摘要：from_active / to_active。"""
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])
    req = _parse_status_request(body)

    db = SessionLocal()
    try:
        row = _get_record_or_shell_404(db, project_id, sku_record_id)
    finally:
        db.close()

    from_active = bool(row.is_active)
    note = (
        "下架后该 SKU 将退出补货分析/定时报表/店铺测算默认消费"
        "（按 is_active=True 过滤），历史数据保留，可随时重新上架"
        if from_active and not req.is_active
        else "上架后该 SKU 重新进入补货/报表/店铺测算默认消费"
    )
    return {
        "action": "sku_info.status.transition",
        "sku_record_id": sku_record_id,
        "sku": str(row.sku),
        "from_active": from_active,
        "to_active": req.is_active,
        "source": req.source,
        "note": note,
    }


@sku_info_router.post(
    "/{sku_record_id}/status", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="sku_info.status.transition",
    build_preview=_preview_status,
    validate=_validate_status,
)
async def transition_sku_info_status(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """W3 上/下架：is_active 软切换；目标值与当前一致时幂等返回当前态。"""
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])
    agent_id = getattr(request.state, "agent_id", None)
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        row = _get_record_or_shell_404(db, project_id, sku_record_id)
        req = _parse_status_request(body)

        # 幂等：目标值与当前一致 → 直接返回当前态（不重复审计）
        if bool(row.is_active) == req.is_active:
            return agent_ok(
                _serialize_sku_record(row),
                idempotency_key=request.headers.get("idempotency-key") or None,
            )

        before = _serialize_sku_record(row)
        status_req = AgentSkuRecordUpdateRequest(
            source=req.source, is_active=req.is_active
        )
        merged = _merge_update_payload(row, status_req)
        updated = update_sku_record_by_id(
            db,
            sku_record_id,
            merged,
            source_file=f"agent:{agent_id}",
            operator=agent_id,
        )
        append_operation_audit_log(
            db,
            action="sku_info.status.transition",
            target_type="sku_info",
            target_id=sku_record_id,
            operator=None,
            before=before,
            after=_serialize_sku_record(updated),
            **_audit_kwargs(request),
        )
        invalidate_sku_financial_cache(project_id)
        db.commit()
    return agent_ok(
        _serialize_sku_record(updated),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ============================================================
# W5 删除（confirm；不可逆硬删除；对齐内部 delete_sku_record 语义）
# ============================================================


def _validate_delete(body: dict, request: Request) -> None:
    """W5 业务校验（先于 confirm 签发 token；短路不生成 token）。"""
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])

    db = SessionLocal()
    try:
        _get_record_or_shell_404(db, project_id, sku_record_id)
    finally:
        db.close()


def _preview_delete(body: dict, request: Request) -> dict:
    """W5 confirm 预览摘要：待删 SKU 标识（sku/asin/country/is_active）。"""
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])

    db = SessionLocal()
    try:
        row = _get_record_or_shell_404(db, project_id, sku_record_id)
    finally:
        db.close()

    return {
        "action": "sku_info.delete",
        "sku_record_id": sku_record_id,
        "sku": str(row.sku),
        "asin": str(row.asin),
        "country": str(row.country),
        "is_active": bool(row.is_active),
        "note": "将永久删除该 SKU 成本记录（不可恢复），成本字段影响 PT4 财务汇总/"
        "补货/报表，请确认",
    }


@sku_info_router.delete(
    "/{sku_record_id}", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="sku_info.delete",
    build_preview=_preview_delete,
    validate=_validate_delete,
)
async def delete_sku_info(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """W5 删除：confirm 两步后硬删除（crud ``delete_sku_record``）+ 审计 + 缓存失效。

    对齐内部 ``DELETE /sku-info/{sku_record_id}`` 语义：不清理 R2 文件
    （fnsku-label / product-image）；记录不存在或不属于该项目 → agent shell 404。
    """
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        row = _get_record_or_shell_404(db, project_id, sku_record_id)
        before = _serialize_sku_record(row)
        delete_sku_record(db, sku_record_id)
        append_operation_audit_log(
            db,
            action="sku_info.delete",
            target_type="sku_info",
            target_id=sku_record_id,
            operator=None,
            before=before,
            **_audit_kwargs(request),
        )
        invalidate_sku_financial_cache(project_id)
        db.commit()
    return agent_ok(
        {"deleted": True, "sku_record_id": sku_record_id},
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ============================================================
# W4 FNSKU 标签 PDF 上传（multipart confirm；spec §4 W4 / §5.6）
# ============================================================


def _validate_upload(fields: dict, request: Request) -> None:
    """W4 业务校验（先于 confirm 签发 token；短路不生成 token）。

    fields 为 multipart 表单字段 dict（``{"source": str, "file":
    {"filename", "size"}}``，见 confirm._parse_multipart_fields）。
    校验顺序：Idempotency-Key → source 枚举（SKU_INFO_INVALID_SOURCE）→
    文件存在/后缀/大小 → record 存在且属于该项目（404）。
    """
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])

    _check_source(fields.get("source"))

    file_meta = fields.get("file")
    if not isinstance(file_meta, dict):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="缺少文件字段 file"
        )
    filename = file_meta.get("filename") or ""
    size = int(file_meta.get("size") or 0)
    if not filename.lower().endswith(".pdf"):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="仅支持 PDF 文件"
        )
    if size == 0:
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message="文件为空")
    if size > MAX_FNSKU_LABEL_SIZE:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="文件大小不能超过 20MB"
        )

    db = SessionLocal()
    try:
        _get_record_or_shell_404(db, project_id, sku_record_id)
    finally:
        db.close()


def _preview_upload(fields: dict, request: Request) -> dict:
    """W4 confirm 预览摘要：filename / file_size / replace_old（是否覆盖旧标签）。"""
    project_id = int(request.path_params["project_id"])
    sku_record_id = int(request.path_params["sku_record_id"])
    file_meta = fields.get("file") or {}

    db = SessionLocal()
    try:
        row = _get_record_or_shell_404(db, project_id, sku_record_id)
    finally:
        db.close()

    replace_old = bool(row.fnsku_label_r2_key)
    note = (
        "将替换该 SKU 现有的 FNSKU 标签（旧标签将被删除）"
        if replace_old
        else "将为该 SKU 上传 FNSKU 标签 PDF"
    )
    return {
        "action": "sku_info.upload_fnsku_label",
        "sku_record_id": sku_record_id,
        "sku": str(row.sku),
        "filename": file_meta.get("filename"),
        "file_size": file_meta.get("size"),
        "replace_old": replace_old,
        "source": fields.get("source"),
        "note": note,
    }


@sku_info_router.post(
    "/{sku_record_id}/fnsku-label",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
@require_multipart_confirmation(
    action="sku_info.upload_fnsku_label",
    build_preview=_preview_upload,
    validate=_validate_upload,
)
async def upload_sku_info_fnsku_label(
    request: Request,
    sku_record_id: int,
    db: Session = Depends(get_primary_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """W4 上传 FNSKU 标签 PDF：multipart confirm 两步后写 R2 + 更新行 + 审计。

    执行路径对齐内部 ``upload_fnsku_label``（sku_info.py:841）：
    删旧 R2 key（失败不阻塞）→ ``upload_bytes_to_r2``（file_type=fnsku-labels，
    content-type=application/pdf）→ 更新 ``fnsku_label_r2_key/url``。
    **不做 FNSKU 内容验证**（D10，用户拍板；``verify_fnsku_label`` 仅内部路径）。
    标签仅展示用途 → 不失效财务缓存（对齐内部行为）。
    """
    import uuid as _uuid

    from app.core.config import get_settings
    from app.services.r2_service import (
        delete_file_from_r2,
        upload_bytes_to_r2,
    )
    from app.services.upload_service import _safe_project_folder_name

    form = await request.form()
    upload_file = form.get("file")
    if not isinstance(upload_file, UploadFile):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="缺少文件字段 file"
        )
    source = form.get("source")
    _check_source(source)

    content = await upload_file.read()
    filename_orig = upload_file.filename or ""
    if not filename_orig.lower().endswith(".pdf"):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="仅支持 PDF 文件"
        )
    if len(content) == 0:
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message="文件为空")
    if len(content) > MAX_FNSKU_LABEL_SIZE:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="文件大小不能超过 20MB"
        )

    project_id = int(request.path_params["project_id"])
    with _service_errors():
        row = _get_record_or_shell_404(db, project_id, sku_record_id)

        settings = get_settings()
        if not settings.r2_enabled:
            raise AgentApiError(ErrorCode.INTERNAL_ERROR, human_message="R2 存储未配置")

        # 删旧标签（失败不阻塞上传，对齐内部 upload_fnsku_label）
        if row.fnsku_label_r2_key:
            try:
                delete_file_from_r2(settings, row.fnsku_label_r2_key)
            except Exception:
                pass

        project_slug = _safe_project_folder_name(row.project_name)
        safe_sku = row.sku.replace("/", "_").replace("\\", "_").replace(" ", "_")
        stored_filename = f"{_uuid.uuid4().hex}_{safe_sku}.pdf"
        result = upload_bytes_to_r2(
            settings=settings,
            data=content,
            filename=stored_filename,
            project_slug=project_slug,
            file_type="fnsku-labels",
            content_type="application/pdf",
        )

        row.fnsku_label_r2_key = result["key"]
        row.fnsku_label_r2_url = result["url"]

        append_operation_audit_log(
            db,
            action="sku_info.upload_fnsku_label",
            target_type="sku_info",
            target_id=sku_record_id,
            operator=None,
            after={
                "sku": row.sku,
                "fnsku_label_r2_key": result["key"],
                "file_size": len(content),
            },
            **_audit_kwargs(request),
        )
        db.commit()

    return agent_ok(
        {
            "sku_record_id": sku_record_id,
            "fnsku_label_r2_url": result["url"],
            "file_size": len(content),
            "filename": stored_filename,
        },
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
