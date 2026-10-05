"""流程模板读写服务（BLF-1237 / P2）。

模板与节点是数据库数据，由管理员维护（权限判定在 endpoint 层用 ``require_admin``）。
服务层负责：模板 CRUD、节点 CRUD 与排序、模板复制（含节点/内容/附件记录复制）、
以及「模板 → 项目」快照所需的读取。

快照语义：项目创建流程时复制节点、内容、附件**记录**；
模板附件与项目副本**共享同一个 R2 对象**，模板后续修改不回写已有项目。
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

from fastapi import HTTPException, status as http_status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.project_workflow_template import (
    WorkflowTemplate,
    WorkflowTemplateTask,
    WorkflowTemplateTaskAttachment,
    WorkflowTemplateTaskContent,
)
from app.services.project_workflow_templates import WORKFLOW_KINDS, is_valid_document_key

KEY_MAX_LENGTH = 80


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

def _normalize_attachment_key(value: str | None) -> str | None:
    if not is_valid_document_key(value):
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="固定文档键不在白名单内",
        )
    normalized = (value or "").strip()
    return normalized or None


def _validate_kind(kind: str) -> str:
    if kind not in WORKFLOW_KINDS:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="流程类型不合法",
        )
    return kind


def _validate_duration(days: int | None) -> int | None:
    if days is None:
        return None
    if days < 0 or days > 3650:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="工期天数必须在 0..3650 之间",
        )
    return days


def _template_key_from_title(title: str) -> str:
    """从标题生成模板键：可读前缀 + 短随机后缀（保证唯一且 ≤80）。"""
    import re

    slug = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", (title or "").strip()).strip("-")
    prefix = slug[:60] or "template"
    return f"{prefix}-{uuid.uuid4().hex[:6]}"[:KEY_MAX_LENGTH]


def _key_exists(db: Session, key: str, *, exclude_id: int | None = None) -> bool:
    stmt = select(WorkflowTemplate.id).where(WorkflowTemplate.key == key)
    if exclude_id is not None:
        stmt = stmt.where(WorkflowTemplate.id != exclude_id)
    return db.execute(stmt).first() is not None


# ---------------------------------------------------------------------------
# 读
# ---------------------------------------------------------------------------

def _template_query():
    return select(WorkflowTemplate).options(
        selectinload(WorkflowTemplate.tasks).selectinload(WorkflowTemplateTask.contents),
        selectinload(WorkflowTemplate.tasks).selectinload(
            WorkflowTemplateTask.attachments
        ),
    )


def list_templates(db: Session) -> list[WorkflowTemplate]:
    rows = db.execute(
        _template_query().order_by(WorkflowTemplate.sort_order.asc(), WorkflowTemplate.id.asc())
    ).scalars()
    return list(rows.unique())


def get_template_row(db: Session, template_id: int) -> WorkflowTemplate | None:
    return (
        db.execute(_template_query().where(WorkflowTemplate.id == template_id))
        .scalars()
        .unique()
        .first()
    )


def get_template_by_key(db: Session, key: str) -> WorkflowTemplate | None:
    """按稳定键取模板（项目创建流程时用，快照源）。"""
    return (
        db.execute(_template_query().where(WorkflowTemplate.key == (key or "").strip()))
        .scalars()
        .unique()
        .first()
    )


def template_options(db: Session) -> list[dict[str, str]]:
    """模板元数据（P1 契约：只下发 key/kind/title，不下发节点正文）。"""
    return [
        {"key": template.key, "kind": template.kind, "title": template.title}
        for template in list_templates(db)
    ]


def ordered_tasks(template: WorkflowTemplate) -> list[WorkflowTemplateTask]:
    return sorted(template.tasks, key=lambda task: (task.sort_order, task.id or 0))


def serialize_template_row(template: WorkflowTemplate) -> dict[str, Any]:
    """模板列表项（不含节点正文）。"""
    return {
        "id": template.id,
        "key": template.key,
        "kind": template.kind,
        "title": template.title,
        "description": template.description,
        "sort_order": template.sort_order,
        "task_count": len(template.tasks),
    }


def serialize_template_detail(template: WorkflowTemplate) -> dict[str, Any]:
    from app.services.project_workflow_attachment_service import (
        serialize_attachment,
    )
    from app.services.project_workflow_service import serialize_content

    payload = serialize_template_row(template)
    payload["tasks"] = [
        {
            "id": task.id,
            "template_id": task.template_id,
            "title": task.title,
            "description": task.description,
            "sort_order": task.sort_order,
            "attachment_key": task.attachment_key,
            "duration_days": task.duration_days,
            "contents": [
                serialize_content(content)
                for content in sorted(
                    task.contents, key=lambda c: (c.sort_order, c.id or 0)
                )
            ],
            "attachments": [
                serialize_attachment(attachment)
                for attachment in sorted(task.attachments, key=lambda a: a.id or 0)
            ],
        }
        for task in ordered_tasks(template)
    ]
    return payload


# ---------------------------------------------------------------------------
# 模板写
# ---------------------------------------------------------------------------

def create_template(
    db: Session,
    *,
    kind: str,
    title: str,
    description: str | None = None,
    key: str | None = None,
    sort_order: int | None = None,
) -> WorkflowTemplate:
    _validate_kind(kind)
    clean_title = (title or "").strip()
    if not clean_title:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail="模板标题不能为空"
        )
    resolved_key = (key or "").strip() or _template_key_from_title(clean_title)
    if len(resolved_key) > KEY_MAX_LENGTH:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"模板键不能超过 {KEY_MAX_LENGTH} 个字符",
        )
    if _key_exists(db, resolved_key):
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail="模板键已存在"
        )
    if sort_order is None:
        sort_order = (
            db.execute(select(func.coalesce(func.max(WorkflowTemplate.sort_order), -1)))
            .scalar()
            or 0
        ) + 1

    template = WorkflowTemplate(
        key=resolved_key,
        kind=kind,
        title=clean_title[:160],
        description=description,
        sort_order=sort_order,
    )
    db.add(template)
    db.commit()
    refreshed = get_template_row(db, template.id)
    assert refreshed is not None
    return refreshed


def update_template(
    db: Session,
    template: WorkflowTemplate,
    *,
    title: str | None = None,
    description: str | None = None,
    sort_order: int | None = None,
    description_provided: bool = False,
) -> WorkflowTemplate:
    """``key`` 与 ``kind`` 不可改：key 是项目的溯源引用，kind 是语义约束。"""
    if title is not None:
        clean_title = title.strip()
        if not clean_title:
            raise HTTPException(
                status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="模板标题不能为空",
            )
        template.title = clean_title[:160]
    if description_provided:
        template.description = description
    if sort_order is not None:
        template.sort_order = sort_order
    db.commit()
    refreshed = get_template_row(db, template.id)
    assert refreshed is not None
    return refreshed


def delete_template(db: Session, template: WorkflowTemplate) -> None:
    """硬删模板（级联节点/内容/附件记录）。

    已创建项目的节点是快照，``project_workflows.template_key`` 只是普通字符串，
    不引用本表，因此删除模板不会影响任何已有项目的进度。
    R2 对象由调用方（endpoint）按引用计数决定是否删除。
    """
    db.delete(template)
    db.commit()


def copy_template(
    db: Session,
    source: WorkflowTemplate,
    *,
    title: str | None = None,
    key: str | None = None,
) -> WorkflowTemplate:
    """复制模板：节点、内容、附件**记录**全部复制，附件共享同一个 R2 对象。"""
    new_title = (title or "").strip() or f"{source.title}（副本）"
    resolved_key = (key or "").strip() or _template_key_from_title(new_title)
    if len(resolved_key) > KEY_MAX_LENGTH:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"模板键不能超过 {KEY_MAX_LENGTH} 个字符",
        )
    if _key_exists(db, resolved_key):
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail="模板键已存在"
        )

    clone = WorkflowTemplate(
        key=resolved_key,
        kind=source.kind,
        title=new_title[:160],
        description=source.description,
        sort_order=(source.sort_order or 0) + 1,
    )
    for task in ordered_tasks(source):
        cloned_task = WorkflowTemplateTask(
            title=task.title,
            description=task.description,
            sort_order=task.sort_order,
            attachment_key=task.attachment_key,
            duration_days=task.duration_days,
        )
        for content in sorted(task.contents, key=lambda c: (c.sort_order, c.id or 0)):
            cloned_task.contents.append(
                WorkflowTemplateTaskContent(
                    title=content.title,
                    body=content.body,
                    sort_order=content.sort_order,
                )
            )
        for attachment in sorted(task.attachments, key=lambda a: a.id or 0):
            cloned_task.attachments.append(
                WorkflowTemplateTaskAttachment(
                    r2_key=attachment.r2_key,
                    filename=attachment.filename,
                    content_type=attachment.content_type,
                    file_size=attachment.file_size,
                    uploader=attachment.uploader,
                )
            )
        clone.tasks.append(cloned_task)

    db.add(clone)
    db.commit()
    refreshed = get_template_row(db, clone.id)
    assert refreshed is not None
    return refreshed


# ---------------------------------------------------------------------------
# 模板节点写
# ---------------------------------------------------------------------------

def get_template_task(db: Session, task_id: int) -> WorkflowTemplateTask | None:
    return (
        db.execute(
            select(WorkflowTemplateTask)
            .where(WorkflowTemplateTask.id == task_id)
            .options(
                selectinload(WorkflowTemplateTask.contents),
                selectinload(WorkflowTemplateTask.attachments),
            )
        )
        .scalars()
        .first()
    )


def _next_sort_order(db: Session, template_id: int) -> int:
    current = db.execute(
        select(func.coalesce(func.max(WorkflowTemplateTask.sort_order), -1)).where(
            WorkflowTemplateTask.template_id == template_id
        )
    ).scalar()
    return int(current if current is not None else -1) + 1


def create_template_task(
    db: Session,
    template: WorkflowTemplate,
    *,
    title: str,
    description: str | None = None,
    attachment_key: str | None = None,
    duration_days: int | None = None,
    sort_order: int | None = None,
) -> WorkflowTemplateTask:
    clean_title = (title or "").strip()
    if not clean_title:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail="节点标题不能为空"
        )
    task = WorkflowTemplateTask(
        template_id=template.id,
        title=clean_title[:160],
        description=description,
        attachment_key=_normalize_attachment_key(attachment_key),
        duration_days=_validate_duration(duration_days),
        sort_order=(
            _next_sort_order(db, template.id) if sort_order is None else sort_order
        ),
    )
    db.add(task)
    db.flush()
    if sort_order is not None:
        _resequence(db, template.id, insert_at=sort_order, inserted_id=task.id)
    db.commit()
    refreshed = get_template_task(db, task.id)
    assert refreshed is not None
    return refreshed


def _resequence(
    db: Session,
    template_id: int,
    *,
    insert_at: int,
    inserted_id: int,
) -> None:
    """把 ``inserted_id`` 放到 ``insert_at`` 位置，其余节点顺移，序号重写为 0..n-1。"""
    rows = list(
        db.execute(
            select(WorkflowTemplateTask)
            .where(WorkflowTemplateTask.template_id == template_id)
            .order_by(WorkflowTemplateTask.sort_order.asc(), WorkflowTemplateTask.id.asc())
        ).scalars()
    )
    ordered = [row for row in rows if row.id != inserted_id]
    position = max(0, min(insert_at, len(ordered)))
    ordered.insert(position, next(row for row in rows if row.id == inserted_id))
    for index, row in enumerate(ordered):
        row.sort_order = index
    db.flush()


def update_template_task(
    db: Session,
    task: WorkflowTemplateTask,
    *,
    title: str | None = None,
    description: str | None = None,
    attachment_key: str | None = None,
    duration_days: int | None = None,
    description_provided: bool = False,
    attachment_key_provided: bool = False,
    duration_days_provided: bool = False,
) -> WorkflowTemplateTask:
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
        task.attachment_key = _normalize_attachment_key(attachment_key)
    if duration_days_provided:
        task.duration_days = _validate_duration(duration_days)
    db.commit()
    refreshed = get_template_task(db, task.id)
    assert refreshed is not None
    return refreshed


def delete_template_task(db: Session, task: WorkflowTemplateTask) -> None:
    template_id = task.template_id
    db.delete(task)
    db.flush()
    _reorder_to_dense(db, template_id)
    db.commit()


def _reorder_to_dense(db: Session, template_id: int) -> None:
    rows = list(
        db.execute(
            select(WorkflowTemplateTask)
            .where(WorkflowTemplateTask.template_id == template_id)
            .order_by(WorkflowTemplateTask.sort_order.asc(), WorkflowTemplateTask.id.asc())
        ).scalars()
    )
    for index, row in enumerate(rows):
        row.sort_order = index
    db.flush()


def reorder_template_tasks(
    db: Session, template: WorkflowTemplate, task_ids: Sequence[int]
) -> WorkflowTemplate:
    rows = list(
        db.execute(
            select(WorkflowTemplateTask).where(
                WorkflowTemplateTask.template_id == template.id
            )
        ).scalars()
    )
    existing = {int(row.id) for row in rows}
    requested = [int(value) for value in task_ids]
    if sorted(existing) != sorted(requested):
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="排序列表必须恰好包含该模板的全部节点",
        )
    by_id = {int(row.id): row for row in rows}
    for index, task_id in enumerate(requested):
        by_id[task_id].sort_order = index
    db.commit()
    refreshed = get_template_row(db, template.id)
    assert refreshed is not None
    return refreshed


# ---------------------------------------------------------------------------
# 模板节点内容写
# ---------------------------------------------------------------------------

def get_template_content(
    db: Session, content_id: int
) -> WorkflowTemplateTaskContent | None:
    return db.get(WorkflowTemplateTaskContent, content_id)


def create_template_content(
    db: Session,
    task: WorkflowTemplateTask,
    *,
    body: str,
    title: str | None = None,
    sort_order: int | None = None,
) -> WorkflowTemplateTaskContent:
    if not (body or "").strip():
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail="内容正文不能为空"
        )
    if sort_order is None:
        current = db.execute(
            select(func.coalesce(func.max(WorkflowTemplateTaskContent.sort_order), -1)).where(
                WorkflowTemplateTaskContent.template_task_id == task.id
            )
        ).scalar()
        sort_order = int(current if current is not None else -1) + 1
    content = WorkflowTemplateTaskContent(
        template_task_id=task.id,
        title=(title or "").strip() or None,
        body=body,
        sort_order=sort_order,
    )
    db.add(content)
    db.commit()
    db.refresh(content)
    return content


def update_template_content(
    db: Session,
    content: WorkflowTemplateTaskContent,
    *,
    body: str | None = None,
    title: str | None = None,
    title_provided: bool = False,
) -> WorkflowTemplateTaskContent:
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
    db.refresh(content)
    return content


def delete_template_content(
    db: Session, content: WorkflowTemplateTaskContent
) -> None:
    task_id = content.template_task_id
    db.delete(content)
    db.flush()
    rows = list(
        db.execute(
            select(WorkflowTemplateTaskContent)
            .where(WorkflowTemplateTaskContent.template_task_id == task_id)
            .order_by(
                WorkflowTemplateTaskContent.sort_order.asc(),
                WorkflowTemplateTaskContent.id.asc(),
            )
        ).scalars()
    )
    for index, row in enumerate(rows):
        row.sort_order = index
    db.commit()
