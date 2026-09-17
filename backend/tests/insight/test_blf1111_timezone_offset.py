"""BLF-1111：insight 时间列的 8 小时偏移回归（真 Postgres + ``Asia/Shanghai`` 会话）。

缺陷形状：旧代码把 **naive UTC** 写进 ``TIMESTAMP WITH TIME ZONE`` 列，Postgres
按**会话时区**解释 naive 值。本地与生产 VPS 的会话时区都是 ``Asia/Shanghai``，
于是每个瞬时被存早 8 小时，由它派生的 ``duration_ms`` / ``first_delta_ms`` 全部
+8h（生产实测 28,806,485 ~ 28,818,256ms），门禁据此误报

    [blocking] insight.first_delta_exceeded observed=28818242 threshold=90000
    [blocking] insight.duration_exceeded  observed=28818256 threshold=300000

为什么必须用真 Postgres：sqlite 的 ``DateTime`` 没有时区语义（写 aware 值、读回
naive），复现不出「按会话时区解释」这一步 —— 这个 bug 在 sqlite 上不存在。所以
本文件用根 ``conftest`` 的 ``db_session``（``TEST_DATABASE_URL`` 指向 BLF_test），
并显式把会话时区钉成 ``+08``，让 CI（时区可能是 UTC）也真跑在触发条件下。

判据选 ``duration_ms < 60_000``：buggy 写入下这里会是 ~28.8M（差 8 小时），修复后
是毫秒级，中间没有灰区。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.schemas.insight import (
    InsightRunRequest,
    InsightStage,
    InsightStatus,
)
from app.services.insight.runs import create_run, to_detail, transition
from app.services.insight.validator import fingerprint_of
from tests.insight.conftest import make_request

#: 8 小时 = 缺陷造成的偏移量级；任何大于它的 duration 都只可能来自时区误解。
_EIGHT_HOURS_MS = 8 * 60 * 60 * 1000


def _completed_run_in_plus8(db: Session, *, key: str):
    """在 ``+08`` 会话下走完一个 run 的完整生命周期（秒级完成）。"""
    db.execute(text("SET TIME ZONE 'Asia/Shanghai'"))
    request = InsightRunRequest.model_validate(
        make_request(idempotency_key=key)
    )
    run, _ = create_run(
        db,
        request=request,
        fingerprint=fingerprint_of(request),
        endpoint_id="default",
        model_id="fake-model",
    )
    transition(db, run, InsightStatus.GENERATING, stage=InsightStage.GENERATING)
    transition(db, run, InsightStatus.FINALIZING, stage=InsightStage.FINALIZING)
    transition(db, run, InsightStatus.COMPLETED, progress=100, content="# 摘要")
    return run


def _seconds_since(instant: datetime) -> float:
    return abs((datetime.now(timezone.utc) - instant).total_seconds())


def test_duration_ms_is_not_inflated_by_8h_in_plus8_session(db_session: Session) -> None:
    """核心回归：+08 会话下 duration_ms 必须是毫秒级，不带 8 小时偏移。

    buggy 写入下 ``started_at`` 被存早 8 小时，而 ``duration_ms`` 用真实的
    ``now`` 去减它 → ~28.8M。这里两个断言都挂。
    """
    run = _completed_run_in_plus8(db_session, key="blf1111-tz-duration")

    assert run.duration_ms is not None
    assert run.duration_ms < 60_000, (
        f"duration_ms={run.duration_ms} —— 疑似 naive 写入被会话时区解释"
        f"（差 {run.duration_ms // _EIGHT_HOURS_MS} 个 8 小时量级）"
    )
    assert run.duration_ms >= 0


def test_stored_instants_round_trip_to_true_utc(db_session: Session) -> None:
    """落库瞬时必须是「真现在」，不是 8 小时前的瞬时。"""
    run = _completed_run_in_plus8(db_session, key="blf1111-tz-roundtrip")

    row = db_session.execute(
        text(
            "SELECT started_at, completed_at, updated_at"
            " FROM insight_runs WHERE run_id = :rid"
        ),
        {"rid": run.run_id},
    ).one()

    for name, stored in zip(
        ("started_at", "completed_at", "updated_at"), row, strict=True
    ):
        assert stored is not None, name
        assert _seconds_since(stored) < 60, (
            f"{name}={stored} 距真实 UTC 现在 {_seconds_since(stored):.0f}s，"
            "疑似被按会话时区解释而偏移"
        )


def test_detail_instants_agree_with_duration(db_session: Session) -> None:
    """``to_detail`` 的 aware 瞬时与 duration_ms 必须自洽（同一条时间线）。"""
    run = _completed_run_in_plus8(db_session, key="blf1111-tz-detail")
    detail = to_detail(run)

    assert detail.started_at is not None
    assert detail.completed_at is not None
    assert detail.started_at.tzinfo is not None
    assert detail.completed_at.tzinfo is not None
    assert detail.started_at <= detail.completed_at

    derived_ms = (detail.completed_at - detail.started_at).total_seconds() * 1000
    assert run.duration_ms is not None
    assert abs(derived_ms - run.duration_ms) < 5, (
        f"completed_at - started_at = {derived_ms:.0f}ms 与 "
        f"duration_ms = {run.duration_ms} 不一致"
    )


def test_status_timeline_stays_utc_z_format(db_session: Session) -> None:
    """时间线对外固定 UTC ``...Z``；改成 aware 写入后不能变成 ``+00:00Z``。"""
    run = _completed_run_in_plus8(db_session, key="blf1111-tz-timeline")

    entries = json.loads(run.status_timeline_json)
    assert len(entries) >= 3  # queued + 每次 transition
    for entry in entries:
        at = entry["at"]
        assert at.endswith("Z"), at
        assert "+00:00" not in at, f"双重标注：{at}"
        parsed = datetime.fromisoformat(at.replace("Z", "+00:00"))
        # 时间线也是真 UTC（buggy 写入下这里会是 naive UTC —— 恰好仍是 UTC，
        # 所以真正钉住的是格式，不是偏移）。
        assert _seconds_since(parsed) < 600, at


@pytest.mark.parametrize(
    "timezone_name",
    ["America/Los_Angeles", "UTC", "Asia/Karachi", "Asia/Shanghai"],
)
def test_derived_instants_are_session_timezone_independent(
    db_session: Session, timezone_name: str
) -> None:
    """换会话时区不改结论：写 aware 值后，偏移量与派生量都不随时区漂移。

    这正是修复的本质判据——旧写法在 ``UTC`` 会话下「恰好正确」、在 ``+08`` 下错 8
    小时；新写法两边一致。
    """
    # ``set_config`` 接受绑定参数（``SET TIME ZONE`` 的语法位置不接受），
    # 所以这里没有拼接 SQL。
    db_session.execute(
        text("SELECT set_config('TimeZone', :tz, false)"), {"tz": timezone_name}
    )
    request = InsightRunRequest.model_validate(
        make_request(idempotency_key=f"blf1111-tz-{timezone_name.replace('/', '-')}")
    )
    run, _ = create_run(
        db_session,
        request=request,
        fingerprint=fingerprint_of(request),
        endpoint_id="default",
        model_id="fake-model",
    )
    transition(db_session, run, InsightStatus.GENERATING, stage=InsightStage.GENERATING)
    transition(db_session, run, InsightStatus.FINALIZING, stage=InsightStage.FINALIZING)
    transition(db_session, run, InsightStatus.COMPLETED, progress=100)

    assert run.duration_ms is not None and run.duration_ms < 60_000
    stored = db_session.execute(
        text("SELECT started_at FROM insight_runs WHERE run_id = :rid"),
        {"rid": run.run_id},
    ).scalar()
    assert _seconds_since(stored) < 60
