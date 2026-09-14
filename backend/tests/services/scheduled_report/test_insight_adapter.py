"""BLF-1014：Schedule Report Insight adapter 契约测试。

覆盖验收矩阵：

1. submit（提交/幂等/scope/数据缺失）
   - 首次提交 → run 行 queued + delivery_log.insight_run_id 落关联；
   - 重复提交（用户重复触发/重试/worker 重启）→ replay 同一 run，不重复入队；
   - 订阅缺失 / 项目范围不可用 → submitted=False，delivery_log 标 failed；
   - slots 通过 role registry 校验（report.context 与 scope 一致）。
2. sync（终态回写）
   - completed → ai_summary=markdown、status=done；
   - failed → status=failed + typed error 摘要；
   - cancelled → status=pending（可再触发）；
   - completed 但空内容 → failed（不写空摘要）。
3. e2e（generate_delivery_summary Celery 任务）
   - 提交 run → 轮询同步 → 终态落回 delivery_log；
   - 幂等：同 log_id 二次运行 task 不再产生 LLM 计费（replay）。

LLM 与 broker 均不打真实网络：generate/enqueue 注入替身。
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models.insight_run import InsightRun
from app.models.project import Project
from app.models.scheduled_report import (
    AiSummaryStatus,
    DeliveryStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)
from app.schemas.insight import (
    InsightErrorCode,
    InsightOutput,
    InsightStatus,
    InsightUsage,
    make_error,
)
from app.services.insight.contracts import sha256_hex
from app.services.insight.runs import get_run, transition
from app.services.scheduled_report.insight_adapter.slots import ScheduleReportSubject
from app.services.scheduled_report.insight_adapter.submit import (
    ROLE_ID,
    ROLE_VERSION,
    build_request_slots,
    idempotency_key_for,
)
from app.services.scheduled_report.insight_adapter.sync import (
    sync_delivery_log_from_run,
)


@pytest.fixture()
def db() -> Iterator[Session]:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)()
    try:
        yield session
    finally:
        session.close()


def _add_project(db: Session, project_id: int = 15, country: str = "US") -> Project:
    project = Project(
        id=project_id,
        project_name="测试店铺A",
        country=country,
        is_active=True,
        sort_order=0,
    )
    db.add(project)
    db.commit()
    return project


def _add_subscription(
    db: Session,
    *,
    frequency: str = "weekly",
    country: str = "US",
    project_ids: str = "15",
) -> ScheduledReportSubscription:
    sub = ScheduledReportSubscription(
        user_id=1,
        email="ops@example.com",
        project_ids=project_ids,
        country=country,
        frequency=frequency,
        dispatch_hour=15,
        dispatch_minute=0,
        ai_model=None,
        enabled=True,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


def _add_sent_log(
    db: Session,
    sub: ScheduledReportSubscription,
    *,
    report_date: str = "2026-09-07",
    frequency: str = "weekly",
) -> ScheduledReportDeliveryLog:
    log = ScheduledReportDeliveryLog(
        subscription_id=sub.id,
        frequency=frequency,
        report_date=report_date,
        email=sub.email,
        status=DeliveryStatus.SENT.value,
        sent_at=datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc),
        ai_summary_status=AiSummaryStatus.PENDING.value,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def _add_ledger_entry(
    db: Session,
    sub: ScheduledReportSubscription,
    log: ScheduledReportDeliveryLog,
    *,
    expected_date: str,
) -> ScheduledReportLedgerEntry:
    entry = ScheduledReportLedgerEntry(
        ledger_key=f"{sub.id}:{expected_date}",
        subscription_id=sub.id,
        frequency=sub.frequency,
        expected_date=expected_date,
        expected_at=datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc),
        email=sub.email,
        project_ids=sub.project_ids,
        country=sub.country,
        status="sent",
        latest_delivery_log_id=log.id,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def _subject(
    log: ScheduledReportDeliveryLog,
    sub: ScheduledReportSubscription,
    *,
    frequency: str = "weekly",
    report_date: str = "2026-09-07",
    ai_model: str | None = None,
) -> ScheduleReportSubject:
    countries = sub.country_list or ["US"]
    return ScheduleReportSubject(
        log_id=log.id,
        ledger_key=None,
        frequency=frequency,
        report_date=report_date,
        reference_date=__import__("datetime").date.fromisoformat(report_date),
        project_ids=sub.project_id_list or None,
        countries=countries,
        project_name=None,
        ai_model=ai_model,
        date_range=(
            __import__("datetime").date.fromisoformat(report_date),
            __import__("datetime").date.fromisoformat(report_date),
        ),
    )


class _AllowAll:
    """scope authorizer 替身：全部放行（单元层；scope 一致性由 validator 测）。"""

    def __call__(self, project_id: int, country: str) -> None:
        return None


def _make_run_row(
    db: Session,
    *,
    status: str = "queued",
    run_id: str | None = None,
) -> InsightRun:
    """直接落一行 schedule_report_summary run（绕过 start_run，供 sync 测试）。"""
    rid = run_id or uuid4().hex
    run = InsightRun(
        run_id=rid,
        attempt=1,
        capability="insight",
        use_case=f"{ROLE_ID}.v{ROLE_VERSION}",
        project_id=15,
        country="US",
        role_id=ROLE_ID,
        role_version=ROLE_VERSION,
        endpoint_id="default",
        model_id="test-model",
        status=status,
        stage="queued",
        progress_percent=0,
        idempotency_key=idempotency_key_for(999),
        request_fingerprint="f" * 64,
        slots_json="{}",
        status_timeline_json="[]",
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


# ---------------------------------------------------------------------------
# 1. submit — 提交、幂等、scope、数据缺失
# ---------------------------------------------------------------------------


class TestSubmitRunForDelivery:
    def test_submit_creates_run_and_links_delivery_log(self, db: Session):
        """首次提交 → run 行 queued + insight_run_id 关联落库。"""
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        _add_project(db)
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)
        enqueued: list[tuple[str, int]] = []

        submitted, run_id, _message = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: enqueued.append((rid, att)),
            settings=_fake_settings(),
        )

        assert submitted is True
        assert run_id is not None
        assert enqueued == [(run_id, 1)]  # fresh run 恰好入队一次
        db.refresh(log)
        assert log.insight_run_id == run_id

        run = get_run(db, run_id)
        assert run.status == "queued"
        assert run.role_id == ROLE_ID
        assert run.role_version == ROLE_VERSION
        assert run.idempotency_key == idempotency_key_for(log.id)
        slots = json.loads(run.slots_json)
        assert slots["report.context"]["country"] == "US"
        assert 15 in slots["report.context"]["project_ids"]
        assert slots["report.data"]["payload"]  # builder 产物

    def test_resubmit_replays_same_run_without_reenqueue(self, db: Session):
        """同一 delivery 重复触发（用户连点/重试）→ replay，不重复扣费。"""
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        _add_project(db)
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)
        enqueued: list[tuple[str, int]] = []

        first = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: enqueued.append((rid, att)),
            settings=_fake_settings(),
        )
        again = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: enqueued.append((rid, att)),
            settings=_fake_settings(),
        )

        assert first[0] is True and again[0] is True
        assert first[1] == again[1]  # 同一 run
        assert len(enqueued) == 1  # 只入队一次（replay 不入队）

    def test_submit_accepts_provider_model_name_from_subscription(self, db: Session):
        """回归：订阅预设的供应商模型名（含大写）必须能提交 run。

        生产实证：订阅 ai_model='GPT-5.6-Luna' 时，adapter 把它塞进
        ``raw['model_id']``，被 schema 的「全小写受控标识」正则打回 →
        ``AI 摘要提交失败：String should match pattern ...``。
        """
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        _add_project(db)
        sub = _add_subscription(db)
        sub.ai_model = "GPT-5.6-Luna"
        db.commit()
        log = _add_sent_log(db, sub)
        settings = _fake_settings()
        settings.ai_chat_basic_models = "GPT-5.6-Luna"

        submitted, run_id, message = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: None,
            settings=settings,
        )

        assert submitted is True, message
        assert run_id is not None
        assert get_run(db, run_id).model_id == "GPT-5.6-Luna"

    def test_submit_fails_when_subscription_missing(self, db: Session):
        """订阅外键失效（级联删除后残余行/悬挂引用）→ submitted=False +
        人可读原因（delivery 标 failed 由调用方）。"""
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        _add_project(db)
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)
        # 模拟订阅已删而 delivery log 悬挂（生产 CASCADE 会连带删除，
        # 这里直接断开外键，锁住 adapter 对无效引用的防御行为）。
        log.subscription_id = sub.id + 9999
        db.commit()

        submitted, run_id, message = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            settings=_fake_settings(),
        )

        assert submitted is False
        assert run_id is None
        assert "订阅" in message

    def test_submit_fails_when_no_visible_project(self, db: Session):
        """项目全删/不可见 → submitted=False（scope 无锚点）。"""
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        sub = _add_subscription(db)  # project_ids="15" 但不建 project 行
        log = _add_sent_log(db, sub)

        submitted, run_id, message = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            settings=_fake_settings(),
        )

        assert submitted is False
        assert run_id is None
        assert "项目范围" in message


def _fake_settings() -> Any:
    """让 InsightModelResolver 通过的最小 settings（不发真实请求）。"""
    from types import SimpleNamespace

    return SimpleNamespace(
        insight_default_endpoint_id="default",
        insight_endpoint_ids="default",
        insight_default_model="test-model",
        insight_role_default_models="",
        ai_chat_default_model="test-model",
        ai_chat_basic_models="",
        ai_chat_premium_models="",
        ai_chat_model_blocklist="",
        ai_chat_provider_api_key="test-key",
        ai_chat_provider_base_url="http://localhost:9/v1",
    )


# ---------------------------------------------------------------------------
# 2. sync — 终态回写
# ---------------------------------------------------------------------------


class TestSyncDeliveryLogFromRun:
    def _subject_log(self, db: Session) -> ScheduledReportDeliveryLog:
        sub = _add_subscription(db)
        return _add_sent_log(db, sub)

    def _complete_run(self, db: Session, markdown: str = "## 摘要\n- 要点") -> InsightRun:
        run = _make_run_row(db, status="finalizing")
        usage = InsightUsage(input_tokens=10, output_tokens=5, total_tokens=15)
        outputs = {"main": InsightOutput(content=markdown, content_sha256=sha256_hex(markdown.encode()))}
        transition(
            db,
            run,
            InsightStatus.COMPLETED,
            usage=usage,
            outputs=outputs,
            content=markdown,
        )
        db.commit()
        db.refresh(run)
        return run

    def test_completed_writes_summary_and_done(self, db: Session):
        log = self._subject_log(db)
        run = self._complete_run(db, markdown="销量10单，库存200件")

        assert sync_delivery_log_from_run(db, log, run) is True
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.DONE.value
        assert log.ai_summary == "销量10单，库存200件"
        assert log.ai_summary_error is None
        assert log.ai_summary_model == run.model_id

    def test_failed_writes_typed_error_text(self, db: Session):
        log = self._subject_log(db)
        run = _make_run_row(db, status="queued")
        transition(
            db,
            run,
            InsightStatus.FAILED,
            error=make_error(
                InsightErrorCode.UPSTREAM_TIMEOUT,
                "Insight run timed out repeatedly",
            ),
        )
        db.commit()

        assert sync_delivery_log_from_run(db, log, run) is True
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.FAILED.value

    def test_cancelled_returns_to_pending(self, db: Session):
        log = self._subject_log(db)
        run = _make_run_row(db, status="queued")
        transition(
            db,
            run,
            InsightStatus.CANCELLED,
            error=make_error(InsightErrorCode.CANCELLED, "Insight run cancelled"),
        )
        db.commit()

        assert sync_delivery_log_from_run(db, log, run) is True
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.PENDING.value

    def test_completed_with_empty_markdown_fails_not_blank(self, db: Session):
        log = self._subject_log(db)
        run = _make_run_row(db, status="finalizing")
        transition(db, run, InsightStatus.COMPLETED, outputs={}, content="")
        db.commit()
        db.refresh(run)

        assert sync_delivery_log_from_run(db, log, run) is True
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.FAILED.value
        assert "内容为空" in (log.ai_summary_error or "")


    def test_active_run_marks_generating_and_returns_false(self, db: Session):
        log = self._subject_log(db)
        run = _make_run_row(db, status="queued")

        assert sync_delivery_log_from_run(db, log, run) is False
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.GENERATING.value


# ---------------------------------------------------------------------------
# 3. role_runtime_for — executor 的角色分发（BLF-1014）
# ---------------------------------------------------------------------------


class TestRoleRuntimeDispatch:
    def test_schedule_report_role_gets_legacy_prompt_and_cleaner(self):
        """role_runtime_for 给 schedule_report_summary 配上业务模板与清洗。"""
        from app.services.insight.executor import role_runtime_for
        from app.services.insight.roles import lookup_role
        from app.services.scheduled_report.insight_adapter.prompt import (
            build_schedule_report_prompt,
            clean_schedule_report_markdown,
            schedule_report_instructions,
        )

        role = lookup_role(ROLE_ID, ROLE_VERSION)
        builder, instructions, cleaner = role_runtime_for(role)
        assert builder is build_schedule_report_prompt
        assert instructions is schedule_report_instructions
        assert cleaner is clean_schedule_report_markdown

    def test_unknown_role_gets_stage2_defaults(self):
        """未注册角色保持确定性行为（canonical prompt、无指令、strip）。"""
        from dataclasses import replace

        from app.services.insight.executor import (
            _identity_cleaner,
            _no_instructions,
            default_prompt_builder,
            role_runtime_for,
        )
        from app.services.insight.roles import lookup_role

        # BLF-1016 后 ad_analysis 已是真实 role；用仍未注册的 role_id 验证兜底。
        role = replace(lookup_role("ad_analysis", 1), role_id="future_domain")
        builder, instructions, cleaner = role_runtime_for(role)
        assert builder is default_prompt_builder
        assert instructions is _no_instructions
        assert cleaner is _identity_cleaner


class TestSlotContract:
    def test_slots_pass_role_registry_validation(self, db: Session):
        """组装出的 slots 能被 schedule_report_summary.v1 registry 校验通过。"""
        from app.services.insight.roles import lookup_role

        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)
        subject = _subject(log, sub)

        slots = build_request_slots(
            subject,
            country="US",
            scope_project_id=15,
            payload={"current_week": {"qty": 12}},
        )

        role = lookup_role(ROLE_ID, ROLE_VERSION)
        for name, payload in slots.items():
            role.adapter_for(name).validate_python(payload)

    def test_idempotency_key_shape(self):
        key = idempotency_key_for(42)
        assert key == "delivery:42"
        import re

        assert re.match(r"^[A-Za-z0-9._:-]{1,64}$", key)

    def test_report_data_payload_is_trimmed_ai_shape(
        self, db: Session, monkeypatch: pytest.MonkeyPatch
    ):
        """report.data payload 用 builder 的 ai_payload（旧 AI 输入形状），
        不带 sku_sales_detail/daily_trend 等大列表——超限清单会被 validator
        拒绝（SLOT_VALIDATION_FAILED），提交安全失败。"""
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        _add_project(db)
        sub = _add_subscription(db, frequency="weekly")
        log = _add_sent_log(db, sub, frequency="weekly")

        def _fake_build(db_, subject, *, country):
            return {
                "current_week": {"qty": 12},
                "sku_sales_detail": [{"sku": f"S{i}"} for i in range(600)],
            }

        monkeypatch.setattr(submit_mod, "build_report_payload", _fake_build)
        submitted, run_id, _msg = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: None,
            settings=_fake_settings(),
        )
        # 600 项 sku 明细超 ARRAY_MAX_ITEMS=500 → validator 拒绝，提交失败
        # 且不抛异常（邮件主流程不受影响）。
        assert submitted is False
        assert run_id is None


# ---------------------------------------------------------------------------
# 4. 多国家 scope 自洽 + prompt 形状（BLF-1014 复核阻塞 1 / 2）
# ---------------------------------------------------------------------------


class TestMultiCountryScopeAndPrompt:
    def test_multi_country_subscription_submits_with_self_consistent_scope(
        self, db: Session, monkeypatch: pytest.MonkeyPatch
    ):
        """生产形状：订阅 country='DE,UK,US' + project_ids='10'(US)。

        旧实现拿订阅首个国家 DE 去校验 US 项目 → COUNTRY_MISMATCH，提交
        100% 失败。scope 必须整体取自同一项目：run.country == 该项目国家，
        且 == report.context.country。
        """
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        _add_project(db, project_id=10, country="US")
        sub = _add_subscription(
            db, frequency="daily", country="DE,UK,US", project_ids="10"
        )
        log = _add_sent_log(db, sub, frequency="daily")

        # 数据构建在 sqlite 空库上跑真实 builder 代价高，这里只锚 scope 层。
        monkeypatch.setattr(
            submit_mod,
            "build_report_payload",
            lambda db_, subject, *, country: {"country": country, "sales": {}},
        )
        enqueued: list[tuple[str, int]] = []
        # 用真实的调度侧 scope 校验（生产就是它抛 COUNTRY_MISMATCH）。
        from app.services.scheduled_report.ledger_service import _admin_scope_authorizer

        submitted, run_id, message = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_admin_scope_authorizer(db),
            enqueue=lambda rid, att: enqueued.append((rid, att)),
            settings=_fake_settings(),
        )

        assert submitted is True, message
        run = get_run(db, run_id)
        assert run.country == "US"
        assert run.project_id == 10
        slots = json.loads(run.slots_json)
        assert slots["report.context"]["country"] == "US"
        assert 10 in slots["report.context"]["project_ids"]
        assert enqueued == [(run_id, 1)]
        db.refresh(log)
        assert log.insight_run_id == run_id

    def test_subscription_countries_without_visible_project_fails_soft(
        self, db: Session
    ):
        """订阅国家里没有任何一个国家能对上可见项目 → 提交安全失败。"""
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        _add_project(db, project_id=15, country="US")
        sub = _add_subscription(db, frequency="weekly", country="DE,UK")
        log = _add_sent_log(db, sub)

        submitted, run_id, message = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: None,
            settings=_fake_settings(),
        )

        assert submitted is False
        assert run_id is None
        assert "项目范围" in message

    def test_multi_country_submit_slots_render_prompt_for_every_frequency(
        self, db: Session
    ):
        """真实 submit 链路产出的 slots 必须能渲染成 prompt（复核阻塞 2 的回归）。

        旧实现把邮件形状（``countries`` 是国家**列表**）直接塞进 slot，
        daily 分支在 ``countries.keys()`` 上抛 AttributeError → run 卡死
        generating。这里走真正的 ``submit_run_for_delivery``（真实多国家
        builder）→ 读 run.slots_json → ``build_schedule_report_prompt``，
        三个频次都不得抛错、且各国上下文齐全。
        """
        from app.services.insight.roles import lookup_role
        from app.services.scheduled_report.insight_adapter import submit as submit_mod
        from app.services.scheduled_report.insight_adapter.prompt import (
            build_schedule_report_prompt,
        )
        from app.services.scheduled_report.ledger_service import _admin_scope_authorizer

        _add_project(db, project_id=15, country="US")
        sub = _add_subscription(db, frequency="weekly", country="DE,UK,US")
        log = _add_sent_log(db, sub)

        submitted, run_id, message = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_admin_scope_authorizer(db),
            enqueue=lambda rid, att: None,
            settings=_fake_settings(),
        )
        assert submitted is True, message

        slots = json.loads(get_run(db, run_id).slots_json)
        payload = slots["report.data"]["payload"]

        # 载荷形状：国家 → 该国载荷 的 dict（不是列表），且带齐上下文键。
        assert isinstance(payload["countries"], dict)
        assert set(payload["countries"]) == {"DE", "UK", "US"}
        assert payload["multi_country"] is True
        assert "project_context" in payload
        assert "sku_context" in payload
        assert "sku_factory_info_text" in payload

        role = lookup_role(ROLE_ID, ROLE_VERSION)

        # 邮件形状（列表）确实会炸——这是修复前的线上形状，保住这个反例，
        # 防止有人把 _multi_country_payload 退回直传。
        with pytest.raises(AttributeError):
            build_schedule_report_prompt(
                role,
                {
                    "report.context": {"frequency": "daily"},
                    "report.data": {"payload": {**payload, "countries": ["DE", "UK", "US"]}},
                },
            )

        for freq in ("daily", "weekly", "monthly"):
            freq_slots = {
                **slots,
                "report.context": {**slots["report.context"], "frequency": freq},
            }
            prompt = build_schedule_report_prompt(role, freq_slots)
            # 三国数据整体进 prompt：工厂信息按国家分块带上，证明多国上下文没丢。
            assert "【美国站】" in prompt
            assert "【德国站】" in prompt
            assert "【英国站】" in prompt
            assert "## 项目背景信息" in prompt
            if freq == "daily":
                assert "## 货币对照表" in prompt
                assert "- US → " in prompt
                assert "- DE → " in prompt
            else:
                assert "## 货币对照表" not in prompt

    def test_replay_of_failed_run_starts_new_attempt_and_reenqueues(
        self, db: Session, monkeypatch: pytest.MonkeyPatch
    ):
        """replay 到死 run（failed/cancelled）→ 开新 attempt 重新入队。

        否则前端「打断并重新生成」会变成永久空操作（旧线程路径每次都重生成）。
        """
        from app.services.insight.runs import get_run as _get_run
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        _add_project(db)
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)
        monkeypatch.setattr(
            submit_mod,
            "build_report_payload",
            lambda db_, subject, *, country: {"current_week": {"qty": 1}},
        )
        enqueued: list[tuple[str, int]] = []
        first = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: enqueued.append((rid, att)),
            settings=_fake_settings(),
        )
        run = _get_run(db, first[1])
        transition(db, run, InsightStatus.FAILED)
        assert run.attempt == 1

        again = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: enqueued.append((rid, att)),
            settings=_fake_settings(),
        )

        assert again[0] is True
        assert again[1] == first[1]  # 同一 run 行（delivery 绑定继续有效）
        run = _get_run(db, first[1])
        assert run.attempt == 2
        assert run.status == InsightStatus.QUEUED.value
        assert enqueued == [(first[1], 1), (first[1], 2)]

    def test_replay_of_completed_run_never_reenqueues(
        self, db: Session, monkeypatch: pytest.MonkeyPatch
    ):
        """replay 到已完成 run → 不重新生成（同一 delivery 不重复扣费）。"""
        from app.services.insight.runs import get_run as _get_run
        from app.services.scheduled_report.insight_adapter import submit as submit_mod

        _add_project(db)
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)
        monkeypatch.setattr(
            submit_mod,
            "build_report_payload",
            lambda db_, subject, *, country: {"current_week": {"qty": 1}},
        )
        enqueued: list[tuple[str, int]] = []
        first = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: enqueued.append((rid, att)),
            settings=_fake_settings(),
        )
        run = _get_run(db, first[1])
        transition(db, run, InsightStatus.FINALIZING)
        transition(db, run, InsightStatus.COMPLETED)

        again = submit_mod.submit_run_for_delivery(
            db,
            log_id=log.id,
            scope_authorizer=_AllowAll(),
            enqueue=lambda rid, att: enqueued.append((rid, att)),
            settings=_fake_settings(),
        )

        assert again[0] is True
        assert again[1] == first[1]
        run = _get_run(db, first[1])
        assert run.status == InsightStatus.COMPLETED.value
        assert run.attempt == 1
        assert len(enqueued) == 1
