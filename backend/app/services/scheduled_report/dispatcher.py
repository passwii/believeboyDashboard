"""Scheduled report dispatcher with AI summary rate limiting.

Dispatches report emails for all active subscriptions of a given frequency.
Uses a threading semaphore to limit concurrent AI API calls (default: 4),
and caches AI summaries by (project_ids, country, date) to avoid duplicate
requests when multiple users subscribe to the same project.

Design notes on AI timeout:
- Per-call AI timeout (30s) is enforced INSIDE the report builders using
  ThreadPoolExecutor + .result(timeout=30). This works in any thread context.
- The old SIGALRM-based pipeline timeout (AI_SUMMARY_TIMEOUT_SEC = 120s) is
  kept as a safety net on the main thread only. Worker threads cannot use
  signals, so they rely on the per-call timeout.
- Cache is cleared per dispatch run to keep memory bounded.
"""

from __future__ import annotations

import logging
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from typing import Any

from celery.exceptions import SoftTimeLimitExceeded, TimeLimitExceeded
from sqlalchemy import select as sa_select

from app.db.session import SessionLocal
from app.services.scheduled_report.email_sender_daily import send_scheduled_report_email
from app.services.scheduled_report.email_sender_monthly import send_monthly_report_email
from app.services.scheduled_report.email_sender_weekly import send_weekly_report_email
from app.services.scheduled_report.report_builder_daily import build_report_email_data
from app.services.scheduled_report.report_builder_monthly import build_monthly_report_data
from app.services.scheduled_report.report_builder_weekly import build_weekly_report_data
from app.services.scheduled_report.subscription_service import (
    create_delivery_log,
    create_delivery_log_with_stage,
    get_active_subscriptions,
    mark_delivery_failed,
    mark_delivery_success,
    update_delivery_log_stage,
)
from app.models.scheduled_report import (
    DeliveryStage,
    LedgerStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
)

logger = logging.getLogger(__name__)

# ── AI concurrency & timeout control ─────────────────────────────────────────
AI_CONCURRENCY_LIMIT = 4  # 每轮最多 4 个 AI 调用并发（15 项目分 2 轮，每轮 8+7=15）
# Overall pipeline timeout per AI call (seconds).
# NOTE: The per-call AI timeout is now enforced inside report_builder_daily /
# report_builder_weekly via ThreadPoolExecutor + .result(timeout=30).  This
# global timeout acts as a safety net for the entire _build_report_data call
# (data-fetching + AI + post-processing).  It only takes effect on the main
# thread where SIGALRM is available; worker threads rely on the per-call timeout.
AI_SUMMARY_TIMEOUT_SEC = 120

_ai_semaphore = threading.Semaphore(AI_CONCURRENCY_LIMIT)

# Per-dispatch-run cache: (project_ids_key, country, date_str, summary_mode) -> report_data dict
# Date and summary mode are included so same project+country on different days or
# AI/no-AI build modes don't collide.
_summary_cache: dict[tuple[str, str, str, str], dict[str, Any]] = {}
_cache_lock = threading.Lock()

# Per-dispatch timestamp — used as the "report date" for the cache key.
# Set at the start of each dispatch_reports() call.
_dispatch_date_str: str = ""


def _cache_key(
    project_ids: list[int] | None,
    country: str,
    date_str: str,
    generate_ai_summary: bool = True,
) -> tuple[str, str, str, str]:
    """Build a cache key that includes project list, country, date and AI mode."""
    if not project_ids:
        proj_key = "*"
    else:
        proj_key = ",".join(str(pid) for pid in sorted(project_ids))
    return (proj_key, country, date_str, "ai" if generate_ai_summary else "noai")


def _raise_timeout(*args):
    """Called by signal handler when AI call times out."""
    raise TimeoutError("AI summary timed out")


# ── Minimum stage display duration ───────────────────────────────────────────
# Ensures fast stages remain visible long enough for the user to notice them.
_STAGE_MIN_SEC = 1.5


def _report_stage(
    db,
    log_id: int,
    stage: str,
    *,
    _stage_started: list[float] | None = None,
) -> None:
    """Update delivery log stage, enforcing a minimum display duration.

    `_stage_started` is a mutable ``[timestamp]`` list used as a
    single-element accumulator so the caller can track when the
    *current* stage began without passing a non-primitive around.
    """
    if _stage_started is not None:
        elapsed = time.monotonic() - _stage_started[0]
        if elapsed < _STAGE_MIN_SEC:
            time.sleep(_STAGE_MIN_SEC - elapsed)
    update_delivery_log_stage(db, log_id, stage)
    if _stage_started is not None:
        _stage_started[0] = time.monotonic()


def _build_report_data_with_timeout(
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    date_str: str,
    ai_model: str | None = None,
    reference_date: "date | None" = None,
    stage_callback: Any = None,
    generate_ai_summary: bool = True,
) -> dict[str, Any]:
    """Build report data inside the semaphore, with optional per-call timeout.

    Uses signal.SIGALRM on UNIX platforms (non-blocking per-call alarm).
    Falls back to direct call on Windows or if signals are unavailable.
    """
    if AI_SUMMARY_TIMEOUT_SEC <= 0 or threading.current_thread() is not threading.main_thread():
        return _do_build_report(
            project_ids,
            country,
            frequency,
            ai_model=ai_model,
            reference_date=reference_date,
            stage_callback=stage_callback,
            generate_ai_summary=generate_ai_summary,
        )

    try:
        old_handler = signal.signal(signal.SIGALRM, _raise_timeout)
        signal.alarm(AI_SUMMARY_TIMEOUT_SEC)
        try:
            result = _do_build_report(
                project_ids,
                country,
                frequency,
                ai_model=ai_model,
                reference_date=reference_date,
                stage_callback=stage_callback,
                generate_ai_summary=generate_ai_summary,
            )
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
        return result
    except (AttributeError, OSError):
        # signal.SIGALRM not available on Windows — call without timeout
        return _do_build_report(
            project_ids,
            country,
            frequency,
            ai_model=ai_model,
            reference_date=reference_date,
            stage_callback=stage_callback,
            generate_ai_summary=generate_ai_summary,
        )
    except TimeoutError:
        logger.warning(
            "AI summary timed out for project=%s country=%s date=%s — using fallback",
            project_ids, country, date_str,
        )
        return _fallback_report_data(project_ids, country, frequency, reference_date=reference_date)


def _do_build_report(
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    ai_model: str | None = None,
    reference_date: "date | None" = None,
    stage_callback: Any = None,
    generate_ai_summary: bool = True,
) -> dict[str, Any]:
    """Build report data (no timeout protection — run inside semaphore)."""
    db = SessionLocal()
    try:
        if frequency == "monthly":
            return build_monthly_report_data(
                db=db,
                project_ids=project_ids,
                country=country,
                reference_date=reference_date,
                stage_callback=stage_callback,
                generate_ai_summary=generate_ai_summary,
            )
        if frequency == "weekly":
            return build_weekly_report_data(
                db=db,
                project_ids=project_ids,
                country=country,
                reference_date=reference_date,
                stage_callback=stage_callback,
                generate_ai_summary=generate_ai_summary,
            )
        return build_report_email_data(
            db=db,
            project_ids=project_ids,
            country=country,
            frequency=frequency,
            ai_model=ai_model,
            reference_date=reference_date,
            stage_callback=stage_callback,
            generate_ai_summary=generate_ai_summary,
        )
    finally:
        db.close()


def _fallback_report_data(
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    reference_date: "date | None" = None,
) -> dict[str, Any]:
    """Return report with plain-text fallback summary when AI times out.

    This is only called by the SIGALRM safety-net on the main thread.
    The report builders already handle per-call AI timeout internally,
    so this path exists as a last-resort fallback.
    """
    db = SessionLocal()
    try:
        if frequency == "monthly":
            data = build_monthly_report_data(
                db=db,
                project_ids=project_ids,
                country=country,
                reference_date=reference_date,
                ai_timeout=0,
            )
            data["ai_summary"] = "AI 摘要生成超时，请登录仪表板查看详情。"
            return data

        if frequency == "weekly":
            data = build_weekly_report_data(
                db=db,
                project_ids=project_ids,
                country=country,
                reference_date=reference_date,
                ai_timeout=0,
            )
            data["ai_summary"] = "AI 摘要生成超时，请登录仪表板查看详情。"
            return data

        data = build_report_email_data(
            db=db,
            project_ids=project_ids,
            country=country,
            frequency=frequency,
            reference_date=reference_date,
            ai_timeout=0,
        )
        # The builder already called _generate_summary(timeout=30) internally.
        # If that also timed out, ai_summary will be the fallback text already.
        # If we still need to ensure no AI call was made, overwrite:
        if not data.get("ai_summary"):
            from app.services.scheduled_report.report_builder_daily import _generate_fallback_summary
            data["ai_summary"] = _generate_fallback_summary(frequency, data)
        return data
    finally:
        db.close()


def _build_report_with_throttle(
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    ai_model: str | None = None,
    reference_date: "date | None" = None,
    stage_callback: Any = None,
    use_cache: bool = True,
    generate_ai_summary: bool = True,
) -> dict[str, Any]:
    """Build report data, throttling AI summary generation via semaphore.

    If another thread already built the same report (same projects + country + date),
    return the cached version to avoid a redundant AI call.

    If the AI call exceeds AI_SUMMARY_TIMEOUT_SEC, it is cancelled and a
    fallback summary is used instead — the semaphore slot is always released.
    """
    # 补发时使用历史日期作为缓存键，避免与当天调度的缓存混淆
    date_str = reference_date.isoformat() if reference_date else _dispatch_date_str
    key = _cache_key(project_ids, country, date_str, generate_ai_summary)

    if not use_cache:
        return _build_report_data_with_timeout(
            project_ids, country, frequency, date_str, ai_model=ai_model,
            reference_date=reference_date, stage_callback=stage_callback,
            generate_ai_summary=generate_ai_summary,
        )

    # ── fast path: cache hit (no semaphore needed) ──────────────────────────
    with _cache_lock:
        if key in _summary_cache:
            logger.info("AI summary cache hit: %s", key)
            return _summary_cache[key]

    # ── slow path: acquire semaphore → throttle AI calls ────────────────────
    _ai_semaphore.acquire()
    try:
        # Double-check cache after acquiring semaphore
        with _cache_lock:
            if key in _summary_cache:
                return _summary_cache[key]

        report_data = _build_report_data_with_timeout(
            project_ids, country, frequency, date_str, ai_model=ai_model,
            reference_date=reference_date, stage_callback=stage_callback,
            generate_ai_summary=generate_ai_summary,
        )

        with _cache_lock:
            _summary_cache[key] = report_data

        return report_data
    finally:
        _ai_semaphore.release()


def _build_multi_country_report(
    project_ids: list[int] | None,
    country_list: list[str],
    frequency: str,
    ai_model: str | None = None,
    reference_date: "date | None" = None,
    stage_callback: Any = None,
    use_cache: bool = True,
    generate_ai_summary: bool = True,
) -> dict[str, Any]:
    """Build report data for multiple countries, each fetched independently.

    Returns a combined dict with ``is_multi_country=True`` and a
    ``country_data`` mapping from country code to its individual report_data.
    """
    from app.services.scheduled_report.email_sender import _country_label

    country_data: dict[str, dict[str, Any]] = {}
    for country in country_list:
        try:
            data = _build_report_with_throttle(
                project_ids, country, frequency,
                ai_model=ai_model, reference_date=reference_date,
                stage_callback=stage_callback, use_cache=use_cache,
                generate_ai_summary=generate_ai_summary,
            )
            country_data[country] = data
        except Exception as e:
            logger.warning("Failed to build report for country=%s: %s", country, e)
            if frequency == "weekly":
                country_data[country] = {
                    "current_week": {"qty": 0, "amount": 0.0, "orders": 0, "avg_price": 0.0},
                    "prev_week": {"qty": 0, "amount": 0.0, "orders": 0, "avg_price": 0.0},
                    "changes": {}, "attribution": [], "top_skus_comparison": [],
                    "ads_comparison": {}, "inventory_alerts": [],
                    "inventory_summary": {
                        "sku_count": 0, "total_available": 0,
                        "low_stock_count": 0, "oos_count": 0,
                    },
                    "returns_data": {"qty": 0, "rate": 0.0},
                    "daily_trend": [], "sku_sales_detail": [],
                    "alerts": [], "action_items": [],
                    "country": country,
                    "report_date": (reference_date or date.today()).isoformat(),
                    "date_range": "",
                    "ai_summary": f"暂无 {_country_label(country)} 数据",
                }
            elif frequency == "monthly":
                country_data[country] = {
                    "current_month": {"qty": 0, "amount": 0.0, "avg_price": 0.0},
                    "prev_month": {"qty": 0, "amount": 0.0, "avg_price": 0.0},
                    "yoy_month": {"qty": 0, "amount": 0.0, "avg_price": 0.0},
                    "mom_changes": {}, "yoy_changes": {},
                    "attribution": [], "top_skus_comparison": [],
                    "ads_comparison": {}, "inventory_alerts": [],
                    "returns_data": {"qty": 0, "rate": 0.0},
                    "weekly_trend": [], "sku_sales_detail": [],
                    "alerts": [], "action_items": [],
                    "country": country,
                    "report_date": (reference_date or date.today()).isoformat(),
                    "month_label": "",
                    "date_range": "",
                    "ai_summary": f"暂无 {_country_label(country)} 数据",
                }
            else:
                country_data[country] = {
                    "sales": {}, "week_sales": {}, "prev_week_sales": {},
                    "trend_days": [], "top_skus": [], "sku_sales_detail": [],
                    "inventory": {}, "alert_rows": [], "ads": {},
                    "returns": {"qty": 0, "rate": 0, "top_returns": []},
                    "country": country,
                    "report_date": (reference_date or date.today()).isoformat(),
                    "date_range": "",
                    "ai_summary": f"暂无 {_country_label(country)} 数据",
                }

    # Use first country's data for shared shell fields
    first = country_data[country_list[0]]

    # Build a unified AI summary covering all countries
    ai_summary = ""
    if generate_ai_summary:
        ai_summary = _generate_multi_country_summary(
            frequency, country_data, ai_model=ai_model,
        )

    # Build result dict — include keys from both daily and weekly formats
    # so that both email senders can find what they need
    result: dict[str, Any] = {
        "is_multi_country": True,
        "countries": country_list,
        "country_data": country_data,
        "project_name": first.get("project_name", "项目"),
        "country": ",".join(country_list),
        "report_date": first.get("report_date", date.today().isoformat()),
        "date_range": first.get("date_range", ""),
        "ai_summary": ai_summary,
    }

    if frequency == "weekly":
        result.update({
            "current_week": first.get("current_week", {}),
            "prev_week": first.get("prev_week", {}),
            "changes": first.get("changes", {}),
            "attribution": first.get("attribution", []),
            "top_skus_comparison": first.get("top_skus_comparison", []),
            "ads_comparison": first.get("ads_comparison", {}),
            "inventory_alerts": first.get("inventory_alerts", []),
            "inventory_summary": first.get("inventory_summary", {
                "sku_count": 0, "total_available": 0,
                "low_stock_count": 0, "oos_count": 0,
            }),
            "returns_data": first.get("returns_data", {}),
            "daily_trend": first.get("daily_trend", []),
            "sku_sales_detail": first.get("sku_sales_detail", []),
            "alerts": first.get("alerts", []),
            "action_items": first.get("action_items", []),
            "week_number": first.get("week_number", ""),
        })
    elif frequency == "monthly":
        result.update({
            "current_month": first.get("current_month", {}),
            "prev_month": first.get("prev_month", {}),
            "yoy_month": first.get("yoy_month", {}),
            "mom_changes": first.get("mom_changes", {}),
            "yoy_changes": first.get("yoy_changes", {}),
            "attribution": first.get("attribution", []),
            "top_skus_comparison": first.get("top_skus_comparison", []),
            "ads_comparison": first.get("ads_comparison", {}),
            "inventory_alerts": first.get("inventory_alerts", []),
            "returns_data": first.get("returns_data", {}),
            "weekly_trend": first.get("weekly_trend", []),
            "sku_sales_detail": first.get("sku_sales_detail", []),
            "alerts": first.get("alerts", []),
            "action_items": first.get("action_items", []),
            "month_label": first.get("month_label", ""),
        })
    else:
        result.update({
            "sales": first.get("sales", {}),
            "week_sales": first.get("week_sales", {}),
            "prev_week_sales": first.get("prev_week_sales", {}),
            "period7d_change_pct": first.get("period7d_change_pct", 0),
            "period7d_amount_change_pct": first.get("period7d_amount_change_pct", 0),
            "trend_days": first.get("trend_days", []),
            "top_skus": first.get("top_skus", []),
            "sku_sales_detail": first.get("sku_sales_detail", []),
            "inventory": first.get("inventory", {}),
            "alert_rows": first.get("alert_rows", []),
            "ads": first.get("ads", {}),
            "returns": first.get("returns", {}),
        })

    return result


def _generate_multi_country_summary(
    frequency: str,
    country_data: dict[str, dict[str, Any]],
    ai_model: str | None = None,
    timeout: float | None = None,
) -> str:
    """Generate a single AI summary covering all countries.

    Falls back to per-country bullet points if AI call fails or times out.
    Uses the same thread-based timeout as _generate_summary.
    """
    from app.services.scheduled_report.ai_timeout import get_ai_timeout_sec
    from app.services.scheduled_report.email_sender import _fmt_currency, _country_label
    from app.services.scheduled_report.report_builder_daily import _generate_fallback_summary

    secs = timeout if timeout is not None else get_ai_timeout_sec(frequency)

    if secs <= 0:
        return _fallback_multi_country_summary(country_data)

    from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

    def _call_ai():
        from app.services.scheduled_report.ai_enhancer_daily import generate_ai_summary
        combined: dict[str, Any] = {
            "multi_country": True,
            "countries": {},
        }
        for country, data in country_data.items():
            combined["countries"][country] = {
                "country_label": _country_label(country),
                "sales": data.get("sales", {}),
                "week_sales": data.get("week_sales", {}),
                "prev_week_sales": data.get("prev_week_sales", {}),
                "inventory": data.get("inventory", {}),
                "ads": data.get("ads", {}),
                "returns": data.get("returns", {}),
                "top_skus": data.get("top_skus", []),
            }
        return generate_ai_summary(frequency, combined, model=ai_model)

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_call_ai)
            return future.result(timeout=secs)
    except FuturesTimeout:
        logger.warning(
            "Multi-country AI summary timed out (%.0fs) — using fallback",
            secs,
        )
        return _fallback_multi_country_summary(country_data)
    except Exception as e:
        logger.warning("Multi-country AI summary failed, using fallback: %s", e)
        return _fallback_multi_country_summary(country_data)


def _fallback_multi_country_summary(
    country_data: dict[str, dict[str, Any]],
) -> str:
    """Fallback multi-country summary when AI is unavailable or times out."""
    from app.services.scheduled_report.email_sender import _fmt_currency, _country_label
    parts: list[str] = []
    for country, data in country_data.items():
        label = _country_label(country)
        sales = data.get("sales", {})
        week_sales = data.get("week_sales", {})
        inventory = data.get("inventory", {})

        qty = sales.get("yesterday_qty", 0)
        amt = sales.get("yesterday_amount", 0)
        change_pct = sales.get("change_pct", 0.0)
        p7d_qty = week_sales.get("week_qty", 0)
        p7d_amt = week_sales.get("week_amount", 0.0)

        total_available = inventory.get("total_available", 0)
        in_transit = inventory.get("in_transit", 0)

        amt_str = f"/{_fmt_currency(amt, country)}" if amt > 0 else ""
        p7d_amt_str = f"/{_fmt_currency(p7d_amt, country)}" if p7d_amt > 0 else ""

        inv_parts = [f"库存{total_available}件"]
        if in_transit > 0:
            inv_parts.append(f"在途{in_transit}件")

        # 折行格式：站点名独占一行，数据行简化为「销量/近7天累计/库存」
        line = f"◉ {label}\n销量{qty}单{amt_str}，近7天累计{p7d_qty}单{p7d_amt_str}，{'，'.join(inv_parts)}"

        parts.append(line)
    return "\n\n".join(parts)


def _should_sync_daily_fallback(frequency: str) -> bool:
    """日报频次且 AI 已关闭（AI_SUMMARY_TIMEOUT_SEC_DAILY=0）→ dispatch 同步写 fallback。

    返回 True 时 `_dispatch_one_task_body` 发送成功后直接生成 fallback 摘要落库，
    不派 Celery——前端点完立即出摘要、零转圈。周报/月报恒 False（仍走 Celery）。
    """
    if frequency != "daily":
        return False
    from app.services.scheduled_report.ai_timeout import get_ai_timeout_sec
    return get_ai_timeout_sec("daily") <= 0


def _build_daily_fallback_summary_from_report(
    report_data: dict[str, Any], frequency: str,
) -> str:
    """从已构建的 report_data 同步生成日报 fallback 摘要（不重建数据、不调 AI）。

    日报频次关闭 AI（AI_SUMMARY_TIMEOUT_SEC_DAILY=0）时，dispatch 发送成功即可
    直接落库摘要——点完立即出结果，无需前端轮询 Celery 异步回填。
    多国家路径用 dispatcher 的折行 fallback；单国家路径复用 report_builder_daily。
    """
    from app.services.scheduled_report.report_builder_daily import _generate_fallback_summary

    if report_data.get("is_multi_country"):
        return _fallback_multi_country_summary(report_data.get("country_data", {}) or {})

    # 单国家：report_data 即 overview（含 sales/week_sales/inventory/country）
    return _generate_fallback_summary(frequency, report_data)


def _dispatch_one(
    subscription_id: int,
    email: str,
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    ai_model: str | None = None,
    use_cache: bool = True,
    triggered_by: str = "auto",
    report_date: str | None = None,
) -> dict[str, Any]:
    """原 API 行为（保留 P2-8 回滚安全网）。

    入口做两件事：
    1) 模块全局同步（用 `date.today()`）— 旧路径兼容（thread path 默认 today_str）
    2) 委托给共享主体 `_dispatch_one_task_body(...)`

    manual_log / P0-3 幂等检查全部位于 `_dispatch_one_task_body` 入口，
    旧路径与新 Celery 路径共享同一段业务逻辑，包括 ai_summary Celery 派发。
    """
    # 自动调度路径（scheduler._run_minutely_scan → _dispatch_subscriptions → 本函数）
    # 不会经过 dispatch_reports()，所以这里的 _dispatch_date_str 和 _summary_cache
    # 不会自动初始化。如果跨天直接复用昨天的全局状态，就会让今天的报告命中昨天的
    # 缓存，截图/数据全部变成旧值（见 BEL-xxx：台账 7.4/7.5 截图一致 bug）。
    # 这里在每次进入时确保日期同步、过期缓存清空，与 dispatch_reports() 行为一致。
    global _dispatch_date_str
    today_str = date.today().isoformat()
    if _dispatch_date_str != today_str:
        with _cache_lock:
            _summary_cache.clear()
        _dispatch_date_str = today_str

    return _dispatch_one_task_body(
        subscription_id=subscription_id,
        email=email,
        project_ids=project_ids,
        country=country,
        frequency=frequency,
        ai_model=ai_model,
        use_cache=use_cache,
        triggered_by=triggered_by,
        report_date=report_date,
    )


def _dispatch_one_task_body(
    subscription_id: int,
    email: str,
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    ai_model: str | None = None,
    use_cache: bool = True,
    triggered_by: str = "auto",
    report_date: str | None = None,
    pre_existing_log_id: int | None = None,
    old_log_id: int | None = None,
) -> dict[str, Any]:
    """派发的**业务主体**：手动触发按钮补发/manual_log 跳过/P0-3 幂等护栏/数据/渲染/发送/AI 摘要派发。

    调用方契约（方案 P0 / 切片 2）：
    - 调用方负责模块全局 `_dispatch_date_str` 与传入 `report_date` 对齐；body 内部不触碰全局。
    - 调用方负责 P0-2/P0-3 行级锁前置（在并发 task 入口加速挡；单调用方不阻塞）。
    - body 入口做 `find_successful_manual_log` 业务跳过判定 + 创建 delivery_log。
    - `pre_existing_log_id`: 调用方在派发前已经创建好 delivery_log（例如 resend
      路径为前端先返回 log_id 让轮询能立刻查到准备态）；传入时 body 跳过 CREATE
      ，只 SELECT 该行继续推进（已 `triggered_by='manual'` 等同于"补发"语义）。

    该函数被三块入口共享：
    - `_dispatch_one`（旧 ThreadPoolExecutor 路径，P2-8 回滚安全网，不传 pre_log_id）
    - `app.celery_tasks.scheduled_report.dispatch_one_task`（新 Celery 路径，定时 / 手动 trigger）
    - `resend_ledger_entry_async`（新 Celery 路径 + pre_log_id，复用 P0-1/P0-2/P0-3 护栏）

    末尾 AI 摘要派发走 `app.celery_tasks.ai_summary.generate_delivery_summary.delay(...)`
    （方案 §4.6 / 切片 2）：三条入口都自动获得 ai_summary Celery 化。
    """
    result: dict[str, Any] = {
        "subscription_id": subscription_id,
        "email": email,
        "success": False,
        "skipped": False,
        "error": None,
    }

    report_date_key = report_date or date.today().isoformat()

    db = SessionLocal()
    try:
        if triggered_by == "auto":
            from app.services.scheduled_report.ledger_service import find_successful_manual_log

            manual_log = find_successful_manual_log(
                db,
                subscription_id=subscription_id,
                frequency=frequency,
                report_date=report_date_key,
            )
            if manual_log is not None:
                result.update({
                    "success": True,
                    "skipped": True,
                    "skipped_reason": "manual_log_exists",
                    "manual_log_id": manual_log.id,
                })
                logger.info(
                    "Skip auto dispatch: sub=%d frequency=%s report_date=%s manual_log_id=%d",
                    subscription_id,
                    frequency,
                    report_date_key,
                    manual_log.id,
                )
                db.close()
                return result

        if pre_existing_log_id is not None:
            # Resend 路径：caller 已经创建行 + commit，仅 SELECT 复用。
            log = db.get(ScheduledReportDeliveryLog, pre_existing_log_id)
            if log is None:
                err = f"pre_existing_log_id={pre_existing_log_id} not found"
                logger.error("Resend dispatch error: sub=%d %s", subscription_id, err)
                result["error"] = err
                db.close()
                return result
            log_id = log.id
        else:
            log = create_delivery_log_with_stage(
                db=db,
                subscription_id=subscription_id,
                frequency=frequency,
                report_date=report_date_key,
                report_month=report_date_key[:7] if frequency == "monthly" else None,
                email=email,
                initial_stage=DeliveryStage.PREPARING.value,
                triggered_by=triggered_by,
            )
            log_id = log.id
    except Exception as e:
        logger.error("Failed to create delivery log for sub %d: %s", subscription_id, e)
        result["error"] = str(e)
        db.close()
        return result

    try:
        # 阶段：获取数据 → AI 摘要（由 builder 内部回调）
        _stage_clock = [time.monotonic()]
        _report_stage(db, log_id, DeliveryStage.FETCHING_DATA.value, _stage_started=_stage_clock)

        def _on_stage(stage_name: str) -> None:
            _report_stage(db, log_id, stage_name, _stage_started=_stage_clock)

        # Parse country list — support multi-country subscriptions
        parsed_countries = [c.strip().upper() for c in country.split(",") if c.strip()]
        reference_date = None
        if report_date is not None:
            reference_date = (
                date.fromisoformat(report_date_key)
                if frequency in ("weekly", "monthly")
                else date.fromisoformat(report_date_key) - timedelta(days=1)
            )
        if len(parsed_countries) > 1:
            report_data = _build_multi_country_report(
                project_ids, parsed_countries, frequency,
                ai_model=ai_model, reference_date=reference_date, stage_callback=_on_stage, use_cache=use_cache,
                generate_ai_summary=False,
            )
        else:
            single_country = parsed_countries[0] if parsed_countries else "US"
            report_data = _build_report_with_throttle(
                project_ids, single_country, frequency,
                ai_model=ai_model, reference_date=reference_date, stage_callback=_on_stage, use_cache=use_cache,
                generate_ai_summary=False,
            )
        # Pass log_id to report_data so email_sender can update screenshot info
        report_data["log_id"] = log_id

        # 阶段：渲染 HTML → 截图 → 发送（由 email sender 内部回调推进）
        _report_stage(db, log_id, DeliveryStage.RENDERING_HTML.value, _stage_started=_stage_clock)
        # 订阅未填写邮箱时仅生成报告（数据/截图/AI 摘要），跳过 Resend 发送
        skip_email = not bool(email)
        if frequency == "monthly":
            success, resend_id_or_error = send_monthly_report_email(email, report_data, stage_callback=_on_stage, skip_email=skip_email)
        elif frequency == "weekly":
            success, resend_id_or_error = send_weekly_report_email(email, report_data, stage_callback=_on_stage, skip_email=skip_email)
        else:
            success, resend_id_or_error = send_scheduled_report_email(email, frequency, report_data, stage_callback=_on_stage, skip_email=skip_email)

        if success:
            # 先写入 status/screenshot，再把 stage 置为 done，避免前端轮询竞态。
            mark_delivery_success(db, log_id, resend_id_or_error)
            # 保存截图 R2 信息到 delivery log
            screenshot_key = report_data.get("screenshot_r2_key")
            screenshot_url = report_data.get("screenshot_r2_url")
            screenshot_thumb_key = report_data.get("screenshot_r2_thumb_key")
            screenshot_thumb_url = report_data.get("screenshot_r2_thumb_url")
            if screenshot_key and screenshot_url:
                try:
                    from app.services.scheduled_report.subscription_service import update_delivery_log_screenshot
                    update_delivery_log_screenshot(
                        db=db,
                        log_id=log_id,
                        screenshot_r2_key=screenshot_key,
                        screenshot_r2_url=screenshot_url,
                        screenshot_r2_thumb_key=screenshot_thumb_key,
                        screenshot_r2_thumb_url=screenshot_thumb_url,
                    )
                except Exception as update_err:
                    logger.warning("更新 delivery log 截图信息失败: %s", update_err)

            # 重发 / 手动重触发：新 log 截图已落库后，清理旧 delivery_log 的 R2 截图，
            # 释放存储，避免同一报告日的重复截图无限累积。
            # （旧路径 _dispatch_one_async 里曾做这件事，但新 Celery 路径漏接了，
            #  导致旧截图一直留在 R2 且仍被旧 log 引用。）
            if old_log_id:
                try:
                    _cleanup_old_log_screenshot(db, old_log_id)
                except Exception as cleanup_err:
                    logger.warning("清理旧截图失败 old_log_id=%d: %s", old_log_id, cleanup_err)

            # AI 摘要派发：日报频次已关闭 AI（AI_SUMMARY_TIMEOUT_SEC_DAILY=0）时
            # **同步**生成 fallback 摘要写入 delivery_log（点完立即出摘要、零转圈），
            # 不再派 Celery 异步任务；周报/月报（或 daily 未关 AI 时）走 Celery。
            try:
                from app.services.scheduled_report.subscription_service import (
                    update_delivery_log_ai_summary,
                )

                if _should_sync_daily_fallback(frequency):
                    summary = _build_daily_fallback_summary_from_report(report_data, frequency)
                    if summary:
                        update_delivery_log_ai_summary(
                            db, log_id, summary, ai_model=None,
                        )
                        logger.info(
                            "Daily sync fallback summary written: sub=%d log=%d",
                            subscription_id, log_id,
                        )
                    else:
                        logger.warning(
                            "Daily fallback summary empty, enqueuing Celery: sub=%d log=%d",
                            subscription_id, log_id,
                        )
                        from app.celery_tasks.ai_summary import generate_delivery_summary
                        generate_delivery_summary.delay(
                            log_id=log_id,
                            ledger_key=None,
                            override_ai_model=ai_model,
                        )
                else:
                    from app.celery_tasks.ai_summary import generate_delivery_summary
                    generate_delivery_summary.delay(
                        log_id=log_id,
                        ledger_key=None,
                        override_ai_model=ai_model,
                    )
            except Exception as sum_err:
                logger.warning("启动 delivery log ai_summary task 失败: %s", sum_err)

            update_delivery_log_stage(db, log_id, DeliveryStage.DONE.value)
            result["success"] = True
            logger.info("Report sent: sub=%d email=%s", subscription_id, email)
        else:
            update_delivery_log_stage(db, log_id, DeliveryStage.FAILED.value)
            mark_delivery_failed(db, log_id, resend_id_or_error or "Unknown error")
            result["error"] = resend_id_or_error
            logger.warning("Report send failed: sub=%d error=%s", subscription_id, resend_id_or_error)
    except (SoftTimeLimitExceeded, TimeLimitExceeded) as e:
        # Celery's generic ``except Exception`` writes FAILED but ``str(exc)``
        # is the unhelpful ``SoftTimeLimitExceeded('300s')`` repr — front-end
        # operators can't tell timeout apart from other failures from that
        # alone. Surface the cause explicitly so the UI shows a useful error
        # string. Regression test: tests/services/scheduled_report/
        # test_resend_hang_regression.py.
        timeout_kind = "soft time limit" if isinstance(e, SoftTimeLimitExceeded) else "hard time limit"
        err = f"Dispatch hit {timeout_kind} ({e}); partial work discarded."
        update_delivery_log_stage(db, log_id, DeliveryStage.FAILED.value)
        mark_delivery_failed(db, log_id, err)
        result["error"] = err
        logger.error("Report dispatch %s: sub=%d", timeout_kind, subscription_id)
    except Exception as e:
        update_delivery_log_stage(db, log_id, DeliveryStage.FAILED.value)
        mark_delivery_failed(db, log_id, str(e))
        result["error"] = str(e)
        logger.error("Report dispatch error: sub=%d %s", subscription_id, e)
    finally:
        db.close()

    return result


def _pre_warm_cache(keys: list[tuple[str, str, str, str]], frequency: str) -> None:
    """Pre-build report data for given cache keys, one at a time.

    Acquires the semaphore for each key sequentially so we don't spike
    AI API concurrency. Pre-warming fills the cache so duplicate
    subscriptions skip the semaphore wait entirely.
    """
    for key in keys:
        proj_key, country, _, summary_mode = key
        project_ids = None if proj_key == "*" else [int(p) for p in proj_key.split(",")]
        try:
            _build_report_with_throttle(
                project_ids,
                country,
                frequency,
                generate_ai_summary=(summary_mode == "ai"),
            )
        except Exception as e:
            logger.warning("Pre-warm failed for key=%s: %s", key, e)


def dispatch_reports(frequency: str, triggered_by: str = "auto") -> dict[str, Any]:
    """Dispatch all active subscriptions for the given frequency.

    This is the main entry point called by the scheduler or a manual trigger.
    It runs subscriptions concurrently with a thread pool but limits AI API
    calls to AI_CONCURRENCY_LIMIT at a time via a semaphore.

    Returns a summary dict with counts of sent/failed/total.
    """
    global _summary_cache
    global _dispatch_date_str

    # Reset per-run state
    with _cache_lock:
        _summary_cache = {}
    _dispatch_date_str = date.today().isoformat()

    db = SessionLocal()
    try:
        subscriptions = get_active_subscriptions(db, frequency)
    finally:
        db.close()

    if not subscriptions:
        logger.info("No active %s subscriptions found", frequency)
        return {"frequency": frequency, "total": 0, "sent": 0, "failed": 0, "skipped": 0, "errors": []}

    # ── pre-warm cache for duplicate project+country combos ───────────────────
    combo_counts: dict[tuple[str, str, str, str], int] = {}
    for sub in subscriptions:
        for c in sub.country_list:
            key = _cache_key(sub.project_id_list or None, c, _dispatch_date_str, False)
            combo_counts[key] = combo_counts.get(key, 0) + 1

    dupes_exist = any(c > 1 for c in combo_counts.values())
    if dupes_exist:
        logger.info(
            "Pre-warming cache for %d unique combos (duplicates will hit cache)",
            len(combo_counts),
        )
        _pre_warm_cache(list(combo_counts.keys()), frequency)

    # ── dispatch all subscriptions in parallel ────────────────────────────────
    logger.info("Dispatching %d %s report(s)", len(subscriptions), frequency)

    tasks = [
        {
            "subscription_id": sub.id,
            "email": sub.email,
            "project_ids": sub.project_id_list or None,
            "country": sub.country,
            "frequency": frequency,
            "ai_model": getattr(sub, "ai_model", None),
            "triggered_by": triggered_by,
        }
        for sub in subscriptions
    ]

    results: list[dict[str, Any]] = []
    max_workers = min(len(tasks), 8)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_dispatch_one, **task): task for task in tasks}
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as e:
                task = futures[future]
                logger.error(
                    "Unexpected error dispatching sub %d: %s",
                    task["subscription_id"], e,
                )
                results.append({
                    "subscription_id": task["subscription_id"],
                    "email": task["email"],
                    "success": False,
                    "error": str(e),
                })

    skipped = sum(1 for r in results if r.get("skipped"))
    sent = sum(1 for r in results if r["success"] and not r.get("skipped"))
    failed = sum(1 for r in results if not r["success"])
    errors = [
        {
            "subscription_id": r["subscription_id"],
            "email": r["email"],
            "error": r["error"],
        }
        for r in results if not r["success"]
    ]

    summary = {
        "frequency": frequency,
        "total": len(results),
        "sent": sent,
        "failed": failed,
        "skipped": skipped,
        "errors": errors,
    }
    logger.info("Dispatch complete: %s", summary)

    # Clear cache after run
    with _cache_lock:
        _summary_cache = {}

    return summary


def prewarm_cache_for_frequency(frequency: str) -> dict[str, Any]:
    """Manually pre-warm the AI summary cache for a frequency.

    Useful for running before a big dispatch to prime the cache.
    Returns the number of unique combos pre-warmed.
    """
    global _dispatch_date_str
    _dispatch_date_str = date.today().isoformat()

    db = SessionLocal()
    try:
        subscriptions = get_active_subscriptions(db, frequency)
    finally:
        db.close()

    if not subscriptions:
        return {"frequency": frequency, "warmed": 0}

    combo_keys = set()
    for sub in subscriptions:
        for c in sub.country_list:
            combo_keys.add(_cache_key(sub.project_id_list or None, c, _dispatch_date_str, False))

    _pre_warm_cache(list(combo_keys), frequency)

    logger.info("Pre-warmed %d unique combos for %s", len(combo_keys), frequency)
    return {"frequency": frequency, "warmed": len(combo_keys)}


def dispatch_report_for_subscription(subscription_id: int, triggered_by: str = "manual") -> dict[str, Any]:
    """Dispatch a single subscription (used by manual trigger API).

    双分支（方案 §6 Phase 2 / 切片 3）：
    - `SCHEDULED_REPORT_VIA_CELERY=true`：调 `dispatch_one_task.delay(...)`
      返回 task_id；前端通过 task_id 查 Celery result / delivery_log 轮询进度。
    - `SCHEDULED_REPORT_VIA_CELERY=false`：原 `_dispatch_one(...)` 一行不动。
    """
    # Hoist `date` to top-of-function so both branches (Celery path and
    # rollback path) can use it without UnboundLocalError. Both branches
    # hit `date.today().isoformat()`.
    from datetime import date

    from app.core.config import get_settings
    from app.services.scheduled_report.subscription_service import get_subscription_by_id

    db = SessionLocal()
    try:
        sub = get_subscription_by_id(db, subscription_id)
        # 手动重触发同一天报告时，找出已存在的同 (订阅,日期,频率) 最新 log，
        # 作为 old_log_id 传给 task body，发送成功后清理其旧截图，
        # 避免重复截图在 R2 无限累积。
        old_log_id = None
        if sub is not None:
            today_str = date.today().isoformat()
            existing = db.execute(
                sa_select(ScheduledReportDeliveryLog.id)
                .where(
                    ScheduledReportDeliveryLog.subscription_id == sub.id,
                    ScheduledReportDeliveryLog.report_date == today_str,
                    ScheduledReportDeliveryLog.frequency == sub.frequency,
                )
                .order_by(ScheduledReportDeliveryLog.id.desc())
            ).first()
            old_log_id = existing[0] if existing else None
    finally:
        db.close()

    if not sub:
        return {
            "subscription_id": subscription_id,
            "success": False,
            "error": "Subscription not found",
        }

    settings = get_settings()
    if settings.scheduled_report_via_celery:
        from app.celery_tasks.scheduled_report import dispatch_one as dispatch_one_task

        async_result = dispatch_one_task.delay(
            subscription_id=sub.id,
            email=sub.email,
            project_ids=sub.project_id_list or None,
            country=sub.country,
            frequency=sub.frequency,
            ai_model=getattr(sub, "ai_model", None),
            triggered_by=triggered_by,
            report_date=date.today().isoformat(),
            old_log_id=old_log_id,
        )
        return {
            "subscription_id": sub.id,
            "task_id": async_result.id,
            "queue": "scheduled",
            "status": "enqueued",
            "triggered_by": triggered_by,
        }

    # ----- 回滚形态 -------------------------------------------------------
    global _summary_cache
    global _dispatch_date_str

    if not _dispatch_date_str:
        _dispatch_date_str = date.today().isoformat()

    with _cache_lock:
        _summary_cache = {}

    return _dispatch_one(
        subscription_id=sub.id,
        email=sub.email,
        project_ids=sub.project_id_list or None,
        country=sub.country,
        frequency=sub.frequency,
        ai_model=getattr(sub, "ai_model", None),
        triggered_by=triggered_by,
    )


def _cleanup_old_log_screenshot(db: Session, old_log_id: int) -> None:
    """补发成功后清理旧 delivery_log 的 R2 截图，释放存储。"""
    from app.services.r2_service import delete_file_from_r2
    from app.core.config import get_settings

    old_log = db.get(ScheduledReportDeliveryLog, old_log_id)
    if not old_log:
        return
    settings = get_settings()
    keys_to_delete = [k for k in (old_log.screenshot_r2_key, old_log.screenshot_r2_thumb_key) if k]
    if not keys_to_delete:
        return
    for key in keys_to_delete:
        try:
            delete_file_from_r2(settings, key)
        except Exception as e:
            logger.warning("删除旧截图 R2 文件失败 key=%s: %s", key, e)
    old_log.screenshot_r2_key = None
    old_log.screenshot_r2_url = None
    old_log.screenshot_r2_thumb_key = None
    old_log.screenshot_r2_thumb_url = None
    db.commit()


def _dispatch_one_async(
    subscription_id: int,
    email: str,
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    ai_model: str | None,
    log_id: int,
    ledger_key: str,
    expected_date: str,
    expected_frequency: str,
    use_cache: bool = True,
    old_log_id: int | None = None,
) -> None:
    """后台执行单个订阅的发送（跳过 delivery_log 创建，复用 _dispatch_one 的逻辑）。

    由 resend_ledger_entry_async 启动，在后台线程中运行。
    """
    db = SessionLocal()
    try:
        # 阶段：获取数据 → AI 摘要（由 builder 内部回调）
        _stage_clock = [time.monotonic()]
        _report_stage(db, log_id, DeliveryStage.FETCHING_DATA.value, _stage_started=_stage_clock)

        def _on_stage(stage_name: str) -> None:
            _report_stage(db, log_id, stage_name, _stage_started=_stage_clock)

        # 补发时使用历史日期作为数据锚定，而非当天
        # 月报：数据锚定 = expected_date 本身（_get_report_month 内部会计算上一个自然月）
        # 周报：数据锚定 = expected_date 本身（_get_previous_natural_week 内部会计算上一个自然周）
        # 日报：数据锚定 = expected_date - 1（与正常调度的 _get_report_anchor_date 逻辑一致）
        if frequency in ("weekly", "monthly"):
            ref_date = date.fromisoformat(expected_date)
        else:
            ref_date = date.fromisoformat(expected_date) - timedelta(days=1)

        # Parse country list — support multi-country subscriptions
        parsed_countries = [c.strip().upper() for c in country.split(",") if c.strip()]
        if len(parsed_countries) > 1:
            report_data = _build_multi_country_report(
                project_ids, parsed_countries, frequency,
                ai_model=ai_model, reference_date=ref_date, stage_callback=_on_stage, use_cache=use_cache,
                generate_ai_summary=False,
            )
        else:
            single_country = parsed_countries[0] if parsed_countries else "US"
            report_data = _build_report_with_throttle(
                project_ids, single_country, frequency,
                ai_model=ai_model, reference_date=ref_date, stage_callback=_on_stage, use_cache=use_cache,
                generate_ai_summary=False,
            )
        report_data["log_id"] = log_id

        # 阶段：渲染 HTML → 截图 → 发送（由 email sender 内部回调推进）
        _report_stage(db, log_id, DeliveryStage.RENDERING_HTML.value, _stage_started=_stage_clock)
        # 补发（resend）按设计只重新生成报告、不发送邮件：强制 skip_email=True
        if frequency == "monthly":
            success, resend_id_or_error = send_monthly_report_email(email, report_data, stage_callback=_on_stage, skip_email=True)
        elif frequency == "weekly":
            success, resend_id_or_error = send_weekly_report_email(email, report_data, stage_callback=_on_stage, skip_email=True)
        else:
            success, resend_id_or_error = send_scheduled_report_email(email, frequency, report_data, stage_callback=_on_stage, skip_email=True)

        if success:
            # 先更新 delivery_log 的 status='sent'（在 stage='done' 之前！）
            # 避免竞态：前端轮询看到 stage='done' 后立即刷新台账，
            # 此时 _classify_log 需要看到 status='sent' 才能正确分类
            mark_delivery_success(db, log_id, resend_id_or_error)

            # 保存截图信息并启动 AI 摘要后台任务（在 stage='done' 之前完成主任务落库）
            screenshot_key = report_data.get("screenshot_r2_key")
            screenshot_url = report_data.get("screenshot_r2_url")
            screenshot_thumb_key = report_data.get("screenshot_r2_thumb_key")
            screenshot_thumb_url = report_data.get("screenshot_r2_thumb_url")
            if screenshot_key and screenshot_url:
                try:
                    from app.services.scheduled_report.subscription_service import update_delivery_log_screenshot
                    update_delivery_log_screenshot(
                        db=db,
                        log_id=log_id,
                        screenshot_r2_key=screenshot_key,
                        screenshot_r2_url=screenshot_url,
                        screenshot_r2_thumb_key=screenshot_thumb_key,
                        screenshot_r2_thumb_url=screenshot_thumb_url,
                    )
                except Exception as update_err:
                    logger.warning("更新 delivery log 截图信息失败: %s", update_err)

            # AI 摘要改为后台异步生成，不阻塞补发主任务。
            try:
                from app.services.scheduled_report.ledger_service import enqueue_ai_summary_generation
                enqueue_ai_summary_generation(
                    db=db,
                    log_id=log_id,
                    ledger_key=ledger_key,
                    override_ai_model=ai_model,
                )
            except Exception as sum_err:
                logger.warning("启动 delivery log ai_summary 后台任务失败: %s", sum_err)

            # 直接更新 ledger entry 状态（不依赖后续的 refresh_ledger）
            try:
                ledger_entry = db.execute(
                    sa_select(ScheduledReportLedgerEntry)
                    .where(ScheduledReportLedgerEntry.ledger_key == ledger_key)
                ).scalars().first()
                if ledger_entry:
                    log_obj = db.get(ScheduledReportDeliveryLog, log_id)
                    ledger_entry.status = LedgerStatus.SENT.value
                    ledger_entry.sent_at = log_obj.sent_at if log_obj else None
                    ledger_entry.error_message = None
                    db.commit()
            except Exception as le_err:
                logger.warning("直接更新 ledger entry 状态失败: %s", le_err)

            # 清理旧 delivery_log 的 R2 截图（补发场景，释放存储）
            if old_log_id:
                try:
                    _cleanup_old_log_screenshot(db, old_log_id)
                except Exception as cleanup_err:
                    logger.warning("清理旧截图失败 old_log_id=%d: %s", old_log_id, cleanup_err)

            # 最后设置 stage='done'（前端轮询的触发点）
            # 此时 status='sent' + 截图 + ledger entry 都已就绪；AI 摘要在后台继续生成。
            update_delivery_log_stage(db, log_id, DeliveryStage.DONE.value)

            logger.info("Async report sent: sub=%d email=%s", subscription_id, email)
        else:
            # 失败时也先更新 ledger entry 再设 stage
            mark_delivery_failed(db, log_id, resend_id_or_error or "Unknown error")
            try:
                ledger_entry = db.execute(
                    sa_select(ScheduledReportLedgerEntry)
                    .where(ScheduledReportLedgerEntry.ledger_key == ledger_key)
                ).scalars().first()
                if ledger_entry:
                    ledger_entry.status = LedgerStatus.FAILED.value
                    ledger_entry.error_message = resend_id_or_error or "Unknown error"
                    db.commit()
            except Exception as le_err:
                logger.warning("直接更新 ledger entry 失败状态失败: %s", le_err)
            update_delivery_log_stage(db, log_id, DeliveryStage.FAILED.value)
            logger.warning("Async report send failed: sub=%d error=%s", subscription_id, resend_id_or_error)
    except Exception as e:
        mark_delivery_failed(db, log_id, str(e))
        update_delivery_log_stage(db, log_id, DeliveryStage.FAILED.value)
        logger.error("Async dispatch error: sub=%d %s", subscription_id, e)
    finally:
        db.close()

    # 更新 ledger entry（作为兜底，确保 refresh_ledger 也能正确同步）
    try:
        from app.services.scheduled_report.ledger_service import refresh_ledger
        refresh_db = SessionLocal()
        try:
            refresh_ledger(refresh_db, start_date=expected_date, end_date=expected_date, frequency=expected_frequency)
        finally:
            refresh_db.close()
    except Exception as refresh_err:
        logger.warning("Failed to refresh ledger after async dispatch: %s", refresh_err)
