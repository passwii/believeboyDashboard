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

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_request_operator
from app.models.user_api_key import UserApiKey
from app.services.audit_log_service import append_operation_audit_log
from app.services.user_api_key_service import (
    normalize_client_id,
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
    # 设备槽（BLF-1059）：一账号多行的区分字段，缺省槽为 ``default``。
    client_id: str
    key_prefix: str
    revoked_at: str | None = None
    created_at: str | None = None


class UserApiKeyRevokeResponse(BaseModel):
    user_id: str
    revoked: bool
    # 实际生效的槽：``client_id`` 缺省表示「全部设备」，此处回显选择器语义。
    client_id: str | None = None
    # 本次真正写入 revoked_at 的行数（幂等重放为 0）。
    revoked_count: int = 0


class UserApiKeyRotateResponse(BaseModel):
    user_id: str
    # 新 key 落在哪个槽（``client_id`` 缺省时固定为 ``default``）。
    client_id: str
    key_prefix: str
    plaintext_key: str


def _optional_client_id(client_id: str | None) -> str | None:
    """归一管理面的 ``client_id`` 查询参数：``None`` / ``""`` → 「全部设备」。

    与登录路径不同，这里 ``None`` **不是** ``default`` 槽，而是「该账号全部
    设备」（拆分前按 user_id 操作的语义）。

    ``""``（如 ``?client_id=``）同样按「没给选择器」处理：本端点的缺省语义本来
    就是全部设备，把空串当成 ``default`` 槽反而是静默窄化（管理员想重置全部
    设备、结果只动了网页端那一把，比全量更难发现）。

    形态非法（含首尾/内部空白、控制字符、超 64 字符）一律 400——这些**不**能被
    当成空值：静默降级成 ``default`` 会让管理员以为动了某一台设备，实际却动了
    网页端那把 key（``" mac-install-a "`` 若被 strip 成合法槽就是这个后果）。
    """
    # 注意：只有真正的空值走缺省分支；`"   "` 之类全空白不是空值，交给下面抛 400。
    if client_id is None or client_id == "":
        return None
    try:
        return normalize_client_id(client_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid client_id") from None


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
    """列出所有用户 key（无明文；key_prefix 仅用于区分，不含密钥尾部）。

    按 ``(user_id, client_id)`` 排序——同一账号的多个设备槽相邻好读。
    """
    rows = db.query(UserApiKey).order_by(UserApiKey.user_id, UserApiKey.client_id).all()
    return [
        UserApiKeyItem(
            id=r.id,
            user_id=str(r.user_id),
            client_id=r.client_id,
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
    client_id: str | None = Query(default=None),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UserApiKeyRevokeResponse:
    """吊销该用户的专属 key（幂等；无 key 记录时返回 404）。

    ``client_id`` 缺省 → 该账号全部设备；给定 → 只失效那一台。
    """
    slot = _optional_client_id(client_id)
    result = revoke_user_key(db, user_id, slot)
    if not result.found:
        raise HTTPException(status_code=404, detail="User API key not found")
    # 审计挂一把代表性的 key id：按槽吊销就挂那一行；全部设备吊销挂第一行
    # （真正失效了哪几行由 after.changed_key_ids 完整记录，不只这一个 id）。
    audit_row = (result.revoked or result.matched)[0]
    append_operation_audit_log(
        db,
        action="user_api_key.revoke",
        target_type="user_api_key",
        target_id=audit_row.id,
        operator=operator or "admin",
        after={
            "user_id": str(user_id),
            "client_id": slot,
            "revoked_count": len(result.revoked),
            "changed_key_ids": [r.id for r in result.revoked],
        },
        request=request,
    )
    db.commit()
    logger.info(
        "user API key revoked user_id=%s client_id=%s keys=%s",
        user_id,
        slot,
        [r.id for r in result.revoked],
    )
    return UserApiKeyRevokeResponse(
        user_id=str(user_id),
        revoked=True,
        client_id=slot,
        revoked_count=len(result.revoked),
    )


@router.post(
    "/{user_id}/rotate",
    response_model=UserApiKeyRotateResponse,
    dependencies=[Depends(_require_admin)],
)
def rotate_user_api_key(
    user_id: str,
    request: Request,
    client_id: str | None = Query(default=None),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UserApiKeyRotateResponse:
    """轮换：签发新 key，明文仅本次返回一次。

    ``client_id`` 缺省 → 一次重置该账号全部设备，新 key 发在 ``default`` 槽
    （拆分前单 key 时代“轮换即旧 key 全失效”的语义）；给定 → 只轮换那一个槽。
    未找到记录时返回 404（补发 key 的自然路径是登录下发）。
    """
    slot = _optional_client_id(client_id)
    rotated = rotate_user_key(db, user_id, slot)
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
        after={
            "user_id": str(user_id),
            "client_id": row.client_id,
            "requested_client_id": slot,
            "key_prefix": row.key_prefix,
        },
        request=request,
    )
    db.commit()
    logger.info(
        "user API key rotated user_id=%s client_id=%s key_id=%s",
        user_id,
        row.client_id,
        row.id,
    )
    return UserApiKeyRotateResponse(
        user_id=str(user_id),
        client_id=row.client_id,
        key_prefix=row.key_prefix,
        plaintext_key=plaintext,
    )
