"""一次性脚本：清理完成后，把 latest_delivery_log_id=NULL 的 ledger entry 状态刷成 missing。

DELETE polluted delivery_log 后 ledger_entry.latest_delivery_log_id 被 FK SET NULL，
但 status 列不会自动更新（只在 refresh_ledger 时才 _classify_log 重算）。
这个脚本调 refresh_ledger() 把受影响日期区间的所有 entry 重新分类。

用法:
    .venv/bin/python scripts/refresh_ledger_status.py --start 2026-05-26 --end 2026-07-05
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import Session, sessionmaker  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.services.scheduled_report.ledger_service import refresh_ledger  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", required=True, help="起始日期 YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="结束日期 YYYY-MM-DD")
    args = parser.parse_args()

    settings = get_settings()
    engine = create_engine(settings.database_url, future=True)
    SessionLocal = sessionmaker(bind=engine, future=True)

    with SessionLocal() as db:
        before_missing = db.execute(
            __import__("sqlalchemy").text(
                "SELECT count(*) FROM scheduled_report_ledger_entries "
                "WHERE latest_delivery_log_id IS NULL AND status != 'missing'"
            )
        ).scalar() or 0
        print(f"[start={args.start}, end={args.end}] 刷新前：{before_missing} 条 ledger entry 是 'latest_log=NULL 但 status≠missing'")

        result = refresh_ledger(db, start_date=args.start, end_date=args.end)
        print(f"刷新完成：total={result.total} sent={result.summary.sent} failed={result.summary.failed} missing={result.summary.missing}")

        after_missing = db.execute(
            __import__("sqlalchemy").text(
                "SELECT count(*) FROM scheduled_report_ledger_entries "
                "WHERE latest_delivery_log_id IS NULL AND status != 'missing'"
            )
        ).scalar() or 0
        print(f"刷新后：{after_missing} 条还是异常（应当为 0）")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())