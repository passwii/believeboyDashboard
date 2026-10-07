"""按请求给重型只读查询加「有界 statement timeout」（BLF-1262 Stage 1）。

为什么需要这一层
----------------
两个既有事实叠加，会让一次「前端已经放弃」的订单查询继续霸占连接最长 120s：

1. ``app/db/session.py`` / ``app/db/replica.py`` 的 ``connect_args`` 里全局配了
   ``-c statement_timeout=120s``。这是**兜底**，不是业务预算：任何一条重型查询
   都可以合法地跑满 120s。
2. 端点是 ``def``（同步）→ FastAPI 把它丢进 anyio 线程池。客户端断开（Next.js
   代理超时 abort、或用户关页面）**不会**取消已经在跑的线程，也就不会给 Postgres
   发 cancel —— 线程会一直跑到语句自然结束或撞上 120s 全局上限。池子
   （``db_pool_size=5`` / ``db_max_overflow=5``）被这种"僵尸查询"占满后，
   正常请求开始排队等 ``pool_timeout=10``。

所以本模块提供的是**按端点的更紧的上限**：把 ``statement_timeout`` 在**当前事务**
上收紧到业务预算（本 issue 取 15s，见 ``Settings.order_info_statement_timeout_ms``），
语句超时即被 Postgres 主动取消，连接立刻回到池里。

刻意不做的事
------------
* **不改** ``connect_args`` 里的全局 120s。全局值是所有端点（含月报、AI 等合法长跑
  查询）的现状兜底，没有逐端点实测数据支撑就动它，属于"未经验证的全局 timeout 改动"。
* **不做**跨语句的请求级 deadline。``statement_timeout`` 是**单语句**预算；
  ``/order-info/overview`` 一次会发 3 条语句，最坏耗时是 3 倍预算。这是刻意的：
  跨语句 deadline 需要额外的 watchdog 线程 + 取消传播，收益/复杂度不划算，
  留给 Stage 2 的 list-only 契约（把 3 条降到 1 条）更划算。
* **不**替非 Postgres 方言兜底。SQLite（单测方言）没有 ``set_config``，直接 no-op。

事务语义
--------
``statement_timeout`` 是**会话/事务**级 GUC。SQLAlchemy 的 Session 是懒 autobegin
的：依赖函数里此刻还没有事务，所以本模块只在 Session 上挂一个 ``after_begin``
监听器，**不**立刻发 SQL —— 第一次真实查询 autobegin 时顺带下发，零额外往返；
若在事务进行中才安装（测试里常见），则立即下发一次。
监听器而不是"设一次就完事"，是因为 ``rollback()`` 会重置事务级 GUC —— 复用同一个
Session 的后续查询需要重新拿到上限。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import event, text
from sqlalchemy.orm import Session

logger = logging.getLogger("app.request")

#: 会话上记录「已安装的 timeout + 监听器」的属性名。
_STATE_ATTR = "_blf_statement_timeout_state"

#: 驱动消息里的稳定英文片段（PG 服务端恒为英文，不随 locale 变）。
_STATEMENT_TIMEOUT_MARKERS = (
    "statement timeout",
    "statement_timeout",
)

_SET_TIMEOUT_SQL = text("SELECT set_config('statement_timeout', :value, true)")


def _make_after_begin(timeout_ms: int):
    """构造 ``after_begin`` 监听器：每个新事务都把上限重新钉上。

    直接在 ``connection`` 上执行（而不是 ``session``）——此时事务已经 begin，
    再走 Session 只会多绕一圈 identity map。
    """

    def _apply(session, transaction, connection) -> None:
        connection.execute(_SET_TIMEOUT_SQL, {"value": f"{timeout_ms}ms"})

    return _apply


def _dialect_name(db: Session) -> str:
    try:
        return db.bind.dialect.name if db.bind is not None else ""
    except Exception:  # noqa: BLE001 - bind 未就绪 / 断连，取不到就当不支持
        return ""


def install_statement_timeout(db: Session, timeout_ms: int) -> bool:
    """给 ``db`` 当前 Session 装上事务级 ``statement_timeout``。

    Returns
    -------
    bool
        True 表示已装上；False 表示非 Postgres 方言或 ``timeout_ms<=0``（no-op）。
    """
    try:
        timeout_ms = int(timeout_ms)
    except (TypeError, ValueError):
        return False
    if timeout_ms <= 0:
        return False
    if _dialect_name(db) not in {"postgresql", "postgres"}:
        return False

    state = getattr(db, _STATE_ATTR, None)
    if state is not None:
        if state["timeout_ms"] == timeout_ms:
            return True
        # 同一个 Session 上换预算：摘掉旧监听器再装新的，避免两条都生效。
        event.remove(db, "after_begin", state["listener"])
    listener = _make_after_begin(timeout_ms)
    event.listen(db, "after_begin", listener)
    setattr(db, _STATE_ATTR, {"timeout_ms": timeout_ms, "listener": listener})

    if db.in_transaction():
        # 事务已经在跑（中途安装），after_begin 不会再来一次 —— 现在就补上。
        db.execute(_SET_TIMEOUT_SQL, {"value": f"{timeout_ms}ms"})
    return True


def current_statement_timeout_ms(db: Session) -> int | None:
    """读回当前事务实际生效的 ``statement_timeout``（毫秒）。仅供测试 / 诊断。"""
    try:
        raw = db.execute(text("SHOW statement_timeout")).scalar()
    except Exception:  # noqa: BLE001
        return None
    if raw is None:
        return None
    return _parse_pg_interval_ms(str(raw))


def _parse_pg_interval_ms(raw: str) -> int | None:
    """把 ``SHOW statement_timeout`` 的输出（``'15s'`` / ``'250ms'`` / ``'0'``）解析成毫秒。"""
    text_value = raw.strip()
    if text_value in {"0", ""}:
        return 0
    try:
        if text_value.endswith("ms"):
            return int(float(text_value[:-2]))
        if text_value.endswith("s"):
            return int(float(text_value[:-1]) * 1000)
        if text_value.endswith("min"):
            return int(float(text_value[:-3]) * 60_000)
        return int(float(text_value) * 1000)
    except ValueError:
        return None


def _iter_causes(exc: BaseException | None):
    """沿 ``__cause__`` / ``orig`` 链遍历所有底层异常。"""
    seen: set[int] = set()
    current: Any = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        nxt = getattr(current, "orig", None) or current.__cause__
        if nxt is None or nxt is current:
            return
        current = nxt


def is_query_timeout_error(exc: BaseException | None) -> bool:
    """判断异常链里是否有「语句被 statement_timeout 取消」。

    只认 statement 超时，**不**认同属 57014 的其它取消源（用户主动 cancel），
    也不认 pool 的 ``pool_timeout`` / 连接的 ``connect_timeout`` —— 那些是另一类
    故障，映射成 504 会误导前端去"收窄筛选"。
    """
    for cause in _iter_causes(exc):
        message = str(cause).lower()
        if any(marker in message for marker in _STATEMENT_TIMEOUT_MARKERS):
            return True
    return False
