"""
BEL-157 订单信息服务

数据源：analysis_sales_order_rows（亚马逊「按 SKU 维度」订单报告入库后的明细）
模型位置：app.models.product_analysis_source.AnalysisSalesOrderRow
AnalysisSourceFile 同模块导出。

只读视图：当前不对外提供 CUD；订单数据由报表上传链路写入（见 app/services/data/upload/recognition.py）。
"""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Iterable
from zoneinfo import ZoneInfo

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.models.product_analysis_source import (
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
)
from app.models.project import Project
from app.schemas.order_info import (
    FilterOption,
    OrderInfoFilterOptions,
    OrderInfoItem,
    OrderInfoListResponse,
    OrderInfoPageData,
    OrderInfoStats,
)

# ===== Constants =====

BEIJING_TZ = ZoneInfo("Asia/Shanghai")

FULFILLMENT_LABEL_MAP: dict[str, str] = {
    "Amazon": "FBA（亚马逊配送）",
    "Merchant": "FBM（自发货配送）",
}

ORDER_STATUS_FALLBACK_LABEL = "未分类"
COUNTRY_FALLBACK_LABEL = "未分类"
CURRENCY_FALLBACK_LABEL = "未分类"

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 500
EXPORT_MAX_ROWS = 5000


# ===== Serialization =====

def _safe_str(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc).isoformat()
        return value.isoformat()
    return str(value)


def _to_float(value: Decimal | float | int | None) -> float:
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _to_beijing_str(value: datetime | None) -> str:
    """将数据库里的 UTC 时间转成北京时间字符串（用于展示 / 导出）。"""
    if not isinstance(value, datetime):
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S")


def _to_pt_str(value: datetime | None) -> str:
    if not isinstance(value, datetime):
        return ""
    return value.strftime("%Y-%m-%d %H:%M:%S")


def serialize_order_row(row: AnalysisSalesOrderRow, *, project: Project | None) -> OrderInfoItem:
    raw: dict = row.raw_row if isinstance(row.raw_row, dict) else {}
    fulfillment = (
        _safe_str(raw.get("fulfillment-channel"))
        or _safe_str(raw.get("fulfillment channel"))
        or ""
    )
    return OrderInfoItem(
        id=int(row.id),
        project_id=int(project.id) if project is not None else -1,
        project_name=str(project.project_name) if project is not None else "未知项目",
        brand_name=_safe_str(project.brand_name) if project is not None else None,
        source_file_id=int(row.source_file_id),
        purchase_at_utc=row.purchase_at_utc,
        purchase_at_pt=row.purchase_at_pt,
        purchase_date_pt=row.purchase_date_pt.isoformat() if row.purchase_date_pt else "",
        amazon_order_id=str(row.amazon_order_id),
        order_status=str(row.order_status) or "UNKNOWN",
        fulfillment_channel=fulfillment,
        fulfillment_label=FULFILLMENT_LABEL_MAP.get(fulfillment, fulfillment or "未分类"),
        ship_service_level=_safe_str(raw.get("ship-service-level"))
        or _safe_str(raw.get("ship service level")),
        sku=_safe_str(row.sku),
        asin=_safe_str(row.asin),
        product_name=_safe_str(raw.get("product-name")) or _safe_str(raw.get("product name")),
        quantity=int(row.quantity or 0),
        item_price=_to_float(row.item_price),
        shipping_price=_to_float(row.shipping_price),
        currency=_safe_str(row.currency),
        country=str(row.country or "").upper(),
        state=_safe_str(raw.get("ship-state"))
        or _safe_str(raw.get("ship state")),
        city=_safe_str(raw.get("ship-city")) or _safe_str(raw.get("ship city")),
        postal_code=_safe_str(raw.get("ship-postal-code"))
        or _safe_str(raw.get("ship postal code")),
        is_counted_sales=bool(row.is_counted_sales),
        created_at=row.created_at,
    )


# ===== Query building =====

def _build_base_query() -> Select:
    """所有"按项目归类"的订单查询都基于此 — 通过 source_file → source_file.project_id 过滤项目"""

    stmt: Select = select(AnalysisSalesOrderRow, Project).join(
        AnalysisSourceFile,
        AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
    ).join(
        Project,
        Project.id == AnalysisSourceFile.project_id,
    )
    return stmt


def _extract_fulfillment_channel(row: AnalysisSalesOrderRow) -> str:
    raw = row.raw_row if isinstance(row.raw_row, dict) else {}
    return _safe_str(raw.get("fulfillment-channel")) or _safe_str(raw.get("fulfillment channel")) or ""


def _fulfillment_filter_sql_supported(db: Session) -> bool:
    """判定当前 dialect 是否能在 SQL 层通过 raw_row JSON 路径精确过滤 fulfillment-channel。

    PG 上的 JSON / JSONB 列都支持 `column['key'].as_string()` 比较；SQLite 需要 JSON1 扩展，
    在测试环境里如果没启用就 fallback 到应用层过滤。
    """
    try:
        dialect = db.bind.dialect.name if db.bind is not None else ""
    except Exception:
        dialect = ""
    return dialect in {"postgresql", "postgres"}


def apply_sql_filters(
    stmt: Select,
    *,
    project_ids: Iterable[int] | None = None,
    order_statuses: Iterable[str] | None = None,
    countries: Iterable[str] | None = None,
    currencies: Iterable[str] | None = None,
    sku_keyword: str | None = None,
    order_id_keyword: str | None = None,
    asin_keyword: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    sort_by: str = "purchase_at_pt",
    sort_dir: str = "desc",
    include_order_by: bool = True,
) -> Select:
    """应用可在 SQL 层表达的过滤。fulfillment-channel 在 raw_row JSON 里，过滤放应用层。"""

    if project_ids:
        stmt = stmt.where(AnalysisSourceFile.project_id.in_(list(project_ids)))

    status_list = [s for s in (order_statuses or []) if s]
    if status_list:
        stmt = stmt.where(AnalysisSalesOrderRow.order_status.in_(status_list))

    country_list = [c for c in (countries or []) if c]
    if country_list:
        stmt = stmt.where(AnalysisSalesOrderRow.country.in_(country_list))

    currency_list = [c for c in (currencies or []) if c]
    if currency_list:
        stmt = stmt.where(AnalysisSalesOrderRow.currency.in_(currency_list))

    if sku_keyword:
        like = f"%{sku_keyword.strip()}%"
        stmt = stmt.where(AnalysisSalesOrderRow.sku.ilike(like))

    if asin_keyword:
        like = f"%{asin_keyword.strip()}%"
        stmt = stmt.where(AnalysisSalesOrderRow.asin.ilike(like))

    if order_id_keyword:
        like = f"%{order_id_keyword.strip()}%"
        stmt = stmt.where(AnalysisSalesOrderRow.amazon_order_id.ilike(like))

    if date_from:
        stmt = stmt.where(AnalysisSalesOrderRow.purchase_date_pt >= date_from)
    if date_to:
        stmt = stmt.where(AnalysisSalesOrderRow.purchase_date_pt <= date_to)

    if not include_order_by:
        return stmt

    sort_column_map = {
        "purchase_at_pt": AnalysisSalesOrderRow.purchase_at_pt,
        "purchase_date_pt": AnalysisSalesOrderRow.purchase_date_pt,
        "quantity": AnalysisSalesOrderRow.quantity,
        "item_price": AnalysisSalesOrderRow.item_price,
        "id": AnalysisSalesOrderRow.id,
    }
    sort_col = sort_column_map.get(sort_by, AnalysisSalesOrderRow.purchase_at_pt)
    stmt = stmt.order_by(sort_col.desc() if sort_dir.lower() != "asc" else sort_col.asc())

    return stmt


def _apply_app_filters(
    rows: list[tuple[AnalysisSalesOrderRow, Project]],
    *,
    fulfillment_channels: Iterable[str] | None = None,
) -> list[tuple[AnalysisSalesOrderRow, Project]]:
    fc_set = {c for c in (fulfillment_channels or []) if c}
    if not fc_set:
        return rows
    out: list[tuple[AnalysisSalesOrderRow, Project]] = []
    for row, project in rows:
        if _extract_fulfillment_channel(row) in fc_set:
            out.append((row, project))
    return out


# ===== Public read APIs =====

def list_orders(
    db: Session,
    *,
    project_ids: list[int] | None = None,
    fulfillment_channels: list[str] | None = None,
    order_statuses: list[str] | None = None,
    countries: list[str] | None = None,
    currencies: list[str] | None = None,
    sku_keyword: str | None = None,
    order_id_keyword: str | None = None,
    asin_keyword: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
    sort_by: str = "purchase_at_pt",
    sort_dir: str = "desc",
) -> OrderInfoListResponse:
    safe_page = max(int(page or 1), 1)
    safe_page_size = min(max(int(page_size or DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE)

    # total: 应用层先按 SQL 过滤拿到候选总数，再按 fulfillment-channel 过滤得到精确 total
    count_sql = select(func.count(AnalysisSalesOrderRow.id)).join(
        AnalysisSourceFile,
        AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
    )
    count_sql = apply_sql_filters(
        count_sql,
        project_ids=project_ids,
        order_statuses=order_statuses,
        countries=countries,
        currencies=currencies,
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=date_from,
        date_to=date_to,
        sort_by=sort_by,
        sort_dir=sort_dir,
        include_order_by=False,
    )
    pre_filter_total = int(db.execute(count_sql).scalar() or 0)

    # 当启用 fulfillment-channel 过滤时，需要重新统计精确 total
    fc_set = {c for c in (fulfillment_channels or []) if c}
    fc_supported_in_sql = _fulfillment_filter_sql_supported(db)
    use_sql_fc = fc_set and fc_supported_in_sql

    if use_sql_fc:
        # SQL 层能精确过滤 fulfillment-channel（PG 上的 JSONB / JSON 列）
        fc_or_clauses = [
            AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string() == channel
            for channel in fc_set
        ]
        if len(fc_or_clauses) == 1:
            count_sql = count_sql.where(fc_or_clauses[0])
        else:
            count_sql = count_sql.where(or_(*fc_or_clauses))
        total = int(db.execute(count_sql).scalar() or 0)

        stmt = _build_base_query()
        stmt = apply_sql_filters(
            stmt,
            project_ids=project_ids,
            order_statuses=order_statuses,
            countries=countries,
            currencies=currencies,
            sku_keyword=sku_keyword,
            order_id_keyword=order_id_keyword,
            asin_keyword=asin_keyword,
            date_from=date_from,
            date_to=date_to,
            sort_by=sort_by,
            sort_dir=sort_dir,
        )
        if len(fc_or_clauses) == 1:
            stmt = stmt.where(fc_or_clauses[0])
        else:
            stmt = stmt.where(or_(*fc_or_clauses))
        offset = (safe_page - 1) * safe_page_size
        page_rows = db.execute(stmt.limit(safe_page_size).offset(offset)).all()
    elif fc_set:
        # Fallback：SQLite 等不支持 SQL JSON path 的方言，走应用层过滤
        full_stmt = _build_base_query()
        full_stmt = apply_sql_filters(
            full_stmt,
            project_ids=project_ids,
            order_statuses=order_statuses,
            countries=countries,
            currencies=currencies,
            sku_keyword=sku_keyword,
            order_id_keyword=order_id_keyword,
            asin_keyword=asin_keyword,
            date_from=date_from,
            date_to=date_to,
            sort_by=sort_by,
            sort_dir=sort_dir,
        )
        all_rows = db.execute(full_stmt.limit(MAX_PAGE_SIZE * 20)).all()
        filtered_full = _apply_app_filters(all_rows, fulfillment_channels=fc_set)
        if len(all_rows) < MAX_PAGE_SIZE * 20:
            total = len(filtered_full)
        else:
            ratio = len(filtered_full) / len(all_rows) if all_rows else 0
            total = int(round(pre_filter_total * ratio))
            total = max(total, len(filtered_full))
        offset = (safe_page - 1) * safe_page_size
        page_rows = filtered_full[offset : offset + safe_page_size]
    else:
        total = pre_filter_total
        stmt = _build_base_query()
        stmt = apply_sql_filters(
            stmt,
            project_ids=project_ids,
            order_statuses=order_statuses,
            countries=countries,
            currencies=currencies,
            sku_keyword=sku_keyword,
            order_id_keyword=order_id_keyword,
            asin_keyword=asin_keyword,
            date_from=date_from,
            date_to=date_to,
            sort_by=sort_by,
            sort_dir=sort_dir,
        )
        offset = (safe_page - 1) * safe_page_size
        page_rows = db.execute(stmt.limit(safe_page_size).offset(offset)).all()

    items: list[OrderInfoItem] = [
        serialize_order_row(row, project=project) for row, project in page_rows
    ]

    return OrderInfoListResponse(
        items=items,
        total=total,
        page=safe_page,
        page_size=safe_page_size,
    )


def compute_stats(
    db: Session,
    *,
    project_ids: list[int] | None = None,
    fulfillment_channels: list[str] | None = None,
    order_statuses: list[str] | None = None,
    countries: list[str] | None = None,
    currencies: list[str] | None = None,
    sku_keyword: str | None = None,
    order_id_keyword: str | None = None,
    asin_keyword: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> OrderInfoStats:
    """顶部 stat bar：当前筛选条件下的 订单数 / 数量 / 金额（取主导币种）/ FBA·FBM 分布"""

    stmt = _build_base_query()
    stmt = apply_sql_filters(
        stmt,
        project_ids=project_ids,
        order_statuses=order_statuses,
        countries=countries,
        currencies=currencies,
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=date_from,
        date_to=date_to,
        sort_by="purchase_at_pt",
        sort_dir="desc",
    )
    fc_set = {c for c in (fulfillment_channels or []) if c}
    if fc_set and _fulfillment_filter_sql_supported(db):
        if len(fc_set) == 1:
            stmt = stmt.where(
                AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string() == next(iter(fc_set))
            )
        else:
            stmt = stmt.where(
                or_(*[
                    AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string() == channel
                    for channel in fc_set
                ])
            )
    # stats 最多拉 1w 行做精确聚合（页面 stat bar 不需要 100% 精确）
    rows = db.execute(stmt.limit(10000)).all()
    rows = _apply_app_filters(rows, fulfillment_channels=fulfillment_channels)

    total_orders = len(rows)
    total_quantity = 0
    total_amount = 0.0
    fba_count = 0
    fbm_count = 0
    currency_count: dict[str, int] = defaultdict(int)

    for row, _project in rows:
        total_quantity += int(row.quantity or 0)
        total_amount += _to_float(row.item_price) + _to_float(row.shipping_price)
        fc = _extract_fulfillment_channel(row)
        if fc == "Amazon":
            fba_count += 1
        elif fc == "Merchant":
            fbm_count += 1
        if row.currency:
            currency_count[str(row.currency)] += 1

    dominant_currency = None
    if currency_count:
        dominant_currency = max(currency_count.items(), key=lambda kv: kv[1])[0]

    return OrderInfoStats(
        total_orders=total_orders,
        total_quantity=total_quantity,
        total_amount=round(total_amount, 2),
        currency=dominant_currency,
        fba_count=fba_count,
        fbm_count=fbm_count,
    )


def collect_filter_options(db: Session) -> OrderInfoFilterOptions:
    """首屏渲染用的筛选项下拉数据。轻量 distinct 查询。"""

    projects = db.execute(
        select(Project.id, Project.project_name, Project.brand_name)
        .where(Project.is_active.is_(True))
        .order_by(Project.project_name.asc())
    ).all()

    project_options: list[FilterOption] = []
    seen_pid: set[int] = set()
    for pid, pname, brand in projects:
        if pid in seen_pid:
            continue
        seen_pid.add(int(pid))
        label = str(pname)
        if brand:
            label = f"{pname}（{brand}）"
        project_options.append(FilterOption(value=str(int(pid)), label=label))

    order_statuses = db.execute(
        select(AnalysisSalesOrderRow.order_status)
        .distinct()
        .order_by(AnalysisSalesOrderRow.order_status.asc())
    ).all()
    status_options = [
        FilterOption(value=str(row[0]), label=str(row[0]) or ORDER_STATUS_FALLBACK_LABEL)
        for row in order_statuses
        if row[0]
    ]

    fc_options = [
        FilterOption(value="Amazon", label=FULFILLMENT_LABEL_MAP["Amazon"]),
        FilterOption(value="Merchant", label=FULFILLMENT_LABEL_MAP["Merchant"]),
    ]

    countries = db.execute(
        select(AnalysisSalesOrderRow.country)
        .distinct()
        .order_by(AnalysisSalesOrderRow.country.asc())
    ).all()
    country_options = [
        FilterOption(value=str(row[0]), label=str(row[0]) or COUNTRY_FALLBACK_LABEL)
        for row in countries
        if row[0]
    ]

    currencies = db.execute(
        select(AnalysisSalesOrderRow.currency)
        .where(AnalysisSalesOrderRow.currency.is_not(None))
        .distinct()
        .order_by(AnalysisSalesOrderRow.currency.asc())
    ).all()
    currency_options = [
        FilterOption(value=str(row[0]), label=str(row[0]))
        for row in currencies
        if row[0]
    ]

    return OrderInfoFilterOptions(
        projects=project_options,
        order_statuses=status_options,
        fulfillment_channels=fc_options,
        countries=country_options,
        currencies=currency_options,
    )


def get_page_data(
    db: Session,
    *,
    project_ids: list[int] | None = None,
    fulfillment_channels: list[str] | None = None,
    order_statuses: list[str] | None = None,
    countries: list[str] | None = None,
    currencies: list[str] | None = None,
    sku_keyword: str | None = None,
    order_id_keyword: str | None = None,
    asin_keyword: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
    sort_by: str = "purchase_at_pt",
    sort_dir: str = "desc",
) -> OrderInfoPageData:
    """一次性返回 list + stats + filter_options，减少前端首屏请求次数"""

    listing = list_orders(
        db,
        project_ids=project_ids,
        fulfillment_channels=fulfillment_channels,
        order_statuses=order_statuses,
        countries=countries,
        currencies=currencies,
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=date_from,
        date_to=date_to,
        page=page,
        page_size=page_size,
        sort_by=sort_by,
        sort_dir=sort_dir,
    )
    stats = compute_stats(
        db,
        project_ids=project_ids,
        fulfillment_channels=fulfillment_channels,
        order_statuses=order_statuses,
        countries=countries,
        currencies=currencies,
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=date_from,
        date_to=date_to,
    )
    options = collect_filter_options(db)
    return OrderInfoPageData(
        items=listing.items,
        total=listing.total,
        page=listing.page,
        page_size=listing.page_size,
        stats=stats,
        filter_options=options,
    )


def parse_date_input(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.strptime(value.strip()[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


# ===== CSV Export =====

ORDER_CSV_HEADERS = [
    "下单日期（北京时间）",
    "下单日期（PT）",
    "订单编号",
    "订单状态",
    "订单类型",
    "服务等级",
    "SKU",
    "ASIN",
    "产品名称",
    "数量",
    "商品金额",
    "运费",
    "币种",
    "店铺",
    "国家",
    "州",
    "城市",
    "邮编",
]


def export_orders_to_csv(
    db: Session,
    *,
    project_ids: list[int] | None = None,
    fulfillment_channels: list[str] | None = None,
    order_statuses: list[str] | None = None,
    countries: list[str] | None = None,
    currencies: list[str] | None = None,
    sku_keyword: str | None = None,
    order_id_keyword: str | None = None,
    asin_keyword: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    max_rows: int = EXPORT_MAX_ROWS,
) -> tuple[str, str]:
    """导出当前筛选条件下的订单 CSV。返回 (filename, csv_text)。"""

    stmt = _build_base_query()
    stmt = apply_sql_filters(
        stmt,
        project_ids=project_ids,
        order_statuses=order_statuses,
        countries=countries,
        currencies=currencies,
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=date_from,
        date_to=date_to,
        sort_by="purchase_at_pt",
        sort_dir="desc",
    )
    fc_set = {c for c in (fulfillment_channels or []) if c}
    if fc_set and _fulfillment_filter_sql_supported(db):
        if len(fc_set) == 1:
            stmt = stmt.where(
                AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string() == next(iter(fc_set))
            )
        else:
            stmt = stmt.where(
                or_(*[
                    AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string() == channel
                    for channel in fc_set
                ])
            )
    rows = db.execute(stmt.limit(max_rows)).all()
    if not (fc_set and _fulfillment_filter_sql_supported(db)):
        rows = _apply_app_filters(rows, fulfillment_channels=fulfillment_channels)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(ORDER_CSV_HEADERS)

    for row, project in rows:
        item = serialize_order_row(row, project=project)
        writer.writerow([
            _to_beijing_str(item.purchase_at_utc),
            _to_pt_str(item.purchase_at_pt) or item.purchase_date_pt or "",
            item.amazon_order_id,
            item.order_status,
            item.fulfillment_label,
            item.ship_service_level or "",
            item.sku or "",
            item.asin or "",
            item.product_name or "",
            item.quantity,
            f"{item.item_price:.2f}",
            f"{item.shipping_price:.2f}",
            item.currency or "",
            item.project_name,
            item.country,
            item.state or "",
            item.city or "",
            item.postal_code or "",
        ])

    csv_text = buffer.getvalue()
    filename = f"order-info-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
    return filename, csv_text


__all__ = [
    "FULFILLMENT_LABEL_MAP",
    "ORDER_CSV_HEADERS",
    "DEFAULT_PAGE_SIZE",
    "MAX_PAGE_SIZE",
    "EXPORT_MAX_ROWS",
    "serialize_order_row",
    "list_orders",
    "compute_stats",
    "collect_filter_options",
    "get_page_data",
    "parse_date_input",
    "export_orders_to_csv",
]