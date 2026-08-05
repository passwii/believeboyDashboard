"""Agent 命名空间限流（设计稿 §7.1）。

沿用 ``app/api/external_security.py`` 的 slowapi 内存 Limiter 模式：
限额按 worker 进程独立计数，网关白名单是 backstop。
与 external 通道不同：agent 通道限流 **day-1 无条件启用**（无开关）。

.. note::

   读桶、写桶各持一个独立 ``Limiter`` 实例（``agent_read_limiter`` /
   ``agent_write_limiter``）——bucket 存储相互隔离、限额字符串/计数器互不
   串台。**仅此还不够**：slowapi 在 ``extension.py:729-733`` 的 async/sync
   wrapper 用 ``request.state._rate_limiting_complete`` 标志做跨依赖去重：
   第一个 ``@limiter.limit()`` 装饰过的依赖跑完就把 flag 置 True，**同一
   request 之后**任何其它 ``@limiter.limit()`` 装饰的依赖都直接被短路（无论
   它们挂的是不是同一个 Limiter 实例——flag 写的是 ``request.state``，全局
   共享）。``agent_router`` 是路由级依赖先跑（read），写路由的
   ``dependencies=[Depends(require_agent_write_rate_limit)]`` 后跑（write），
   顺序固定；不重置 flag 写桶永远跑不到 ``_check_request_limit``。

   所以写桶依赖除了挂在独立的 Limiter 上，还在自身入口清掉
   ``request.state._rate_limiting_complete``，让 slowapi wrapper 重新走一遍
   check 流程——这是绕过 slowapi 这层 wrapper-only 去重的最小侵入方式。

   P0 阶段因读桶没写桶对手未暴露，Task 4 仅定义了 ``write_rate_limit`` 而
   没有写路由挂载，测试覆盖也未触发；Task 5 写路由首次挂载后才浮出。
   ``tests/api/agent/test_shipments_confirm.py::TestWriteRateLimit`` 是
   既有的回归用例：写 2 次 200、第三次 429，失败即证明 flag 没清干净。

   旧名 ``agent_limiter`` 保留为 ``agent_read_limiter`` 的别名，兼容既有
   import 与 conftest 复位逻辑。
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


# 读桶 limiter —— 挂 agent_router，覆盖所有读路由。
agent_read_limiter = Limiter(
    key_func=get_agent_id_or_ip, default_limits=[], headers_enabled=True
)

# 写桶 limiter —— 独立实例（bucket 存储、计数都隔开），由具体写路由
# 显式挂载（不挂在 agent_router，读路由不吃写桶）。
agent_write_limiter = Limiter(
    key_func=get_agent_id_or_ip, default_limits=[], headers_enabled=True
)

# 向后兼容别名：旧 import（``from app.api.agent.rate_limit import agent_limiter``）
# 仍能解析到读桶实例，conftest 里也照旧复位。后续若有调用方想拿写桶实例，请
# 直接 import ``agent_write_limiter``。
agent_limiter = agent_read_limiter


def _read_limit_value() -> str:
    return get_settings().agent_api_read_rate_limit


def _write_limit_value() -> str:
    return get_settings().agent_api_write_rate_limit


@agent_read_limiter.limit(_read_limit_value)
def require_agent_read_rate_limit(
    request: Request,  # slowapi @limiter.limit 要求
    response: Response,  # headers_enabled=True：FastAPI 注入真实 Response，slowapi 写 X-RateLimit-* 头
    _credential=Depends(require_agent_credential),
) -> None:
    """读桶限额（命名空间级依赖，挂 agent_router）。"""
    return None


@agent_write_limiter.limit(_write_limit_value)
def _require_agent_write_rate_limit_inner(
    request: Request,
    response: Response,  # 同上
    _credential=Depends(require_agent_credential),
) -> None:
    """写桶限额底层函数（被 @limiter.limit 装饰的 inner）。

    单独存在是因为 outer 依赖会先清掉 ``request.state._rate_limiting_complete``
    标志，再调用本函数——这样 slowapi wrapper 看到 flag=False 时会真正执行
    ``_check_request_limit``，而不是短路。
    """
    return None


def require_agent_write_rate_limit(
    request: Request,
    response: Response,
    _credential=Depends(require_agent_credential),
) -> None:
    """写桶限额：P2 写路由逐个显式挂载（读路由不吃写桶）。

    必须先清掉 slowapi 的跨依赖去重 flag，再调用底层被装饰函数；详见
    模块 docstring 的 ``request.state._rate_limiting_complete`` 段。
    """
    # 读桶（路由级依赖）先跑，已经把 flag 置 True；这里清掉，wrapper 才会真做检查。
    request.state._rate_limiting_complete = False
    # 走 kwargs 传 response：slowapi sync_wrapper 通过 ``kwargs.get("response")``
    # 拿这个对象去 ``_inject_headers``，位置参数拿不到。
    return _require_agent_write_rate_limit_inner(
        request=request, response=response, _credential=_credential
    )
