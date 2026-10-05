"""流程模板管理 API 测试（BLF-1237 / P2）。

覆盖：管理员模板 CRUD、节点 CRUD 与排序、多条内容、模板复制、
固定文档键白名单校验、非管理员 403、删除模板不影响已有项目。
运行需要独立测试库（``backend/.env.test``），否则整套跳过。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.main import app
from app.models.project import Project
from app.models.project_workflow import ProjectWorkflow, ProjectWorkflowTask
from app.models.project_workflow_template import WorkflowTemplate

BASE = "/api/v1"
ADMIN = f"{BASE}/project-workflows/admin"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def template_factory(db_session):
    """Create throwaway templates and clean them up (cascades to nodes/contents/attachments)."""
    created: list[int] = []

    def _create(**overrides) -> int:
        payload = {
            "kind": "product_development",
            "title": f"BLF1237-{uuid.uuid4().hex[:8]}",
            "key": f"blf1237-{uuid.uuid4().hex[:10]}",
            **overrides,
        }
        row = WorkflowTemplate(
            key=payload["key"],
            kind=payload["kind"],
            title=payload["title"],
            description=payload.get("description"),
            sort_order=999,
        )
        db_session.add(row)
        db_session.commit()
        created.append(int(row.id))
        return int(row.id)

    yield _create

    for template_id in created:
        db_session.execute(delete(WorkflowTemplate).where(WorkflowTemplate.id == template_id))
    db_session.commit()


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


def _task_titles(detail: dict) -> list[str]:
    return [task["title"] for task in detail["tasks"]]


# ── 权限 ────────────────────────────────────────────────────────────────


def test_admin_can_list_templates_with_seeded_p1_rows(client, admin_headers):
    response = client.get(f"{ADMIN}/templates", headers=admin_headers)
    assert response.status_code == 200, response.text
    keys = {item["key"] for item in response.json()["templates"]}
    assert {"store-launch-v1", "product-womens-swimwear-v1"} <= keys


def test_non_admin_cannot_list_templates(client, operator_headers):
    response = client.get(f"{ADMIN}/templates", headers=operator_headers)
    assert response.status_code == 403, response.text


def test_non_admin_cannot_write_templates(client, operator_headers, template_factory):
    template_id = template_factory()
    assert (
        client.post(
            f"{ADMIN}/templates",
            json={"kind": "store_launch", "title": "x"},
            headers=operator_headers,
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"{ADMIN}/templates/{template_id}",
            json={"title": "x"},
            headers=operator_headers,
        ).status_code
        == 403
    )
    assert (
        client.delete(f"{ADMIN}/templates/{template_id}", headers=operator_headers).status_code
        == 403
    )
    assert (
        client.post(
            f"{ADMIN}/templates/{template_id}/tasks",
            json={"title": "节点"},
            headers=operator_headers,
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"{ADMIN}/templates/{template_id}/copy", json={}, headers=operator_headers
        ).status_code
        == 403
    )


# ── 模板 CRUD ───────────────────────────────────────────────────────────


def test_create_update_and_delete_template(client, admin_headers):
    key = f"blf1237-{uuid.uuid4().hex[:10]}"
    created = client.post(
        f"{ADMIN}/templates",
        json={
            "kind": "product_development",
            "title": "家居品类",
            "description": "家居产品开发流程",
            "key": key,
        },
        headers=admin_headers,
    )
    assert created.status_code == 200, created.text
    template = created.json()
    assert template["key"] == key
    assert template["task_count"] == 0

    updated = client.patch(
        f"{ADMIN}/templates/{template['id']}",
        json={"title": "家居品类 v2", "description": None},
        headers=admin_headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["title"] == "家居品类 v2"
    assert updated.json()["description"] is None

    removed = client.delete(f"{ADMIN}/templates/{template['id']}", headers=admin_headers)
    assert removed.status_code == 204, removed.text
    assert (
        client.get(f"{ADMIN}/templates/{template['id']}", headers=admin_headers).status_code
        == 404
    )


def test_auto_generated_key_when_omitted(client, admin_headers):
    created = client.post(
        f"{ADMIN}/templates",
        json={"kind": "store_launch", "title": "自定义店铺启动"},
        headers=admin_headers,
    )
    assert created.status_code == 200, created.text
    template = created.json()
    assert template["key"]
    assert len(template["key"]) <= 80
    client.delete(f"{ADMIN}/templates/{template['id']}", headers=admin_headers)


def test_duplicate_key_is_rejected(client, admin_headers, template_factory):
    template_id = template_factory()
    detail = client.get(f"{ADMIN}/templates/{template_id}", headers=admin_headers).json()
    response = client.post(
        f"{ADMIN}/templates",
        json={"kind": "store_launch", "title": "重复键", "key": detail["key"]},
        headers=admin_headers,
    )
    assert response.status_code == 422, response.text


def test_invalid_kind_is_rejected(client, admin_headers):
    response = client.post(
        f"{ADMIN}/templates",
        json={"kind": "not_a_kind", "title": "非法类型"},
        headers=admin_headers,
    )
    assert response.status_code == 422, response.text


def test_unknown_template_returns_404(client, admin_headers):
    assert (
        client.get(f"{ADMIN}/templates/99999999", headers=admin_headers).status_code == 404
    )


# ── 模板节点 ────────────────────────────────────────────────────────────


def test_create_update_reorder_and_delete_nodes(client, admin_headers, template_factory):
    template_id = template_factory()
    for title in ("第一步", "第二步", "第三步"):
        created = client.post(
            f"{ADMIN}/templates/{template_id}/tasks",
            json={"title": title, "duration_days": 3},
            headers=admin_headers,
        )
        assert created.status_code == 200, created.text

    detail = client.get(f"{ADMIN}/templates/{template_id}", headers=admin_headers).json()
    assert _task_titles(detail) == ["第一步", "第二步", "第三步"]
    assert [task["sort_order"] for task in detail["tasks"]] == [0, 1, 2]
    assert all(task["duration_days"] == 3 for task in detail["tasks"])

    first_id = detail["tasks"][0]["id"]
    updated = client.patch(
        f"{ADMIN}/template-tasks/{first_id}",
        json={"title": "第一步（改）", "duration_days": 7},
        headers=admin_headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["tasks"][0]["title"] == "第一步（改）"
    assert updated.json()["tasks"][0]["duration_days"] == 7

    reordered_ids = [detail["tasks"][2]["id"], detail["tasks"][0]["id"], detail["tasks"][1]["id"]]
    reordered = client.put(
        f"{ADMIN}/templates/{template_id}/tasks/order",
        json={"task_ids": reordered_ids},
        headers=admin_headers,
    )
    assert reordered.status_code == 200, reordered.text
    assert [task["id"] for task in reordered.json()["tasks"]] == reordered_ids

    removed = client.delete(
        f"{ADMIN}/template-tasks/{reordered_ids[0]}", headers=admin_headers
    )
    assert removed.status_code == 200, removed.text
    assert [task["sort_order"] for task in removed.json()["tasks"]] == [0, 1]


def test_reorder_with_incomplete_id_set_is_rejected(
    client, admin_headers, template_factory
):
    template_id = template_factory()
    created = client.post(
        f"{ADMIN}/templates/{template_id}/tasks",
        json={"title": "唯一节点"},
        headers=admin_headers,
    )
    assert created.status_code == 200, created.text
    response = client.put(
        f"{ADMIN}/templates/{template_id}/tasks/order",
        json={"task_ids": [99999999]},
        headers=admin_headers,
    )
    assert response.status_code == 422, response.text


def test_attachment_key_must_be_allowlisted(client, admin_headers, template_factory):
    template_id = template_factory()
    rejected = client.post(
        f"{ADMIN}/templates/{template_id}/tasks",
        json={"title": "非法文档键", "attachment_key": "../../etc/passwd"},
        headers=admin_headers,
    )
    assert rejected.status_code == 422, rejected.text

    accepted = client.post(
        f"{ADMIN}/templates/{template_id}/tasks",
        json={"title": "合法文档键", "attachment_key": "worldfirst_registration_guide"},
        headers=admin_headers,
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["tasks"][0]["attachment_key"] == "worldfirst_registration_guide"


def test_template_node_supports_multiple_contents(client, admin_headers, template_factory):
    template_id = template_factory()
    created = client.post(
        f"{ADMIN}/templates/{template_id}/tasks",
        json={"title": "带内容的节点"},
        headers=admin_headers,
    )
    task_id = created.json()["tasks"][0]["id"]

    for body in ("第一条内容", "第二条内容", "第三条内容"):
        response = client.post(
            f"{ADMIN}/template-tasks/{task_id}/contents",
            json={"title": "小标题", "body": body},
            headers=admin_headers,
        )
        assert response.status_code == 200, response.text

    detail = client.get(f"{ADMIN}/templates/{template_id}", headers=admin_headers).json()
    contents = detail["tasks"][0]["contents"]
    assert [item["body"] for item in contents] == ["第一条内容", "第二条内容", "第三条内容"]
    assert [item["sort_order"] for item in contents] == [0, 1, 2]

    updated = client.patch(
        f"{ADMIN}/template-task-contents/{contents[0]['id']}",
        json={"body": "第一条内容（改）"},
        headers=admin_headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["tasks"][0]["contents"][0]["body"] == "第一条内容（改）"

    removed = client.delete(
        f"{ADMIN}/template-task-contents/{contents[0]['id']}", headers=admin_headers
    )
    assert removed.status_code == 200, removed.text
    remaining = removed.json()["tasks"][0]["contents"]
    assert [item["body"] for item in remaining] == ["第二条内容", "第三条内容"]
    assert [item["sort_order"] for item in remaining] == [0, 1]


def test_empty_content_body_is_rejected(client, admin_headers, template_factory):
    template_id = template_factory()
    created = client.post(
        f"{ADMIN}/templates/{template_id}/tasks",
        json={"title": "节点"},
        headers=admin_headers,
    )
    task_id = created.json()["tasks"][0]["id"]
    response = client.post(
        f"{ADMIN}/template-tasks/{task_id}/contents",
        json={"body": ""},
        headers=admin_headers,
    )
    assert response.status_code == 422, response.text


# ── 模板复制 ────────────────────────────────────────────────────────────


def test_copy_template_copies_nodes_and_contents(client, admin_headers, template_factory):
    template_id = template_factory()
    created = client.post(
        f"{ADMIN}/templates/{template_id}/tasks",
        json={"title": "节点 A", "duration_days": 5},
        headers=admin_headers,
    )
    task_id = created.json()["tasks"][0]["id"]
    client.post(
        f"{ADMIN}/template-tasks/{task_id}/contents",
        json={"body": "内容 A"},
        headers=admin_headers,
    )

    copied = client.post(
        f"{ADMIN}/templates/{template_id}/copy", json={}, headers=admin_headers
    )
    assert copied.status_code == 200, copied.text
    clone = copied.json()
    assert clone["id"] != template_id
    assert clone["title"].endswith("（副本）")
    assert clone["tasks"][0]["title"] == "节点 A"
    assert clone["tasks"][0]["duration_days"] == 5
    assert [item["body"] for item in clone["tasks"][0]["contents"]] == ["内容 A"]

    client.delete(f"{ADMIN}/templates/{clone['id']}", headers=admin_headers)


def test_copy_with_explicit_key_and_title(client, admin_headers, template_factory):
    template_id = template_factory()
    key = f"blf1237-copy-{uuid.uuid4().hex[:8]}"
    copied = client.post(
        f"{ADMIN}/templates/{template_id}/copy",
        json={"title": "指定标题", "key": key},
        headers=admin_headers,
    )
    assert copied.status_code == 200, copied.text
    assert copied.json()["key"] == key
    assert copied.json()["title"] == "指定标题"
    client.delete(f"{ADMIN}/templates/{copied.json()['id']}", headers=admin_headers)


# ── 删除模板不影响已有项目 ──────────────────────────────────────────────


def test_deleting_template_keeps_existing_project_progress(
    client, admin_headers, template_factory, project_factory
):
    template_id = template_factory()
    created = client.post(
        f"{ADMIN}/templates/{template_id}/tasks",
        json={"title": "项目节点"},
        headers=admin_headers,
    )
    assert created.status_code == 200, created.text
    detail = client.get(f"{ADMIN}/templates/{template_id}", headers=admin_headers).json()

    project_id = project_factory()
    workflow = client.post(
        f"{BASE}/projects/{project_id}/workflows",
        json={
            "kind": "product_development",
            "template_key": detail["key"],
            "title": "快照流程",
        },
        headers=admin_headers,
    )
    assert workflow.status_code == 200, workflow.text
    assert _task_titles(workflow.json()) == ["项目节点"]

    removed = client.delete(f"{ADMIN}/templates/{template_id}", headers=admin_headers)
    assert removed.status_code == 204, removed.text

    after = client.get(f"{BASE}/projects/{project_id}/workflows", headers=admin_headers)
    assert after.status_code == 200, after.text
    workflows = after.json()["workflows"]
    assert len(workflows) == 1
    assert _task_titles(workflows[0]) == ["项目节点"]
    assert workflows[0]["template_key"] == detail["key"]
