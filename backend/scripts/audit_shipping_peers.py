"""只读审计：Shipping 状态的订单，在全表其他文件版本里有无更新终态。

目的：验证用户顾虑——Shipping 可能是中间态，同订单号其他版本
可能是 Cancelled（被取消）或 Shipped。不写库。
"""
from collections import defaultdict

from sqlalchemy import select, func, distinct

from app.db.session import SessionLocal
from app.models import AnalysisSalesOrderRow


def main() -> None:
    db = SessionLocal()
    try:
        ship_ids = [
            r[0]
            for r in db.execute(
                select(distinct(AnalysisSalesOrderRow.amazon_order_id)).where(
                    AnalysisSalesOrderRow.order_status == "Shipping"
                )
            ).all()
        ]
        print("Shipping 涉及的不同订单号数:", len(ship_ids))

        if not ship_ids:
            return

        rows = db.execute(
            select(
                AnalysisSalesOrderRow.amazon_order_id,
                AnalysisSalesOrderRow.order_status,
                func.count(),
            )
            .where(AnalysisSalesOrderRow.amazon_order_id.in_(ship_ids))
            .group_by(
                AnalysisSalesOrderRow.amazon_order_id,
                AnalysisSalesOrderRow.order_status,
            )
            .order_by(
                AnalysisSalesOrderRow.amazon_order_id,
                AnalysisSalesOrderRow.order_status,
            )
        ).all()

        agg = defaultdict(set)
        for oid, st, _n in rows:
            agg[oid].add(st)

        print("=== 每个 Shipping 订单号，在全表的其他状态 ===")
        for oid in ship_ids:
            others = agg[oid] - {"Shipping"}
            if others:
                print(f"  {oid}: 同订单其他状态 = {sorted(others)}")
            else:
                print(f"  {oid}: (无其他版本，仅 Shipping)")

        cancelled_peers = [oid for oid, st in agg.items() if "Cancelled" in st]
        shipped_peers = [oid for oid, st in agg.items() if "Shipped" in st]
        print()
        print("=== 同订单存在 Cancelled 的 Shipping 订单数 ===", len(cancelled_peers))
        for oid in cancelled_peers:
            print("   ", oid)
        print("=== 同订单存在 Shipped 的 Shipping 订单数 ===", len(shipped_peers))
        for oid in shipped_peers:
            print("   ", oid)
        only_ship = [oid for oid in ship_ids if agg[oid] == {"Shipping"}]
        print("=== 全表仅有 Shipping、无任何其他版本的订单数 ===", len(only_ship))
    finally:
        db.close()


if __name__ == "__main__":
    main()
