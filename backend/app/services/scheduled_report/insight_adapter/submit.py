"""Schedule Report Insight adapter — Insight run 提交与数据组装（BLF-1014）。

`generate_delivery_summary` 的执行主体：为一条 delivery_log 构建
`schedule_report_summary.v1` run 并入队 Celery。三个关键不变量：

1. **幂等**：idempotency_key = ``delivery:{log_id}``。同一 delivery 无论
   重试、worker 重启还是用户重复触发，都 replay 同一 run 行——LLM 只扣
   一次费（create_run 的 scope+key 唯一约束 + start_run 只在 fresh 时
   enqueue，BLF-1011 语义）。
2. **邮件主流程不阻塞**：AI 生成在独立 Celery run 里进行；本模块只提交
   run 并把 delivery_log 标记 generating。提交失败时降级为旧口径的
   failed 状态（typed error 摘要），绝不让 dispatch/邮件路径抛错。
3. **数据在 worker 侧组装**：submit 只落 run 行（slots 里的
   report.data 是构建指令型小载荷），真正的大 payload 由
   `build_report_payload` 在 execute 阶段拉取并填进 run 的 slots。
"""
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.scheduled_report import (
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)
from app.services.insight.executor import start_run
from app.services.insight.runs import (
    IdempotencyConflict,
    get_run,
    to_detail,
)
from app.services.scheduled_report.insight_adapter.slots import (
    ScheduleReportSubject,
    report_context_slot,
    report_data_slot,
)

logger = logging.getLogger(__name__)
#: schedule_report_summary role 的固定标识
ROLE_ID = "schedule_report_summary"
ROLE_VERSION = 1

#: delivery → run 的幂等键前缀（64 字符内，符合 IDEMPOTENCY_KEY_PATTERN）
_IDEMPOTENCY_PREFIX = "delivery"


def idempotency_key_for(log_id: int) -> str:
    """同一 delivery 的所有触发共享一个幂等键。"""
    return f"{_IDEMPOTENCY_PREFIX}:{log_id}"


def _resolve_ledger_entry(
    db: Session, ledger_key: str | None
) -> ScheduledReportLedgerEntry | None:
    if not ledger_key:
        return None
    return db.execute(
        select(ScheduledReportLedgerEntry).where(
            ScheduledReportLedgerEntry.ledger_key == ledger_key
        )
    ).scalars().first()


def _visible_project_id(
    db: Session, project_ids: list[int] | None, country: str
) -> int | None:
    """run scope 的 project_id：订阅项目里第一个属于该国家的。

    Insight run 的 scope 是单 project（Stage 1 合同）；多项目订阅用首个
    项目作 scope 锚点，全部数据仍进 slots。找不到（如项目已删除）返回
    None，由调用方按数据缺失处理。
    """
    if project_ids:
        from app.models.project import Project

        rows = db.execute(
            select(Project.id)
            .where(Project.id.in_(project_ids), Project.country == country)
            .order_by(Project.id)
        ).scalars().all()
        if rows:
            return rows[0]
        rows_any = db.execute(
            select(Project.id).where(Project.id.in_(project_ids)).order_by(Project.id)
        ).scalars().all()
        return rows_any[0] if rows_any else None
    from app.models.project import Project

    row = db.execute(
        select(Project.id).where(Project.country == country).order_by(Project.id)
    ).scalars().first()
    if row is not None:
        return row
    return db.execute(select(Project.id).order_by(Project.id)).scalars().first()


def build_report_payload(
    db: Session, subject: ScheduleReportSubject, *, country: str
) -> dict[str, Any]:
    """构建 AI 输入载荷（与旧 builder 的 report_data_for_ai 同口径）。

    单国家 → 该国 builder 的 ``ai_payload``（旧 AI 输入的冻结形状，
    不含 sku_sales_detail/daily_trend 等大列表，规避 slot 大小上限）；
    多国家 → 多国合并报告（country_data 每国一份裁剪后产物，与旧
    _generate_multi_country_summary 的输入形状一致，一次 run 生成覆盖
    全部站点的统一摘要）。
    """
    from app.services.scheduled_report.dispatcher import (
        _build_multi_country_report,
        _build_report_with_throttle,
    )

    if len(subject.countries) > 1:
        # 多国家 country_data 各国 value 是完整 builder 产物；
        # 裁剪到 ai_payload 形状与单国家口径一致。
        combined = _build_multi_country_report(
            subject.project_ids,
            subject.countries,
            subject.frequency,
            ai_model=subject.ai_model,
            reference_date=subject.reference_date,
            use_cache=False,
            generate_ai_summary=False,
        )
        country_data: dict[str, Any] = {}
        for c, data in combined.get("country_data", {}).items():
            if isinstance(data, dict):
                country_data[c] = data.get("ai_payload") or data
            else:
                country_data[c] = data
        combined["country_data"] = country_data
        return combined

    single = _build_report_with_throttle(
        subject.project_ids,
        country,
        subject.frequency,
        ai_model=subject.ai_model,
        reference_date=subject.reference_date,
        use_cache=False,
        generate_ai_summary=False,
    )
    return single.get("ai_payload") or single


def build_request_slots(
    subject: ScheduleReportSubject,
    *,
    country: str,
    scope_project_id: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """组装 run 的完整 slots（validator 按 role registry 校验）。"""
    context_ids = subject.project_ids or [scope_project_id]
    return {
        "report.context": report_context_slot(
            subject, country=country, project_ids=context_ids
        ),
        "report.data": report_data_slot(payload),
    }


def submit_run_for_delivery(
    db: Session,
    *,
    log_id: int,
    ledger_key: str | None = None,
    override_ai_model: str | None = None,
    scope_authorizer: Any,
    enqueue: Any = None,
    settings: Any = None,
) -> tuple[bool, str | None, str]:
    """为 delivery_log 提交（或 replay）一个 schedule summary run。

    Returns:
        ``(submitted, run_id, message)`` — ``submitted=False`` 时 message
        是人可读原因（订阅缺失/项目不可见等），调用方据此把
        delivery_log 标 failed。已存在完成的 run（重放且 terminal）时返回
        ``submitted=True``，让调用方走终态回写路径。
    """
    log = db.get(ScheduledReportDeliveryLog, log_id)
    if log is None:
        return False, None, "delivery log 不存在"
    subscription = db.get(ScheduledReportSubscription, log.subscription_id)
    if subscription is None:
        return False, None, "订阅不存在或已删除"

    entry = _resolve_ledger_entry(db, ledger_key)
    subject = ScheduleReportSubject.from_delivery(
        log,
        subscription,
        ledger_key=ledger_key,
        expected_date=entry.expected_date if entry else None,
        override_ai_model=override_ai_model,
    )

    # Insight scope 是单国家：多国家订阅按国家逐个提交（调用方循环），
    # 本函数只处理一个国家时由参数 country 决定；这里取订阅首个国家
    # 作为单国家路径（多国家由 submit_runs_for_delivery 展开）。
    country = subject.countries[0] if subject.countries else "US"
    return _submit_one(
        db,
        subject=subject,
        country=country,
        log=log,
        scope_authorizer=scope_authorizer,
        enqueue=enqueue,
        settings=settings,
    )


def _submit_one(
    db: Session,
    *,
    subject: ScheduleReportSubject,
    country: str,
    log: ScheduledReportDeliveryLog,
    scope_authorizer: Any,
    enqueue: Any,
    settings: Any,
) -> tuple[bool, str | None, str]:
    scope_project_id = _visible_project_id(db, subject.project_ids, country)
    if scope_project_id is None:
        return False, None, f"项目范围不可用（country={country}）"

    payload = build_report_payload(db, subject, country=country)
    slots = build_request_slots(
        subject,
        country=country,
        scope_project_id=scope_project_id,
        payload=payload,
    )
    raw: dict[str, Any] = {
        "schema_version": 1,
        "role_id": ROLE_ID,
        "role_version": ROLE_VERSION,
        "project_id": scope_project_id,
        "country": country,
        "slots": slots,
        "idempotency_key": idempotency_key_for(subject.log_id),
    }
    if subject.ai_model:
        raw["model_id"] = subject.ai_model

    try:
        run, replayed = start_run(
            db=db,
            raw=raw,
            scope_authorizer=scope_authorizer,
            enqueue=enqueue,
            settings=settings,
        )
    except IdempotencyConflict:
        # 同 delivery 的 fingerprint 冲突：订阅配置变了（模型/数据口径）。
        # 不覆盖旧 run——旧摘要仍可读；把 delivery 标回 pending 等人工重试。
        logger.warning(
            "insight submit: idempotency conflict log_id=%s", subject.log_id
        )
        return False, None, "同一报告已有不同口径的生成记录，请稍后重试"
    except Exception as exc:  # noqa: BLE001 — 提交失败不阻塞邮件主流程
        logger.warning("insight submit failed log_id=%s: %s", subject.log_id, exc)
        return False, None, f"AI 摘要提交失败：{exc}"

    log.ai_summary_run_id = run.run_id
    db.commit()
    return True, run.run_id, "AI 摘要生成已启动" if not replayed else "AI 摘要生成已在进行中"


def run_detail_for(db: Session, run_id: str) -> Any | None:
    """读取 run 权威 detail（终态回写与状态查询共用）；不存在返回 None。"""
    from app.services.insight.runs import RunNotFound

    try:
        return to_detail(get_run(db, run_id))
    except RunNotFound:
        return None


__all__ = [
    "ROLE_ID",
    "ROLE_VERSION",
    "ScheduleReportSubject",
    "build_report_payload",
    "build_request_slots",
    "idempotency_key_for",
    "run_detail_for",
    "submit_run_for_delivery",
]
