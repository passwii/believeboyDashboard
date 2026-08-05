"""Agent 命名空间 project_scope 项目范围准入依赖（BLF-441，spec §6）。

L2 硬前置：店铺测算域（以及后续所有 agent 域写路由）合入前必须先落地。
语义（§6.2 #1）：

* ``project_scope == "*"`` → 放行（存量 key 兼容，行为不变）；
* 否则按 ``,`` 分隔的 project_id 白名单校验，不在 → **403
  ``AGENT_PROJECT_OUT_OF_SCOPE``**（``errors.py`` 已有 code + 映射，无新码）；
* 查不到 key 行（auth 之后被并发吊销/删除）→ 401 fail closed，
  语义与 ``require_agent_credential`` 的 ``token_invalid`` 一致。

必须在 ``require_agent_credential`` 之后运行（它注入
``request.state.agent_api_key_id``）；路由级挂载时由依赖顺序天然保证。
"""

from __future__ import annotations

import logging

from fastapi import Request

from app.api.agent.errors import AgentApiError, ErrorCode
from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey

logger = logging.getLogger(__name__)

# 全量放行哨兵值（与 DB server_default 对齐）。
SCOPE_ALL = "*"


def _parse_scope(scope: str) -> set[int]:
    """把 ``"12, 34"`` 解析成 project_id 集合；非法片段跳过并告警。"""
    ids: set[int] = set()
    for part in scope.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.add(int(part))
        except ValueError:
            logger.warning("invalid project id in project_scope: %r", part)
    return ids


def require_project_scope(project_id: int, request: Request) -> None:
    """项目范围准入依赖。

    ``project_id`` 来自路径参数（店铺域路由统一 ``/projects/{project_id}/...``）。
    通过则静默放行；未通过抛 ``AgentApiError``，由 agent 错误处理器序列化。
    """
    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is None:
        # 依赖顺序错误（auth 未先跑）或 state 未注入 → fail closed。
        raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")

    db = SessionLocal()
    try:
        key = db.get(AgentApiKey, key_id)
        if key is None:
            # auth 之后 key 被删/并发吊销：与 auth 语义一致 401。
            raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")
        scope = key.project_scope or SCOPE_ALL
        if scope == SCOPE_ALL:
            return
        if project_id not in _parse_scope(scope):
            raise AgentApiError(
                ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE,
                reason="project_not_in_scope",
            )
    finally:
        db.close()
