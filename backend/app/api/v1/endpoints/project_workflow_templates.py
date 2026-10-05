"""流程模板管理 API（BLF-1237 / P2，**仅管理员**）。

模板与节点是数据库数据，管理员可增删改排序、可复制；模板节点的多条内容与附件也在这里维护。
P1 的只读目录 ``GET /project-workflows/templates`` 仍在 ``project_workflows`` 端点里，
形状不变（只下发 key/kind/title）。

权限：本文件所有路由都挂 ``require_admin``；非管理员一律 403（前端隐藏入口不算权限）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
    require_admin,
)
from app.core.config import Settings, get_settings
from app.schemas.project_workflow_template import (
    WorkflowTemplateCopy,
    WorkflowTemplateCreate,
    WorkflowTemplateDetail,
    WorkflowTemplateListResponse,
    WorkflowTemplateTaskCreate,
    WorkflowTemplateTaskOrderUpdate,
    WorkflowTemplateTaskUpdate,
    WorkflowTemplateContentCreate,
    WorkflowTemplateContentUpdate,
    WorkflowTemplateUpdate,
)
from app.services import project_workflow_template_service as template_service
from app.services.project_workflow_attachment_service import (
    delete_attachment_row,
    store_upload,
)

router = APIRouter(dependencies=[Depends(protected)])

# 模板附件在 R2 里的路径前缀（服务端固定值，绝不由用户输入拼路径）。
_TEMPLATE_SLUG = "project-launch-templates"


def _template_or_404(db: Session, template_id: int):
    template = template_service.get_template_row(db, template_id)
    if template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="模板不存在")
    return template


def _template_task_or_404(db: Session, task_id: int):
    task = template_service.get_template_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="节点不存在")
    return task


# ---------------------------------------------------------------------------
# 模板 CRUD
# ---------------------------------------------------------------------------

@router.get(
    "/project-workflows/admin/templates",
    response_model=WorkflowTemplateListResponse,
    dependencies=[Depends(require_admin)],
)
def list_admin_templates(
    db: Session = Depends(get_read_db_session),
) -> WorkflowTemplateListResponse:
    return WorkflowTemplateListResponse(
        templates=[
            template_service.serialize_template_row(template)
            for template in template_service.list_templates(db)
        ]
    )


@router.get(
    "/project-workflows/admin/templates/{template_id}",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def get_admin_template(
    template_id: int,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    template = _template_or_404(db, template_id)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))


@router.post(
    "/project-workflows/admin/templates",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def create_admin_template(
    payload: WorkflowTemplateCreate,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    template = template_service.create_template(
        db,
        kind=payload.kind,
        title=payload.title,
        description=payload.description,
        key=payload.key,
        sort_order=payload.sort_order,
    )
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))


@router.patch(
    "/project-workflows/admin/templates/{template_id}",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def update_admin_template(
    template_id: int,
    payload: WorkflowTemplateUpdate,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    template = _template_or_404(db, template_id)
    updated = template_service.update_template(
        db,
        template,
        title=payload.title,
        description=payload.description,
        sort_order=payload.sort_order,
        description_provided="description" in payload.model_fields_set,
    )
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(updated))


@router.delete(
    "/project-workflows/admin/templates/{template_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_admin)],
)
def delete_admin_template(
    template_id: int,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_primary_db_session),
) -> None:
    template = _template_or_404(db, template_id)
    # 先按引用计数处理附件对象，再删模板（行级联）。
    for task in template_service.ordered_tasks(template):
        for attachment in list(task.attachments):
            delete_attachment_row(db, attachment, settings=settings)
    template = _template_or_404(db, template_id)
    template_service.delete_template(db, template)


@router.post(
    "/project-workflows/admin/templates/{template_id}/copy",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def copy_admin_template(
    template_id: int,
    payload: WorkflowTemplateCopy,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    template = _template_or_404(db, template_id)
    clone = template_service.copy_template(
        db, template, title=payload.title, key=payload.key
    )
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(clone))


# ---------------------------------------------------------------------------
# 模板节点
# ---------------------------------------------------------------------------

@router.post(
    "/project-workflows/admin/templates/{template_id}/tasks",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def create_admin_template_task(
    template_id: int,
    payload: WorkflowTemplateTaskCreate,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    template = _template_or_404(db, template_id)
    template_service.create_template_task(
        db,
        template,
        title=payload.title,
        description=payload.description,
        attachment_key=payload.attachment_key,
        duration_days=payload.duration_days,
        sort_order=payload.sort_order,
    )
    template = _template_or_404(db, template_id)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))


@router.patch(
    "/project-workflows/admin/template-tasks/{task_id}",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def update_admin_template_task(
    task_id: int,
    payload: WorkflowTemplateTaskUpdate,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    task = _template_task_or_404(db, task_id)
    template_service.update_template_task(
        db,
        task,
        title=payload.title,
        description=payload.description,
        attachment_key=payload.attachment_key,
        duration_days=payload.duration_days,
        description_provided="description" in payload.model_fields_set,
        attachment_key_provided="attachment_key" in payload.model_fields_set,
        duration_days_provided="duration_days" in payload.model_fields_set,
    )
    template = _template_or_404(db, task.template_id)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))


@router.delete(
    "/project-workflows/admin/template-tasks/{task_id}",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def delete_admin_template_task(
    task_id: int,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    task = _template_task_or_404(db, task_id)
    template_id = task.template_id
    for attachment in list(task.attachments):
        delete_attachment_row(db, attachment, settings=settings)
    task = _template_task_or_404(db, task_id)
    template_service.delete_template_task(db, task)
    template = _template_or_404(db, template_id)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))


@router.put(
    "/project-workflows/admin/templates/{template_id}/tasks/order",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def reorder_admin_template_tasks(
    template_id: int,
    payload: WorkflowTemplateTaskOrderUpdate,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    template = _template_or_404(db, template_id)
    updated = template_service.reorder_template_tasks(db, template, payload.task_ids)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(updated))


# ---------------------------------------------------------------------------
# 模板节点内容（多条）
# ---------------------------------------------------------------------------

@router.post(
    "/project-workflows/admin/template-tasks/{task_id}/contents",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def create_admin_template_content(
    task_id: int,
    payload: WorkflowTemplateContentCreate,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    task = _template_task_or_404(db, task_id)
    template_service.create_template_content(
        db,
        task,
        body=payload.body,
        title=payload.title,
        sort_order=payload.sort_order,
    )
    template = _template_or_404(db, task.template_id)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))


@router.patch(
    "/project-workflows/admin/template-task-contents/{content_id}",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def update_admin_template_content(
    content_id: int,
    payload: WorkflowTemplateContentUpdate,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    content = template_service.get_template_content(db, content_id)
    if content is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="内容不存在")
    task_id = content.template_task_id
    template_service.update_template_content(
        db,
        content,
        body=payload.body,
        title=payload.title,
        title_provided="title" in payload.model_fields_set,
    )
    task = _template_task_or_404(db, task_id)
    template = _template_or_404(db, task.template_id)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))


@router.delete(
    "/project-workflows/admin/template-task-contents/{content_id}",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def delete_admin_template_content(
    content_id: int,
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    content = template_service.get_template_content(db, content_id)
    if content is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="内容不存在")
    task_id = content.template_task_id
    template_service.delete_template_content(db, content)
    task = _template_task_or_404(db, task_id)
    template = _template_or_404(db, task.template_id)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))


# ---------------------------------------------------------------------------
# 模板节点附件
# ---------------------------------------------------------------------------

@router.post(
    "/project-workflows/admin/template-tasks/{task_id}/attachments",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def upload_admin_template_attachment(
    task_id: int,
    file: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    from app.models.project_workflow_template import WorkflowTemplateTaskAttachment

    task = _template_task_or_404(db, task_id)
    stored = store_upload(
        file,
        settings=settings,
        project_slug=_TEMPLATE_SLUG,
        file_type=f"template-task-{task.id}",
    )
    db.add(
        WorkflowTemplateTaskAttachment(
            template_task_id=task.id,
            uploader=operator,
            **stored,
        )
    )
    db.commit()
    template = _template_or_404(db, task.template_id)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))


@router.delete(
    "/project-workflows/admin/template-task-attachments/{attachment_id}",
    response_model=WorkflowTemplateDetail,
    dependencies=[Depends(require_admin)],
)
def delete_admin_template_attachment(
    attachment_id: int,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_primary_db_session),
) -> WorkflowTemplateDetail:
    from app.models.project_workflow_template import WorkflowTemplateTaskAttachment

    attachment = db.get(WorkflowTemplateTaskAttachment, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="附件不存在")
    task_id = attachment.template_task_id
    delete_attachment_row(db, attachment, settings=settings)
    task = _template_task_or_404(db, task_id)
    template = _template_or_404(db, task.template_id)
    return WorkflowTemplateDetail(**template_service.serialize_template_detail(template))
