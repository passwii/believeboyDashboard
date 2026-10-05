"""项目启动台流程读写服务（BLF-1234）。

职责：
- 模板 → 流程实例的快照复制（创建后模板改动不影响已有进度）。
- 流程/任务的读与状态写，派生聚合状态。
- 概要批量查询：**一次查询**覆盖所有可见项目，不做逐项目 fan-out。

访问校验（``project_service.ensure_project_access``）由 endpoint 层负责，
服务层只管数据。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from fastapi import HTTPException, status as http_status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models.project_workflow import (
    ProjectWorkflow,
    ProjectWorkflowTask,
    WORKFLOW_TASK_STATUSES,
)
from app.services.project_workflow_templates import (
    WORKFLOW_KIND_STORE_LAUNCH,
    get_template,
)

STATUS_NOT_STARTED = "not_started"
STATUS_IN_PROGRESS = "in_progress"
STATUS_WAITING_ON_PARTNER = "waiting_on_partner"
STATUS_COMPLETED = "completed"


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


def _ordered_tasks(workflow: ProjectWorkflow) -> list[ProjectWorkflowTask]:
    return sorted(workflow.tasks, key=lambda task: (task.sort_order, task.id or 0))


def serialize_task(task: ProjectWorkflowTask) -> dict[str, Any]:
    return {
        "id": task.id,
        "workflow_id": task.workflow_id,
        "title": task.title,
        "description": task.description,
        "sort_order": task.sort_order,
        "status": task.status,
        "attachment_key": task.attachment_key,
    }


def serialize_workflow(workflow: ProjectWorkflow) -> dict[str, Any]:
    tasks = _ordered_tasks(workflow)
    statuses = [task.status for task in tasks]
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
        "tasks": [serialize_task(task) for task in tasks],
    }


def list_workflows(db: Session, project_id: int) -> list[ProjectWorkflow]:
    return list(
        db.execute(
            select(ProjectWorkflow)
            .where(ProjectWorkflow.project_id == project_id)
            .options(selectinload(ProjectWorkflow.tasks))
            .order_by(ProjectWorkflow.id.asc())
        )
        .scalars()
        .all()
    )


def get_workflow(db: Session, workflow_id: int) -> ProjectWorkflow | None:
    return (
        db.execute(
            select(ProjectWorkflow)
            .where(ProjectWorkflow.id == workflow_id)
            .options(selectinload(ProjectWorkflow.tasks))
        )
        .scalars()
        .first()
    )


def find_store_launch_workflow(
    db: Session, project_id: int
) -> ProjectWorkflow | None:
    return (
        db.execute(
            select(ProjectWorkflow)
            .where(
                ProjectWorkflow.project_id == project_id,
                ProjectWorkflow.kind == WORKFLOW_KIND_STORE_LAUNCH,
            )
            .options(selectinload(ProjectWorkflow.tasks))
        )
        .scalars()
        .first()
    )


def create_workflow(
    db: Session,
    *,
    project_id: int,
    kind: str,
    template_key: str,
    title: str | None = None,
) -> tuple[ProjectWorkflow, bool]:
    """Create a workflow by snapshotting its template.

    Returns ``(workflow, created)``. Store-startup creation is idempotent: when
    the project already has one, the existing row is returned with
    ``created=False``. Product-development creation is repeatable.
    """
    template = get_template(template_key)
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
    )
    for index, task_template in enumerate(template.tasks):
        workflow.tasks.append(
            ProjectWorkflowTask(
                title=task_template.title,
                description=task_template.description,
                sort_order=index,
                status=STATUS_NOT_STARTED,
                attachment_key=task_template.attachment_key,
            )
        )
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


def get_task_with_workflow(
    db: Session, task_id: int
) -> tuple[ProjectWorkflowTask, ProjectWorkflow] | None:
    task = db.get(ProjectWorkflowTask, task_id)
    if task is None:
        return None
    workflow = db.get(ProjectWorkflow, task.workflow_id)
    if workflow is None:
        return None
    return task, workflow


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
        entry = grouped.setdefault(workflow.id, {"workflow": workflow, "statuses": []})
        if task is not None:
            entry["statuses"].append(task.status)

    for entry in grouped.values():
        workflow: ProjectWorkflow = entry["workflow"]
        statuses: list[str] = entry["statuses"]
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
            }
        )
    return result


def template_options() -> list[dict[str, str]]:
    """Template metadata only — the UI never receives template task bodies."""
    from app.services.project_workflow_templates import list_templates

    return [
        {"key": template.key, "kind": template.kind, "title": template.title}
        for template in list_templates()
    ]
