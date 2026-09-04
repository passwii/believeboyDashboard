"""
cleanup_sales_date_shift_dupes.py — 清理销售订单「跨日重复行」（BEL-376 后续数据修复）

背景（2026-08-02 排查结论）：
  analysis_sales_order_rows 的唯一键是
    UNIQUE (project_id, amazon_order_id, sku, country, purchase_date_pt)
  含 purchase_date_pt（BEL-348 故意设计，避免把相邻日期桶的订单误合并）。
  副作用：同一笔订单在「早一次拉取」和「晚一次拉取」时若派生出的 purchase_date_pt
  相差 1 天（通常是订单早期 Pending → 后期 Shipped 时 Amazon 报表里的日期变了），
  就会写入两行，唯一键不合并 → 销量被重复累计。

  已验证（本地 BLF，16 个 project）：
    - 仅 project 5 / 10 受影响，共 18 组；其余 14 个项目零重复。
    - 18 组的 purchase_at_utc 完全相同，只是派生列 purchase_date_pt 差了 +1 天。
    - 用当前确定性代码 (purchase_at_utc AT TIME ZONE 'America/Los_Angeles')::date
      重派生，18/18 都只应得到「较早那天」——即较晚那天的一行是脏数据。
    - 安全核对：删掉脏行不会丢任何「已计入」的销售（保留行状态 ≥ 被删行）。

本脚本做什么：
  对每组 (project_id, amazon_order_id, sku, country) 有 >1 个不同 purchase_date_pt 的，
  删除 purchase_date_pt ≠ 正确派生日期 的那一行（即 +1 天的脏行），保留正确行。
  幂等：第二次运行删除 0 行。

安全模型：
  - 默认 DRY-RUN：只打印将被删除的行 + 影响，不动数据。
  - --execute     真正删除，并打印删除前后各受影响 project 的已计入销量对比。
  - 内置安全闸：若检测到任何一组「被删行已计入、但保留行未计入」（会丢真实销量），
    直接中止并报错，不删除。

运行（在 VPS 上，prod .env 提供 DATABASE_URL）：
  cd /root/believeboyDashboard/backend
  .venv/bin/python scripts/cleanup_sales_date_shift_dupes.py            # dry-run
  .venv/bin/python scripts/cleanup_sales_date_shift_dupes.py --execute  # 真正删除
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 把 backend/ 加进 sys.path，让 `from app.xxx import ...` 能跑
_HERE = Path(__file__).resolve().parent
_CANDIDATES = [_HERE, _HERE.parent, Path.cwd()]
for _c in _CANDIDATES:
    if (_c / "app").is_dir():
        sys.path.insert(0, str(_c))
        break
else:
    sys.path.insert(0, str(_HERE.parent))

from sqlalchemy import text  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402


_DUPE_GROUPS_SQL = """
    SELECT project_id, amazon_order_id, sku, country
    FROM analysis_sales_order_rows
    GROUP BY project_id, amazon_order_id, sku, country
    HAVING count(DISTINCT purchase_date_pt) > 1
"""

# 脏行 = 属于跨日重复组，且 purchase_date_pt ≠ 从 purchase_at_utc 重派生的正确日期
_BAD_ROWS_SQL = """
    SELECT sar.id, sar.project_id, sar.amazon_order_id, sar.sku,
           sar.purchase_date_pt AS stored_date,
           (sar.purchase_at_utc AT TIME ZONE 'America/Los_Angeles')::date AS correct_date,
           sar.order_status, sar.quantity, sar.is_counted_sales
    FROM analysis_sales_order_rows sar
    WHERE (sar.project_id, sar.amazon_order_id, sar.sku, sar.country) IN (
        SELECT project_id, amazon_order_id, sku, country
        FROM analysis_sales_order_rows
        GROUP BY project_id, amazon_order_id, sku, country
        HAVING count(DISTINCT purchase_date_pt) > 1
    )
    AND sar.purchase_date_pt <> (sar.purchase_at_utc AT TIME ZONE 'America/Los_Angeles')::date
    ORDER BY sar.project_id, sar.amazon_order_id
"""

_DELETE_SQL = """
    DELETE FROM analysis_sales_order_rows sar
    WHERE (sar.project_id, sar.amazon_order_id, sar.sku, sar.country) IN (
        SELECT project_id, amazon_order_id, sku, country
        FROM analysis_sales_order_rows
        GROUP BY project_id, amazon_order_id, sku, country
        HAVING count(DISTINCT purchase_date_pt) > 1
    )
    AND sar.purchase_date_pt <> (sar.purchase_at_utc AT TIME ZONE 'America/Los_Angeles')::date
"""


def _counted_sales(db, project_id: int) -> tuple[int, int]:
    row = db.execute(
        text(
            """
            SELECT coalesce(sum(quantity),0), count(*)
            FROM analysis_sales_order_rows
            WHERE project_id=:p AND is_counted_sales=true
              AND order_status NOT IN ('Cancelled','Pending')
            """
        ),
        {"p": project_id},
    ).first()
    return int(row[0]), int(row[1])


def _safety_check(db) -> int:
    """返回「会丢已计入销售」的高危组数。>0 时必须中止。"""
    groups = db.execute(text(_DUPE_GROUPS_SQL)).fetchall()
    risky = 0
    for p, o, s, c in groups:
        kept = db.execute(
            text(
                """
                SELECT order_status, is_counted_sales FROM analysis_sales_order_rows
                WHERE project_id=:p AND amazon_order_id=:o AND sku=:s AND country=:c
                  AND purchase_date_pt = (purchase_at_utc AT TIME ZONE 'America/Los_Angeles')::date
                """
            ),
            {"p": p, "o": o, "s": s, "c": c},
        ).fetchall()
        dele = db.execute(
            text(
                """
                SELECT order_status, is_counted_sales FROM analysis_sales_order_rows
                WHERE project_id=:p AND amazon_order_id=:o AND sku=:s AND country=:c
                  AND purchase_date_pt <> (purchase_at_utc AT TIME ZONE 'America/Los_Angeles')::date
                """
            ),
            {"p": p, "o": o, "s": s, "c": c},
        ).fetchall()
        if not kept or not dele:
            continue
        k_status, k_counted = kept[0]
        d_status, d_counted = dele[0]
        kept_is_counted = (k_status not in ("Cancelled", "Pending")) and bool(k_counted)
        del_is_counted = (d_status not in ("Cancelled", "Pending")) and bool(d_counted)
        if del_is_counted and not kept_is_counted:
            risky += 1
            print(f"  ⚠️ 高危: proj={p} order={o} sku={s} 保留行未计入但被删行已计入")
    return risky


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument(
        "--execute",
        action="store_true",
        help="真正删除（默认 dry-run 只打印）",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        addr = db.execute(text("SELECT current_database()")).scalar()
        print(f"目标数据库: {addr}")

        bad_rows = db.execute(text(_BAD_ROWS_SQL)).fetchall()
        print(f"\n跨日重复的脏行数: {len(bad_rows)}")
        for r in bad_rows:
            print(
                f"  id={r[0]} proj={r[1]} order={r[2]} sku={r[3]} "
                f"stored={r[4]} correct={r[5]} status={r[6]} qty={r[7]} counted={r[8]}"
            )

        if not bad_rows:
            print("无需清理（幂等：脏行已清完）。")
            return 0

        # 安全闸
        risky = _safety_check(db)
        if risky > 0:
            print(f"\n❌ 检测到 {risky} 组会丢失已计入销售，中止。请人工核查。")
            return 1
        print("\n安全核对通过：删除不会丢失任何已计入销售。")

        affected_projects = sorted({r[1] for r in bad_rows})
        before = {p: _counted_sales(db, p) for p in affected_projects}

        if not args.execute:
            print("\n[DRY-RUN] 未执行删除。加 --execute 才真正删除。")
            return 0

        result = db.execute(text(_DELETE_SQL))
        deleted = result.rowcount
        db.commit()
        print(f"\n已删除 {deleted} 行。")

        print("\n删除前后对比（受影响 project 的已计入销量）:")
        for p in affected_projects:
            b_units, b_rows = before[p]
            a_units, a_rows = _counted_sales(db, p)
            print(f"  proj={p}: {b_units} → {a_units} units ({b_rows} → {a_rows} rows)")

        remaining = db.execute(
            text(f"SELECT count(*) FROM ({_DUPE_GROUPS_SQL}) t")
        ).scalar()
        print(f"\n剩余跨日重复组: {remaining}（应为 0）")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
