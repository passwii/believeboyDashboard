"""项目启动台流程读写服务（BLF-1234 / P2 BLF-1237）。

职责：
- 模板 → 流程实例的快照复制（节点 + 多条内容 + 附件记录 + 计划工期）。
- 流程/任务的读与状态写，派生聚合状态。
- P2：项目内节点增删改排序（管理员）、节点多条内容、阶段排期推算。
- 概要批量查询：**一次查询**覆盖所有可见项目，不做逐项目 fan-out。

访问校验（``project_service.ensure_project_access``）与管理员判定由 endpoint 层负责，
服务层只管数据。

排期口径（P2）：
- 流程 ``start_date`` 是排期锚点。
- 节点日期**手填优先**：``start_date``/``end_date`` 已填的节点不动；
  未填且有 ``duration_days`` 的节点，从游标（上一节点的结束日 + 1）推算。
- 流程/项目的起止与时长是**派生**值（不落库）：min(节点开始) / max(节点结束)。
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException, status as http_status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models.project_workflow import (
    ProjectWorkflow,
    ProjectWorkflowTask,
    ProjectWorkflowTaskAttachment,
    ProjectWorkflowTaskContent,
    WORKFLOW_TASK_STATUSES,
)
from app.services import project_workflow_template_service as template_service
from app.services.project_workflow_templates import (
    WORKFLOW_KIND_STORE_LAUNCH,
    is_valid_document_key,
)

STATUS_NOT_STARTED = "not_started"
STATUS_IN_PROGRESS = "in_progress"
STATUS_WAITING_ON_PARTNER = "waiting_on_partner"
STATUS_COMPLETED = "completed"

MAX_DURATION_DAYS = 3650


def derive_status(statuses: Sequence[str]) -> str:
    """聚合派生状态。

    全部完成 → completed；任一进行中 → in_progress；
    无进行中但有等待对方 → waiting_on_partner；否则 not_started。
    """
    values = list(statuses)
    if values and all(value == STATUS_COMPLETED for value in values):
        return STATUS_COMPLETED
    if any(value == STATUS_IN_PROGRESS for value in values):
        return STATUS_IN_PROGRESS
    if any(value == STATUS_WAITING_ON_PARTNER for value in values):
        return STATUS_WAITING_ON_PARTNER
    return STATUS_NOT_STARTED


# ---------------------------------------------------------------------------
# 排期
# ---------------------------------------------------------------------------

def span_days(start: date | None, end: date | None) -> int | None:
    """含头含尾的天数（``2026-01-01``→``2026-01-02`` 记 2 天）。"""
    if start is None or end is None:
        return None
    return (end - start).days + 1


def schedule_bounds(
    tasks: Sequence[ProjectWorkflowTask],
) -> tuple[date | None, date | None]:
    starts = [task.start_date for task in tasks if task.start_date is not None]
    ends = [task.end_date for task in tasks if task.end_date is not None]
    return (min(starts) if starts else None, max(ends) if ends else None)


def _ordered_tasks(workflow: ProjectWorkflow) -> list[ProjectWorkflowTask]:
    return sorted(workflow.tasks, key=lambda task: (task.sort_order, task.id or 0))


def recompute_schedule(workflow: ProjectWorkflow) -> None:
    """按节点顺序补齐缺失的起止日期（手填优先，落库）。

    游标从流程 ``start_date`` 开始；每个节点结束后游标指向「结束日 + 1」。
    只填了 ``start_date`` 没有 ``end_date`` 的节点，游标推进一天（不猜工期）。
    """
    cursor: date | None = workflow.start_date
    for task in _ordered_tasks(workflow):
        if (
            task.start_date is None
            and task.end_date is None
            and task.duration_days
            and cursor is not None
        ):
            task.start_date = cursor
            task.end_date = cursor + timedelta(days=max(task.duration_days, 1) - 1)
        if task.end_date is not None:
            cursor = task.end_date + timedelta(days=1)
        elif task.start_date is not None:
            cursor = task.start_date + timedelta(days=1)


def _validate_duration(days: int | None) -> int | None:
    if days is None:
        return None
    if days < 0 or days > MAX_DURATION_DAYS:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"工期天数必须在 0..{MAX_DURATION_DAYS} 之间",
        )
    return days


def _validate_attachment_key(value: str | None) -> str | None:
    if not is_valid_document_key(value):
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="固定文档键不在白名单内",
        )
    normalized = (value or "").strip()
    return normalized or None


def _validate_date_pair(start: date | None, end: date | None) -> None:
    if start is not None and end is not None and end < start:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="结束日期不能早于开始日期",
        )


# ---------------------------------------------------------------------------
# 序列化
# ---------------------------------------------------------------------------

def serialize_content(content: ProjectWorkflowTaskContent) -> dict[str, Any]:
    return {
        "id": content.id,
        "title": content.title,
        "body": content.body,
        "sort_order": content.sort_order,
    }


def serialize_task(task: ProjectWorkflowTask) -> dict[str, Any]:
    from app.services.project_workflow_attachment_service import serialize_attachment

    return {
        "id": task.id,
        "workflow_id": task.workflow_id,
        "title": task.title,
        "description": task.description,
        "sort_order": task.sort_order,
        "status": task.status,
        "attachment_key": task.attachment_key,
        "duration_days": task.duration_days,
        "start_date": task.start_date,
        "end_date": task.end_date,
        "span_days": span_days(task.start_date, task.end_date),
        "contents": [
            serialize_content(content)
            for content in sorted(task.contents, key=lambda c: (c.sort_order, c.id or 0))
        ],
        "attachments": [
            serialize_attachment(attachment, include_origin=True)
            for attachment in sorted(task.attachments, key=lambda a: a.id or 0)
        ],
    }


def serialize_workflow(workflow: ProjectWorkflow) -> dict[str, Any]:
    tasks = _ordered_tasks(workflow)
    statuses = [task.status for task in tasks]
    start, end = schedule_bounds(tasks)
    return {
        "id": workflow.id,
        "project_id": workflow.project_id,
        "kind": workflow.kind,
        "title": workflow.title,
        "template_key": workflow.template_key,
        "status": derive_status(statuses),
        "task_count": len(tasks),
        "completed_task_count": sum(
            1 for value in statuses if value == STATUS_COMPLETED
        ),
        "start_date": workflow.start_date,
        "schedule_start": start,
        "schedule_end": end,
        "schedule_days": span_days(start, end),
        "tasks": [serialize_task(task) for task in tasks],
    }


# ---------------------------------------------------------------------------
# 读
# ---------------------------------------------------------------------------

def _workflow_query():
    return select(ProjectWorkflow).options(
        selectinload(ProjectWorkflow.tasks).selectinload(ProjectWorkflowTask.contents),
        selectinload(ProjectWorkflow.tasks).selectinload(
            ProjectWorkflowTask.attachments
        ),
    )


def list_workflows(db: Session, project_id: int) -> list[ProjectWorkflow]:
    return list(
        db.execute(
            _workflow_query()
            .where(ProjectWorkflow.project_id == project_id)
            .order_by(ProjectWorkflow.id.asc())
        )
        .scalars()
        .unique()
        .all()
    )


def get_workflow(db: Session, workflow_id: int) -> ProjectWorkflow | None:
    return (
        db.execute(_workflow_query().where(ProjectWorkflow.id == workflow_id))
        .scalars()
        .unique()
        .first()
    )


def find_store_launch_workflow(
    db: Session, project_id: int
) -> ProjectWorkflow | None:
    return (
        db.execute(
            _workflow_query().where(
                ProjectWorkflow.project_id == project_id,
                ProjectWorkflow.kind == WORKFLOW_KIND_STORE_LAUNCH,
            )
        )
        .scalars()
        .unique()
        .first()
    )


def get_task_with_workflow(
    db: Session, task_id: int
) -> tuple[ProjectWorkflowTask, ProjectWorkflow] | None:
    task = (
        db.execute(
            select(ProjectWorkflowTask)
            .where(ProjectWorkflowTask.id == task_id)
            .options(
                selectinload(ProjectWorkflowTask.contents),
                selectinload(ProjectWorkflowTask.attachments),
            )
        )
        .scalars()
        .first()
    )
    if task is None:
        return None
    workflow = get_workflow(db, task.workflow_id)
    if workflow is None:
        return None
    return task, workflow


def get_workflow_task(db: Session, task_id: int) -> ProjectWorkflowTask | None:
    return (
        db.execute(
            select(ProjectWorkflowTask)
            .where(ProjectWorkflowTask.id == task_id)
            .options(
                selectinload(ProjectWorkflowTask.contents),
                selectinload(ProjectWorkflowTask.attachments),
            )
        )
        .scalars()
        .first()
    )


# ---------------------------------------------------------------------------
# 创建（模板快照）
# ---------------------------------------------------------------------------

def create_workflow(
    db: Session,
    *,
    project_id: int,
    kind: str,
    template_key: str,
    title: str | None = None,
    start_date: date | None = None,
) -> tuple[ProjectWorkflow, bool]:
    """Create a workflow by snapshotting its template.

    Returns ``(workflow, created)``. Store-startup creation is idempotent: when
    the project already has one, the existing row is returned with
    ``created=False``. Product-development creation is repeatable.

    P2：模板从数据库读取，快照额外复制**多条内容**与**附件记录**
    （附件共享模板的同一个 R2 对象，``origin='template'``）与计划工期。
    """
    template = template_service.get_template_by_key(db, template_key)
    if template is None:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="流程模板不存在",
        )
    if template.kind != kind:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="流程模板与流程类型不匹配",
        )

    if kind == WORKFLOW_KIND_STORE_LAUNCH:
        existing = find_store_launch_workflow(db, project_id)
        if existing is not None:
            return existing, False

    workflow_title = (title or "").strip() or template.title
    workflow = ProjectWorkflow(
        project_id=project_id,
        kind=kind,
        title=workflow_title[:160],
        template_key=template.key,
        start_date=start_date,
    )
    for index, task_template in enumerate(template_service.ordered_tasks(template)):
        task = ProjectWorkflowTask(
            title=task_template.title,
            description=task_template.description,
            sort_order=index,
            status=STATUS_NOT_STARTED,
            attachment_key=task_template.attachment_key,
            duration_days=task_template.duration_days,
        )
        for content in sorted(
            task_template.contents, key=lambda c: (c.sort_order, c.id or 0)
        ):
            task.contents.append(
                ProjectWorkflowTaskContent(
                    title=content.title,
                    body=content.body,
                    sort_order=content.sort_order,
                )
            )
        for attachment in sorted(task_template.attachments, key=lambda a: a.id or 0):
            task.attachments.append(
                ProjectWorkflowTaskAttachment(
                    r2_key=attachment.r2_key,
                    filename=attachment.filename,
                    content_type=attachment.content_type,
                    file_size=attachment.file_size,
                    uploader=attachment.uploader,
                    origin="template",
                )
            )
        workflow.tasks.append(task)

    db.add(workflow)
    try:
        db.commit()
    except IntegrityError:
        # 并发重复创建店铺启动流程：唯一索引兜底，回退到已存在的那条。
        db.rollback()
        existing = find_store_launch_workflow(db, project_id)
        if existing is None:
            raise
        return existing, False

    refreshed = get_workflow(db, workflow.id)
    return (refreshed or workflow), True


# ---------------------------------------------------------------------------
# 写：状态（P1，非管理员可用）
# ---------------------------------------------------------------------------

def update_task_status(
    db: Session, task: ProjectWorkflowTask, new_status: str
) -> ProjectWorkflow:
    if new_status not in WORKFLOW_TASK_STATUSES:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="任务状态不合法",
        )
    task.status = new_status
    db.flush()
    workflow = db.get(ProjectWorkflow, task.workflow_id)
    if workflow is None:
        db.rollback()
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="流程不存在"
        )
    db.commit()
    refreshed = get_workflow(db, workflow.id)
    return refreshed or workflow


# ---------------------------------------------------------------------------
# 写：流程定义（P2，仅管理员）
# ---------------------------------------------------------------------------

def update_workflow_definition(
    db: Session,
    workflow: ProjectWorkflow,
    *,
    title: str | None = None,
    start_date: date | None = None,
    start_date_provided: bool = False,
) -> ProjectWorkflow:
    if title is not None:
        clean_title = title.strip()
        if not clean_title:
            raise HTTPException(
                status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="流程标题不能为空",
            )
        workflow.title = clean_title[:160]
    if start_date_provided:
        workflow.start_date = start_date
    recompute_schedule(workflow)
    db.commit()
    refreshed = get_workflow(db, workflow.id)
    assert refreshed is not None
    return refreshed


def _next_task_sort_order(db: Session, workflow_id: int) -> int:
    current = db.execute(
        select(func.coalesce(func.max(ProjectWorkflowTask.sort_order), -1)).where(
            ProjectWorkflowTask.workflow_id == workflow_id
        )
    ).scalar()
    return int(current if current is not None else -1) + 1


def _resequence_project_tasks(
    db: Session, workflow_id: int, *, insert_at: int, inserted_id: int
) -> None:
    rows = list(
        db.execute(
            select(ProjectWorkflowTask)
            .where(ProjectWorkflowTask.workflow_id == workflow_id)
            .order_by(
                ProjectWorkflowTask.sort_order.asc(), ProjectWorkflowTask.id.asc()
            )
        ).scalars()
    )
    ordered = [row for row in rows if row.id != inserted_id]
    position = max(0, min(insert_at, len(ordered)))
    ordered.insert(position, next(row for row in rows if row.id == inserted_id))
    for index, row in enumerate(ordered):
        row.sort_order = index
    db.flush()


def _reorder_project_tasks_dense(db: Session, workflow_id: int) -> None:
    rows = list(
        db.execute(
            select(ProjectWorkflowTask)
            .where(ProjectWorkflowTask.workflow_id == workflow_id)
            .order_by(
                ProjectWorkflowTask.sort_order.asc(), ProjectWorkflowTask.id.asc()
            )
        ).scalars()
    )
    for index, row in enumerate(rows):
        row.sort_order = index
    db.flush()


def create_project_task(
    db: Session,
    workflow: ProjectWorkflow,
    *,
    title: str,
    description: str | None = None,
    attachment_key: str | None = None,
    duration_days: int | None = None,
    sort_order: int | None = None,
) -> ProjectWorkflow:
    clean_title = (title or "").strip()
    if not clean_title:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail="节点标题不能为空"
        )
    task = ProjectWorkflowTask(
        workflow_id=workflow.id,
        title=clean_title[:160],
        description=description,
        attachment_key=_validate_attachment_key(attachment_key),
        duration_days=_validate_duration(duration_days),
        status=STATUS_NOT_STARTED,
        sort_order=(
            _next_task_sort_order(db, workflow.id) if sort_order is None else sort_order
        ),
    )
    db.add(task)
    db.flush()
    if sort_order is not None:
        _resequence_project_tasks(
            db, workflow.id, insert_at=sort_order, inserted_id=task.id
        )
    db.commit()
    refreshed = get_workflow(db, workflow.id)
    assert refreshed is not None
    return refreshed


def update_project_task_definition(
    db: Session,
    workflow: ProjectWorkflow,
    task: ProjectWorkflowTask,
    *,
    title: str | None = None,
    description: str | None = None,
    attachment_key: str | None = None,
    duration_days: int | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    description_provided: bool = False,
    attachment_key_provided: bool = False,
    duration_days_provided: bool = False,
    start_date_provided: bool = False,
    end_date_provided: bool = False,
) -> ProjectWorkflow:
    if title is not None:
        clean_title = title.strip()
        if not clean_title:
            raise HTTPException(
                status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="节点标题不能为空",
            )
        task.title = clean_title[:160]
    if description_provided:
        task.description = description
    if attachment_key_provided:
        task.attachment_key = _validate_attachment_key(attachment_key)
    if duration_days_provided:
        task.duration_days = _validate_duration(duration_days)
    if start_date_provided:
        task.start_date = start_date
    if end_date_provided:
        task.end_date = end_date
    _validate_date_pair(task.start_date, task.end_date)
    db.flush()
    refreshed = get_workflow(db, workflow.id)
    assert refreshed is not None
    recompute_schedule(refreshed)
    db.commit()
    final = get_workflow(db, workflow.id)
    assert final is not None
    return final


def delete_project_task(
    db: Session, workflow: ProjectWorkflow, task: ProjectWorkflowTask
) -> ProjectWorkflow:
    db.delete(task)
    db.flush()
    _reorder_project_tasks_dense(db, workflow.id)
    refreshed = get_workflow(db, workflow.id)
    assert refreshed is not None
    recompute_schedule(refreshed)
    db.commit()
    final = get_workflow(db, workflow.id)
    assert final is not None
    return final


def reorder_project_tasks(
    db: Session, workflow: ProjectWorkflow, task_ids: Sequence[int]
) -> ProjectWorkflow:
    rows = list(
        db.execute(
            select(ProjectWorkflowTask).where(
                ProjectWorkflowTask.workflow_id == workflow.id
            )
        ).scalars()
    )
    existing = {int(row.id) for row in rows}
    requested = [int(value) for value in task_ids]
    if sorted(existing) != sorted(requested):
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="排序列表必须恰好包含该流程的全部节点",
        )
    by_id = {int(row.id): row for row in rows}
    for index, task_id in enumerate(requested):
        by_id[task_id].sort_order = index
    db.flush()
    refreshed = get_workflow(db, workflow.id)
    assert refreshed is not None
    recompute_schedule(refreshed)
    db.commit()
    final = get_workflow(db, workflow.id)
    assert final is not None
    return final

# ---------------------------------------------------------------------------
# 写：项目节点内容（P2，仅管理员）
# ---------------------------------------------------------------------------

def get_project_content(db: Session, content_id: int) -> ProjectWorkflowTaskContent | None:
    return db.get(ProjectWorkflowTaskContent, content_id)


def create_project_content(
    db: Session,
    task: ProjectWorkflowTask,
    *,
    body: str,
    title: str | None = None,
    sort_order: int | None = None,
) -> ProjectWorkflow:
    if not (body or "").strip():
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail="内容正文不能为空"
        )
    if sort_order is None:
        current = db.execute(
            select(func.coalesce(func.max(ProjectWorkflowTaskContent.sort_order), -1)).where(
                ProjectWorkflowTaskContent.task_id == task.id
            )
        ).scalar()
        sort_order = int(current if current is not None else -1) + 1
    db.add(
        ProjectWorkflowTaskContent(
            task_id=task.id,
            title=(title or "").strip() or None,
            body=body,
            sort_order=sort_order,
        )
    )
    db.commit()
    refreshed = get_workflow(db, task.workflow_id)
    assert refreshed is not None
    return refreshed


def update_project_content(
    db: Session,
    content: ProjectWorkflowTaskContent,
    *,
    body: str | None = None,
    title: str | None = None,
    title_provided: bool = False,
) -> ProjectWorkflow:
    workflow_id = _workflow_id_of_content(db, content)
    if body is not None:
        if not body.strip():
            raise HTTPException(
                status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="内容正文不能为空",
            )
        content.body = body
    if title_provided:
        content.title = (title or "").strip() or None
    db.commit()
    refreshed = get_workflow(db, workflow_id)
    assert refreshed is not None
    return refreshed


def _workflow_id_of_content(db: Session, content: ProjectWorkflowTaskContent) -> int:
    task = db.get(ProjectWorkflowTask, content.task_id)
    return int(task.workflow_id) if task is not None else 0


def delete_project_content(
    db: Session, content: ProjectWorkflowTaskContent
) -> ProjectWorkflow:
    task_id = content.task_id
    workflow_id = _workflow_id_of_content(db, content)
    db.delete(content)
    db.flush()
    rows = list(
        db.execute(
            select(ProjectWorkflowTaskContent)
            .where(ProjectWorkflowTaskContent.task_id == task_id)
            .order_by(
                ProjectWorkflowTaskContent.sort_order.asc(),
                ProjectWorkflowTaskContent.id.asc(),
            )
        ).scalars()
    )
    for index, row in enumerate(rows):
        row.sort_order = index
    db.commit()
    refreshed = get_workflow(db, workflow_id)
    assert refreshed is not None
    return refreshed


# ---------------------------------------------------------------------------
# 概要（批量）
# ---------------------------------------------------------------------------

def bulk_workflow_summaries(
    db: Session, project_ids: Sequence[int]
) -> dict[int, list[dict[str, Any]]]:
    """One query for every project's workflow summary (no per-project fan-out)."""
    result: dict[int, list[dict[str, Any]]] = {
        int(project_id): [] for project_id in project_ids
    }
    if not result:
        return result

    rows = db.execute(
        select(ProjectWorkflow, ProjectWorkflowTask)
        .outerjoin(
            ProjectWorkflowTask,
            ProjectWorkflowTask.workflow_id == ProjectWorkflow.id,
        )
        .where(ProjectWorkflow.project_id.in_(list(result.keys())))
        .order_by(ProjectWorkflow.id.asc(), ProjectWorkflowTask.sort_order.asc())
    ).all()

    grouped: dict[int, dict[str, Any]] = {}
    for workflow, task in rows:
        entry = grouped.setdefault(
            workflow.id,
            {"workflow": workflow, "statuses": [], "starts": [], "ends": []},
        )
        if task is not None:
            entry["statuses"].append(task.status)
            if task.start_date is not None:
                entry["starts"].append(task.start_date)
            if task.end_date is not None:
                entry["ends"].append(task.end_date)

    for entry in grouped.values():
        workflow: ProjectWorkflow = entry["workflow"]
        statuses: list[str] = entry["statuses"]
        start = min(entry["starts"]) if entry["starts"] else None
        end = max(entry["ends"]) if entry["ends"] else None
        result.setdefault(workflow.project_id, []).append(
            {
                "id": workflow.id,
                "kind": workflow.kind,
                "title": workflow.title,
                "template_key": workflow.template_key,
                "status": derive_status(statuses),
                "task_count": len(statuses),
                "completed_task_count": sum(
                    1 for value in statuses if value == STATUS_COMPLETED
                ),
                "start_date": workflow.start_date,
                "schedule_start": start,
                "schedule_end": end,
                "schedule_days": span_days(start, end),
            }
        )
    return result


def bulk_project_schedules(
    db: Session, project_ids: Sequence[int]
) -> dict[int, dict[str, Any]]:
    """每个项目的排期并集（一次聚合查询）：最早节点开始 → 最晚节点结束。"""
    result: dict[int, dict[str, Any]] = {
        int(project_id): {
            "schedule_start": None,
            "schedule_end": None,
            "schedule_days": None,
        }
        for project_id in project_ids
    }
    if not result:
        return result

    rows = db.execute(
        select(
            ProjectWorkflow.project_id,
            func.min(ProjectWorkflowTask.start_date),
            func.max(ProjectWorkflowTask.end_date),
        )
        .join(
            ProjectWorkflowTask,
            ProjectWorkflowTask.workflow_id == ProjectWorkflow.id,
        )
        .where(ProjectWorkflow.project_id.in_(list(result.keys())))
        .group_by(ProjectWorkflow.project_id)
    ).all()

    for project_id, start, end in rows:
        result[int(project_id)] = {
            "schedule_start": start,
            "schedule_end": end,
            "schedule_days": span_days(start, end),
        }
    return result


def template_options(db: Session) -> list[dict[str, str]]:
    """Template metadata only — the UI never receives template task bodies."""
    return template_service.template_options(db)
