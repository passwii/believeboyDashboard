"""Task service (P7, BLF-510): crm_tasks CRUD + 状态流转 + 权限。

权限规则（拍板简化版，见设计文档 §6.2）：
- 任务操作权限 = 任务 owner 或 admin，不随关联客户 owner 自动授权。
- 普通销售：scope=all 降级 mine（端点层 resolve_scope 处理）；创建默认 owner=自己，
  不可指派他人；owner_id 不可改。
- 管理员：scope=all 看全部；可指派/改负责人。

P5-6 强一致：写操作默认 commit=False（仅 flush），由端点统一 commit，
保证业务写入 + 审计写入原子化。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer, CrmLead, CrmTask
from app.schemas.crm import TaskItem

# 筛选白名单（防注入：未知字段直接 ValueError → 端点转 400）
TASK_FILTER_FIELDS = (
    "type",
    "status",
    "priority",
    "owner_id",
    "customer_id",
    "lead_id",
)
# 排序白名单
TASK_SORT_FIELDS = ("due_date", "priority", "created_at", "completed_at")

# 状态流转终态：done/cancelled 后不可再流转（设计文档 §9）
TERMINAL_STATUSES = {"done", "cancelled"}

# §3.3 完成联动（方案 A）：互动类任务 type → 自动生成的 follow type 映射
TASK_FOLLOW_TYPE_MAP = {"call": "phone", "visit": "visit", "follow_up": "note"}
# 互动类任务：done 时自动生成 follow + 回写实体；custom 不联动（可手动补跟进）
INTERACTIVE_TYPES = frozenset({"follow_up", "call", "visit"})

# priority 排序权重（urgent > high > medium > low）
_PRIORITY_RANK = case(
    (CrmTask.priority == "urgent", 4),
    (CrmTask.priority == "high", 3),
    (CrmTask.priority == "medium", 2),
    (CrmTask.priority == "low", 1),
    else_=0,
)


def _current_user_id(user_id: str | None) -> str | None:
    if user_id is None:
        return None
    uid = user_id.strip()
    return uid or None


def _names_map(db: Session, ids: set[str]) -> dict[str, str]:
    """批量查 user_accounts.name（owner/created_by 联查），避免 N+1。"""
    from sqlalchemy import text

    if not ids:
        return {}
    rows = db.execute(
        text("select id, name from public.user_accounts where id = any(:ids)"),
        {"ids": list(ids)},
    ).all()
    return {str(r[0]): r[1] for r in rows}


def _customer_names_map(db: Session, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = db.execute(
        select(CrmCustomer.id, CrmCustomer.name).where(CrmCustomer.id.in_(ids))
    ).all()
    return {r[0]: r[1] for r in rows}


def _lead_names_map(db: Session, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = db.execute(select(CrmLead.id, CrmLead.name).where(CrmLead.id.in_(ids))).all()
    return {r[0]: r[1] for r in rows}


def _to_item(
    db: Session,
    task: CrmTask,
    user_names: dict[str, str],
    customer_names: dict[int, str],
    lead_names: dict[int, str],
) -> TaskItem:
    return TaskItem(
        id=task.id,
        title=task.title,
        description=task.description,
        due_date=task.due_date,
        priority=task.priority,
        status=task.status,
        type=task.type,
        owner_id=task.owner_id,
        owner_name=user_names.get(task.owner_id) if task.owner_id else None,
        customer_id=task.customer_id,
        customer_name=customer_names.get(task.customer_id)
        if task.customer_id
        else None,
        lead_id=task.lead_id,
        lead_name=lead_names.get(task.lead_id) if task.lead_id else None,
        reminded_at=task.reminded_at,
        created_by=task.created_by,
        completed_at=task.completed_at,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def _hydrate(db: Session, task: CrmTask) -> TaskItem:
    user_names = _names_map(db, {t for t in (task.owner_id, task.created_by) if t})
    customer_names = _customer_names_map(
        db, {task.customer_id} if task.customer_id else set()
    )
    lead_names = _lead_names_map(db, {task.lead_id} if task.lead_id else set())
    return _to_item(db, task, user_names, customer_names, lead_names)


def get_task(db: Session, task_id: int) -> TaskItem | None:
    """详情（联查客户名/线索名/owner 名）；不存在返回 None。"""
    task = db.execute(select(CrmTask).where(CrmTask.id == task_id)).scalar_one_or_none()
    if task is None:
        return None
    return _hydrate(db, task)


def get_task_orm(db: Session, task_id: int) -> CrmTask | None:
    """原始 ORM 对象（权限校验 / 状态流转用）。"""
    return db.execute(select(CrmTask).where(CrmTask.id == task_id)).scalar_one_or_none()


def list_tasks(
    db: Session,
    *,
    user_id: str | None,
    scope: str = "mine",
    filters: dict | None = None,
    sort_by: str = "due_date",
    sort_order: str = "asc",
    page: int = 1,
    page_size: int = 20,
    is_admin: bool = False,
) -> tuple[list[TaskItem], int]:
    """列表：筛选（白名单）+ 排序（白名单）+ 分页。

    默认排序：due_date ASC NULLS LAST, priority DESC, created_at DESC。
    scope：mine=owner_id==当前用户；all=不加 owner 过滤（端点层已 resolve_scope 降级）。
    """
    cur = _current_user_id(user_id)
    stmt = select(CrmTask)

    if scope == "mine":
        stmt = stmt.where(CrmTask.owner_id == cur)
    # scope == "all": 不加 owner 过滤（admin 专属，端点层已降级非 admin）

    filters = filters or {}
    for key, value in filters.items():
        if value is None or value == "":
            continue
        if key not in TASK_FILTER_FIELDS:
            raise ValueError(f"不支持的筛选字段: {key}")
        # owner_id 过滤仅管理员可用（非 admin scope 已降级 mine，再过滤会串权）
        if key == "owner_id" and not is_admin:
            raise ValueError("owner_id 筛选仅管理员可用")
        stmt = stmt.where(getattr(CrmTask, key) == value)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()

    if sort_by not in TASK_SORT_FIELDS:
        raise ValueError(f"不支持的排序字段: {sort_by}")
    if sort_order not in ("asc", "desc"):
        raise ValueError(f"不支持的排序方向: {sort_order}")

    if sort_by == "priority":
        # priority 是字符串，按语义权重排序（urgent > high > medium > low）
        col = _PRIORITY_RANK
    else:
        col = getattr(CrmTask, sort_by)
    if sort_order == "asc":
        ordered = [col.asc().nulls_last()]
    else:
        ordered = [col.desc().nulls_last()]

    # 默认排序（due_date 主序）：设计文档 §6.1 — due_date + priority 权重 + created_at 兜底。
    # 三键随 sort_order 同步反向（保证 tie-breaker 与主序方向一致，避免不稳定排序）。
    if sort_by == "due_date":
        if sort_order == "asc":
            ordered = [
                CrmTask.due_date.asc().nulls_last(),
                _PRIORITY_RANK.desc(),
                CrmTask.created_at.desc(),
            ]
        else:
            ordered = [
                CrmTask.due_date.desc().nulls_last(),
                _PRIORITY_RANK.asc(),
                CrmTask.created_at.asc(),
            ]
    stmt = stmt.order_by(*ordered)
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = db.execute(stmt).scalars().all()

    user_ids = {t for r in rows for t in (r.owner_id, r.created_by) if t}
    user_names = _names_map(db, user_ids)
    customer_names = _customer_names_map(
        db, {r.customer_id for r in rows if r.customer_id}
    )
    lead_names = _lead_names_map(db, {r.lead_id for r in rows if r.lead_id})
    items = [_to_item(db, r, user_names, customer_names, lead_names) for r in rows]
    return items, int(total)


def create_task(
    db: Session,
    payload,
    *,
    user_id: str | None,
    is_admin: bool = False,
    commit: bool = True,
) -> TaskItem:
    """建任务；owner 默认=自己；admin 可指派他人（非 admin 传 owner_id → 403）。

    customer_id/lead_id 的存在性校验在端点层做（不存在 → 404）。
    """
    from fastapi import HTTPException, status

    cur = _current_user_id(user_id)
    data = payload.model_dump(exclude_unset=True)
    if data.get("owner_id") is not None and not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="仅管理员可指派负责人"
        )
    data["owner_id"] = data.get("owner_id") or cur
    data["created_by"] = cur
    task = CrmTask(**data)
    db.add(task)
    db.flush()
    if commit:
        db.commit()
    db.refresh(task)
    return _hydrate(db, task)


def update_task(
    db: Session,
    task: CrmTask,
    payload,
    *,
    user_id: str | None,
    commit: bool = True,
    is_admin: bool = False,
) -> TaskItem | None:
    """改字段；owner_id 仅 admin 可改（非 admin 传 owner_id → 403）。"""
    from fastapi import HTTPException, status

    data = payload.model_dump(exclude_unset=True)
    if "owner_id" in data and not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="仅管理员可修改负责人"
        )
    for key, value in data.items():
        setattr(task, key, value)
    db.flush()
    if commit:
        db.commit()
    db.refresh(task)
    return _hydrate(db, task)


def complete_task(
    db: Session,
    task: CrmTask,
    *,
    user_id: str | None,
    payload=None,
    commit: bool = True,
) -> TaskItem:
    """完成：status→done + completed_at + §3.3 完成联动（互动类自动生成 follow + 回写实体）。

    §3.3 方案 A（设计文档默认，用户已拍板）：互动类任务（follow_up/call/visit）完成时
    同一事务内：① status→done + completed_at；② 自动创建 follow（type 映射
    call→phone / visit→visit / follow_up→note，content=任务标题，可带完成备注）；
    ③ 回写实体 last_follow_at=now + next_follow_at 设值/未填清空（与
    follow_service.create_follow 语义一致）；custom 类不联动（可手动补跟进）。

    联动仅在有实体（customer_id/lead_id）时生效——无实体的任务没有可挂靠的 follow。
    payload: TaskCompleteRequest | None（next_follow_at + note，见 schemas.crm）。
    """
    from fastapi import HTTPException, status

    if task.status == "done":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="任务已完成，不可重复完成"
        )
    if task.status == "cancelled":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="任务已取消，不可完成"
        )
    task.status = "done"
    task.completed_at = datetime.now(timezone.utc)
    db.flush()
    _maybe_link_completion(db, task, payload, user_id=user_id)
    if commit:
        db.commit()
    db.refresh(task)
    return _hydrate(db, task)


def _maybe_link_completion(
    db: Session, task: CrmTask, payload, *, user_id: str | None
) -> None:
    """§3.3 完成联动：互动类 + 有实体 → 自动生成 follow + 回写（同事务，commit=False）。

    follow_service.create_follow 在事务内 flush 并回写实体（commit=False 由端点统一
    commit），保证 task + follow + 回写 + 审计单事务（P5-6 强一致）。
    """
    from app.schemas.crm import FollowCreate
    from app.services.crm import follow_service

    if task.type not in INTERACTIVE_TYPES:
        return
    if task.customer_id is None and task.lead_id is None:
        return  # 无实体可挂 follow（设计：联动写实体的跟进时间线）

    next_follow_at = (
        getattr(payload, "next_follow_at", None) if payload is not None else None
    )
    note = (getattr(payload, "note", None) or "").strip() if payload is not None else ""
    content = task.title if not note else f"{task.title}：{note}"
    entity_type = "customer" if task.customer_id is not None else "lead"
    entity_id = task.customer_id if task.customer_id is not None else task.lead_id

    follow_payload = FollowCreate(
        entity_type=entity_type,
        entity_id=entity_id,
        type=TASK_FOLLOW_TYPE_MAP[task.type],
        content=content,
        next_follow_at=next_follow_at,
    )
    follow_service.create_follow(db, follow_payload, user_id=user_id, commit=False)


def cancel_task(
    db: Session,
    task: CrmTask,
    *,
    user_id: str | None,
    commit: bool = True,
) -> TaskItem:
    """取消：status→cancelled。"""
    from fastapi import HTTPException, status

    if task.status == "done":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="任务已完成，不可取消"
        )
    task.status = "cancelled"
    db.flush()
    if commit:
        db.commit()
    db.refresh(task)
    return _hydrate(db, task)


def set_task_status(
    db: Session,
    task: CrmTask,
    status_value: str,
    *,
    user_id: str | None,
    commit: bool = True,
) -> TaskItem:
    """看板拖拽流转（pending/in_progress/done）；done/cancelled 后不可再流转。"""
    from fastapi import HTTPException, status

    if task.status in TERMINAL_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"任务已{task.status}，不可再流转",
        )
    if status_value not in ("pending", "in_progress", "done"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"不支持的状态: {status_value}",
        )
    task.status = status_value
    if status_value == "done":
        task.completed_at = datetime.now(timezone.utc)
    db.flush()
    if commit:
        db.commit()
    db.refresh(task)
    return _hydrate(db, task)
