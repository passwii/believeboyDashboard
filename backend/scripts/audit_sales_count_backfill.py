"""BEL-348 历史回刷 · Step 0 只读量化审计（不写库）。

目的：量化"按新口径（as_of = 所属 source_file 的 report_date，
取不到回退 created_at 日期）"重算 is_counted_sales 后，历史订单行
有多少会从现有值翻转。对齐 BEL-348 新上传口径：优先 report_date，
无则回退上传时间。

用法（在 VPS backend 目录，用 venv python 跑）：
    .venv/bin/python scripts/audit_sales_count_backfill.py

只 SELECT，不 UPDATE。输出各项计数与按维度分布。
"""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy import select, func, case
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models import AnalysisSalesOrderRow, AnalysisSourceFile
from app.utils.parsers import is_counted_sales_status


def _as_of_for_source(rec):
    """历史行为推荐的 as_of 快照：优先 report_date，回退 created_at 日期。

    rec: (report_date, created_at) 元组，来自 src_map。
    """
    if not rec:
        return None
    rd, ca = rec
    if rd is not None:
        return rd
    if ca is not None:
        return ca.date()
    return None


def main() -> None:
    db: Session = SessionLocal()
    try:
        # 预取所有 source_file 的 (report_date, created_at)，避免逐行查。
        src_rows = db.execute(
            select(
                AnalysisSourceFile.id,
                AnalysisSourceFile.report_date,
                AnalysisSourceFile.created_at,
            )
        ).all()
        src_map = {sid: (rd, ca) for sid, rd, ca in src_rows}

        total = db.execute(
            select(func.count()).select_from(AnalysisSalesOrderRow)
        ).scalar_one()

        flip_t2f = flip_f2t = no_asof = missing_src = 0
        # 按购买年分布翻转
        by_year = defaultdict(lambda: [0, 0, 0])  # [total, t2f, f2t]
        # 按项目分布
        by_proj = defaultdict(lambda: [0, 0, 0])
        # as_of 来源占比
        asof_from_report = asof_from_created = 0

        rows = db.execute(
            select(
                AnalysisSalesOrderRow.id,
                AnalysisSalesOrderRow.project_id,
                AnalysisSalesOrderRow.source_file_id,
                AnalysisSalesOrderRow.order_status,
                AnalysisSalesOrderRow.purchase_date_pt,
                AnalysisSalesOrderRow.is_counted_sales,
            )
        ).yield_per(2000)

        for rid, pid, sfid, status, pdate, cur in rows:
            sr = src_map.get(sfid)
            asof = _as_of_for_source(sr) if sr else None
            if sr is None:
                missing_src += 1
            if asof is None:
                no_asof += 1
                continue
            if sr and sr[0] is not None:
                asof_from_report += 1
            else:
                asof_from_created += 1

            new = is_counted_sales_status(status or "", pdate, asof)
            year = pdate.year if pdate else 0
            by_year[year][0] += 1
            by_proj[pid][0] += 1
            if new != bool(cur):
                if cur and not new:
                    flip_t2f += 1
                    by_year[year][1] += 1
                    by_proj[pid][1] += 1
                else:
                    flip_f2t += 1
                    by_year[year][2] += 1
                    by_proj[pid][2] += 1

        print("=" * 60)
        print("BEL-348 历史 is_counted_sales 回刷 · 只读量化")
        print("=" * 60)
        print(f"历史订单行总数            : {total}")
        print(f"  - 能取到 as_of 快照    : {total - no_asof - missing_src}")
        print(f"  - 无 source_file 关联  : {missing_src}")
        print(f"  - 有 source 但无 as_of : {no_asof}")
        print(f"as_of 来源: report_date  : {asof_from_report}")
        print(f"as_of 来源: created_at   : {asof_from_created}")
        print("-" * 60)
        print(f"会翻转的总行数            : {flip_t2f + flip_f2t}")
        print(f"  - True → False (去虚高) : {flip_t2f}")
        print(f"  - False → True (补回)   : {flip_f2t}")
        print(f"翻转占比                  : {(flip_t2f + flip_f2t) / total * 100:.2f}%")
        print("-" * 60)
        print("按购买年分布 (total / T→F / F→T):")
        for y in sorted(by_year):
            t, a, b = by_year[y]
            print(f"  {y}: {t:>7} / {a:>6} / {b:>6}")
        print("-" * 60)
        print("按项目分布 top10 (proj_id: total / T→F / F→T):")
        for pid, (t, a, b) in sorted(
            by_proj.items(), key=lambda kv: kv[1][1] + kv[1][2], reverse=True
        )[:10]:
            print(f"  {pid}: {t:>7} / {a:>6} / {b:>6}")
        print("=" * 60)
        print("★ 本脚本未写入任何数据。确认影响面后再执行回刷。")
    finally:
        db.close()


if __name__ == "__main__":
    main()
