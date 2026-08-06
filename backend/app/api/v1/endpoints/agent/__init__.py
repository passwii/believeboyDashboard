"""Agent API 命名空间 — ``/api/v1/agent/*``。

面向 LLM Agent 的读写 API（替代 /api/v1/external/*；设计稿见
docs/agent-api-design.md）。鉴权 day-1 强制：Bearer + X-Agent-Id。
"""

from fastapi import APIRouter, Depends, HTTPException

from app.api.agent.auth import require_agent_credential
from app.api.agent.rate_limit import require_agent_read_rate_limit
from app.api.agent.scope import require_business_scope
from app.api.v1.endpoints.agent.external_mirror import external_mirror_router
from app.api.v1.endpoints.agent.health import router as health_router
from app.api.v1.endpoints.agent.new_product_calculations import (
    new_product_calculations_router,
)
from app.api.v1.endpoints.agent.shipments import shipments_router
from app.api.v1.endpoints.agent.shop_calculations import shop_calculations_router

agent_router = APIRouter(
    prefix="/agent",
    tags=["agent"],
    dependencies=[
        Depends(require_agent_credential),
        Depends(require_agent_read_rate_limit),
    ],
)

agent_router.include_router(health_router)
agent_router.include_router(
    shipments_router,
    dependencies=[Depends(require_business_scope("shipments"))],
)
agent_router.include_router(
    shop_calculations_router,
    dependencies=[Depends(require_business_scope("shop_calculations"))],
)
# 新品测算域（BLF-451）：只挂 require_project_scope；business_scope（BLF-448）
# 暂不挂载，域 code 预留 new_product_calculations。
agent_router.include_router(new_product_calculations_router)
# BLF-459 (P1 路径迁移)：/external/* 读路由镜像（项目白名单在路由级
# require_project_scope，见 external_mirror.py）。必须插在兜底路由之前。
agent_router.include_router(external_mirror_router)


# ⚠️ 路由遮蔽警告：兜底路由必须是 agent_router 注册的最后一个路由。
# 后续新增 include_router(...) 一律插在它之前，否则新路由会被这里
# 静默吞成 404 壳（鉴权照常执行，但永远到不了真实 handler）。
@agent_router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
def _agent_namespace_fallback(path: str) -> None:
    """命名空间内未注册路径的兜底 404（spec E6）。

    Starlette 先路由后依赖：没有这条兜底，未匹配路径会绕过路由级鉴权
    直接 404。挂在 agent_router 之下可保证鉴权依赖先跑——未鉴权得
    401 壳，已鉴权得 404 壳（均由 agent 错误处理器包装）。
    """
    raise HTTPException(status_code=404)
