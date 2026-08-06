"""External API 410 Gone 兜底路由（BLF-459 V3）。

V3 起 ``/api/v1/external/*`` 全部下线，老消费者已迁移到 ``/api/v1/agent/*``
（一对一路径镜像，见 ``docs/agent-api-design.md`` §6）。本路由对仍打到旧
命名空间的请求返回 **410 Gone** + ``Link: rel="successor-version"`` 指向
对应 agent 路径，而不是裸 404——给未迁移的调用方一个明确的"已搬迁"信号。

挂载点：``app/api/v1/router.py``（与 ``external_router`` 并列；旧 external
模块保留给 ``agent/external_mirror.py`` 复用，但不再挂载到应用）。
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

external_retired_router = APIRouter()


@external_retired_router.api_route(
    "/external/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def external_retired_gone(request: Request, path: str) -> JSONResponse:
    """旧 /external/* 全部 410 Gone，指向 /agent/* 对应路径。"""
    agent_path = "/api/v1/agent" + request.url.path[len("/api/v1/external") :]
    return JSONResponse(
        status_code=410,
        content={
            "detail": "该接口已下线，请迁移到 /api/v1/agent/*（路径后缀不变）",
            "successor": agent_path,
        },
        headers={
            "Link": f'<{agent_path}>; rel="successor-version"',
            "Deprecation": "true",
        },
    )
