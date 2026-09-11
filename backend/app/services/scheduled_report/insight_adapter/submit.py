"""Schedule Report Insight adapter — Insight run 提交与数据组装（BLF-1014）。

`generate_delivery_summary` 的执行主体：为一条 delivery_log 构建
`schedule_report_summary.v1` run 并入队 Celery。三个关键不变量：

1. **幂等**：idempotency_key = ``delivery:{log_id}``。同一 delivery 无论
   重试、worker 重启还是用户重复触发，都复用同一 run 行——LLM 只扣一次费
   （create_run 的 scope+key 唯一约束）。仅当复用到的 run 已经死掉
   （failed/cancelled）才开新 attempt 重新入队，completed 一律 replay。
2. **邮件主流程不阻塞**：AI 生成在独立 Celery run 里进行；本模块只提交
   run 并把 delivery_log 标记 generating。提交失败时降级为旧口径的
   failed 状态（typed error 摘要），绝不让 dispatch/邮件路径抛错。
3. **数据在提交期组装**：`build_report_payload` 在 submit 时拉取（或直接
   复用）report_data 并写进 run 的 ``report.data`` slot；worker 只消费
   slots，不再回查业务库。
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
from app.schemas.insight import InsightStatus
from app.services.insight.executor import start_run
from app.services.insight.lifecycle import LifecycleError
from app.services.insight.runs import (
    IdempotencyConflict,
    StaleRunWrite,
    get_run,
    retry_run,
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

#: 三段项目背景：prompt 侧单独成段渲染，不进数据 JSON（见
#: ``ai_schedule_report._build_daily_user_content`` 的 display_data 过滤）
_CONTEXT_KEYS = ("project_context", "sku_context", "sku_factory_info_text")

#: 死掉的 run：行还在，但永远不可能产出摘要 → 再次触发必须开新 attempt。
#: （completed 相反：已有可用摘要，只 replay 不重复扣费。）
_DEAD_RUN_STATUSES = (InsightStatus.FAILED.value, InsightStatus.CANCELLED.value)


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


def _resolve_scope(
    db: Session, project_ids: list[int] | None, countries: list[str]
) -> tuple[int, str] | None:
    """选一组自洽的 run scope ``(project_id, country)``。

    两个约束必须**同时**成立，所以 scope 只能整体取自同一个项目：
    validator 要求 ``report.context.country == run.country``，而
    ``_admin_scope_authorizer`` 要求项目自身的国家就是 run 的国家。分别
    取「订阅首个国家」和「首个项目」（旧 ``countries[0]`` + 回落
    ``rows_any[0]``）在多国家订阅上必然对不上：country='DE,UK,US' + 项目
    10(US) 会拿 DE 去校验 US 项目 → COUNTRY_MISMATCH → 提交 100% 失败。

    取订阅国家顺序里第一个「有可见项目」的国家；订阅未限定项目时按国家
    找项目。这些国家下没有任何可见项目时返回 None，由调用方按数据缺失
    报错（绝不把 run 建在一个不属于订阅范围的国家上）。
    """
    from app.models.project import Project

    stmt = select(Project.id, Project.country).order_by(Project.id)
    if project_ids:
        stmt = stmt.where(Project.id.in_(project_ids))
    by_country: dict[str, int] = {}
    for pid, project_country in db.execute(stmt).all():
        code = (project_country or "").strip().upper()
        if code:
            by_country.setdefault(code, pid)
    for raw in countries:
        code = (raw or "").strip().upper()
        if code in by_country:
            return by_country[code], code
    return None


def _multi_country_payload(combined: dict[str, Any]) -> dict[str, Any]:
    """把邮件形状的多国家报告折成 prompt 侧的 AI 载荷。

    ``_build_multi_country_report`` 的产物是**邮件**形状：``countries`` 是
    国家代码列表、各国数据在 ``country_data`` 里。prompt 侧
    （``ai_schedule_report._build_*_user_content``）读的却是 ``countries``
    **字典** + 顶层三段项目背景——把邮件形状原样塞进 slot，daily 会在
    ``countries.keys()`` 上抛 AttributeError，run 卡在 generating（复核
    阻塞 2）。这里重建旧 ``_generate_multi_country_summary`` 的输入形状。

    各国取 builder 的 ``ai_payload``（与单国家同口径的冻结形状；构建失败
    的国家只有 dispatcher 的兜底 dict，此时退回 dict 本身），并把三段项目
    背景提到顶层：project_context/sku_context 由 project_ids 决定、各国
    相同；sku_factory_info_text 与国家相关，非空者按国家标注合并。
    """
    from app.services.scheduled_report.email_sender import _country_label

    countries: dict[str, Any] = {}
    shared: dict[str, Any] = {}
    factory_blocks: list[tuple[str, str]] = []
    for code, data in (combined.get("country_data") or {}).items():
        if not isinstance(data, dict):
            continue
        payload = data.get("ai_payload") or data
        if not isinstance(payload, dict):
            continue
        countries[code] = {
            k: v for k, v in payload.items() if k not in _CONTEXT_KEYS
        }
        for key in ("project_context", "sku_context"):
            if key not in shared and payload.get(key):
                shared[key] = payload[key]
        text = str(payload.get("sku_factory_info_text") or "").strip()
        if text:
            factory_blocks.append((code, text))

    if len(factory_blocks) == 1:
        factory_text = factory_blocks[0][1]
    else:
        factory_text = "\n\n".join(
            f"【{_country_label(code)}】\n{text}" for code, text in factory_blocks
        )
    return {
        "multi_country": True,
        "countries": countries,
        "project_context": shared.get("project_context"),
        "sku_context": shared.get("sku_context"),
        "sku_factory_info_text": factory_text,
    }


def build_report_payload(
    db: Session, subject: ScheduleReportSubject, *, country: str
) -> dict[str, Any]:
    """构建 AI 输入载荷（与旧 builder 的 report_data_for_ai 同口径）。

    单国家 → 该国 builder 的 ``ai_payload``（旧 AI 输入的冻结形状，
    不含 sku_sales_detail/daily_trend 等大列表，规避 slot 大小上限）；
    多国家 → 旧 ``_generate_multi_country_summary`` 的输入形状（``countries``
    是「国家 → 该国 AI 载荷」的 dict，一个 run 生成覆盖全部站点的统一摘要）。
    """
    from app.services.scheduled_report.dispatcher import (
        _build_multi_country_report,
        _build_report_with_throttle,
    )

    if len(subject.countries) > 1:
        combined = _build_multi_country_report(
            subject.project_ids,
            subject.countries,
            subject.frequency,
            ai_model=subject.ai_model,
            reference_date=subject.reference_date,
            use_cache=False,
            generate_ai_summary=False,
        )
        return _multi_country_payload(combined)

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

    一次 delivery 提交**一个** run：多国家订阅的数据全部进 slots，由同一次
    生成输出覆盖全部站点的统一摘要；run 的 scope 取订阅国家里第一个有可见
    项目的国家（见 ``_resolve_scope``），与 ``report.context.country`` 自洽。

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

    return _submit_one(
        db,
        subject=subject,
        log=log,
        scope_authorizer=scope_authorizer,
        enqueue=enqueue,
        settings=settings,
    )


def _submit_one(
    db: Session,
    *,
    subject: ScheduleReportSubject,
    log: ScheduledReportDeliveryLog,
    scope_authorizer: Any,
    enqueue: Any,
    settings: Any,
) -> tuple[bool, str | None, str]:
    scope = _resolve_scope(db, subject.project_ids, subject.countries)
    if scope is None:
        return False, None, f"项目范围不可用（country={','.join(subject.countries)}）"
    scope_project_id, country = scope

    if enqueue is None:
        # 生产 EnqueueFunc：不显式注入时用真实 Celery 派发（run 只建行不入队
        # 会永远停在 queued，等待方空转到 soft limit——提交即派发是默认语义）。
        from app.celery_tasks.insights.run import enqueue_insight_run

        enqueue = enqueue_insight_run

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

    if replayed and run.status in _DEAD_RUN_STATUSES:
        # 上一次尝试已失败/被取消：run 行虽在，但不可能再产出摘要。旧线程
        # 路径每次触发都重新生成，若这里只 replay，前端「打断并重新生成」
        # 会变成永久空操作。开新 attempt（同一 run 行 → delivery 的
        # insight_run_id 绑定继续有效），并重新派发。
        restarted = False
        try:
            run = retry_run(db, run.run_id)
            db.commit()
            restarted = True
        except (LifecycleError, StaleRunWrite):
            # 并发的另一次触发已经把它重启了：本次不重复入队。
            db.rollback()
            run = get_run(db, run.run_id)
        if restarted:
            enqueue(run.run_id, run.attempt)
        log.insight_run_id = run.run_id
        db.commit()
        return True, run.run_id, (
            "AI 摘要已重新开始生成" if restarted else "AI 摘要生成已在进行中"
        )

    log.insight_run_id = run.run_id
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
