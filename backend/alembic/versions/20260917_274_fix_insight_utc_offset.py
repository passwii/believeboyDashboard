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

订正写完后还会**自证**（``_assert_correction_holds``）：只用「本来就没存错」的列
反证偏移选对了——订正过的行不得再满足 ``updated_at < created_at``（**订正不足**
必响），且 ``duration_ms`` 必须等于订正后的 ``completed_at - started_at``
（**订正过头**必响：时间列按行自己的瞬时订正、``duration_ms`` 按会话偏移减，
只有两者一致才说明会话偏移就是这些行的解释偏移）。任一不成立即中止并整体回滚，
让迁移自己证明偏移正确，而不是靠运维记得核对。

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
    column("id", Integer),
    column("created_at", DateTime(timezone=True)),
    column("started_at", DateTime(timezone=True)),
    column("completed_at", DateTime(timezone=True)),
    column("updated_at", DateTime(timezone=True)),
    column("duration_ms", Integer),
)

_observations = table(
    "insight_run_observations",
    column("id", Integer),
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

#: 自证时 ``duration_ms`` 与「订正后的 completed_at - started_at」允许的偏差（毫秒）。
#: 正常写入路径就是 ``int((completed_at - started_at).total_seconds() * 1000)``
#: （截断到毫秒），真数据逐行偏差 0；留 2s 余量吸收取整，同时仍能抓住任何
#: 小时级的偏移错误（时区偏移最小也是 15min，远大于 2s）。
_DURATION_TOLERANCE_MS = 2_000


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


def _assert_correction_holds(
    bind: Any,
    run_ids: Sequence[int],
    observation_ids: Sequence[int],
) -> None:
    """订正自证：用**独立于恢复公式**的量反证「偏移选对了」，不成立即中止。

    1. 订正过的行不得再满足 ``updated_at < created_at``。``created_at`` 走
       ``server_default=now()``、从来没存错，所以**订正不足**（偏移取小了）
       必然留下 ``updated_at < created_at`` 的行。这条同时是幂等性的机械证明：
       重跑时判据命中 0 行（该判据就是订正范围的来源）。
    2. ``duration_ms`` 必须等于订正后的 ``completed_at - started_at``。时间列按
       **行自己的瞬时**取偏移，``duration_ms`` 按**会话偏移**减，两者只有在会话
       偏移恰好是这些行的解释偏移时才吻合。**订正过头**时断言 1 不会响
       （``updated_at`` 反而更大），但 ``duration_ms`` 会被多减甚至被
       ``greatest(..., 0)`` 夹到 0，这里必响。

    只检查本次真正订正过的行（订正后判据不再命中，故用订正前记下的 id 找回）：
    不把「未来某行 duration_ms 因其它原因与时间戳不吻合」变成每次部署都会触发的
    永久地雷。observation 行没有 started_at / completed_at，其 duration_ms 与
    run 同源，故只对 run 行做第 2 条。
    """
    stale = 0
    drift = 0

    if run_ids:
        stale += (
            bind.execute(
                select(func.count())
                .select_from(_runs)
                .where(_runs.c.id.in_(run_ids), _RUNS_AFFECTED)
            ).scalar()
            or 0
        )
        drift = (
            bind.execute(
                select(func.count())
                .select_from(_runs)
                .where(
                    _runs.c.id.in_(run_ids),
                    _runs.c.duration_ms.is_not(None),
                    _runs.c.started_at.is_not(None),
                    _runs.c.completed_at.is_not(None),
                    func.abs(
                        _runs.c.duration_ms
                        - func.extract(
                            "epoch", _runs.c.completed_at - _runs.c.started_at
                        )
                        * 1000
                    )
                    > _DURATION_TOLERANCE_MS,
                )
            ).scalar()
            or 0
        )

    if observation_ids:
        stale += (
            bind.execute(
                select(func.count())
                .select_from(_observations)
                .where(
                    _observations.c.id.in_(observation_ids), _OBSERVATIONS_AFFECTED
                )
            ).scalar()
            or 0
        )

    if stale or drift:
        raise RuntimeError(
            "BLF-1111 数据订正自证失败："
            f"{stale} 行订正后仍满足 updated_at < created_at，"
            f"{drift} 行的 duration_ms 与订正后的 completed_at - started_at 不符"
            f"（容差 {_DURATION_TOLERANCE_MS}ms）。这说明本会话时区偏移不是这些行的"
            "解释偏移（偏移取小或取大），或者库里的时间数据与本次判据不符。"
            "本次迁移整体回滚，库保持订正前状态；请先核对写入侧会话时区"
            "（本地 / 生产均为 Asia/Shanghai）再重跑，不要用错误偏移改数据。"
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

    # 订正前记下命中判据的行 id：UPDATE 之后这些行不再命中判据，
    # 自证只能靠 id 把它们找回来（见 _assert_correction_holds）。
    run_ids = list(bind.execute(select(_runs.c.id).where(_RUNS_AFFECTED)).scalars())
    observation_ids = list(
        bind.execute(select(_observations.c.id).where(_OBSERVATIONS_AFFECTED)).scalars()
    )

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

    # 让迁移自己证明偏移选对了（不成立 → 抛错 → 整体回滚）
    _assert_correction_holds(bind, run_ids, observation_ids)


def downgrade() -> None:
    """有意的空操作：这是一次性数据订正，回滚会破坏修复后按 UTC 写入的行。

    订正后同一个 ``updated_at < created_at`` 判据不再命中任何行（见模块
    docstring 的幂等性说明），所以「反向平移」没有可靠的行范围可圈——盲目反向
    会把修复后正常写入的行再推偏 8 小时。要回退请整库恢复到订正前的备份。
    """
