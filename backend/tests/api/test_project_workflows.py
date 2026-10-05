"""项目启动台流程 API 测试（BLF-1234）。

覆盖：模板目录、批量概要、店铺启动幂等、产品开发可重复创建、
任务状态流转与派生状态、项目权限校验、受保护文档下载白名单。
运行需要独立测试库（``backend/.env.test``），否则整套跳过。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.project import Project

BASE = "/api/v1"

STORE_LAUNCH_TITLES = [
    "店铺注册资料收集",
    "万里汇收款账户注册",
    "店铺业务审核",
    "品牌备案",
    "UPC 注册豁免",
    "收款账户后台绑定验证",
]

SWIMWEAR_TITLES = [
    "产品选款对接",
    "产品打样对接",
    "产品包装设计",
    "产品吊卡设计",
    "产品洗标",
    "完整款打样、打包与邮寄",
]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_factory(db_session):
    """Create throwaway projects and clean them up (cascades to workflows)."""
    created: list[int] = []

    def _create(*, project_operator: str | None = None) -> int:
        project = Project(
            project_name=f"BLF1234-{uuid.uuid4().hex[:8]}",
            sort_order=1,
            project_operator=project_operator,
        )
        db_session.add(project)
        db_session.commit()
        created.append(int(project.id))
        return int(project.id)

    yield _create

    from sqlalchemy import delete, select

    from app.models.project_workflow import ProjectWorkflow, ProjectWorkflowTask

    for project_id in created:
        workflow_ids = [
            int(row)
            for row in db_session.execute(
                select(ProjectWorkflow.id).where(
                    ProjectWorkflow.project_id == project_id
                )
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


def _create_workflow(client, project_id, headers, payload):
    response = client.post(
        f"{BASE}/projects/{project_id}/workflows", json=payload, headers=headers
    )
    return response


# ── 模板目录 ────────────────────────────────────────────────────────────


def test_templates_only_expose_metadata(client, admin_headers):
    response = client.get(f"{BASE}/project-workflows/templates", headers=admin_headers)
    assert response.status_code == 200, response.text
    templates = response.json()["templates"]
    keys = {item["key"]: item for item in templates}
    assert "store-launch-v1" in keys
    assert "product-womens-swimwear-v1" in keys
    assert keys["store-launch-v1"]["kind"] == "store_launch"
    assert keys["store-launch-v1"]["title"] == "店铺启动"
    assert keys["product-womens-swimwear-v1"]["kind"] == "product_development"
    # 模板元数据里不允许携带任务正文
    assert all(set(item) == {"key", "kind", "title"} for item in templates)


# ── 批量概要 ────────────────────────────────────────────────────────────


def test_summary_includes_project_without_workflows(
    client, admin_headers, project_factory
):
    project_id = project_factory()
    response = client.get(f"{BASE}/project-workflows/summary", headers=admin_headers)
    assert response.status_code == 200, response.text
    entries = {item["project_id"]: item for item in response.json()["projects"]}
    assert project_id in entries
    assert entries[project_id]["workflows"] == []


# ── 店铺启动流程 ────────────────────────────────────────────────────────


def test_create_store_launch_snapshots_template(
    client, admin_headers, project_factory
):
    project_id = project_factory()
    response = _create_workflow(
        client,
        project_id,
        admin_headers,
        {"kind": "store_launch", "template_key": "store-launch-v1"},
    )
    assert response.status_code == 200, response.text
    workflow = response.json()
    assert workflow["kind"] == "store_launch"
    assert workflow["title"] == "店铺启动"
    assert workflow["status"] == "not_started"
    assert workflow["task_count"] == 6
    assert workflow["completed_task_count"] == 0
    assert [task["title"] for task in workflow["tasks"]] == STORE_LAUNCH_TITLES
    assert [task["sort_order"] for task in workflow["tasks"]] == list(range(6))
    assert all(task["status"] == "not_started" for task in workflow["tasks"])
    assert workflow["tasks"][0]["attachment_key"] == "amazon_registration_form"
    assert workflow["tasks"][1]["attachment_key"] == "worldfirst_registration_guide"
    assert all(task["attachment_key"] is None for task in workflow["tasks"][2:])


def test_store_launch_creation_is_idempotent(client, admin_headers, project_factory):
    project_id = project_factory()
    payload = {"kind": "store_launch", "template_key": "store-launch-v1"}
    first = _create_workflow(client, project_id, admin_headers, payload)
    second = _create_workflow(client, project_id, admin_headers, payload)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["id"] == second.json()["id"]

    listing = client.get(
        f"{BASE}/projects/{project_id}/workflows", headers=admin_headers
    )
    assert listing.status_code == 200, listing.text
    assert len(listing.json()["workflows"]) == 1


# ── 产品开发流程 ────────────────────────────────────────────────────────


def test_product_workflows_are_repeatable(client, admin_headers, project_factory):
    project_id = project_factory()
    first = _create_workflow(
        client,
        project_id,
        admin_headers,
        {
            "kind": "product_development",
            "template_key": "product-womens-swimwear-v1",
            "title": "女士泳衣A款",
        },
    )
    second = _create_workflow(
        client,
        project_id,
        admin_headers,
        {
            "kind": "product_development",
            "template_key": "product-womens-swimwear-v1",
            "title": "女士泳衣B款",
        },
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["id"] != second.json()["id"]
    assert first.json()["title"] == "女士泳衣A款"
    assert [task["title"] for task in first.json()["tasks"]] == SWIMWEAR_TITLES
    assert all(
        task["attachment_key"] is None for task in first.json()["tasks"]
    )


def test_summary_aggregates_workflows_for_one_project(
    client, admin_headers, project_factory
):
    project_id = project_factory()
    _create_workflow(
        client,
        project_id,
        admin_headers,
        {"kind": "store_launch", "template_key": "store-launch-v1"},
    )
    _create_workflow(
        client,
        project_id,
        admin_headers,
        {
            "kind": "product_development",
            "template_key": "product-womens-swimwear-v1",
        },
    )
    response = client.get(f"{BASE}/project-workflows/summary", headers=admin_headers)
    assert response.status_code == 200, response.text
    entries = {item["project_id"]: item for item in response.json()["projects"]}
    workflows = entries[project_id]["workflows"]
    assert len(workflows) == 2
    kinds = sorted(item["kind"] for item in workflows)
    assert kinds == ["product_development", "store_launch"]
    assert all(item["task_count"] == 6 for item in workflows)
    assert all(item["status"] == "not_started" for item in workflows)


# ── 任务状态流转 ────────────────────────────────────────────────────────


def test_task_status_update_derives_workflow_status(
    client, admin_headers, project_factory
):
    project_id = project_factory()
    created = _create_workflow(
        client,
        project_id,
        admin_headers,
        {"kind": "store_launch", "template_key": "store-launch-v1"},
    ).json()
    tasks = created["tasks"]

    first = client.patch(
        f"{BASE}/project-workflow-tasks/{tasks[0]['id']}",
        json={"status": "waiting_on_partner"},
        headers=admin_headers,
    )
    assert first.status_code == 200, first.text
    assert first.json()["status"] == "waiting_on_partner"
    assert first.json()["completed_task_count"] == 0

    second = client.patch(
        f"{BASE}/project-workflow-tasks/{tasks[1]['id']}",
        json={"status": "in_progress"},
        headers=admin_headers,
    )
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "in_progress"

    for task in tasks:
        done = client.patch(
            f"{BASE}/project-workflow-tasks/{task['id']}",
            json={"status": "completed"},
            headers=admin_headers,
        )
        assert done.status_code == 200, done.text
    assert done.json()["status"] == "completed"
    assert done.json()["completed_task_count"] == 6

    listing = client.get(
        f"{BASE}/projects/{project_id}/workflows", headers=admin_headers
    ).json()["workflows"]
    assert listing[0]["status"] == "completed"


def test_invalid_status_is_rejected(client, admin_headers, project_factory):
    project_id = project_factory()
    created = _create_workflow(
        client,
        project_id,
        admin_headers,
        {"kind": "store_launch", "template_key": "store-launch-v1"},
    ).json()
    response = client.patch(
        f"{BASE}/project-workflow-tasks/{created['tasks'][0]['id']}",
        json={"status": "done"},
        headers=admin_headers,
    )
    assert response.status_code == 422, response.text


def test_missing_task_returns_404(client, admin_headers):
    response = client.patch(
        f"{BASE}/project-workflow-tasks/99999999",
        json={"status": "completed"},
        headers=admin_headers,
    )
    assert response.status_code == 404, response.text


# ── 校验与权限 ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "store_launch", "template_key": "no-such-template"},
        {"kind": "product_development", "template_key": "store-launch-v1"},
        {"kind": "store_launch", "template_key": "product-womens-swimwear-v1"},
    ],
)
def test_template_validation_returns_422(
    client, admin_headers, project_factory, payload
):
    project_id = project_factory()
    response = _create_workflow(client, project_id, admin_headers, payload)
    assert response.status_code == 422, response.text


def test_unknown_project_returns_404(client, admin_headers):
    response = client.get(
        f"{BASE}/projects/99999999/workflows", headers=admin_headers
    )
    assert response.status_code == 404, response.text


def test_operator_without_project_access_is_forbidden(
    client, operator_headers, project_factory
):
    project_id = project_factory(project_operator="其他人")
    response = _create_workflow(
        client,
        project_id,
        operator_headers,
        {"kind": "store_launch", "template_key": "store-launch-v1"},
    )
    assert response.status_code == 403, response.text


# ── 受保护文档下载 ──────────────────────────────────────────────────────


def test_document_download_returns_original_file(
    client, admin_headers, project_factory
):
    project_id = project_factory()
    response = client.get(
        f"{BASE}/projects/{project_id}/workflows/documents/amazon_registration_form",
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    assert (
        response.headers["content-type"]
        == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert len(response.content) > 0


def test_document_download_rejects_unknown_key(client, admin_headers, project_factory):
    project_id = project_factory()
    response = client.get(
        f"{BASE}/projects/{project_id}/workflows/documents/../../etc/passwd",
        headers=admin_headers,
    )
    assert response.status_code in (403, 404), response.text


def test_document_download_requires_project_access(
    client, operator_headers, project_factory
):
    project_id = project_factory(project_operator="其他人")
    response = client.get(
        f"{BASE}/projects/{project_id}/workflows/documents/amazon_registration_form",
        headers=operator_headers,
    )
    assert response.status_code == 403, response.text
