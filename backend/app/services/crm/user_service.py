"""CRM user source: active user_accounts for crm-user-select."""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.schemas.crm import CrmUserItem

# 显示名统一取 full_name（BLF-1441），不回落到登录名 name（运营名已随 BLF-1441 删除）。
# CrmUserItem.name 承载的就是「展示给用户的人名」，故直接把 full_name 映射到它。
_SELECT_USER = """
    select id::text as id, coalesce(trim(full_name), '') as name, email,
           role_type, is_active
    from public.user_accounts
"""


def list_crm_users(db: Session) -> list[CrmUserItem]:
    """活跃用户列表（按显示名排序），供 crm-user-select 选负责人/转移目标。

    user_accounts.id 是 UUID，CrmUserItem.id 为 str，故取 id::text。
    显示名取 ``full_name``；为空时返回空串（前端展示「未命名」），不回落登录名。

    ``full_name`` 为空的账号不进候选名单：空白项照样能被选中，落库后负责人 /
    操作人对谁都匹配不上（#775 review 第三节），不如一开始就不给人选。
    """
    rows = db.execute(
        text(
            f"{_SELECT_USER} "
            "where is_active = true and coalesce(trim(full_name), '') <> '' "
            "order by name"
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
        text(f"{_SELECT_USER} where id::text = :id limit 1"),
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
