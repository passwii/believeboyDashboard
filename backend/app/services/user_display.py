"""全局人物显示名解析（BLF-1441）：唯一来源 ``user_accounts.full_name``。

口径（业务方已定死）：全局 person 显示名**只取** ``public.user_accounts.full_name``，
不做 ``operator_name_zh`` / ``name`` 的兜底链。``operator_name_zh`` 退化为
「历史别名 / 项目匹配键」，``name`` 只是登录名，两者都不再参与展示。

两种「取不到」要分开：

- **账号存在但 ``full_name`` 为空**：解析不到（键缺失），调用方按「没有名字」处理，
  不得回落登录名——回落就等于把兜底又装回去了。
- **账号不存在**（已离职删除的账号、从未建号的外部人员）：历史记录里的自由文本
  原样保留，不关联、不回填、不猜测映射。

本模块只做「id → 姓名」的解析，不写库、不改历史数据。
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

#: 统一的人名解析 SQL：只取 ``full_name``，不加任何 coalesce 兜底。
DISPLAY_NAME_SQL = "select id, full_name from public.user_accounts where id = any(:ids)"


def resolve_display_names(
    db: Session, user_ids: set[str] | None
) -> dict[str, str]:
    """批量把 ``user_accounts.id`` 解析成中文姓名，避免 N+1。

    返回 ``{str(id): full_name}``。账号不存在、``full_name`` 为空（或只有空白）
    的 id **不会**出现在返回里，调用方按「取不到」处理即可。
    """
    ids = {str(uid) for uid in (user_ids or set()) if uid}
    if not ids:
        return {}
    rows = db.execute(text(DISPLAY_NAME_SQL), {"ids": sorted(ids)}).all()
    resolved: dict[str, str] = {}
    for row in rows:
        name = str(row[1]).strip() if row[1] is not None else ""
        if name:
            resolved[str(row[0])] = name
    return resolved


def resolve_display_name(db: Session, user_id: str | None) -> str | None:
    """单个 id 的显示名；语义同 :func:`resolve_display_names`。"""
    if not user_id:
        return None
    return resolve_display_names(db, {user_id}).get(str(user_id))
