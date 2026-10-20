"""CRM 操作级权限（MVP：is_admin 二分，身份来自 deps.get_request_is_admin）。

规则（用户拍板 2026-07-23）：
- 普通销售：``scope=all`` 降级为 ``mine``（只见自己名下；公海/线索池仍由 ``scope=sea`` 显式访问）；
  不可指派负责人（batch-transfer）；不可写非自己名下记录（编辑/删除/转化/领取）。
- 管理员（is_admin）：``scope=all`` 看全部（含别人私海）；可指派/释放任意记录。

全部(all) ⊇ 我的(mine)；公海 = owner_id IS NULL。

**例外：客户方案域（proposal）全员可见（BLF-1403 / BLF-1410）**
- 客户方案按业务要求「全员可见」：方案列表非 admin 的 ``scope=all`` **不降级**，
  只读端点（详情 / 预览 / 下载）对所有登录用户开放。
- 该例外**仅限方案域**，用 ``resolve_proposal_scope`` 表达，**不要**改 ``resolve_scope``
  ——后者是客户 / 线索 / 任务 / 跟进 / 漏斗等全域共用的「私海保护」，动了会连带拆掉那些域的边界。
- 方案域的**写操作**（编辑 / 删除 / 追加版本）仍受 ``require_owner_or_admin`` 保护：
  全员可读 ≠ 全员可改。
"""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session


def resolve_scope(scope: str, is_admin: bool) -> str:
    """非管理员请求 ``all`` → 降级为 ``mine``（看不到别人私海）。

    ⚠️ 这是 **CRM 全域**口径（客户 / 线索 / 任务 / 跟进 / 漏斗…），
    承载 2026-07-23 拍板的私海保护规则——**不要**为了某个域的需求改它。
    客户方案域是已知例外，请用 ``resolve_proposal_scope``。
    """
    if scope == "all" and not is_admin:
        return "mine"
    return scope


def resolve_proposal_scope(scope: str, is_admin: bool) -> str:
    """方案域 scope：**``all`` 不降级**（客户方案全员可见，BLF-1403 / BLF-1410）。

    与 ``resolve_scope`` 的区别：``resolve_scope`` 是 CRM 全域的「私海保护」，
    非 admin 的 ``all`` 会被降级为 ``mine``；客户方案按业务要求全员可见，
    因此这里保留请求方的 ``scope`` 语义（``all`` = 全部方案，``mine`` = 只看自己名下）。

    写操作的 owner 校验仍在各端点单独把关（见 ``require_owner_or_admin``）：
    **全员可读 ≠ 全员可改**。

    参数 ``is_admin`` 保留是为了与 ``resolve_scope`` 形状一致（便于对照与单测），
    当前口径下不依赖它——admin 与非 admin 在方案域的可见性相同。
    """
    return scope


def require_proposal_readable(
    record_owner_id: str | None, user_id: str | None, is_admin: bool
) -> None:
    """方案域**只读**可见性：全员可读（含跨私海，BLF-1403 / BLF-1410）。

    与 ``require_owner_or_admin`` 的区别：那个守的是「写」——非 owner 不可改 / 删 / 传版本；
    这个守的是「读」——方案本身按业务要求全员可见，故一律放行。

    保留这个显式函数（而不是直接删掉门禁行）是为了让意图可读：
    后来者看到 ``require_proposal_readable`` 就知道「这里放开是有意为之」，
    而看到空实现才会怀疑是漏了权限校验。

    三个入参目前不参与判定（全员可读），但保留签名以便未来收紧口径
    （如「仅共享方案可跨私海读」）时不必改调用方。
    """
    del record_owner_id, user_id, is_admin
    return None


def require_admin(is_admin: bool) -> None:
    """仅管理员可执行（如指派负责人）；否则 403。"""
    if not is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin required")


def require_owner_or_admin(record_owner_id: str | None, user_id: str | None, is_admin: bool) -> None:
    """非管理员只能操作自己名下记录；管理员放行。

    记录无主（在公海/线索池）时，非管理员不可直接写（须先领取）→ 403。
    """
    if is_admin:
        return
    if record_owner_id is None or record_owner_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not the record owner")


def filter_owned_ids(db: Session, model, ids: list[int], user_id: str | None, is_admin: bool) -> list[int]:
    """批量「释放回公海/线索池」：非管理员只保留自己名下的 id，管理员全保留。"""
    if is_admin:
        return ids
    rows = db.execute(
        select(model.id).where(model.id.in_(ids), model.owner_id == user_id)
    ).scalars().all()
    return list(rows)
