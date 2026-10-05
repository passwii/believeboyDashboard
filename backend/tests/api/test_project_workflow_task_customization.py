"""项目内节点自定义与阶段排期测试（BLF-1237 / P2）。

覆盖：项目节点增删改排序（仅管理员）、节点多条内容、阶段日期/时长推算、
模板改动不回写已有项目、P1 ``PATCH {status}`` 对操作者保持可用、跨项目 404。
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


def _node(client, project_id, task_id, headers, **payload):
    return client.patch(
        f"{BASE}/project-workflow-tasks/{task_id}/definition",
        json=payload,
        headers=headers,
    )


# ── 项目内节点 CRUD ─────────────────────────────────────────────────────


def test_admin_can_add_update_and_delete_project_node(client, admin_headers, project_factory):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    workflow_id = workflow["id"]

    added = client.post(
        f"{BASE}/projects/{project_id}/workflows/{workflow_id}/tasks",
        json={"title": "追加节点", "description": "说明", "duration_days": 4},
        headers=admin_headers,
    )
    assert added.status_code == 200, added.text
    tasks = added.json()["tasks"]
    assert tasks[-1]["title"] == "追加节点"
    assert tasks[-1]["duration_days"] == 4
    assert tasks[-1]["sort_order"] == len(tasks) - 1

    target_id = tasks[-1]["id"]
    updated = _node(
        client,
        project_id,
        target_id,
        admin_headers,
        title="追加节点（改）",
        attachment_key="amazon_registration_form",
    )
    assert updated.status_code == 200, updated.text
    updated_task = updated.json()["tasks"][-1]
    assert updated_task["title"] == "追加节点（改）"
    assert updated_task["attachment_key"] == "amazon_registration_form"

    removed = client.delete(
        f"{BASE}/project-workflow-tasks/{target_id}", headers=admin_headers
    )
    assert removed.status_code == 200, removed.text
    assert "追加节点（改）" not in [task["title"] for task in removed.json()["tasks"]]
    assert [task["sort_order"] for task in removed.json()["tasks"]] == list(
        range(len(removed.json()["tasks"]))
    )


def test_project_node_reorder(client, admin_headers, project_factory):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    workflow_id = workflow["id"]
    task_ids = [task["id"] for task in workflow["tasks"]]
    reversed_ids = list(reversed(task_ids))

    response = client.put(
        f"{BASE}/projects/{project_id}/workflows/{workflow_id}/tasks/order",
        json={"task_ids": reversed_ids},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    assert [task["id"] for task in response.json()["tasks"]] == reversed_ids


def test_reorder_with_incomplete_id_set_is_rejected(client, admin_headers, project_factory):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    response = client.put(
        f"{BASE}/projects/{project_id}/workflows/{workflow['id']}/tasks/order",
        json={"task_ids": [workflow["tasks"][0]["id"]]},
        headers=admin_headers,
    )
    assert response.status_code == 422, response.text


def test_cross_project_task_is_404(client, admin_headers, project_factory):
    project_a = project_factory()
    project_b = project_factory()
    workflow_a = _create_workflow(client, project_a, admin_headers).json()
    workflow_b = _create_workflow(client, project_b, admin_headers).json()

    response = client.post(
        f"{BASE}/projects/{project_b}/workflows/{workflow_a['id']}/tasks",
        json={"title": "越权节点"},
        headers=admin_headers,
    )
    assert response.status_code == 404, response.text

    response = client.put(
        f"{BASE}/projects/{project_b}/workflows/{workflow_b['id']}/tasks/order",
        json={"task_ids": [task["id"] for task in workflow_a["tasks"]]},
        headers=admin_headers,
    )
    assert response.status_code == 422, response.text


# ── 权限 ────────────────────────────────────────────────────────────────


def test_non_admin_cannot_edit_project_node(
    client, admin_headers, operator_headers, test_operator, project_factory
):
    project_id = project_factory(project_operator=test_operator["name"])
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    assert (
        _node(client, project_id, task_id, operator_headers, title="越权改名").status_code
        == 403
    )
    assert (
        client.post(
            f"{BASE}/projects/{project_id}/workflows/{workflow['id']}/tasks",
            json={"title": "越权新增"},
            headers=operator_headers,
        ).status_code
        == 403
    )
    assert (
        client.delete(
            f"{BASE}/project-workflow-tasks/{task_id}", headers=operator_headers
        ).status_code
        == 403
    )
    assert (
        client.put(
            f"{BASE}/projects/{project_id}/workflows/{workflow['id']}/tasks/order",
            json={"task_ids": [task["id"] for task in workflow["tasks"]]},
            headers=operator_headers,
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"{BASE}/project-workflows/{workflow['id']}",
            json={"start_date": "2026-01-05"},
            headers=operator_headers,
        ).status_code
        == 403
    )


def test_status_patch_stays_available_to_operator_with_project_access(
    client, admin_headers, operator_headers, test_operator, project_factory
):
    """P1 契约回归：有项目权限的操作者仍能改状态（不需要管理员）。"""
    project_id = project_factory(project_operator=test_operator["name"])
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    response = client.patch(
        f"{BASE}/project-workflow-tasks/{task_id}",
        json={"status": "in_progress"},
        headers=operator_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "in_progress"


def test_operator_without_project_access_gets_403(
    client, admin_headers, operator_headers, project_factory
):
    project_id = project_factory(project_operator="其他人")
    workflow = _create_workflow(client, project_id, admin_headers).json()
    response = _node(
        client, project_id, workflow["tasks"][0]["id"], operator_headers, title="越权"
    )
    assert response.status_code == 403, response.text


# ── 模板不回写 ──────────────────────────────────────────────────────────


def test_template_edit_does_not_write_back_to_existing_project(
    client, admin_headers, project_factory
):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    original_title = workflow["tasks"][0]["title"]

    templates = client.get(f"{ADMIN}/templates", headers=admin_headers).json()["templates"]
    store_launch = next(item for item in templates if item["key"] == STORE_LAUNCH)
    detail = client.get(
        f"{ADMIN}/templates/{store_launch['id']}", headers=admin_headers
    ).json()
    template_task_id = detail["tasks"][0]["id"]

    edited = client.patch(
        f"{ADMIN}/template-tasks/{template_task_id}",
        json={"title": "模板改名（不应回写）"},
        headers=admin_headers,
    )
    assert edited.status_code == 200, edited.text

    after = client.get(f"{BASE}/projects/{project_id}/workflows", headers=admin_headers)
    assert after.json()["workflows"][0]["tasks"][0]["title"] == original_title

    # 复原模板标题，避免影响其他用例。
    client.patch(
        f"{ADMIN}/template-tasks/{template_task_id}",
        json={"title": original_title},
        headers=admin_headers,
    )


# ── 多条内容 ────────────────────────────────────────────────────────────


def test_project_node_supports_multiple_contents(client, admin_headers, project_factory):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]

    for body in ("内容一", "内容二", "内容三"):
        response = client.post(
            f"{BASE}/projects/{project_id}/workflow-tasks/{task_id}/contents",
            json={"body": body, "title": "小标题"},
            headers=admin_headers,
        )
        assert response.status_code == 200, response.text

    contents = response.json()["tasks"][0]["contents"]
    assert [item["body"] for item in contents] == ["内容一", "内容二", "内容三"]

    updated = client.patch(
        f"{BASE}/project-workflow-task-contents/{contents[0]['id']}",
        json={"body": "内容一（改）"},
        headers=admin_headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["tasks"][0]["contents"][0]["body"] == "内容一（改）"

    removed = client.delete(
        f"{BASE}/project-workflow-task-contents/{contents[1]['id']}", headers=admin_headers
    )
    assert removed.status_code == 200, removed.text
    remaining = removed.json()["tasks"][0]["contents"]
    assert [item["body"] for item in remaining] == ["内容一（改）", "内容三"]
    assert [item["sort_order"] for item in remaining] == [0, 1]


def test_non_admin_cannot_edit_project_content(
    client, admin_headers, operator_headers, test_operator, project_factory
):
    project_id = project_factory(project_operator=test_operator["name"])
    workflow = _create_workflow(client, project_id, admin_headers).json()
    task_id = workflow["tasks"][0]["id"]
    response = client.post(
        f"{BASE}/projects/{project_id}/workflow-tasks/{task_id}/contents",
        json={"body": "越权内容"},
        headers=operator_headers,
    )
    assert response.status_code == 403, response.text


def test_project_node_created_from_template_copies_template_contents(
    client, admin_headers, project_factory
):
    template = client.post(
        f"{ADMIN}/templates",
        json={
            "kind": "product_development",
            "title": "内容复制模板",
            "key": f"blf1237-{uuid.uuid4().hex[:10]}",
        },
        headers=admin_headers,
    ).json()
    task = client.post(
        f"{ADMIN}/templates/{template['id']}/tasks",
        json={"title": "带内容的模板节点", "duration_days": 2},
        headers=admin_headers,
    ).json()["tasks"][0]
    client.post(
        f"{ADMIN}/template-tasks/{task['id']}/contents",
        json={"body": "模板内容 A"},
        headers=admin_headers,
    )

    project_id = project_factory()
    workflow = client.post(
        f"{BASE}/projects/{project_id}/workflows",
        json={"kind": "product_development", "template_key": template["key"]},
        headers=admin_headers,
    )
    assert workflow.status_code == 200, workflow.text
    snapshot = workflow.json()["tasks"][0]
    assert snapshot["title"] == "带内容的模板节点"
    assert snapshot["duration_days"] == 2
    assert [item["body"] for item in snapshot["contents"]] == ["模板内容 A"]

    client.delete(f"{ADMIN}/templates/{template['id']}", headers=admin_headers)


# ── 阶段排期 ────────────────────────────────────────────────────────────


def test_schedule_is_computed_from_durations_and_anchor(
    client, admin_headers, project_factory
):
    project_id = project_factory()
    workflow = _create_workflow(
        client, project_id, admin_headers, start_date="2026-01-05"
    ).json()
    assert workflow["start_date"] == "2026-01-05"
    assert workflow["schedule_start"] is None
    assert workflow["schedule_days"] is None

    tasks = workflow["tasks"]
    first = _node(
        client, project_id, tasks[0]["id"], admin_headers, duration_days=2
    ).json()["tasks"][0]
    assert first["start_date"] == "2026-01-05"
    assert first["end_date"] == "2026-01-06"
    assert first["span_days"] == 2

    second = _node(
        client, project_id, tasks[1]["id"], admin_headers, duration_days=3
    ).json()["tasks"][1]
    assert second["start_date"] == "2026-01-07"
    assert second["end_date"] == "2026-01-09"

    third = _node(
        client, project_id, tasks[2]["id"], admin_headers, duration_days=1
    ).json()
    assert third["tasks"][2]["start_date"] == "2026-01-10"
    assert third["tasks"][2]["end_date"] == "2026-01-10"
    assert third["schedule_start"] == "2026-01-05"
    assert third["schedule_end"] == "2026-01-10"
    assert third["schedule_days"] == 6


def test_manual_dates_win_and_chain_continues(client, admin_headers, project_factory):
    project_id = project_factory()
    workflow = _create_workflow(
        client, project_id, admin_headers, start_date="2026-03-01"
    ).json()
    tasks = workflow["tasks"]

    # 手填第一个节点日期（覆盖锚点推算）
    manual = _node(
        client,
        project_id,
        tasks[0]["id"],
        admin_headers,
        start_date="2026-04-01",
        end_date="2026-04-05",
    ).json()
    assert manual["tasks"][0]["start_date"] == "2026-04-01"
    assert manual["tasks"][0]["end_date"] == "2026-04-05"
    assert manual["tasks"][0]["span_days"] == 5

    # 后续节点按工期从「手填结束日 + 1」继续
    chained = _node(
        client, project_id, tasks[1]["id"], admin_headers, duration_days=2
    ).json()["tasks"][1]
    assert chained["start_date"] == "2026-04-06"
    assert chained["end_date"] == "2026-04-07"


def test_end_date_before_start_date_is_rejected(client, admin_headers, project_factory):
    project_id = project_factory()
    workflow = _create_workflow(client, project_id, admin_headers).json()
    response = _node(
        client,
        project_id,
        workflow["tasks"][0]["id"],
        admin_headers,
        start_date="2026-05-10",
        end_date="2026-05-01",
    )
    assert response.status_code == 422, response.text


def test_summary_exposes_project_schedule(client, admin_headers, project_factory):
    project_id = project_factory()
    workflow = _create_workflow(
        client, project_id, admin_headers, start_date="2026-06-01"
    ).json()
    tasks = workflow["tasks"]
    _node(client, project_id, tasks[0]["id"], admin_headers, duration_days=2)
    _node(client, project_id, tasks[1]["id"], admin_headers, duration_days=3)

    summary = client.get(f"{BASE}/project-workflows/summary", headers=admin_headers)
    assert summary.status_code == 200, summary.text
    entry = next(
        item
        for item in summary.json()["projects"]
        if item["project_id"] == project_id
    )
    assert entry["schedule_start"] == "2026-06-01"
    assert entry["schedule_end"] == "2026-06-05"
    assert entry["schedule_days"] == 5
    assert entry["workflows"][0]["schedule_start"] == "2026-06-01"


def test_creating_workflow_from_template_computes_stage_dates(
    client, admin_headers, project_factory
):
    """回归（把关 ②）：创建流程时就要算日期，不能等改节点才生效。

    模板节点填了工期 + 创建请求带锚点，应当立刻得到各阶段起止。
    """
    template = client.post(
        f"{ADMIN}/templates",
        json={
            "kind": "product_development",
            "title": "排期模板",
            "key": f"blf1237-{uuid.uuid4().hex[:10]}",
        },
        headers=admin_headers,
    ).json()
    for title, days in (("节点一", 3), ("节点二", 2), ("节点三", 1)):
        client.post(
            f"{ADMIN}/templates/{template['id']}/tasks",
            json={"title": title, "duration_days": days},
            headers=admin_headers,
        )

    project_id = project_factory()
    response = client.post(
        f"{BASE}/projects/{project_id}/workflows",
        json={
            "kind": "product_development",
            "template_key": template["key"],
            "start_date": "2026-07-01",
        },
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    workflow = response.json()

    assert [(task["start_date"], task["end_date"]) for task in workflow["tasks"]] == [
        ("2026-07-01", "2026-07-03"),
        ("2026-07-04", "2026-07-05"),
        ("2026-07-06", "2026-07-06"),
    ]
    assert workflow["schedule_start"] == "2026-07-01"
    assert workflow["schedule_end"] == "2026-07-06"
    assert workflow["schedule_days"] == 6

    client.delete(f"{ADMIN}/templates/{template['id']}", headers=admin_headers)


def test_adding_project_node_computes_its_stage_dates(
    client, admin_headers, project_factory
):
    """回归（把关 ②）：新增节点也要参与排期推算。"""
    project_id = project_factory()
    workflow = _create_workflow(
        client, project_id, admin_headers, start_date="2026-08-01"
    ).json()
    workflow_id = workflow["id"]
    _node(client, project_id, workflow["tasks"][0]["id"], admin_headers, duration_days=2)

    response = client.post(
        f"{BASE}/projects/{project_id}/workflows/{workflow_id}/tasks",
        json={"title": "新增阶段", "duration_days": 3},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    added = response.json()["tasks"][-1]
    assert added["start_date"] == "2026-08-03"
    assert added["end_date"] == "2026-08-05"
