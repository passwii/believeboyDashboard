"""External API deprecation headers middleware（BLF-459 P1 路径迁移）。

给 ``/api/v1/external/*`` 的**全部响应**（含 404 等错误响应）打上过渡期头：

* ``Deprecation: true``
* ``Sunset: <external_api_sunset>``（Settings 可调，默认 2026-11-01）
* ``Link: </api/v1/agent/...>; rel="successor-version"``（指向对应 agent 路径）

为什么用 middleware 而不是在路由里注入 ``Response``：FastAPI 在 404 等
由异常处理器产出的响应上**不会带上路由注入的响应头**（BLF-416 已记录），
而 middleware 包裹整个应用，任何状态码的响应都经过这里。

挂载点：``app/main.py``（与 ``agent_api_audit`` 并列，见
``register_agent_api_audit_middleware``）。
"""

from __future__ import annotations

from fastapi import FastAPI, Request

from app.core.config import get_settings

EXTERNAL_PREFIX = "/api/v1/external/"
AGENT_PREFIX = "/api/v1/agent/"


def _successor_path(path: str) -> str:
    """把 ``/api/v1/external/...`` 换成对应的 ``/api/v1/agent/...`` 路径。

    BLF-459 迁移是一对一路径镜像（设计稿 §6.2），所以前缀替换即可得到
    successor；``/external/projects`` → ``/agent/projects``。
    """
    return AGENT_PREFIX + path[len(EXTERNAL_PREFIX) :]


def register_external_deprecation_middleware(app: FastAPI) -> None:
    """Attach the deprecation-header middleware to ``app`` (from ``main.py``)."""

    @app.middleware("http")
    async def external_deprecation_headers(request: Request, call_next):
        path = request.url.path
        if not path.startswith(EXTERNAL_PREFIX):
            return await call_next(request)
        response = await call_next(request)
        response.headers["Deprecation"] = "true"
        response.headers["Sunset"] = get_settings().external_api_sunset
        response.headers["Link"] = f'<{_successor_path(path)}>; rel="successor-version"'
        return response
