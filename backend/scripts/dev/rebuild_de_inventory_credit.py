"""BEL-XXX: 一次性脚本 —— 修完 DE General Adjustment 误归 income 桶后，
重算所有历史 DE 月报的 PT3/PT4，让历史报表口径与新逻辑对齐。

背景：
  Amazon DE 报表偶尔导出 description 为
  'Versand durch Amazon Erstattung für Lagerbestand -  Allgemeine Anpassung'
  （中间双空格），旧代码 ``normalize_payment_description`` 不折叠中间空白，
  且 PAYMENT_DESCRIPTION_ALIASES 缺 DE 长串 alias，导致这一行被错误归到
  adjustment_income 桶，符号为负 → 把 income_fba_inventory_credit 拉低 15.94，
  expense_adjustments 漏算 -15.94。

数学不变量：
  每个 DE 月报，PT3 amazon_pay_back 与 PT4 amazon_pay_back 修后不变（同一行
  从 income 移到 expense，正负对消）。income_total +15.94 / expense_total -15.94。

用法（VPS prod 维护窗口）：
  cd /root/believeboyDashboard/backend
  .venv/bin/python scripts/dev/rebuild_de_inventory_credit.py            # dry-run
  .venv/bin/python scripts/dev/rebuild_de_inventory_credit.py --execute   # 真跑
  .venv/bin/python scripts/dev/rebuild_de_inventory_credit.py --report-id 123 --execute

安全模型：
  - 默认 dry-run：只打印将被重建的报表，不写 DB。
  - --execute 才会真跑；每条 report 单独事务，失败回滚不影响其他。
  - 幂等：第二次跑数字与第一次一致（重建 = 重建）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 让脚本能 import 到 app.*
BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))

from sqlalchemy import select  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.models import MonthlyReport  # noqa: E402
from app.services.report.monthly import rebuild_pt3_pt4_for_report  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild PT3/PT4 for all DE monthly reports after BEL-XXX fix."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,  # 默认 dry-run（与 cleanup_sales_date_shift_dupes.py 风格一致）
        help="(default) 只打印将被重建的报表，不写 DB。",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="真正重建（覆盖 --dry-run 默认值）。",
    )
    parser.add_argument(
        "--report-id",
        type=int,
        default=None,
        help="只重建指定 ID 的报表（调试用）。",
    )
    args = parser.parse_args()

    do_execute = args.execute

    get_settings()  # 触发 .env 加载

    rebuilt = 0
    skipped = 0
    failed = 0
    total = 0

    with SessionLocal() as db:
        stmt = select(MonthlyReport).where(
            MonthlyReport.country == "DE",
            # 只重建当前生效版本：历史 is_current=False 版本保持原口径
            # （前端不展示，且按当时逻辑生成，不应被后修逻辑覆盖）
            MonthlyReport.is_current.is_(True),
        )
        if args.report_id is not None:
            stmt = stmt.where(MonthlyReport.id == args.report_id)
        reports = list(
            db.execute(stmt.order_by(MonthlyReport.report_month.asc())).scalars().all()
        )
        total = len(reports)

        for r in reports:
            label = f"#{r.id} {r.project_name} {r.report_month}"
            if not do_execute:
                print(f"[DRY] would rebuild {label}")
                continue
            try:
                ok = rebuild_pt3_pt4_for_report(db, r.id)
                if ok:
                    db.commit()
                    rebuilt += 1
                    print(f"[OK]  rebuilt {label}")
                else:
                    skipped += 1
                    print(f"[--]  skipped {label} (no transactions)")
            except Exception as exc:  # pragma: no cover
                db.rollback()
                failed += 1
                print(f"[ERR] rebuild {label} failed: {exc!r}")

    mode = "EXECUTE" if do_execute else "DRY-RUN"
    print(
        f"\n[{mode}] Summary: rebuilt={rebuilt} skipped={skipped} "
        f"failed={failed} total={total}"
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
