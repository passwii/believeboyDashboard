"""Internal admin endpoints for API keys (BEL-377).

Admin-only CRUD for the credentials that guard ``/api/v1/external/*``
（过渡期同时覆盖 ``/api/v1/agent/*``）:

  POST   /api/v1/internal/api-keys                   create (returns plaintext once)
  GET    /api/v1/internal/api-keys                   list (no secrets; ?include_deleted=)
  PATCH  /api/v1/internal/api-keys/{id}              edit label / project_scope / business_scope（BLF-480）
  POST   /api/v1/internal/api-keys/{id}/revoke       soft-revoke (兼容别名)
  POST   /api/v1/internal/api-keys/{id}/deactivate   停用（BLF-468，与 /revoke 同语义）
  POST   /api/v1/internal/api-keys/{id}/activate     激活（BLF-468）
  DELETE /api/v1/internal/api-keys/{id}              软删除（BLF-468，幂等）

Gated on ``X-Is-Admin`` (same pattern as ``internal_jobs.py``). The admin
surface is only reachable behind the authenticated dashboard proxy, so the
header gate is sufficient here.

术语重命名（BLF-468）：前端统一走 ``/deactivate`` / ``/activate`` / ``DELETE``；
``/revoke`` 保留为 ``/deactivate`` 的兼容别名，便于过渡期老客户端平滑迁移。
"""

from __future__ import annotations

import logging

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_request_operator
from app.schemas.agent_api_key import (
    ApiKeyActivateResponse,
    ApiKeyCreateRequest,
    ApiKeyCreateResponse,
    ApiKeyDeactivateResponse,
    ApiKeyItem,
    ApiKeyRevokeResponse,
    ApiKeyUpdateRequest,
)
from app.services.agent import key_service
from app.services.audit_log_service import append_operation_audit_log
from app.models.agent_api_key import AgentApiKey

#: 单例冲突提示（管理 Key 全局单例红线，BLF-847）。
_SINGLETONE_CONFLICT_MSG = (
    "管理 Key 全局单例：已存在一张有效的签发域(agent_provisioning)凭据；"
    "请先停用/删除现役管理 Key 后再签发或补授签发域"
)


def _ensure_provisioning_singleton(
    db: Session, *, business_scope: str, exclude_id: int | None = None
) -> None:
    """单例互斥护栏：结果 business_scope 含签发域且已存在另一张有效持有者 → 409。

    卡死管理员 create / PATCH 两个写入口（自助路径已被红线 A 物理封死）。
    并发兜底由迁移 260 的部分唯一索引承担（极端双发在 DB 层也不可能成立）。
    """
    if not key_service._business_scope_has_provisioning(business_scope):
        return
    if key_service.active_provisioning_key_exists(db, exclude_id=exclude_id):
        raise HTTPException(status_code=409, detail=_SINGLETONE_CONFLICT_MSG)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/api-keys", tags=["internal-api-keys"])


def _require_admin(is_admin: bool = Header(default=False, alias="X-Is-Admin")) -> bool:
    if not is_admin:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return True


@router.post(
    "",
    response_model=ApiKeyCreateResponse,
    status_code=201,
    dependencies=[Depends(_require_admin)],
)
def create_api_key(
    body: ApiKeyCreateRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ApiKeyCreateResponse:
    # 红线 B（BLF-847）：管理 Key 全局单例。结果 scope 含签发域且已存在另一张
    # 有效持有者 → 拒绝，杜绝第二张全能签发 key 同时存在。
    _ensure_provisioning_singleton(db, business_scope=body.business_scope or "*")
    try:
        record, plaintext = key_service.create_api_key(
            db,
            label=body.label,
            created_by=operator or "admin",
            scope=body.scope,
            project_scope=body.project_scope,
            business_scope=body.business_scope,
            expires_at=body.expires_at,
            agent_id=body.agent_id,
            item_key=body.item_key,
        )
    except IntegrityError:
        # 并发兜底：迁移 260 部分唯一索引拦下的极端双发。
        db.rollback()
        raise HTTPException(status_code=409, detail=_SINGLETONE_CONFLICT_MSG) from None
    append_operation_audit_log(
        db,
        action="api_key.create",
        target_type="agent_api_key",
        target_id=record.id,
        operator=operator or "admin",
        request=request,
    )
    db.commit()
    db.refresh(record)
    logger.info("API key created id=%s label=%s", record.id, record.label)
    return ApiKeyCreateResponse(
        id=record.id,
        key_prefix=record.key_prefix,
        label=record.label,
        scope=record.scope,
        project_scope=record.project_scope,
        business_scope=record.business_scope,
        agent_id=record.agent_id,
        item_key=record.item_key,
        expires_at=record.expires_at,
        created_at=record.created_at,
        plaintext_key=plaintext,
    )


@router.get(
    "",
    response_model=list[ApiKeyItem],
    dependencies=[Depends(_require_admin)],
)
def list_api_keys(
    db: Session = Depends(get_primary_db_session),
    include_deleted: bool = Query(
        default=False,
        description="BLF-468：默认隐藏已删除 Key；true 返回全量（审计/回溯）。",
    ),
) -> list[ApiKeyItem]:
    return [
        ApiKeyItem.model_validate(k, from_attributes=True)
        for k in key_service.list_api_keys(db, include_deleted=include_deleted)
    ]


@router.patch(
    "/{key_id}",
    response_model=ApiKeyItem,
    dependencies=[Depends(_require_admin)],
)
def update_api_key(
    key_id: int,
    body: ApiKeyUpdateRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ApiKeyItem:
    """编辑 Key 的权限与业务范围（BLF-480）。

    PATCH 语义：仅更新显式传入的字段（label / project_scope / business_scope）。
    项目范围与业务域范围变更即刻生效——鉴权路径（``scope.py``）每请求实时读列，
    无需重建凭据。已删除 Key 不可编辑（404），与 deactivate / activate 一致。

    红线 B（BLF-847）：防止给存量 key 补授签发域造出第二张管理 Key——先算
    出「结果 business_scope」做单例互斥校验，再落库。
    """
    record = db.get(AgentApiKey, key_id)
    if record is None or record.deleted_at is not None:
        raise HTTPException(status_code=404, detail="API key not found")
    # 结果 business_scope：传入则覆盖，否则保持原值；空串归一为 '*'（与 service 对齐）。
    resulting_bs = (
        body.business_scope
        if body.business_scope is not None
        else record.business_scope
    ) or "*"
    _ensure_provisioning_singleton(db, business_scope=resulting_bs, exclude_id=key_id)
    record = key_service.update_api_key(
        db,
        key_id,
        label=body.label,
        project_scope=body.project_scope,
        business_scope=body.business_scope,
        item_key=body.item_key,
    )
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found")
    append_operation_audit_log(
        db,
        action="api_key.update",
        target_type="agent_api_key",
        target_id=key_id,
        operator=operator or "admin",
        request=request,
    )
    try:
        db.commit()
    except IntegrityError:
        # 并发兜底：迁移 260 部分唯一索引拦下的极端双发。
        db.rollback()
        raise HTTPException(status_code=409, detail=_SINGLETONE_CONFLICT_MSG) from None
    db.refresh(record)
    logger.info("API key updated id=%s", key_id)
    return ApiKeyItem.model_validate(record, from_attributes=True)


@router.post(
    "/{key_id}/revoke",
    response_model=ApiKeyRevokeResponse,
    dependencies=[Depends(_require_admin)],
)
def revoke_api_key(
    key_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ApiKeyRevokeResponse:
    """兼容别名：BLF-468 前端走 ``/deactivate``，老客户端仍可用。"""
    record = key_service.revoke_api_key(db, key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found")
    append_operation_audit_log(
        db,
        action="api_key.revoke",
        target_type="agent_api_key",
        target_id=key_id,
        operator=operator or "admin",
        request=request,
    )
    db.commit()
    logger.info("API key revoked id=%s", key_id)
    return ApiKeyRevokeResponse(id=record.id, is_revoked=record.is_revoked)


@router.post(
    "/{key_id}/deactivate",
    response_model=ApiKeyDeactivateResponse,
    dependencies=[Depends(_require_admin)],
)
def deactivate_api_key(
    key_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ApiKeyDeactivateResponse:
    """停用 Key（BLF-468；与 ``/revoke`` 同语义，前端主路径）。"""
    record = key_service.revoke_api_key(db, key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found")
    append_operation_audit_log(
        db,
        action="api_key.deactivate",
        target_type="agent_api_key",
        target_id=key_id,
        operator=operator or "admin",
        request=request,
    )
    db.commit()
    logger.info("API key deactivated id=%s", key_id)
    return ApiKeyDeactivateResponse(id=record.id, is_revoked=record.is_revoked)


@router.post(
    "/{key_id}/activate",
    response_model=ApiKeyActivateResponse,
    dependencies=[Depends(_require_admin)],
)
def activate_api_key(
    key_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ApiKeyActivateResponse:
    """激活 Key（BLF-468）—— 取消停用，恢复访问权限。已删除 Key 不可激活。"""
    record = key_service.activate_api_key(db, key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found")
    append_operation_audit_log(
        db,
        action="api_key.activate",
        target_type="agent_api_key",
        target_id=key_id,
        operator=operator or "admin",
        request=request,
    )
    db.commit()
    logger.info("API key activated id=%s", key_id)
    return ApiKeyActivateResponse(id=record.id, is_revoked=record.is_revoked)


@router.delete(
    "/{key_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(_require_admin)],
    response_class=Response,
)
def delete_api_key(
    key_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> Response:
    """软删除 Key（BLF-468，幂等）。

    鉴权加固：已删除 Key 在 ``resolve_key`` / ``resolve_key_for_agent`` 中
    判定为 ``not_found``，先于 revoked——防止删除后被误激活复活。
    """
    record = key_service.delete_api_key(db, key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found")
    append_operation_audit_log(
        db,
        action="api_key.delete",
        target_type="agent_api_key",
        target_id=key_id,
        operator=operator or "admin",
        request=request,
    )
    db.commit()
    logger.info("API key soft-deleted id=%s", key_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
