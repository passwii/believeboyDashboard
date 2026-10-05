"""项目节点附件 API 测试（BLF-1237 / P2）。

覆盖：上传（R2，字段完整、key 前缀受控）、列表（内嵌在流程详情）、下载（服务端流式 +
RFC 5987 原始文件名）、删除（引用计数决定是否删 R2 对象）、模板附件副本共享对象、
跨项目/无权限/类型/大小/R2 未配置等错误语义。

R2 全部打桩（不触碰真实桶），沿用仓库既有写法：
``patch("app.services.r2_service.upload_bytes_to_r2")`` + ``PropertyMock(r2_enabled=True)``。
运行需要独立测试库（``backend/.env.test``），否则整套跳过。
"""

from __future__ import annotations

import uuid
from unittest.mock import PropertyMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text

from app.main import app
from app.models.project import Project
from app.models.project_workflow import (
    ProjectWorkflow,
    ProjectWorkflowTask,
    ProjectWorkflowTaskAttachment,
)
from app.services.r2_service import R2DeleteResult

BASE = "/api/v1"
ADMIN = f"{BASE}/project-workflows/admin"
STORE_LAUNCH = "store-launch-v1"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_factory(db_session):
    created: list[int] = []

    def _create(*, project_operator: str | None = None) -> int:
        project = Project(
            project_name=f"BLF1237-{uuid.uuid4().hex[:8]}",
            sort_order=1,
            project_operator=project_operator,
        )
        db_session.add(project)
        db_session.commit()
        created.append(int(project.id))
        return int(project.id)

    yield _create

    for project_id in created:
        workflow_ids = [
            int(row)
            for row in db_session.execute(
                select(ProjectWorkflow.id).where(ProjectWorkflow.project_id == project_id)
            ).scalars()
        ]
        if workflow_ids:
            db_session.execute(
                delete(ProjectWorkflowTask).where(
                    ProjectWorkflowTask.workflow_id.in_(workflow_ids)
                )
            )
            db_session.execute(
                delete(ProjectWorkflow).where(ProjectWorkflow.id.in_(workflow_ids))
            )
        db_session.execute(delete(Project).where(Project.id == project_id))
    db_session.commit()


def _create_workflow(client, project_id, headers, **overrides):
    payload = {"kind": "store_launch", "template_key": STORE_LAUNCH, **overrides}
    return client.post(
        f"{BASE}/projects/{project_id}/workflows", json=payload, headers=headers
    )


def _r2_patches(settings, *, exists=True, delete_ok=True, delete_calls=None):
    """Patch every R2 boundary the attachment service touches."""

    def _upload(_settings, _data, stored_name, project_slug, file_type, _content_type):
        return {
            "key": f"{project_slug}/{file_type}/{stored_name}",
            "url": "https://r2.example/mock",
            "bucket": "mock",
            "size": 0,
        }

    def _iter(_settings, _key, chunk_size=1024 * 1024):
        yield b"attachment-bytes"

    def _delete(_settings, key):
        if delete_calls is not None:
            delete_calls.append(key)
        if delete_ok:
            return R2DeleteResult(success=True, key=key)
        return R2DeleteResult(
            success=False, key=key, error_class="ClientError", error_message="boom"
        )

    return [
        patch("app.services.r2_service.upload_bytes_to_r2", side_effect=_upload),
        patch("app.services.r2_service.check_file_exists", return_value=exists),
        patch("app.services.r2_service.iter_file_from_r2", side_effect=_iter),
        patch("app.services.r2_service.try_delete_file_from_r2", side_effect=_delete),
        patch.object(type(settings), "r2_enabled", new_callable=PropertyMock, return_value=True),
    ]


def _upload_attachment(client, project_id, task_id, headers, *, filename="注册表.xlsx"):
    return client.post(
        f"{BASE}/projects/{project_id}/workflow-tasks/{task_id}/attachments",
        files={
            "file": (
                filename,
                b"attachment-bytes",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
        headers=headers,
    )


def _stored_attachment(db_session, task_id):
    return (
        db_session.execute(
            select(ProjectWorkflowTaskAttachment)
            .where(ProjectWorkflowTaskAttachment.task_id == task_id)
            .order_by(ProjectWorkflowTaskAttachment.id.desc())
        )
        .scalars()
        .first()
    )


# ── 上传 / 列出 / 下载 / 删除 ───────────────────────────────────────────


def test_upload_lists_attachment_on_task(client, admin_headers, project_factory, settings):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        response = _upload_attachment(client, project_id, task_id, admin_headers)

    assert response.status_code == 200, response.text
    attachments = response.json()["tasks"][0]["attachments"]
    assert len(attachments) == 1
    assert attachments[0]["filename"] == "注册表.xlsx"
    assert attachments[0]["file_size"] == len(b"attachment-bytes")
    assert attachments[0]["origin"] == "upload"
    assert attachments[0]["uploader"]

    # 列表来自流程详情（不单独开端点）
    listed = client.get(f"{BASE}/projects/{project_id}/workflows", headers=admin_headers)
    assert listed.json()["workflows"][0]["tasks"][0]["attachments"][0]["id"] == attachments[0]["id"]


def test_uploaded_key_is_scoped_to_project_and_task(
    client, admin_headers, project_factory, settings, db_session
):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        _upload_attachment(client, project_id, task_id, admin_headers)

    row = _stored_attachment(db_session, task_id)
    assert row is not None
    assert row.r2_key.startswith(f"project-launch-{project_id}/task-{task_id}/")
    assert ".." not in row.r2_key


def test_download_streams_with_original_filename(
    client, admin_headers, project_factory, settings, db_session
):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        _upload_attachment(client, project_id, task_id, admin_headers)
    attachment_id = int(_stored_attachment(db_session, task_id).id)

    patches = _r2_patches(settings)
    with patches[1], patches[2], patches[4]:
        response = client.get(
            f"{BASE}/projects/{project_id}/workflow-task-attachments/{attachment_id}/download",
            headers=admin_headers,
        )

    assert response.status_code == 200, response.text
    assert response.content == b"attachment-bytes"
    disposition = response.headers["content-disposition"]
    assert "attachment;" in disposition
    assert "filename*=utf-8''" in disposition
    assert "%E6%B3%A8%E5%86%8C%E8%A1%A8.xlsx" in disposition


def test_delete_last_reference_removes_r2_object(
    client, admin_headers, project_factory, settings, db_session
):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        _upload_attachment(client, project_id, task_id, admin_headers)
    row = _stored_attachment(db_session, task_id)
    attachment_id, r2_key = int(row.id), row.r2_key

    delete_calls: list[str] = []
    patches = _r2_patches(settings, delete_calls=delete_calls)
    with patches[3]:
        response = client.delete(
            f"{BASE}/projects/{project_id}/workflow-task-attachments/{attachment_id}",
            headers=admin_headers,
        )

    assert response.status_code == 200, response.text
    assert response.json()["tasks"][0]["attachments"] == []
    assert delete_calls == [r2_key]


def test_r2_delete_failure_is_recorded(
    client, admin_headers, project_factory, settings, db_session
):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        _upload_attachment(client, project_id, task_id, admin_headers)
    row = _stored_attachment(db_session, task_id)
    attachment_id, r2_key = int(row.id), row.r2_key

    patches = _r2_patches(settings, delete_ok=False)
    with patches[3]:
        response = client.delete(
            f"{BASE}/projects/{project_id}/workflow-task-attachments/{attachment_id}",
            headers=admin_headers,
        )

    # 行删除是事实来源：R2 删除失败不阻塞，写入死信表等待重试。
    assert response.status_code == 200, response.text
    recorded = db_session.execute(
        text("select count(*) from r2_delete_failures where r2_key = :key"),
        {"key": r2_key},
    ).scalar()
    assert recorded == 1
    db_session.execute(
        text("delete from r2_delete_failures where r2_key = :key"), {"key": r2_key}
    )
    db_session.commit()


# ── 模板附件副本共享同一个 R2 对象 ──────────────────────────────────────


def _template_with_attachment(client, admin_headers, settings, db_session):
    template = client.post(
        f"{ADMIN}/templates",
        json={
            "kind": "product_development",
            "title": "附件复制模板",
            "key": f"blf1237-{uuid.uuid4().hex[:10]}",
        },
        headers=admin_headers,
    ).json()
    task = client.post(
        f"{ADMIN}/templates/{template['id']}/tasks",
        json={"title": "带附件的模板节点"},
        headers=admin_headers,
    ).json()["tasks"][0]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        uploaded = client.post(
            f"{ADMIN}/template-tasks/{task['id']}/attachments",
            files={"file": ("模板附件.pdf", b"attachment-bytes", "application/pdf")},
            headers=admin_headers,
        )
    assert uploaded.status_code == 200, uploaded.text
    template_attachment = uploaded.json()["tasks"][0]["attachments"][0]
    return template, task, template_attachment


def test_project_copy_shares_object_and_delete_keeps_it(
    client, admin_headers, project_factory, settings, db_session
):
    template, task, template_attachment = _template_with_attachment(
        client, admin_headers, settings, db_session
    )
    project_id = project_factory()
    workflow = client.post(
        f"{BASE}/projects/{project_id}/workflows",
        json={"kind": "product_development", "template_key": template["key"]},
        headers=admin_headers,
    )
    assert workflow.status_code == 200, workflow.text
    snapshot_task_id = workflow.json()["tasks"][0]["id"]
    copy = _stored_attachment(db_session, snapshot_task_id)
    assert copy is not None
    assert copy.origin == "template"
    assert copy.filename == "模板附件.pdf"

    # 删项目侧副本：模板仍引用同一 key → 不删 R2 对象
    delete_calls: list[str] = []
    patches = _r2_patches(settings, delete_calls=delete_calls)
    with patches[3]:
        removed = client.delete(
            f"{BASE}/projects/{project_id}/workflow-task-attachments/{int(copy.id)}",
            headers=admin_headers,
        )
    assert removed.status_code == 200, removed.text
    assert delete_calls == []

    # 再删模板侧附件：此时无人引用 → 删 R2 对象
    delete_calls.clear()
    with patches[3]:
        removed_template = client.delete(
            f"{ADMIN}/template-task-attachments/{template_attachment['id']}",
            headers=admin_headers,
        )
    assert removed_template.status_code == 200, removed_template.text
    assert len(delete_calls) == 1

    client.delete(f"{ADMIN}/templates/{template['id']}", headers=admin_headers)


def test_template_attachment_delete_keeps_object_when_project_copy_exists(
    client, admin_headers, project_factory, settings, db_session
):
    template, _task, template_attachment = _template_with_attachment(
        client, admin_headers, settings, db_session
    )
    project_id = project_factory()
    client.post(
        f"{BASE}/projects/{project_id}/workflows",
        json={"kind": "product_development", "template_key": template["key"]},
        headers=admin_headers,
    )

    delete_calls: list[str] = []
    patches = _r2_patches(settings, delete_calls=delete_calls)
    with patches[3]:
        removed = client.delete(
            f"{ADMIN}/template-task-attachments/{template_attachment['id']}",
            headers=admin_headers,
        )
    assert removed.status_code == 200, removed.text
    # 项目侧副本仍引用该对象 → 不删
    assert delete_calls == []

    client.delete(f"{ADMIN}/templates/{template['id']}", headers=admin_headers)


# ── 权限与错误语义 ──────────────────────────────────────────────────────


def test_cross_project_download_is_404(
    client, admin_headers, project_factory, settings, db_session
):
    project_a = project_factory()
    project_b = project_factory()
    workflow = _create_workflow(client, project_a, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]
    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        _upload_attachment(client, project_a, task_id, admin_headers)
    attachment_id = int(_stored_attachment(db_session, task_id).id)

    patches = _r2_patches(settings)
    with patches[1], patches[2], patches[4]:
        response = client.get(
            f"{BASE}/projects/{project_b}/workflow-task-attachments/{attachment_id}/download",
            headers=admin_headers,
        )
    assert response.status_code == 404, response.text


def test_operator_without_project_access_cannot_upload(
    client, admin_headers, operator_headers, project_factory, settings
):
    project_id = project_factory(project_operator="其他人")
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        response = _upload_attachment(client, project_id, task_id, operator_headers)
    assert response.status_code == 403, response.text


def test_operator_with_project_access_can_upload(
    client, admin_headers, operator_headers, test_operator, project_factory, settings
):
    """内务回传是执行性工作：有项目权限即可上传，不需要管理员。"""
    project_id = project_factory(project_operator=test_operator["name"])
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        response = _upload_attachment(client, project_id, task_id, operator_headers)
    assert response.status_code == 200, response.text


def test_disallowed_extension_is_rejected(
    client, admin_headers, project_factory, settings
):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        response = _upload_attachment(
            client, project_id, task_id, admin_headers, filename="payload.exe"
        )
    assert response.status_code == 400, response.text


def test_disallowed_mime_is_rejected(client, admin_headers, project_factory, settings):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        response = client.post(
            f"{BASE}/projects/{project_id}/workflow-tasks/{task_id}/attachments",
            files={"file": ("x.pdf", b"x", "application/x-msdownload")},
            headers=admin_headers,
        )
    assert response.status_code == 400, response.text


def test_oversized_file_is_rejected(client, admin_headers, project_factory, settings):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    patches = _r2_patches(settings)
    with patches[0], patches[4], patch.object(
        settings, "workflow_attachment_max_bytes", 4
    ):
        response = client.post(
            f"{BASE}/projects/{project_id}/workflow-tasks/{task_id}/attachments",
            files={"file": ("big.pdf", b"1234567890", "application/pdf")},
            headers=admin_headers,
        )
    assert response.status_code == 413, response.text


def test_r2_disabled_returns_503(client, admin_headers, project_factory, settings):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    with patch.object(
        type(settings), "r2_enabled", new_callable=PropertyMock, return_value=False
    ):
        response = _upload_attachment(client, project_id, task_id, admin_headers)
    assert response.status_code == 503, response.text


def test_download_missing_object_is_404(
    client, admin_headers, project_factory, settings, db_session
):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]
    patches = _r2_patches(settings)
    with patches[0], patches[4]:
        _upload_attachment(client, project_id, task_id, admin_headers)
    attachment_id = int(_stored_attachment(db_session, task_id).id)

    patches = _r2_patches(settings, exists=False)
    with patches[1], patches[2], patches[4]:
        response = client.get(
            f"{BASE}/projects/{project_id}/workflow-task-attachments/{attachment_id}/download",
            headers=admin_headers,
        )
    assert response.status_code == 404, response.text


def test_unknown_attachment_is_404(client, admin_headers, project_factory):
    project_id = project_factory()
    response = client.get(
        f"{BASE}/projects/{project_id}/workflow-task-attachments/99999999/download",
        headers=admin_headers,
    )
    assert response.status_code == 404, response.text
