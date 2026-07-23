"""CRM user source: active user_accounts for crm-user-select."""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.schemas.crm import CrmUserItem


def list_crm_users(db: Session) -> list[CrmUserItem]:
    """活跃用户列表（按 name 排序），供 crm-user-select 选负责人/转移目标。

    user_accounts.id 是 UUID，CrmUserItem.id 为 str，故取 id::text。
    """
    rows = db.execute(
        text(
            """
            select id::text as id, name, email, role_type, is_active
            from public.user_accounts
            where is_active = true
            order by name
            """
        )
    ).mappings().all()
    return [
        CrmUserItem(
            id=str(r["id"]),
            name=r["name"],
            email=r["email"],
            role_type=r.get("role_type"),
            is_active=bool(r["is_active"]),
        )
        for r in rows
    ]


def get_crm_user(db: Session, user_id: str) -> CrmUserItem | None:
    """按 UUID（str）取单个用户；不存在返回 None。"""
    row = db.execute(
        text(
            """
            select id::text as id, name, email, role_type, is_active
            from public.user_accounts
            where id::text = :id
            limit 1
            """
        ),
        {"id": user_id},
    ).mappings().first()
    if row is None:
        return None
    return CrmUserItem(
        id=str(row["id"]),
        name=row["name"],
        email=row["email"],
        role_type=row.get("role_type"),
        is_active=bool(row["is_active"]),
    )
