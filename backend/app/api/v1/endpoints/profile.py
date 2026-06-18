"""Self-service profile endpoints.

The Next.js frontend proxy calls these via ``/api/v1/system-management/profile*``.
Every handler:

1. Reads the authenticated user id from the ``X-User-Id`` header injected by
   the frontend proxy (``buildBackendAuthHeaders``).
2. Re-loads the row from ``public.user_accounts`` so we always serve fresh
   state (mirrors the ``GET /auth/me`` pattern — no in-process caching).
3. Refuses to act on any other user's record: there is no admin override,
   no ``{user_id}`` path parameter. A user can only see and mutate their
   own profile.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import (
    get_db_session,
    get_request_operator,
    get_request_user_id,
    protected,
)
from app.core.config import get_settings
from app.schemas.profile import (
    AvatarDeleteResponse,
    AvatarUploadResponse,
    ProfileResponse,
    ProfileUpdate,
)
from app.schemas.system_management import UserRoleType
from app.services.audit_log_service import append_operation_audit_log
from app.services.r2_service import delete_file_from_r2, extract_key_from_url
from app.services.upload_service import save_user_avatar_file

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/system-management/profile",
    tags=["profile"],
    dependencies=[Depends(protected)],
)


def _load_profile_row(db: Session, user_id: str) -> Optional[dict]:
    return (
        db.execute(
            text(
                """
                select
                  id::text as id,
                  email,
                  name,
                  full_name,
                  operator_name_zh,
                  is_admin,
                  is_active,
                  role_type,
                  avatar_url,
                  password_changed_at,
                  created_at,
                  updated_at
                from public.user_accounts
                where id::text = :user_id
                limit 1
                """
            ),
            {"user_id": user_id},
        )
        .mappings()
        .first()
    )


def _serialize_profile(row: dict) -> ProfileResponse:
    role_raw = row.get("role_type")
    role = (
        UserRoleType(role_raw)
        if role_raw
        else (UserRoleType.admin if row.get("is_admin") else UserRoleType.operator)
    )
    return ProfileResponse(
        id=str(row["id"]),
        email=str(row["email"]),
        name=str(row["name"]),
        full_name=(str(row["full_name"]) if row["full_name"] else None),
        operator_name_zh=(str(row["operator_name_zh"]) if row["operator_name_zh"] else None),
        is_admin=bool(row["is_admin"]),
        is_active=bool(row["is_active"]),
        role_type=role,
        avatar_url=(str(row["avatar_url"]) if row.get("avatar_url") else None),
        password_changed_at=row.get("password_changed_at"),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


@router.get("", response_model=ProfileResponse)
def get_profile(
    user_id: Optional[str] = Depends(get_request_user_id),
    db: Session = Depends(get_db_session),
) -> ProfileResponse:
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    row = _load_profile_row(db, user_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return _serialize_profile(row)


@router.patch("", response_model=ProfileResponse)
def update_profile(
    payload: ProfileUpdate,
    request: Request,
    user_id: Optional[str] = Depends(get_request_user_id),
    db: Session = Depends(get_db_session),
    operator: Optional[str] = Depends(get_request_operator),
) -> ProfileResponse:
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    before_row = _load_profile_row(db, user_id)
    if before_row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    updates: dict[str, object | None] = {}
    if payload.name is not None:
        cleaned = payload.name.strip()
        if not cleaned:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="姓名不能为空")
        updates["name"] = cleaned
    if payload.full_name is not None:
        cleaned = payload.full_name.strip()
        updates["full_name"] = cleaned or None
    if payload.operator_name_zh is not None:
        cleaned = payload.operator_name_zh.strip()
        updates["operator_name_zh"] = cleaned or None

    if not updates:
        # Nothing to do — return the current row so the frontend can rely on
        # the same response shape regardless of whether it sent changes.
        return _serialize_profile(before_row)

    # Build a parameterised SET clause. pgsql parameter binding is positional
    # so we generate placeholders dynamically but keep every value bound.
    set_clauses = [f"{col} = :{col}" for col in updates]
    params = {col: value for col, value in updates.items()}
    params["user_id"] = user_id

    updated_row = (
        db.execute(
            text(
                f"""
                update public.user_accounts
                set {', '.join(set_clauses)}
                where id::text = :user_id
                returning
                  id::text as id,
                  email,
                  name,
                  full_name,
                  operator_name_zh,
                  is_admin,
                  is_active,
                  role_type,
                  avatar_url,
                  password_changed_at,
                  created_at,
                  updated_at
                """
            ),
            params,
        )
        .mappings()
        .first()
    )
    if updated_row is None:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    append_operation_audit_log(
        db,
        action="profile.update",
        target_type="user_account",
        target_id=str(updated_row["id"]),
        operator=operator,
        # PII hygiene: log only the changed field names, never the new values.
        before={"changed": list(updates.keys())},
        after={"changed": list(updates.keys())},
        request=request,
    )
    db.commit()

    return _serialize_profile(updated_row)


@router.post("/avatar", response_model=AvatarUploadResponse)
def upload_avatar(
    request: Request,
    file: UploadFile = File(...),
    user_id: Optional[str] = Depends(get_request_user_id),
    db: Session = Depends(get_db_session),
    operator: Optional[str] = Depends(get_request_operator),
) -> AvatarUploadResponse:
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    settings = get_settings()
    if not settings.r2_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud storage is not configured",
        )

    before_row = _load_profile_row(db, user_id)
    if before_row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    try:
        result = save_user_avatar_file(file, settings, user_id)
    except HTTPException:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Avatar upload failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Avatar upload failed",
        )

    new_url = result["r2_url"]
    db.execute(
        text(
            """
            update public.user_accounts
            set avatar_url = :avatar_url
            where id::text = :user_id
            """
        ),
        {"avatar_url": new_url, "user_id": user_id},
    )
    append_operation_audit_log(
        db,
        action="profile.avatar.upload",
        target_type="user_account",
        target_id=user_id,
        operator=operator,
        # Don't log the URL or content_type — both can leak user identity / file
        # provenance. The action name alone is enough for audit reviewers.
        before={"had_avatar": bool(before_row.get("avatar_url"))},
        after={"has_avatar": True, "size": int(result["size"])},
        request=request,
    )
    db.commit()

    # Best-effort cleanup of the previous avatar. Failures here must not
    # surface to the user; the upload has already succeeded.
    old_url = before_row.get("avatar_url")
    if old_url and old_url != new_url:
        old_key = extract_key_from_url(old_url, settings)
        if old_key:
            try:
                delete_file_from_r2(settings, old_key)
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("Failed to delete old avatar key=%s: %s", old_key, exc)

    return AvatarUploadResponse(
        avatar_url=new_url,
        size=int(result["size"]),
        content_type=str(result["content_type"]),
    )


@router.delete("/avatar", response_model=AvatarDeleteResponse)
def delete_avatar(
    request: Request,
    user_id: Optional[str] = Depends(get_request_user_id),
    db: Session = Depends(get_db_session),
    operator: Optional[str] = Depends(get_request_operator),
) -> AvatarDeleteResponse:
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    settings = get_settings()
    before_row = _load_profile_row(db, user_id)
    if before_row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    old_url = before_row.get("avatar_url")
    db.execute(
        text(
            """
            update public.user_accounts
            set avatar_url = null
            where id::text = :user_id
            """
        ),
        {"user_id": user_id},
    )
    append_operation_audit_log(
        db,
        action="profile.avatar.delete",
        target_type="user_account",
        target_id=user_id,
        operator=operator,
        before={"had_avatar": bool(old_url)},
        after={"has_avatar": False},
        request=request,
    )
    db.commit()

    if old_url:
        old_key = extract_key_from_url(old_url, settings)
        if old_key:
            try:
                delete_file_from_r2(settings, old_key)
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("Failed to delete avatar key=%s: %s", old_key, exc)

    return AvatarDeleteResponse(ok=True)