"""项目启动台（店铺启动 / 产品开发）流程 API（BLF-1234）。

所有路由都在 ``protected`` 之下，且每个项目级读写在服务调用前用
``project_service.ensure_project_access`` 校验项目权限。
对外文档走白名单键 → 服务器固定路径，绝不拼接用户输入。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.schemas.project_workflow import (
    ProjectWorkflowCreate,
    ProjectWorkflowItem,
    ProjectWorkflowListResponse,
    ProjectWorkflowSummaryItem,
    ProjectWorkflowSummaryResponse,
    ProjectWorkflowSummaryWorkflow,
    ProjectWorkflowTaskUpdate,
    ProjectWorkflowTemplatesResponse,
)
from app.services import project_service, project_workflow_service
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


@router.get("/project-workflows/templates", response_model=ProjectWorkflowTemplatesResponse)
def list_project_workflow_templates() -> ProjectWorkflowTemplatesResponse:
    """只暴露模板元数据（key/kind/title），不下发模板任务正文。"""
    return ProjectWorkflowTemplatesResponse(
        templates=project_workflow_service.template_options()
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
    summaries = project_workflow_service.bulk_workflow_summaries(
        db, [int(project.id) for project in projects]
    )
    return ProjectWorkflowSummaryResponse(
        projects=[
            ProjectWorkflowSummaryItem(
                project_id=int(project.id),
                workflows=[
                    ProjectWorkflowSummaryWorkflow(**item)
                    for item in summaries.get(int(project.id), [])
                ],
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
    project_service.ensure_project_access(
        db, project_id, operator=operator, is_admin=bool(is_admin)
    )
    workflows = project_workflow_service.list_workflows(db, project_id)
    return ProjectWorkflowListResponse(
        project_id=project_id,
        workflows=[
            ProjectWorkflowItem(**project_workflow_service.serialize_workflow(row))
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
    project_service.ensure_project_access(
        db, project_id, operator=operator, is_admin=bool(is_admin)
    )
    workflow, _created = project_workflow_service.create_workflow(
        db,
        project_id=project_id,
        kind=payload.kind,
        template_key=payload.template_key,
        title=payload.title,
    )
    return ProjectWorkflowItem(
        **project_workflow_service.serialize_workflow(workflow)
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
    found = project_workflow_service.get_task_with_workflow(db, task_id)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
    task, workflow = found
    project_service.ensure_project_access(
        db, workflow.project_id, operator=operator, is_admin=bool(is_admin)
    )
    updated = project_workflow_service.update_task_status(db, task, payload.status)
    return ProjectWorkflowItem(
        **project_workflow_service.serialize_workflow(updated)
    )


@router.get("/projects/{project_id}/workflows/documents/{document_key}")
def download_project_workflow_document(
    project_id: int,
    document_key: str,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> FileResponse:
    project_service.ensure_project_access(
        db, project_id, operator=operator, is_admin=bool(is_admin)
    )
    entry = _ALLOWED_DOCUMENTS.get(document_key)
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文档不存在")
    path = _DOCUMENTS_DIR / entry["path"]
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文档不存在")
    return FileResponse(
        path=str(path), filename=entry["filename"], media_type=entry["media_type"]
    )
