from datetime import datetime, timezone

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


def _to_item(row: dict) -> UserItem:
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
        role_type=UserRoleType(row["role_type"]) if row.get("role_type") else (UserRoleType.admin if row.get("is_admin") else UserRoleType.operator),
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
        if (
            getattr(exc, "orig", None) is not None
            and "duplicate key value" in str(exc.orig).lower()
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
    role_type = payload.role_type.value if isinstance(payload.role_type, UserRoleType) else None
    # Keep is_admin in sync with role_type: when role_type changes, auto-derive is_admin
    if role_type is not None:
        is_admin = (role_type == UserRoleType.admin.value)
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
            pass

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

    if before_row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")

    before_item = _to_item(before_row)
    if before_item.name.lower() in ("yawei",) or before_item.email.lower().startswith("yawei@"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Yawei 账号不允许删除")

    db.execute(text("delete from public.user_accounts where id::text = :user_id"), {"user_id": user_id})
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
        pass  # non-critical
    db.commit()
    return None


@router.post("/{user_id}/revoke-sessions")
def revoke_user_sessions(
    user_id: str,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> dict:
    """Admin endpoint: revoke all sessions for a specific user."""
    # Verify user exists
    row = db.execute(
        text("select id::text as id from public.user_accounts where id::text = :user_id"),
        {"user_id": user_id},
    ).mappings().first()
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
