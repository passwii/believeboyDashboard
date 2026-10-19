import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.passwords import hash_password
from app.schemas.system_management import UserRoleType
from app.services.audit_log_service import (
    append_operation_audit_log,
    append_operation_view_log,
)
from app.services.infra import delete_user_sessions
from app.services.r2_lifecycle import record_delete_failure
from app.services.r2_service import extract_key_from_url, try_delete_file_from_r2
from app.services.rate_limit_service import clear_login_failures
from app.services.user_api_key_service import revoke_user_key

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/system-management/users", tags=["users"], dependencies=[Depends(protected)]
)


class UserItem(BaseModel):
    id: str
    name: str
    email: str
    full_name: str | None = None
    operator_name_zh: str | None = None
    is_admin: bool
    is_active: bool
    role_type: UserRoleType = UserRoleType.operator
    created_at: str
    updated_at: str


class UsersResponse(BaseModel):
    items: list[UserItem]


class CreateUserRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    email: str = Field(min_length=3, max_length=255)
    full_name: str | None = Field(default=None, max_length=255)
    operator_name_zh: str | None = Field(default=None, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    is_admin: bool = False
    role_type: UserRoleType = UserRoleType.operator


class CreateUserResponse(BaseModel):
    item: UserItem


class UpdateUserRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    full_name: str | None = Field(default=None, max_length=255)
    operator_name_zh: str | None = Field(default=None, max_length=255)
    is_admin: bool | None = None
    is_active: bool | None = None
    role_type: UserRoleType | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)


class UpdateUserResponse(BaseModel):
    item: UserItem


def _to_item(row: Mapping[str, Any]) -> UserItem:
    """把 ``user_accounts`` 查询行转成响应模型。

    入参是 SQLAlchemy 的 ``RowMapping``（不是 ``dict``），注解成 ``dict`` 会被
    类型检查器判为不兼容；用 ``Mapping`` 同时兼容两者。
    """
    return UserItem(
        id=str(row["id"]),
        name=str(row["name"]),
        email=str(row["email"]),
        full_name=(str(row["full_name"]) if row["full_name"] is not None else None),
        operator_name_zh=(
            str(row["operator_name_zh"])
            if row["operator_name_zh"] is not None
            else None
        ),
        is_admin=bool(row["is_admin"]),
        is_active=bool(row["is_active"]),
        role_type=UserRoleType(row["role_type"])
        if row.get("role_type")
        else (UserRoleType.admin if row.get("is_admin") else UserRoleType.operator),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _serialize_user_item(item: UserItem) -> dict[str, object | None]:
    return {
        "id": item.id,
        "name": item.name,
        "email": item.email,
        "full_name": item.full_name,
        "operator_name_zh": item.operator_name_zh,
        "is_admin": item.is_admin,
        "is_active": item.is_active,
        "role_type": item.role_type.value,
    }


@router.get("", response_model=UsersResponse)
def list_users(
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UsersResponse:
    rows = (
        db.execute(
            text(
                """
            select
              id::text as id,
              name,
              email,
              full_name,
              operator_name_zh,
              is_admin,
              is_active,
              role_type,
              created_at,
              updated_at
            from public.user_accounts
            order by created_at desc
            """
            )
        )
        .mappings()
        .all()
    )
    append_operation_view_log(
        db,
        action="users.list",
        target_type="user_account",
        operator=operator,
        after={"count": len(rows)},
        request=request,
    )
    db.commit()
    return UsersResponse(items=[_to_item(row) for row in rows])


@router.post("", response_model=CreateUserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: CreateUserRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CreateUserResponse:
    password_hash = hash_password(payload.password)
    try:
        row = (
            db.execute(
                text(
                    """
                insert into public.user_accounts (name, email, full_name, operator_name_zh, password_hash, is_admin, role_type, is_active)
                values (:name, :email, :full_name, :operator_name_zh, :password_hash, :is_admin, :role_type, true)
                returning
                  id::text as id,
                  name,
                  email,
                  full_name,
                  operator_name_zh,
                  is_admin,
                  is_active,
                  role_type,
                  created_at,
                  updated_at
                """
                ),
                {
                    "name": payload.name.strip(),
                    "email": payload.email.strip().lower(),
                    "full_name": payload.full_name.strip()
                    if payload.full_name
                    else None,
                    "operator_name_zh": payload.operator_name_zh.strip()
                    if payload.operator_name_zh
                    else None,
                    "password_hash": password_hash,
                    "is_admin": bool(payload.is_admin),
                    "role_type": payload.role_type.value,
                },
            )
            .mappings()
            .first()
        )
    except Exception as exc:
        db.rollback()
        # 先打日志再转 HTTP 错误：吞掉原始异常会让线上「创建失败」无从排查（BLF-1381）。
        logger.exception("users.create failed email=%s", payload.email)
        if (
            getattr(exc, "orig", None) is not None
            and "duplicate key value" in str(exc.orig).lower()  # type: ignore[attr-defined]
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="邮箱已存在"
            )
        if "duplicate key value" in str(exc).lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="邮箱已存在"
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="创建用户失败"
        )

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="创建用户失败"
        )
    item = _to_item(row)
    append_operation_audit_log(
        db,
        action="users.create",
        target_type="user_account",
        target_id=item.id,
        operator=operator,
        after=_serialize_user_item(item),
        request=request,
    )
    db.commit()
    # BLF-1381：清掉该邮箱的历史登录失败桶。删除后重建拿到的是新 id，而桶是按
    # 邮箱计数的 —— 不清就会「新账号、新密码，还没登录就被 429 挡 30 分钟」。
    clear_login_failures(item.email)
    return CreateUserResponse(item=item)


@router.patch("/{user_id}", response_model=UpdateUserResponse)
def update_user(
    user_id: str,
    payload: UpdateUserRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> UpdateUserResponse:
    before_row = (
        db.execute(
            text(
                """
            select
              id::text as id,
              name,
              email,
              full_name,
              operator_name_zh,
              is_admin,
              is_active,
              role_type,
              created_at,
              updated_at
            from public.user_accounts
            where id::text = :user_id
            """
            ),
            {"user_id": user_id},
        )
        .mappings()
        .first()
    )

    name = payload.name.strip() if isinstance(payload.name, str) else None
    full_name = (
        payload.full_name.strip() if isinstance(payload.full_name, str) else None
    )
    operator_name_zh = (
        payload.operator_name_zh.strip() or None
        if isinstance(payload.operator_name_zh, str)
        else None
    )
    is_admin = payload.is_admin if isinstance(payload.is_admin, bool) else None
    is_active = payload.is_active if isinstance(payload.is_active, bool) else None
    role_type = (
        payload.role_type.value if isinstance(payload.role_type, UserRoleType) else None
    )
    # Keep is_admin in sync with role_type: when role_type changes, auto-derive is_admin
    if role_type is not None:
        is_admin = role_type == UserRoleType.admin.value
    password = (
        payload.password
        if isinstance(payload.password, str) and payload.password
        else None
    )
    password_hash = hash_password(password) if password is not None else None
    password_changed_at = datetime.now(timezone.utc) if password is not None else None

    row = (
        db.execute(
            text(
                """
            update public.user_accounts
            set
              name = coalesce(:name, name),
              is_admin = coalesce(:is_admin, is_admin),
              is_active = coalesce(:is_active, is_active),
              full_name = coalesce(:full_name, full_name),
              operator_name_zh = coalesce(:operator_name_zh, operator_name_zh),
              role_type = coalesce(:role_type, role_type),
              password_hash = coalesce(:password_hash, password_hash),
              password_changed_at = coalesce(:password_changed_at, password_changed_at),
              updated_at = now()
            where id::text = :user_id
            returning
              id::text as id,
              name,
              email,
              full_name,
              operator_name_zh,
              is_admin,
              is_active,
              role_type,
              created_at,
              updated_at
            """
            ),
            {
                "user_id": user_id,
                "name": name,
                "full_name": full_name,
                "operator_name_zh": operator_name_zh,
                "is_admin": is_admin,
                "is_active": is_active,
                "role_type": role_type,
                "password_hash": password_hash,
                "password_changed_at": password_changed_at,
            },
        )
        .mappings()
        .first()
    )

    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
    item = _to_item(row)

    # BLF-1059：改密码 → 撤销该账号**全部设备**的用户 API key。
    #
    # 密码是这个账号唯一的共享秘密：一旦它变了，所有凭它换来的长期凭据（每台设备
    # 槽里的 blf_ key）都必须失效——否则改密码（含管理员重置他人密码）对已签发的
    # key 毫无约束力，被重置者手里的 key 照样能一直访问。此处 client_id=None 即
    # 「全部设备」，与同文件下方 delete_user_sessions 的语义保持一致。
    #
    # 放在 db.commit() 之前：用户行更新与 key 吊销同一事务提交，不会出现
    # 「密码已改但旧 key 仍有效」的窗口。改密码者随后重新登录即可拿到新 key。
    if password is not None:
        revoked_keys = revoke_user_key(db, user_id).revoked
        logger.info(
            "user API keys revoked on password change user_id=%s keys=%s",
            user_id,
            [r.id for r in revoked_keys],
        )

    append_operation_audit_log(
        db,
        action="users.update",
        target_type="user_account",
        target_id=user_id,
        operator=operator,
        before=_serialize_user_item(_to_item(before_row))
        if before_row is not None
        else None,
        after=_serialize_user_item(item),
        request=request,
    )
    db.commit()

    # Revoke all sessions if account disabled or password changed
    if is_active is False or password is not None:
        try:
            delete_user_sessions(user_id)
        except Exception:
            # Redis 不可用时保留用户行已改的事实（改密已提交），只记日志。
            logger.warning(
                "delete_user_sessions failed user_id=%s", user_id, exc_info=True
            )

    # BLF-1381：重置密码后清掉该邮箱的登录失败计数。
    #
    # 现场症状就是「管理员点了重置密码，用户还是登不进去」：重置前用户用旧密码
    # 试错几次把 login_email_fail（5 次 / 30 分钟）打满，而重置动作本身不碰这个
    # 桶 —— 新密码完全正确也照样 429，用户只能干等半小时，看起来就像重置没生效。
    # 放在 commit 之后：桶是旁路状态，清失败也不该把已经提交的改密回滚。
    if password is not None:
        clear_login_failures(item.email)

    return UpdateUserResponse(item=item)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> None:
    before_row = (
        db.execute(
            text(
                """
            select
              id::text as id,
              name,
              email,
              full_name,
              operator_name_zh,
              is_admin,
              is_active,
              role_type,
              created_at,
              updated_at,
              avatar_url
            from public.user_accounts
            where id::text = :user_id
            """
            ),
            {"user_id": user_id},
        )
        .mappings()
        .first()
    )

    if before_row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")

    before_item = _to_item(before_row)
    if before_item.name.lower() in ("yawei",) or before_item.email.lower().startswith(
        "yawei@"
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Yawei 账号不允许删除"
        )

    # Capture R2 avatar key before row is deleted. Without this, the avatar
    # PNG stays in R2 forever as orphan sediment (LEAK-005).
    captured_avatar_key = _avatar_url_to_key(before_row.get("avatar_url"))

    db.execute(
        text("delete from public.user_accounts where id::text = :user_id"),
        {"user_id": user_id},
    )
    # NOTE: legacy raw-SQL DELETE — user_accounts is not in SQLAlchemy ORM.
    # caller's db.commit() happens via get_db_session dependency; no explicit
    # commit needed here. R2 cleanup happens AFTER DB transaction so we don't
    # leak a half-deleted state if cleanup itself fails (dead-letter catches).
    try:
        append_operation_audit_log(
            db,
            action="users.delete",
            target_type="user_account",
            target_id=user_id,
            operator=operator,
            before=_serialize_user_item(before_item),
            request=request,
        )
    except Exception:
        # 审计日志失败不该阻碍删除（用户已经答应删了）；记日志留痕迹。
        logger.warning(
            "users.delete audit log failed user_id=%s", user_id, exc_info=True
        )
    db.commit()

    # BLF-1381：删除账号后把该邮箱的登录失败桶与 Redis 会话一起回收。
    #
    # 桶按**邮箱**计数，删除重建虽换了新 user_id 却仍挂同一邮箱上 —— 不清就会
    # 「新账号第一次登录就 429」；会话不清则旧 key 最多再活 8 小时（与改密 /
    # 停用路径对齐）。两者都是旁路状态，失败不回撅已提交的删除。
    clear_login_failures(before_item.email)
    try:
        delete_user_sessions(user_id)
    except Exception:
        logger.warning(
            "delete_user_sessions failed on user delete user_id=%s",
            user_id,
            exc_info=True,
        )

    # P1 LEAK-005: clean up user's R2 avatar after DB commit.
    # Failure -> dead-letter (sync delete + never raise).
    if captured_avatar_key:
        _cleanup_user_avatar_r2(
            captured_avatar_key,
            context={"user_id": user_id},
        )

    return None


def _avatar_url_to_key(avatar_url: str | None) -> str | None:
    """Extract R2 object key from a public URL. Returns None for empty / external.

    Examples:
      https://bucket.believeboy.com/avatars/u123/abc.jpg -> "avatars/u123/abc.jpg"
      None / "" / "https://cdn.discordapp.com/..." (not R2) -> None
    """
    if not avatar_url or not isinstance(avatar_url, str):
        return None
    key = extract_key_from_url(avatar_url)
    return key if key else None


def _cleanup_user_avatar_r2(r2_key: str, *, context: dict) -> None:
    """Best-effort sync R2 delete + dead-letter on failure.

    Never raises. Logged as WARNING if R2 call fails.
    """
    try:
        from app.core.config import get_settings

        settings = get_settings()
        result = try_delete_file_from_r2(settings, r2_key, log_failure=False)
    except Exception:
        # Defensive: if anything unexpected crashes the R2 call site, log + return.
        # (try_delete_file_from_r2 itself already swallows ClientError/BotoCoreError/OSError,
        # but other RuntimeErrors etc. could escape.)
        logger.exception("[r2] cleanup_user_avatar_r2 raised for key=%s", r2_key)
        return

    if not result.success:
        logger.warning(
            "[r2] failed to delete avatar key=%s err=%s - dead-lettered",
            r2_key,
            result.error_class,
        )
        record_delete_failure(
            r2_key,
            result,
            source="user_delete",
            context=context,
        )


@router.post("/{user_id}/revoke-sessions")
def revoke_user_sessions(
    user_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> dict:
    """Admin endpoint: revoke all sessions for a specific user."""
    # Verify user exists
    row = (
        db.execute(
            text(
                "select id::text as id from public.user_accounts where id::text = :user_id"
            ),
            {"user_id": user_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")

    try:
        deleted = delete_user_sessions(user_id)
    except Exception:
        deleted = 0

    append_operation_audit_log(
        db,
        action="users.revoke_sessions",
        target_type="user_account",
        target_id=user_id,
        operator=operator,
        after={"revoked": deleted},
        request=request,
    )
    db.commit()
    return {"ok": True, "revoked": deleted}
