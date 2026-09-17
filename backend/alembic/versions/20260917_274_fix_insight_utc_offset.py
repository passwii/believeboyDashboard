"""订正 insight 时间列的 8 小时偏移（BLF-1111）

Revision ID: 274
Revises: 273
Create Date: 2026-09-17 00:00:00.000000

纯数据订正，**无 schema 变更**（时间列本来就是 ``TIMESTAMP WITH TIME ZONE``，
是写入侧发了 naive 值才出错的——见 ``runs._utcnow`` 的说明）。

问题：旧代码把 **naive UTC** 写进 ``timestamptz`` 列，Postgres 按**会话时区**
解释它；本地与生产 VPS 的会话时区都是 ``Asia/Shanghai (+0800)``，于是每个瞬时
被存早 8 小时，由它派生的 ``duration_ms`` / ``first_delta_ms`` 全部 +8h
（生产 13 行 run、13 行 observation 无一例外），门禁因此误报
``first_delta_exceeded`` / ``duration_exceeded``。

订正范围由**可证的判据**圈定，而不是「一张表整表平移」：

    updated_at < created_at

- ``created_at`` 走 ``server_default=now()``，从来没错过；``updated_at`` 只要被
  状态机显式写过就晚了 8 小时。因此对**正常行** ``updated_at >= created_at``
  恒成立，而 **buggy 行** ``updated_at = 真值 - 8h``。insight run 的写窗口是
  秒级（硬超时 300s），远小于 8h，所以 buggy 行必然落进这个判据。
- 这条判据同时给了幂等性：订正后 ``updated_at >= created_at``，重跑即空操作。
- 它还把 ``source='legacy_fallback'`` 行自动排除在外（那些行的 ``updated_at``
  走 server_default，本来就对，平移反而会弄坏它们）。

恢复公式按**行自己的瞬时**取会话时区偏移，不写死 8 小时（``timezone(zone, ts)``
与 ``ts AT TIME ZONE zone`` 等价，故可用 Core 表达式而无需裸 SQL）：

    col + (timezone(current_setting('TimeZone'), col) - timezone('UTC', col))

固定偏移时区（Asia/Shanghai）下这是精确值；在会话时区本来就是 UTC 的库上
结果为 0（那些库的行本来也没存错）。若确实存在 buggy 行（判据命中）却算出 0
偏移，说明迁移会话时区与写入者不一致，直接报错中止，绝不用错误偏移静默改数据。

派生整数同批订正：``duration_ms`` / ``first_delta_ms`` 是「真值 + 8h」，减去
偏移并夹到 >= 0；``first_delta_ms`` 还要夹到 ``duration_ms`` 以内——取消路径的
终态时刻在取消落地时即写，worker 到下一个 guard 才停，其后仍可能投出第一帧，
那种帧描述的已不是活跃 run（``observation.record_run_snapshot`` 同口径）。

实现说明：用 ``sa.table()`` 轻量构造而非 import ``app.models``，让这次订正绑在
**当时的列语义**上，不被后续模型改动带偏。
"""

from collections.abc import Sequence
from typing import Any

from sqlalchemy import (
    BigInteger,
    ColumnElement,
    DateTime,
    Integer,
    String,
    case,
    cast,
    column,
    func,
    null,
    select,
    table,
    update,
)

from alembic import op

revision: str = '274'
down_revision: str | None = '273'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_runs = table(
    "insight_runs",
    column("created_at", DateTime(timezone=True)),
    column("started_at", DateTime(timezone=True)),
    column("completed_at", DateTime(timezone=True)),
    column("updated_at", DateTime(timezone=True)),
    column("duration_ms", Integer),
)

_observations = table(
    "insight_run_observations",
    column("source", String),
    column("created_at", DateTime(timezone=True)),
    column("updated_at", DateTime(timezone=True)),
    column("duration_ms", Integer),
    column("first_delta_ms", Integer),
)

#: buggy 行的可证判据（见模块 docstring）：updated_at 被按 naive 写过才会早于
#: created_at；正常行恒满足 updated_at >= created_at。
_RUNS_AFFECTED = _runs.c.updated_at < _runs.c.created_at
_OBSERVATIONS_AFFECTED = (
    (_observations.c.source == "insight_run")
    & (_observations.c.updated_at < _observations.c.created_at)
)


def _local_wall_clock(instant: ColumnElement[Any]) -> ColumnElement[Any]:
    """会话时区下的墙上时间（= ``instant AT TIME ZONE current_setting(...)``）。"""
    return func.timezone(func.current_setting("TimeZone"), instant)


def _utc_wall_clock(instant: ColumnElement[Any]) -> ColumnElement[Any]:
    """UTC 下的墙上时间（= ``instant AT TIME ZONE 'UTC'``）。"""
    return func.timezone("UTC", instant)


def _as_true_instant(instant: ColumnElement[Any]) -> ColumnElement[Any]:
    """把「按会话时区误解的瞬时」搬回真瞬时：加回会话时区偏移。

    两个墙上时间都是 ``timestamp without time zone``，相减得 interval，因此
    ``instant + interval`` 就是订正后的瞬时。
    """
    return instant + (_local_wall_clock(instant) - _utc_wall_clock(instant))


def _session_offset_ms() -> ColumnElement[int]:
    """本会话时区相对 UTC 的偏移（毫秒，bigint → Python int）。"""
    return cast(
        (
            func.extract(
                "epoch", func.timezone(func.current_setting("TimeZone"), func.now())
            )
            - func.extract("epoch", func.timezone("UTC", func.now()))
        )
        * 1000,
        BigInteger,
    )


def upgrade() -> None:
    bind = op.get_bind()
    runs = (
        bind.execute(
            select(func.count())
            .select_from(_runs)
            .where(_RUNS_AFFECTED)
        ).scalar()
        or 0
    )
    observations = (
        bind.execute(
            select(func.count())
            .select_from(_observations)
            .where(_OBSERVATIONS_AFFECTED)
        ).scalar()
        or 0
    )
    if not runs and not observations:
        return

    offset = bind.execute(select(_session_offset_ms())).scalar() or 0
    if not offset:
        raise RuntimeError(
            "BLF-1111 数据订正：发现 "
            f"{runs} 行 insight_runs / {observations} 行 observation 带 naive 写入"
            "特征（updated_at < created_at），但本会话时区相对 UTC 的偏移是 0，"
            "无法算出订正量。这通常意味着 alembic 会话时区与写入者不一致"
            "（写入者是 +08 会话）；请确认连接的 TimeZone 后再重跑，"
            "不要用错误偏移改数据。"
        )

    bind.execute(
        update(_runs)
        .where(_RUNS_AFFECTED)
        .values(
            started_at=_as_true_instant(_runs.c.started_at),
            completed_at=_as_true_instant(_runs.c.completed_at),
            # 判据用的是**旧** updated_at（UPDATE 的 WHERE 与 SET 都读旧行），
            # 订正后该行不再命中判据 → 重跑即空操作。
            updated_at=_as_true_instant(_runs.c.updated_at),
            # 显式 CASE 保住 NULL：PG 的 GREATEST **忽略** NULL，
            # GREATEST(NULL, 0) 会回 0，把「无时长」写成「0ms」。
            duration_ms=case(
                (_runs.c.duration_ms.is_(None), null()),
                else_=func.greatest(_runs.c.duration_ms - offset, 0),
            ),
        )
    )
    bind.execute(
        update(_observations)
        .where(_OBSERVATIONS_AFFECTED)
        .values(
            updated_at=_as_true_instant(_observations.c.updated_at),
            duration_ms=case(
                (_observations.c.duration_ms.is_(None), null()),
                else_=func.greatest(_observations.c.duration_ms - offset, 0),
            ),
            # 首字时延不可能晚于 run 时长：夹进 duration_ms（同
            # observation.record_run_snapshot 口径）。
            first_delta_ms=case(
                (_observations.c.first_delta_ms.is_(None), null()),
                (
                    _observations.c.duration_ms.is_(None),
                    func.greatest(_observations.c.first_delta_ms - offset, 0),
                ),
                else_=func.least(
                    func.greatest(_observations.c.first_delta_ms - offset, 0),
                    func.greatest(_observations.c.duration_ms - offset, 0),
                ),
            ),
        )
    )


def downgrade() -> None:
    """有意的空操作：这是一次性数据订正，回滚会破坏修复后按 UTC 写入的行。

    订正后同一个 ``updated_at < created_at`` 判据不再命中任何行（见模块
    docstring 的幂等性说明），所以「反向平移」没有可靠的行范围可圈——盲目反向
    会把修复后正常写入的行再推偏 8 小时。要回退请整库恢复到订正前的备份。
    """
