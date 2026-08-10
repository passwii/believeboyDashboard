"""Agent 项目列表路由（BLF-582 原生化：非 ad 域之一）。

在 ``/api/v1/agent/projects`` 开放 1 条读路由——**原生替换 external 镜像
特例**（BLF-459 P1 镜像时代由 ``external_mirror._agent_projects_list`` 接管；
BLF-583 镜像已删除，本模块为唯一实现，external/projects.py 端点模块早已
删除，逻辑全部在原生模块内）：

* 查询契约与删除前的 ``get_external_projects`` 完全一致（``status`` 过滤 +
  ``ProjectItem{project_id, project_name}`` 形状），parity 测试锁定
  （agent 通道 == ``projects_query.list_projects`` 直调）。
* ``?name=``（BLF-461）：可选的项目名精确过滤，作为 Agent「名字 → ID」
  的确定性解析步骤——``project_name`` 有唯一约束，命中 0/1 条；未命中
  返回空列表。
* **scope 过滤（L2 门禁语义）**：受 ``project_scope`` 限制的 agent key
  （如 ``project_scope="1,2"``）只看到白名单内的项目；``*`` 全放行时与
  external 行为完全一致。

**无 business_scope 门禁**：项目列表是跨域基础设施端点（所有 agent 域
都靠它做「名字 → ID」解析），不挂任何业务域 scope——对齐镜像时代行为
（无 project_id 路径 → 不挂 project_scope；列表过滤在 handler 内按 key 的
project_scope 做）。
"""

from __future__ import annotations

from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import SCOPE_ALL
from app.api.deps import get_read_db_session
from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey
from app.schemas.external.projects import ProjectItem
from app.services.external import projects_query

projects_router = APIRouter(tags=["agent-projects"])


# ============================================================
# 壳翻译与解析 helper（对齐各原生域模板）
# ============================================================


@contextmanager
def _service_errors():
    """把 service 层 HTTPException 翻译成 agent 响应壳（设计稿 §5）。"""
    try:
        yield
    except AgentApiError:
        raise
    except HTTPException as exc:
        detail = str(exc.detail) if exc.detail else None
        if exc.status_code == 404:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND, human_message=detail
            ) from None
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail) from None


def _to_json(value) -> dict:
    """pydantic 模型 → JSON-safe dict。"""
    return value.model_dump(mode="json")


# ============================================================
# /projects 列表（原生）
# ============================================================


@projects_router.get("/projects")
def get_agent_projects(
    request: Request,
    status: str = Query(default="active"),
    name: str | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
) -> dict:
    """``/agent/projects`` 列表：项目名 + id。

    复用 ``projects_query.list_projects``（与删除前的 external handler 同一
    服务函数）；``?name=`` 精确过滤；受 scope 限制的 key 按 project_scope
    白名单过滤 items。
    """
    with _service_errors():
        projects = projects_query.list_projects(db, status=status)

    if name:
        projects = [p for p in projects if p.project_name == name]

    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is not None:
        db2 = SessionLocal()
        try:
            key = db2.get(AgentApiKey, key_id)
            scope = (key.project_scope if key else None) or SCOPE_ALL
        finally:
            db2.close()
        if scope != SCOPE_ALL:
            allowed = {int(part.strip()) for part in scope.split(",") if part.strip()}
            projects = [p for p in projects if p.id in allowed]

    return agent_ok(
        [
            _to_json(
                ProjectItem(
                    project_id=p.id,
                    project_name=p.project_name,
                )
            )
            for p in projects
        ]
    )
