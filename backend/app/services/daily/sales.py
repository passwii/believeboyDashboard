from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow
from app.services.daily.aggregation import _get_or_create_bucket, _set_asin_if_blank
from app.services.sales_query import counted_sales_where
from app.utils.sales_amount import sales_amount_value


def _load_sales_metrics(
    db: Session,
    *,
    detail_buckets: dict[tuple[str, str], object],
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
) -> tuple[set[str], str | None]:
    # BEL-348: 直接按行过滤（不再 JOIN source_file + is_current），改用购买日期分组。
    stmt = select(
        AnalysisSalesOrderRow.purchase_date_pt,
        AnalysisSalesOrderRow.sku,
        AnalysisSalesOrderRow.asin,
        AnalysisSalesOrderRow.quantity,
        AnalysisSalesOrderRow.item_price,
        AnalysisSalesOrderRow.shipping_price,
        AnalysisSalesOrderRow.item_tax,
        AnalysisSalesOrderRow.shipping_tax,
    ).where(
        *counted_sales_where(
            project_id=project_id,
            country=country,
            date_from=start_date,
            date_to=end_date,
        )
    )
    rows = db.execute(stmt).all()
    dates: set[str] = set()
    latest: date | None = None
    for (
        purchase_date_pt,
        sku,
        asin,
        quantity,
        item_price,
        shipping_price,
        item_tax,
        shipping_tax,
    ) in rows:
        if purchase_date_pt is None:
            continue
        normalized_sku = (sku or "").strip()
        if not normalized_sku:
            continue
        dates.add(purchase_date_pt.isoformat())
        latest = (
            purchase_date_pt if latest is None or purchase_date_pt > latest else latest
        )
        bucket = _get_or_create_bucket(detail_buckets, purchase_date_pt, normalized_sku)
        _set_asin_if_blank(bucket, asin)
        bucket.order_qty += int(quantity or 0)
        # BLF-565: 销售额口径统一走公共函数——DE/UK 含税（item+shipping+两税），
        # 其余站点净额（item+shipping），与定时报告（BLF-475）一致。
        bucket.sales_amount += sales_amount_value(
            country,
            item_price=item_price,
            shipping_price=shipping_price,
            item_tax=item_tax,
            shipping_tax=shipping_tax,
        )
    return dates, latest.isoformat() if latest is not None else None
