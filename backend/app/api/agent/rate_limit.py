"""Agent 命名空间限流（设计稿 §7.1）。

沿用 ``app/api/external_security.py`` 的 slowapi 内存 Limiter 模式：
限额按 worker 进程独立计数，网关白名单是 backstop。
与 external 通道不同：agent 通道限流 **day-1 无条件启用**（无开关）。
"""

from __future__ import annotations

from fastapi import Depends, Request, Response
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.api.agent.auth import require_agent_credential
from app.core.config import get_settings


def get_agent_id_or_ip(request: Request) -> str:
    """限流键：已鉴权取 agent_id，否则回退客户端 IP。"""
    agent_id = getattr(request.state, "agent_id", None)
    if agent_id:
        return f"agent:{agent_id}"
    return get_remote_address(request)


agent_limiter = Limiter(
    key_func=get_agent_id_or_ip, default_limits=[], headers_enabled=True
)


def _read_limit_value() -> str:
    return get_settings().agent_api_read_rate_limit


@agent_limiter.limit(_read_limit_value)
def require_agent_read_rate_limit(
    request: Request,  # slowapi @limiter.limit 要求
    response: Response,  # headers_enabled=True：FastAPI 注入真实 Response，slowapi 写 X-RateLimit-* 头
    _credential=Depends(require_agent_credential),
) -> None:
    """读桶限额（命名空间级依赖，挂 agent_router）。"""
    return None


def _write_limit_value() -> str:
    return get_settings().agent_api_write_rate_limit


@agent_limiter.limit(_write_limit_value)
def require_agent_write_rate_limit(
    request: Request,
    response: Response,  # 同上
    _credential=Depends(require_agent_credential),
) -> None:
    """写桶限额：P2 写路由逐个显式挂载（读路由不吃写桶）。"""
    return None
