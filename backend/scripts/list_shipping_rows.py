"""只读：列出全部 Shipping 状态订单行明细，供人工上游对账。

输出：行 id / amazon_order_id / project_id / country / purchase_date_pt /
source_file_id / is_counted_sales / created_at。不写库。
"""
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import AnalysisSalesOrderRow


def main() -> None:
    db = SessionLocal()
    try:
        rows = db.execute(
            select(
                AnalysisSalesOrderRow.id,
                AnalysisSalesOrderRow.amazon_order_id,
                AnalysisSalesOrderRow.project_id,
                AnalysisSalesOrderRow.country,
                AnalysisSalesOrderRow.purchase_date_pt,
                AnalysisSalesOrderRow.source_file_id,
                AnalysisSalesOrderRow.is_counted_sales,
                AnalysisSalesOrderRow.created_at,
            )
            .where(AnalysisSalesOrderRow.order_status == "Shipping")
            .order_by(
                AnalysisSalesOrderRow.project_id,
                AnalysisSalesOrderRow.amazon_order_id,
            )
        ).fetchall()

        print(f"Shipping 行数: {len(rows)}\n")
        print(
            f"{'row_id':>7} | {'amazon_order_id':<22} | {'proj':>4} | "
            f"{'country':<3} | {'purchase_date_pt':<12} | {'src_file':>8} | counted"
        )
        print("-" * 90)
        for r in rows:
            rid, oid, pid, ctry, pd, sfid, cnt, ca = r
            print(
                f"{rid:>7} | {oid:<22} | {pid:>4} | {ctry:<3} | "
                f"{str(pd):<12} | {sfid:>8} | {cnt}"
            )
    finally:
        db.close()


if __name__ == "__main__":
    main()
