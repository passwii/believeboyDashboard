"""用户专属 API Key 管理端点（BLF-711 C2 方案）。

Admin-only 吊销 / 轮换 / 列表，按 user_id 操作：

  GET   /api/v1/internal/user-api-keys                        list（无明文）
  POST  /api/v1/internal/user-api-keys/{user_id}/revoke       吊销（幂等）
  POST  /api/v1/internal/user-api-keys/{user_id}/rotate       轮换（返回明文一次）

Gated on ``X-Is-Admin``（与 ``internal/api_keys.py`` 相同模式）——管理面
只经已认证的 dashboard 代理可达，header 门控足够。所有写操作走现有审计日志。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_request_operator
from app.models.user_api_key import UserApiKey
from app.services.audit_log_service import append_operation_audit_log
from app.services.user_api_key_service import (
    revoke_user_key,
    rotate_user_key,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/user-api-keys", tags=["internal-user-api-keys"])


class UserApiKeyItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    # user_accounts.id 是 UUID，统一以字符串形态透出（对齐 X-User-Id header 语义）
    user_id: str
    key_prefix: str
    revoked_at: str | None = None
    created_at: str | None = None


class UserApiKeyRevokeResponse(BaseModel):
    user_id: str
    revoked: bool


class UserApiKeyRotateResponse(BaseModel):
    user_id: str
    key_prefix: str
    plaintext_key: str


def _require_admin(is_admin: bool = Header(default=False, alias="X-Is-Admin")) -> bool:
    if not is_admin:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return True


@router.get(
    "",
    response_model=list[UserApiKeyItem],
    dependencies=[Depends(_require_admin)],
)
def list_user_api_keys(
    db: Session = Depends(get_primary_db_session),
) -> list[UserApiKeyItem]:
    """列出所有用户 key（无明文；key_prefix 仅用于区分，不含密钥尾部）。"""
    rows = db.query(UserApiKey).order_by(UserApiKey.user_id).all()
    return [
        UserApiKeyItem(
            id=r.id,
            user_id=str(r.user_id),
            key_prefix=r.key_prefix,
            revoked_at=r.revoked_at.isoformat() if r.revoked_at else None,
            created_at=r.created_at.isoformat() if r.created_at else None,
        )
        for r in rows
    ]


@router.post(
    "/{user_id}/revoke",
    response_model=UserApiKeyRevokeResponse,
    dependencies=[Depends(_require_admin)],
)
def revoke_user_api_key(
    user_id: str,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UserApiKeyRevokeResponse:
    """按 user_id 吊销该用户的专属 key（幂等；无 key 记录时返回 404）。"""
    row = revoke_user_key(db, user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="User API key not found")
    append_operation_audit_log(
        db,
        action="user_api_key.revoke",
        target_type="user_api_key",
        target_id=row.id,
        operator=operator or "admin",
        after={"user_id": str(user_id)},
        request=request,
    )
    db.commit()
    logger.info("user API key revoked user_id=%s key_id=%s", user_id, row.id)
    return UserApiKeyRevokeResponse(user_id=str(user_id), revoked=True)


@router.post(
    "/{user_id}/rotate",
    response_model=UserApiKeyRotateResponse,
    dependencies=[Depends(_require_admin)],
)
def rotate_user_api_key(
    user_id: str,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UserApiKeyRotateResponse:
    """按 user_id 轮换：旧 key 立即失效、签发新 key，明文仅本次返回一次。

    未找到记录时返回 404（补发 key 的自然路径是登录下发）。
    """
    rotated = rotate_user_key(db, user_id)
    if rotated is None:
        raise HTTPException(status_code=404, detail="User API key not found")
    row, plaintext = rotated
    if row is None:
        raise HTTPException(status_code=404, detail="User API key not found")
    append_operation_audit_log(
        db,
        action="user_api_key.rotate",
        target_type="user_api_key",
        target_id=row.id,
        operator=operator or "admin",
        after={"user_id": str(user_id), "key_prefix": row.key_prefix},
        request=request,
    )
    db.commit()
    logger.info("user API key rotated user_id=%s key_id=%s", user_id, row.id)
    return UserApiKeyRotateResponse(
        user_id=str(user_id),
        key_prefix=row.key_prefix,
        plaintext_key=plaintext,
    )
