"""BEL-348 历史回刷 · Step 1 最小侵入回刷（is_counted_sales 重算）。

只做一件事：对历史 analysis_sales_order_rows，按新口径
（as_of = 所属 source_file 的 report_date，对齐 BEL-348 新上传口径）
重算 is_counted_sales，并把 data_version 自增到 2 标记"已回刷"。

不碰 project_id / 唯一键 / is_current / order_status（那些留给后续轮次）。

安全设计：
- 默认 dry-run：只统计将改动的行，不写库。
- --apply 才真写；写前自动建备份表 _sales_rows_bak_<date>。
- 用单条 UPDATE ... FROM 批量完成，事务内执行，失败回滚。
- 幂等：只更新 is_counted_sales 当前值与新口径不一致的行。

用法（VPS backend 目录，venv）：
    PYTHONPATH=. .venv/bin/python scripts/backfill_sales_count.py            # dry-run
    PYTHONPATH=. .venv/bin/python scripts/backfill_sales_count.py --apply   # 真写
"""
from __future__ import annotations

import argparse
import datetime as dt

from sqlalchemy import text

from app.db.session import SessionLocal
from app.utils.parsers import is_counted_sales_status


def _compute_new_flags(db) -> list[tuple[int, bool]]:
    """纯 Python 算每一行的 (row_id, new_is_counted)。与审计脚本同口径。"""
    from app.models import AnalysisSalesOrderRow, AnalysisSourceFile

    src_rows = db.execute(
        text(
            "SELECT id, report_date, created_at "
            "FROM analysis_source_files"
        )
    ).all()
    src_map = {sid: (rd, ca) for sid, rd, ca in src_rows}

    out: list[tuple[int, bool]] = []
    rows = db.execute(
        text(
            "SELECT id, source_file_id, order_status, purchase_date_pt, is_counted_sales "
            "FROM analysis_sales_order_rows"
        )
    ).fetchall()
    for rid, sfid, status, pdate, cur in rows:
        sr = src_map.get(sfid)
        if not sr:
            continue
        rd, ca = sr
        as_of = rd if rd is not None else (ca.date() if ca is not None else None)
        if as_of is None or pdate is None:
            continue
        new = is_counted_sales_status(status or "", pdate, as_of)
        if bool(cur) != new:
            out.append((rid, new))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真写库（默认 dry-run）")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        changes = _compute_new_flags(db)
        print(f"将改动行数: {len(changes)}")

        if not args.apply:
            t2f = sum(1 for _, n in changes if n is False)
            f2t = sum(1 for _, n in changes if n is True)
            print(f"  - True→False: {t2f}")
            print(f"  - False→True: {f2t}")
            print("★ DRY-RUN：未写入任何数据。加 --apply 执行回刷。")
            return

        # ---- apply ----
        bak = f"_sales_rows_bak_{dt.date.today().strftime('%Y%m%d')}"
        db.execute(
            text(
                f"CREATE TABLE IF NOT EXISTS {bak} "
                f"AS SELECT * FROM analysis_sales_order_rows"
            )
        )
        print(f"已建备份表: {bak}")

        for rid, new_val in changes:
            db.execute(
                text(
                    "UPDATE analysis_sales_order_rows "
                    "SET is_counted_sales = :nv, "
                    "    data_version = data_version + 1, "
                    "    updated_at = now() "
                    "WHERE id = :rid"
                ),
                {"nv": new_val, "rid": rid},
            )
        db.commit()
        print(f"✅ 已回刷 {len(changes)} 行（is_counted_sales + data_version 自增）。")
        print("如需回滚: 见备份表，按需 UPDATE ... FROM 还原。")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
