"""
一次性脚本：从数据库拉 P1+P4 的 SKU 真实数据，跑健康度评分，打印结果。
不写入文件，只在终端输出，方便人工核对。
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

# 把 backend 加进 path（对齐 rebuild_de_inventory_credit.py 的 BACKEND 约定）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.services.inventory.health_score import ItemInput, assess
from app.services.inventory.replenishment import (
    _load_in_transit_map,
    _load_inventory_map,
    _load_sales_dms_map,
)


def run():
    settings = get_settings()
    engine = create_engine(settings.database_url)
    SessionLocal = sessionmaker(bind=engine)

    today = date(2026, 7, 31)
    targets = [
        # (project_id, country, label)
        (1, "US", "P1"),
        (4, "US", "P4"),
    ]

    with SessionLocal() as db:
        for project_id, country, label in targets:
            print(f"\n{'='*80}")
            print(f"  {label} (project_id={project_id}, country={country})")
            print(f"{'='*80}")

            inv_map = _load_inventory_map(db, project_id, country)
            dms_30 = _load_sales_dms_map(db, project_id, country, today, 30)
            dms_7 = _load_sales_dms_map(db, project_id, country, today, 7)
            in_transit = _load_in_transit_map(db, project_id, country)

            print(f"  库存快照: {len(inv_map)} SKU; 销售 30/7 日: {len(dms_30)}/{len(dms_7)} SKU")
            print()

            # 表头
            print(
                f"  {'SKU':<18} {'可用':>5} {'DoH':>6} {'dms_30':>7} {'dms_7':>7} "
                f"{'在途':>5} {'库龄主':>10} {'score':>5}  status     原因"
            )
            print(f"  {'-'*120}")

            for sku, snap in sorted(inv_map.items()):
                d30 = dms_30.get(sku)
                d7 = dms_7.get(sku)
                transit = in_transit.get(sku, 0)

                # 库龄主分布
                aging_buckets = [
                    ("0-90", snap.age_0_90_qty),
                    ("91-180", snap.age_91_180_qty),
                    ("181-270", snap.age_181_270_qty),
                    ("271-365", snap.age_271_365_qty),
                    ("365+", snap.age_365_plus_qty),
                ]
                main_aging = max(aging_buckets, key=lambda x: x[1])
                total_aging = sum(q for _, q in aging_buckets)
                if total_aging > 0 and main_aging[1] > 0:
                    aging_str = f"{main_aging[0]}({main_aging[1]/total_aging:.0%})"
                else:
                    aging_str = "-"

                # DoH: dms_30 > 0 时用 available / dms_30
                if d30 and d30 > 0:
                    doh = snap.available_qty / d30
                else:
                    doh = None

                item = ItemInput(
                    available_qty=snap.available_qty,
                    sellable_days=doh,
                    dms_30=d30,
                    dms_7=d7,
                    age_0_90_qty=snap.age_0_90_qty,
                    age_91_180_qty=snap.age_91_180_qty,
                    age_181_270_qty=snap.age_181_270_qty,
                    age_271_365_qty=snap.age_271_365_qty,
                    age_365_plus_qty=snap.age_365_plus_qty,
                    in_transit_qty=transit,
                )
                result = assess(item)
                reasons = " | ".join(result.risk_reasons[:3])

                doh_str = f"{doh:.1f}" if doh is not None else "null"
                d30_str = f"{d30:.2f}" if d30 is not None else "null"
                d7_str = f"{d7:.2f}" if d7 is not None else "null"

                print(
                    f"  {sku:<18} {snap.available_qty:>5} {doh_str:>6} {d30_str:>7} {d7_str:>7} "
                    f"{transit:>5} {aging_str:>10} {result.health_score:>5}  "
                    f"{result.risk_status:<9}  {reasons}"
                )

            # 汇总
            print()
            print(f"  汇总:")
            from collections import Counter
            status_count = Counter()
            for sku, snap in inv_map.items():
                d30 = dms_30.get(sku)
                d7 = dms_7.get(sku)
                transit = in_transit.get(sku, 0)
                if d30 and d30 > 0:
                    doh = snap.available_qty / d30
                else:
                    doh = None
                item = ItemInput(
                    available_qty=snap.available_qty,
                    sellable_days=doh,
                    dms_30=d30,
                    dms_7=d7,
                    age_0_90_qty=snap.age_0_90_qty,
                    age_91_180_qty=snap.age_91_180_qty,
                    age_181_270_qty=snap.age_181_270_qty,
                    age_271_365_qty=snap.age_271_365_qty,
                    age_365_plus_qty=snap.age_365_plus_qty,
                    in_transit_qty=transit,
                )
                result = assess(item)
                status_count[result.risk_status] += 1
            for status, count in status_count.most_common():
                print(f"    {status}: {count}")


if __name__ == "__main__":
    run()
