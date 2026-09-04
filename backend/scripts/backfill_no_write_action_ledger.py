#!/usr/bin/env python3
"""BLF-533 历史回填：把"当日无写文件动作但仍标记 sent"的 delivery_log 改为 failed。

背景：改造前（BLF-533 未上线），自动调度即使店铺当天没上传任何文件，也会
生成全 0 空报告并把 delivery_log 标记为 sent（台账显示"成功"）。本脚本按与
新门禁一致的判定（has_write_action：覆盖范围内**全部项目 × 全部国家**在报告
覆盖日期是否有写文件动作）重新检查历史 sent 记录：

- 有写动作（Write Log 命中）→ 保留 sent，不动；
- 无写动作（Write Log 为空）→ 标记 failed + error_message="当日无数据写入动作
  （Write Log 为空），已跳过调度"，台账相应显示"失败"（可手动补发）。

安全护栏：
1. 默认 dry-run（只报告，不落库），需显式 --apply 才写入；
2. 只处理 `triggered_by='auto'` 的自动调度记录（手动补发不碰）；
3. 只处理 Write Log 表已开始有数据的日期之后（earliest_log_date 之前无法判定，
   保持原样，避免误伤早期记录）。

用法：
    python scripts/backfill_no_write_action_ledger.py --dry-run
    python scripts/backfill_no_write_action_ledger.py --apply
    python scripts/backfill_no_write_action_ledger.py --start-date 2026-07-01 --end-date 2026-08-07 --apply
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date, timedelta

from sqlalchemy import func, select

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_no_write_action")

from app.db.session import SessionLocal  # noqa: E402
from app.models.auto_report_upload_log import AutoReportUploadLog  # noqa: E402
from app.models.report_upload_log import ReportUploadLog  # noqa: E402
from app.models.scheduled_report import (  # noqa: E402
    DeliveryStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)
from app.services.scheduled_report.data_gate import has_write_action  # noqa: E402


def _earliest_log_date(db) -> date | None:
    """Write Log 两张表里最早有数据的日期；此日期之前无法判定，跳过。"""
    candidates: list[date] = []
    rul = db.execute(select(func.min(ReportUploadLog.upload_date))).scalar()
    if rul is not None:
        candidates.append(rul)
    aru = db.execute(select(func.min(AutoReportUploadLog.created_at))).scalar()
    if aru is not None:
        candidates.append(
            aru.date() if hasattr(aru, "date") else date.fromisoformat(str(aru)[:10])
        )
    return min(candidates) if candidates else None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="BLF-533 历史回填：空报告 sent → failed"
    )
    parser.add_argument(
        "--start-date", help="开始日期 YYYY-MM-DD（默认 earliest_log_date 或 30 天前）"
    )
    parser.add_argument("--end-date", help="结束日期 YYYY-MM-DD（默认今天）")
    parser.add_argument("--apply", action="store_true", help="实际写入（默认 dry-run）")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        earliest = _earliest_log_date(db)
        if earliest is None:
            logger.error("Write Log 表无任何数据，无法判定，中止")
            return 1

        start = (
            date.fromisoformat(args.start_date)
            if args.start_date
            else max(earliest, date.today() - timedelta(days=30))
        )
        if start < earliest:
            logger.warning(
                "start_date=%s 早于 Write Log 最早数据 %s，已钳制到 %s",
                start,
                earliest,
                earliest,
            )
            start = earliest
        end = date.fromisoformat(args.end_date) if args.end_date else date.today()

        logs = (
            db.execute(
                select(ScheduledReportDeliveryLog)
                .where(ScheduledReportDeliveryLog.status == DeliveryStatus.SENT.value)
                .where(ScheduledReportDeliveryLog.triggered_by == "auto")
                .where(ScheduledReportDeliveryLog.report_date >= start.isoformat())
                .where(ScheduledReportDeliveryLog.report_date <= end.isoformat())
                .order_by(ScheduledReportDeliveryLog.report_date)
            )
            .scalars()
            .all()
        )

        logger.info(
            "候选 sent 记录：%d 条（%s ~ %s，earliest_log=%s）",
            len(logs),
            start,
            end,
            earliest,
        )

        changed = 0
        kept = 0
        errors = 0
        for log in logs:
            sub = db.get(ScheduledReportSubscription, log.subscription_id)
            if sub is None:
                logger.warning("log_id=%d 订阅不存在，跳过", log.id)
                errors += 1
                continue
            ok = has_write_action(
                db,
                project_ids=sub.project_id_list or None,
                country=sub.country,
                frequency=sub.frequency,
                report_date=log.report_date,
            )
            if ok:
                kept += 1
                continue
            changed += 1
            logger.info(
                "标记 failed: log_id=%d sub=%d date=%s freq=%s（%s）",
                log.id,
                sub.id,
                log.report_date,
                log.frequency,
                sub.project_ids,
            )
            if args.apply:
                log.status = DeliveryStatus.FAILED.value
                log.error_message = "当日无数据写入动作（Write Log 为空），已跳过调度"
                db.add(log)
                # 同步 ledger entry 状态（fail-safe：refresh_ledger 兜底也会校正）
                entry = (
                    db.execute(
                        select(ScheduledReportLedgerEntry)
                        .where(ScheduledReportLedgerEntry.subscription_id == sub.id)
                        .where(
                            ScheduledReportLedgerEntry.expected_date == log.report_date
                        )
                    )
                    .scalars()
                    .first()
                )
                if entry is not None:
                    entry.status = DeliveryStatus.FAILED.value
                    entry.error_message = log.error_message
                    db.add(entry)

        if args.apply:
            db.commit()
            logger.info("已提交：changed=%d kept=%d errors=%d", changed, kept, errors)
        else:
            logger.info(
                "dry-run：changed=%d kept=%d errors=%d（加 --apply 实际写入）",
                changed,
                kept,
                errors,
            )
        return 0
    except Exception as exc:  # noqa: BLE001
        logger.error("回填失败: %s", exc)
        db.rollback()
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
