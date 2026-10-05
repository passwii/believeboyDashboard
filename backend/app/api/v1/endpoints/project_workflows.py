"""项目启动台（店铺启动 / 产品开发）流程 API（BLF-1234 / P2 BLF-1237）。

所有路由都在 ``protected`` 之下，且每个项目级读写在服务调用前用
``project_service.ensure_project_access`` 校验项目权限。对外文档走白名单键 → 服务器固定路径，
绝不由用户输入拼路径；节点附件走受控 R2 key + 服务端流式下载（每次请求都过鉴权）。

权限分界（P2）：
- P1 的 ``PATCH /project-workflow-tasks/{task_id}`` 仍**只收 status**，非管理员可用（契约一字不改）。
- 项目内节点/内容的增删改排序、流程标题与排期锚点 → ``require_admin``。
- 节点附件的上传/下载/删除 → 项目权限即可（内务回传是执行性工作）。
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
    require_admin,
)
from app.core.config import Settings, get_settings
from app.models.project_workflow import ProjectWorkflow, ProjectWorkflowTask
from app.schemas.project_workflow import (
    ProjectWorkflowContentCreate,
    ProjectWorkflowContentUpdate,
    ProjectWorkflowCreate,
    ProjectWorkflowDefinitionUpdate,
    ProjectWorkflowItem,
    ProjectWorkflowListResponse,
    ProjectWorkflowSummaryItem,
    ProjectWorkflowSummaryResponse,
    ProjectWorkflowSummaryWorkflow,
    ProjectWorkflowTaskCreate,
    ProjectWorkflowTaskDefinitionUpdate,
    ProjectWorkflowTaskOrderUpdate,
    ProjectWorkflowTaskUpdate,
    ProjectWorkflowTemplatesResponse,
)
from app.services import (
    project_service,
    project_workflow_service as workflow_service,
)
from app.services.project_workflow_attachment_service import (
    delete_attachment_row,
    store_upload,
)
from app.services.project_workflow_templates import (
    DOCUMENT_KEY_AMAZON_REGISTRATION_FORM,
    DOCUMENT_KEY_WORLDFIRST_REGISTRATION_GUIDE,
)

router = APIRouter(dependencies=[Depends(protected)])

_DOCUMENTS_DIR = (
    Path(__file__).resolve().parents[3] / "resources" / "project_launch_documents"
)

# 严格白名单：只有这两个键可下载，路径与文件名都是服务器固定值。
_ALLOWED_DOCUMENTS: dict[str, dict[str, str]] = {
    DOCUMENT_KEY_AMAZON_REGISTRATION_FORM: {
        "path": "亚马逊_注册信息收集表.xlsx",
        "filename": "亚马逊_注册信息收集表.xlsx",
        "media_type": (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
    },
    DOCUMENT_KEY_WORLDFIRST_REGISTRATION_GUIDE: {
        "path": "万里汇海外收款注册流程.pdf",
        "filename": "万里汇海外收款注册流程.pdf",
        "media_type": "application/pdf",
    },
}

# 项目节点附件在 R2 里的路径前缀（服务端固定值）。
_PROJECT_ATTACHMENT_SLUG = "project-launch"


# ---------------------------------------------------------------------------
# 内部工具
# ---------------------------------------------------------------------------

def _ensure_project_access(
    db: Session, project_id: int, operator: str | None, is_admin: bool
) -> None:
    project_service.ensure_project_access(
        db, project_id, operator=operator, is_admin=bool(is_admin)
    )


def _workflow_in_project_or_404(
    db: Session, project_id: int, workflow_id: int
) -> ProjectWorkflow:
    workflow = workflow_service.get_workflow(db, workflow_id)
    if workflow is None or int(workflow.project_id) != int(project_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="流程不存在"
        )
    return workflow


def _task_in_project_or_404(
    db: Session, project_id: int, task_id: int
) -> tuple[ProjectWorkflowTask, ProjectWorkflow]:
    found = workflow_service.get_task_with_workflow(db, task_id)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    task, workflow = found
    if int(workflow.project_id) != int(project_id):
        # 跨项目一律 404，不泄露存在性（防枚举）。
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    return task, workflow


def _attachment_in_project_or_404(db: Session, project_id: int, attachment_id: int):
    from app.models.project_workflow import ProjectWorkflowTaskAttachment

    attachment = db.get(ProjectWorkflowTaskAttachment, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="附件不存在")
    task = workflow_service.get_workflow_task(db, attachment.task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="附件不存在")
    workflow = workflow_service.get_workflow(db, task.workflow_id)
    if workflow is None or int(workflow.project_id) != int(project_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="附件不存在")
    return attachment, task, workflow


# ---------------------------------------------------------------------------
# P1 契约（形状不变）
# ---------------------------------------------------------------------------

@router.get("/project-workflows/templates", response_model=ProjectWorkflowTemplatesResponse)
def list_project_workflow_templates(
    db: Session = Depends(get_read_db_session),
) -> ProjectWorkflowTemplatesResponse:
    """只暴露模板元数据（key/kind/title），不下发模板任务正文。"""
    return ProjectWorkflowTemplatesResponse(
        templates=workflow_service.template_options(db)
    )


@router.get("/project-workflows/summary", response_model=ProjectWorkflowSummaryResponse)
def get_project_workflow_summary(
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowSummaryResponse:
    """所有可见项目的流程概要（一次批量查询，无逐项目 fan-out）。"""
    projects = project_service.list_project_items(
        db, operator=operator, is_admin=bool(is_admin)
    )
    project_ids = [int(project.id) for project in projects]
    summaries = workflow_service.bulk_workflow_summaries(db, project_ids)
    schedules = workflow_service.bulk_project_schedules(db, project_ids)
    return ProjectWorkflowSummaryResponse(
        projects=[
            ProjectWorkflowSummaryItem(
                project_id=int(project.id),
                workflows=[
                    ProjectWorkflowSummaryWorkflow(**item)
                    for item in summaries.get(int(project.id), [])
                ],
                **schedules.get(int(project.id), {}),
            )
            for project in projects
        ]
    )


@router.get(
    "/projects/{project_id}/workflows", response_model=ProjectWorkflowListResponse
)
def list_project_workflows(
    project_id: int,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowListResponse:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    workflows = workflow_service.list_workflows(db, project_id)
    return ProjectWorkflowListResponse(
        project_id=project_id,
        workflows=[
            ProjectWorkflowItem(**workflow_service.serialize_workflow(row))
            for row in workflows
        ],
    )


@router.post(
    "/projects/{project_id}/workflows",
    response_model=ProjectWorkflowItem,
)
def create_project_workflow(
    project_id: int,
    payload: ProjectWorkflowCreate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    workflow, _created = workflow_service.create_workflow(
        db,
        project_id=project_id,
        kind=payload.kind,
        template_key=payload.template_key,
        title=payload.title,
        start_date=payload.start_date,
    )
    return ProjectWorkflowItem(
        **workflow_service.serialize_workflow(workflow)
    )


@router.patch(
    "/project-workflow-tasks/{task_id}", response_model=ProjectWorkflowItem
)
def update_project_workflow_task(
    task_id: int,
    payload: ProjectWorkflowTaskUpdate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    """P1 契约：只接受 ``{status}``，非管理员 + 有项目权限仍可用。"""
    found = workflow_service.get_task_with_workflow(db, task_id)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    task, workflow = found
    _ensure_project_access(db, workflow.project_id, operator, bool(is_admin))
    updated = workflow_service.update_task_status(db, task, payload.status)
    return ProjectWorkflowItem(
        **workflow_service.serialize_workflow(updated)
    )


@router.get("/projects/{project_id}/workflows/documents/{document_key}")
def download_project_workflow_document(
    project_id: int,
    document_key: str,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> FileResponse:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    entry = _ALLOWED_DOCUMENTS.get(document_key)
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文档不存在")
    path = _DOCUMENTS_DIR / entry["path"]
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文档不存在")
    return FileResponse(
        path=str(path), filename=entry["filename"], media_type=entry["media_type"]
    )


# ---------------------------------------------------------------------------
# P2：流程定义与项目内节点（仅管理员）
# ---------------------------------------------------------------------------

@router.patch(
    "/project-workflows/{workflow_id}",
    response_model=ProjectWorkflowItem,
    dependencies=[Depends(require_admin)],
)
def update_project_workflow_definition(
    workflow_id: int,
    payload: ProjectWorkflowDefinitionUpdate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    workflow = workflow_service.get_workflow(db, workflow_id)
    if workflow is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="流程不存在")
    _ensure_project_access(db, workflow.project_id, operator, bool(is_admin))
    updated = workflow_service.update_workflow_definition(
        db,
        workflow,
        title=payload.title,
        start_date=payload.start_date,
        start_date_provided="start_date" in payload.model_fields_set,
    )
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(updated))


@router.post(
    "/projects/{project_id}/workflows/{workflow_id}/tasks",
    response_model=ProjectWorkflowItem,
    dependencies=[Depends(require_admin)],
)
def create_project_workflow_task(
    project_id: int,
    workflow_id: int,
    payload: ProjectWorkflowTaskCreate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    workflow = _workflow_in_project_or_404(db, project_id, workflow_id)
    updated = workflow_service.create_project_task(
        db,
        workflow,
        title=payload.title,
        description=payload.description,
        attachment_key=payload.attachment_key,
        duration_days=payload.duration_days,
        sort_order=payload.sort_order,
    )
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(updated))


@router.patch(
    "/project-workflow-tasks/{task_id}/definition",
    response_model=ProjectWorkflowItem,
    dependencies=[Depends(require_admin)],
)
def update_project_workflow_task_definition(
    task_id: int,
    payload: ProjectWorkflowTaskDefinitionUpdate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    found = workflow_service.get_task_with_workflow(db, task_id)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    task, workflow = found
    _ensure_project_access(db, workflow.project_id, operator, bool(is_admin))
    updated = workflow_service.update_project_task_definition(
        db,
        workflow,
        task,
        title=payload.title,
        description=payload.description,
        attachment_key=payload.attachment_key,
        duration_days=payload.duration_days,
        start_date=payload.start_date,
        end_date=payload.end_date,
        description_provided="description" in payload.model_fields_set,
        attachment_key_provided="attachment_key" in payload.model_fields_set,
        duration_days_provided="duration_days" in payload.model_fields_set,
        start_date_provided="start_date" in payload.model_fields_set,
        end_date_provided="end_date" in payload.model_fields_set,
    )
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(updated))


@router.delete(
    "/project-workflow-tasks/{task_id}",
    response_model=ProjectWorkflowItem,
    dependencies=[Depends(require_admin)],
)
def delete_project_workflow_task(
    task_id: int,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    found = workflow_service.get_task_with_workflow(db, task_id)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    task, workflow = found
    _ensure_project_access(db, workflow.project_id, operator, bool(is_admin))
    for attachment in list(task.attachments):
        delete_attachment_row(db, attachment, settings=settings)
    found = workflow_service.get_task_with_workflow(db, task_id)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    task, workflow = found
    updated = workflow_service.delete_project_task(db, workflow, task)
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(updated))


@router.put(
    "/projects/{project_id}/workflows/{workflow_id}/tasks/order",
    response_model=ProjectWorkflowItem,
    dependencies=[Depends(require_admin)],
)
def reorder_project_workflow_tasks(
    project_id: int,
    workflow_id: int,
    payload: ProjectWorkflowTaskOrderUpdate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    workflow = _workflow_in_project_or_404(db, project_id, workflow_id)
    updated = workflow_service.reorder_project_tasks(db, workflow, payload.task_ids)
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(updated))


# ---------------------------------------------------------------------------
# P2：项目节点内容（仅管理员）
# ---------------------------------------------------------------------------

@router.post(
    "/projects/{project_id}/workflow-tasks/{task_id}/contents",
    response_model=ProjectWorkflowItem,
    dependencies=[Depends(require_admin)],
)
def create_project_workflow_content(
    project_id: int,
    task_id: int,
    payload: ProjectWorkflowContentCreate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    task, _workflow = _task_in_project_or_404(db, project_id, task_id)
    updated = workflow_service.create_project_content(
        db, task, body=payload.body, title=payload.title, sort_order=payload.sort_order
    )
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(updated))


@router.patch(
    "/project-workflow-task-contents/{content_id}",
    response_model=ProjectWorkflowItem,
    dependencies=[Depends(require_admin)],
)
def update_project_workflow_content(
    content_id: int,
    payload: ProjectWorkflowContentUpdate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    content, task, workflow = _content_in_project_or_404_for_update(
        db, content_id, operator, bool(is_admin)
    )
    updated = workflow_service.update_project_content(
        db,
        content,
        body=payload.body,
        title=payload.title,
        title_provided="title" in payload.model_fields_set,
    )
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(updated))


@router.delete(
    "/project-workflow-task-contents/{content_id}",
    response_model=ProjectWorkflowItem,
    dependencies=[Depends(require_admin)],
)
def delete_project_workflow_content(
    content_id: int,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    content, _task, _workflow = _content_in_project_or_404_for_update(
        db, content_id, operator, bool(is_admin)
    )
    updated = workflow_service.delete_project_content(db, content)
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(updated))


def _content_in_project_or_404_for_update(
    db: Session, content_id: int, operator: str | None, is_admin: bool
):
    """内容 id 不带项目路径，因此先解析所属项目再做权限校验。"""
    content = workflow_service.get_project_content(db, content_id)
    if content is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="内容不存在")
    task = workflow_service.get_workflow_task(db, content.task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="内容不存在")
    workflow = workflow_service.get_workflow(db, task.workflow_id)
    if workflow is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="内容不存在")
    _ensure_project_access(db, workflow.project_id, operator, is_admin)
    return content, task, workflow


# ---------------------------------------------------------------------------
# P2：项目节点附件（项目权限即可 —— 内务回传）
# ---------------------------------------------------------------------------

@router.post(
    "/projects/{project_id}/workflow-tasks/{task_id}/attachments",
    response_model=ProjectWorkflowItem,
)
def upload_project_workflow_attachment(
    project_id: int,
    task_id: int,
    file: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    from app.models.project_workflow import ProjectWorkflowTaskAttachment

    _ensure_project_access(db, project_id, operator, bool(is_admin))
    task, workflow = _task_in_project_or_404(db, project_id, task_id)
    stored = store_upload(
        file,
        settings=settings,
        project_slug=f"{_PROJECT_ATTACHMENT_SLUG}-{int(project_id)}",
        file_type=f"task-{int(task.id)}",
    )
    db.add(
        ProjectWorkflowTaskAttachment(
            task_id=task.id,
            uploader=operator,
            origin="upload",
            **stored,
        )
    )
    db.commit()
    refreshed = workflow_service.get_workflow(db, workflow.id)
    assert refreshed is not None
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(refreshed))


@router.get("/projects/{project_id}/workflow-task-attachments/{attachment_id}/download")
def download_project_workflow_attachment(
    project_id: int,
    attachment_id: int,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    """鉴权 + 项目权限校验后，服务端从 R2 流式返回（不下发公开 URL / presigned URL）。"""
    from app.services.r2_service import check_file_exists, iter_file_from_r2

    _ensure_project_access(db, project_id, operator, bool(is_admin))
    attachment, _task, _workflow = _attachment_in_project_or_404(
        db, project_id, attachment_id
    )

    if not settings.r2_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud storage is not configured. Please contact administrator.",
        )
    if not check_file_exists(settings, attachment.r2_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="附件不存在")

    encoded = quote(attachment.filename)
    headers = {
        "Content-Length": str(attachment.file_size),
        "Content-Disposition": (
            f"attachment; filename=\"attachment\"; filename*=utf-8''{encoded}"
        ),
    }
    return StreamingResponse(
        iter_file_from_r2(settings, attachment.r2_key),
        media_type=attachment.content_type,
        headers=headers,
    )


@router.delete(
    "/projects/{project_id}/workflow-task-attachments/{attachment_id}",
    response_model=ProjectWorkflowItem,
)
def delete_project_workflow_attachment(
    project_id: int,
    attachment_id: int,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ProjectWorkflowItem:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    attachment, _task, workflow = _attachment_in_project_or_404(
        db, project_id, attachment_id
    )
    delete_attachment_row(db, attachment, settings=settings)
    refreshed = workflow_service.get_workflow(db, workflow.id)
    assert refreshed is not None
    return ProjectWorkflowItem(**workflow_service.serialize_workflow(refreshed))
