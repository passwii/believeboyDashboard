"""
清理被定时报告缓存 bug 污染的 daily delivery_log

背景：
    2026-05-24 引入 minutely-scan 自动调度路径后，_dispatch_one 没初始化
    dispatcher._summary_cache 全局状态，导致跨日自动调度反复命中前一天的缓存，
    产出的 auto log 截图/数据全部是旧值（BEL: 台账 7.4/7.5 数据错误 bug）。
    bug 已在 _dispatch_one 入口修复（跨日清缓存 + 刷新日期）。

用途：
    历史污染的 auto log 直接 DELETE，ledger entry 状态变成 missing，UI 显示「可补发」
    按钮（用户可选择以后补发，也可不管）。

    已被人工补发过的 entry（latest_log 已指向 manual log）会被自动跳过，避免误删。

使用方法：
    # Dry-run: 只列出哪些会被删，不动数据
    .venv/bin/python scripts/cleanup_polluted_daily_logs.py --dry-run

    # 实际执行：先删 R2 截图（best-effort），再删 DB 行
    .venv/bin/python scripts/cleanup_polluted_daily_logs.py --apply

    # 只删 DB 行，跳过 R2
    .venv/bin/python scripts/cleanup_polluted_daily_logs.py --apply --skip-r2
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 把 backend/ 加进 sys.path，让 `from app.xxx import ...` 能跑
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, delete, select, text  # noqa: E402
from sqlalchemy.orm import Session, sessionmaker  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.models.scheduled_report import (  # noqa: E402
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)


def find_polluted_logs(db: Session) -> list[dict]:
    """找出应该被清理的 delivery_log。

    返回 [{log_id, ledger_key, subscription_id, project_ids, email,
           expected_date, screenshot_r2_key, screenshot_r2_thumb_key,
           skipped_reason_or_None}, ...]
    """
    sql = text(
        r"""
        WITH daily_auto AS (
          SELECT dl.id, dl.subscription_id, dl.frequency, dl.report_date, dl.screenshot_r2_key,
                 SUBSTRING(dl.screenshot_r2_key FROM '/(\d{4}-\d{2}-\d{2})_') AS filename_date
          FROM scheduled_report_delivery_logs dl
          WHERE dl.frequency = 'daily'
            AND dl.screenshot_r2_key IS NOT NULL
            AND dl.report_date = (dl.created_at AT TIME ZONE 'Asia/Shanghai')::date::text
        ),
        lagged AS (
          SELECT *,
                 lag(filename_date) OVER (PARTITION BY subscription_id ORDER BY report_date) AS prev_filename_date
          FROM daily_auto
        )
        SELECT DISTINCT ON (le.ledger_key)
          le.ledger_key,
          le.subscription_id,
          s.email,
          s.project_ids,
          le.expected_date,
          le.latest_delivery_log_id                                       AS polluted_log_id,
          latest_dl.triggered_by                                          AS latest_log_triggered_by,
          latest_dl.screenshot_r2_key,
          latest_dl.screenshot_r2_thumb_key
        FROM lagged
        JOIN scheduled_report_ledger_entries   le        ON le.subscription_id = lagged.subscription_id
                                                       AND le.expected_date   = lagged.report_date
        JOIN scheduled_report_subscriptions    s         ON s.id              = lagged.subscription_id
        LEFT JOIN scheduled_report_delivery_logs latest_dl ON latest_dl.id    = le.latest_delivery_log_id
        WHERE prev_filename_date IS NOT NULL
          AND filename_date = prev_filename_date
        ORDER BY le.ledger_key
        """
    )
    rows = db.execute(sql).mappings().all()

    targets = []
    for r in rows:
        skip_reason = None
        polluted_log_id = r["polluted_log_id"]

        if polluted_log_id is None:
            skip_reason = "ledger entry 无 latest_delivery_log_id（理论上不应出现）"
        elif r["latest_log_triggered_by"] == "manual":
            skip_reason = "latest_log 已是 manual（用户已补发过，跳过）"
        elif r["latest_log_triggered_by"] is None:
            skip_reason = "latest_log 已不存在（FK 已被 set NULL？跳过清理）"

        targets.append({
            "log_id": polluted_log_id,
            "ledger_key": r["ledger_key"],
            "subscription_id": r["subscription_id"],
            "email": r["email"],
            "project_ids": r["project_ids"],
            "expected_date": r["expected_date"],
            "screenshot_r2_key": r["screenshot_r2_key"],
            "screenshot_r2_thumb_key": r["screenshot_r2_thumb_key"],
            "skip_reason": skip_reason,
        })
    return targets


def cleanup_r2_files(targets: list[dict], dry_run: bool) -> tuple[int, int]:
    """best-effort 删 R2 文件。返回 (success_count, fail_count)。"""
    from app.services.r2_service import delete_file_from_r2

    settings = get_settings()
    success = 0
    fail = 0
    for t in targets:
        if t["skip_reason"] is not None:
            continue
        for key_attr in ("screenshot_r2_key", "screenshot_r2_thumb_key"):
            key = t.get(key_attr)
            if not key:
                continue
            if dry_run:
                print(f"  [r2 dry-run] would delete {key}")
                continue
            try:
                delete_file_from_r2(settings, key)
                success += 1
            except Exception as e:
                fail += 1
                print(f"  [r2 fail] {key}: {e}")
    return success, fail


def delete_db_rows(db: Session, log_ids: list[int], dry_run: bool) -> int:
    """DELETE polluted delivery_log 行；FK 自动把 ledger_entry.latest_delivery_log_id SET NULL。"""
    if not log_ids:
        return 0
    if dry_run:
        print(f"  [db dry-run] would DELETE {len(log_ids)} rows from scheduled_report_delivery_logs")
        return 0
    stmt = delete(ScheduledReportDeliveryLog).where(ScheduledReportDeliveryLog.id.in_(log_ids))
    result = db.execute(stmt)
    db.commit()
    return result.rowcount or 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true", help="只列出要删的，不动数据")
    g.add_argument("--apply", action="store_true", help="实际执行删除")
    parser.add_argument("--skip-r2", action="store_true", help="跳过 R2 文件删除，只删 DB 行")
    args = parser.parse_args()
    dry_run = args.dry_run

    settings = get_settings()
    engine = create_engine(settings.database_url, future=True)
    SessionLocal = sessionmaker(bind=engine, future=True)

    with SessionLocal() as db:
        targets = find_polluted_logs(db)

    to_clean = [t for t in targets if t["skip_reason"] is None]
    skipped = [t for t in targets if t["skip_reason"] is not None]

    print(f"\n=== 扫描结果 ===")
    print(f"找到               : {len(targets)} 条 ledger entry（满足污染判据）")
    print(f"将要清理（auto log）: {len(to_clean)} 条")
    print(f"跳过（已 manual 等）: {len(skipped)} 条")
    if skipped:
        print(f"\n--- 跳过明细 ---")
        for t in skipped:
            print(f"  {t['ledger_key']:24s}  log_id={t['log_id']}  reason={t['skip_reason']}")

    if not to_clean:
        print("\n没有需要清理的 log，退出。")
        return 0

    print(f"\n--- 将要清理的 log（前 10 条示例） ---")
    for t in to_clean[:10]:
        print(f"  log_id={t['log_id']:4d}  ledger_key={t['ledger_key']:24s}  "
              f"project={t['project_ids']:6s}  expected={t['expected_date']}  "
              f"r2_key={t['screenshot_r2_key']}")
    if len(to_clean) > 10:
        print(f"  ... 还有 {len(to_clean) - 10} 条")

    if dry_run:
        print(f"\n[DRY-RUN] 不动任何数据。重跑加 --apply 真正删除。")
        return 0

    # 实际删除
    print(f"\n=== 开始清理 ===")
    log_ids = [t["log_id"] for t in to_clean]

    r2_done = r2_fail = 0
    if not args.skip_r2:
        print("[1/2] 删除 R2 截图...")
        r2_done, r2_fail = cleanup_r2_files(to_clean, dry_run=False)
        print(f"  R2 删除成功={r2_done} 失败={r2_fail}")
    else:
        print("[1/2] --skip-r2：跳过 R2 清理")

    print("[2/2] DELETE DB 行（ledger_entry.latest_delivery_log_id 会自动 SET NULL）...")
    with SessionLocal() as db:
        deleted = delete_db_rows(db, log_ids, dry_run=False)
    print(f"  删了 {deleted} 行")

    # 重新打开 session 验证
    with SessionLocal() as db2:
        still_polluted = find_polluted_logs(db2)
        remaining_to_clean = [t for t in still_polluted if t["skip_reason"] is None]
        print(f"\n=== 清理后状态 ===")
        print(f"还剩               : {len(remaining_to_clean)} 条 ledger entry 待清理（应当为 0）")
        print(f"跳过（保持原状）   : {len([t for t in still_polluted if t['skip_reason'] is not None])} 条")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())