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
import logging
from collections.abc import Iterable
from datetime import date, datetime, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import Select, case, func, or_, select
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
    OrderInfoOverview,
    OrderInfoPageData,
    OrderInfoStats,
    OrderLiveStreamItem,
)
from app.utils.country import SUPPORTED_COUNTRIES, get_today_for_country
from app.utils.math_utils import round_money
from app.utils.sales_amount import sales_amount_expr_by_row

# ===== Logger =====

logger = logging.getLogger("app.request")

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


def _to_float(value: Decimal | float | None) -> float:
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


def _beijing_hhmm(value: datetime | None) -> str:
    """UTC 瞬间 → 北京时间 ``HH:MM``（Live Stream 时间标签用，BLF-839）。"""
    if not isinstance(value, datetime):
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(BEIJING_TZ).strftime("%H:%M")


def serialize_order_row(
    row: AnalysisSalesOrderRow, *, project: Project | None
) -> OrderInfoItem:
    raw: dict = row.raw_row if isinstance(row.raw_row, dict) else {}
    fulfillment = (
        _safe_str(getattr(row, "fulfillment_channel", None))
        or _safe_str(raw.get("fulfillment-channel"))
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
        purchase_date_pt=row.purchase_date_pt.isoformat()
        if row.purchase_date_pt
        else "",
        amazon_order_id=str(row.amazon_order_id),
        order_status=str(row.order_status) or "UNKNOWN",
        fulfillment_channel=fulfillment,
        fulfillment_label=FULFILLMENT_LABEL_MAP.get(
            fulfillment, fulfillment or "未分类"
        ),
        ship_service_level=_safe_str(raw.get("ship-service-level"))
        or _safe_str(raw.get("ship service level")),
        sku=_safe_str(row.sku),
        asin=_safe_str(row.asin),
        product_name=_safe_str(raw.get("product-name"))
        or _safe_str(raw.get("product name")),
        quantity=int(row.quantity or 0),
        item_price=_to_float(row.item_price),
        shipping_price=_to_float(row.shipping_price),
        currency=_safe_str(row.currency),
        country=str(row.country or "").upper(),
        state=_safe_str(raw.get("ship-state")) or _safe_str(raw.get("ship state")),
        city=_safe_str(raw.get("ship-city")) or _safe_str(raw.get("ship city")),
        postal_code=_safe_str(raw.get("ship-postal-code"))
        or _safe_str(raw.get("ship postal code")),
        is_counted_sales=bool(row.is_counted_sales),
        created_at=row.created_at,
        carrier=_safe_str(row.carrier),
        tracking_no=_safe_str(row.tracking_no),
        shipped_at=row.shipped_at,
        updated_by=_safe_str(row.updated_by),
        updated_at=row.updated_at,
    )


# ===== Query building =====


def _build_base_query() -> Select:
    """所有“按项目归类”的订单查询都基于此 — join source_files 以取得项目元数据；
    项目过滤打在行级冗余列 AnalysisSalesOrderRow.project_id（见 apply_sql_filters）。

    销售订单按行级 upsert 维护（BEL-348），source_file.is_current 不再代表销售行是否
    有效；必须读取所有订单行，不能用该版本指针过滤，否则会丢失新上传和历史保留行。
    """

    return (
        select(AnalysisSalesOrderRow, Project)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .join(
            Project,
            Project.id == AnalysisSourceFile.project_id,
        )
    )


def _ensure_project_access_for_orders(
    db: Session,
    *,
    candidate_project_ids: list[int] | None,
    operator: str | None,
    is_admin: bool,
) -> list[int] | None:
    """对齐 ad/analysis._ensure_project_access：对非 admin 操作员返回其有权限访问的 project_id 列表。

    - admin：候选集合为空时返回 None（表示「不限项目」，让 caller 的 SQL 走全量）；
            候选非空时原样透传。
    - 非 admin 且 operator 为空：返回空列表（不抛 403，与 ad/analysis 行为一致
      —— 让上层 0 行结果自然出现；endpoint 仍由 `protected` 守住鉴权）。
    - 非 admin 且 operator 非空：从候选集合中过滤"运营关联包含该 operator"的项目；
            没传候选时，按 `list_accessible_project_ids` 缩到 operator 有权限的活跃项目。
    """
    from app.services import project_service
    from app.services.ad.helpers import _ensure_project_access

    if is_admin:
        # admin 透传候选；若前端没传（默认"全部店铺"），返回 None 让 caller 不带
        # project_id 过滤，避免被「scoped_project_ids=[] → 0 行」的早返回误伤。
        return candidate_project_ids if candidate_project_ids else None

    if not operator:
        return []

    if not candidate_project_ids:
        # 没传 project 过滤时，operator 只被允许看自己运营的活跃项目
        return project_service.list_accessible_project_ids(
            db, operator=operator, is_admin=False
        )

    allowed: list[int] = []
    for pid in candidate_project_ids:
        try:
            _ensure_project_access(
                db, project_id=int(pid), operator=operator, is_admin=False
            )
        except Exception:
            continue
        allowed.append(int(pid))
    return allowed


def _extract_fulfillment_channel(row: AnalysisSalesOrderRow) -> str:
    raw = row.raw_row if isinstance(row.raw_row, dict) else {}
    return (
        _safe_str(getattr(row, "fulfillment_channel", None))
        or _safe_str(raw.get("fulfillment-channel"))
        or _safe_str(raw.get("fulfillment channel"))
        or ""
    )


def _fulfillment_channel_sql_expr(db: Session):
    """Use the materialized PG value when available, retaining JSON extraction elsewhere."""
    try:
        dialect = db.bind.dialect.name if db.bind is not None else ""
    except Exception:
        dialect = ""
    if dialect in {"postgresql", "postgres"}:
        return AnalysisSalesOrderRow.fulfillment_channel
    # SQLite remains on the original JSON expression (JSON1); the production
    # migration and optimized read path are PostgreSQL-only.
    return AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string()


def _fulfillment_filter_sql_supported(db: Session) -> bool:
    """判定当前 dialect 是否能在 SQL 层精确过滤 fulfillment-channel。

    PostgreSQL 用生成列；其他方言保持原 JSON 路径，缺少 JSON1 扩展时
    fallback 到应用层过滤。
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
    """应用可在 SQL 层表达的过滤。fulfillment-channel 在 raw_row JSON 里，过滤放应用层。

    项目过滤打在行级冗余列 ``AnalysisSalesOrderRow.project_id``（BEL-348 从
    source_file 回填、upsert 时同步，prod 验证与 source_files.project_id 恒等），
    而非 join 出来的 ``AnalysisSourceFile.project_id``——这样能命中
    ``(project_id, purchase_at_pt)`` 复合索引，单项目分页从全表倒扫降到索引直扫。
    销售行级 upsert 的可见性不依赖 source_files.is_current；基础查询只借 source_file 关联项目。
    """

    if project_ids:
        stmt = stmt.where(AnalysisSalesOrderRow.project_id.in_(list(project_ids)))

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
    stmt = stmt.order_by(
        sort_col.desc() if sort_dir.lower() != "asc" else sort_col.asc()
    )

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
    operator: str | None = None,
    is_admin: bool = True,
    known_total: int | None = None,
) -> OrderInfoListResponse:
    safe_page = max(int(page or 1), 1)
    safe_page_size = min(max(int(page_size or DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE)

    # 非 admin 操作员的项目过滤（admin 透传候选集合，非 admin 缩到自己有权限的）
    scoped_project_ids = _ensure_project_access_for_orders(
        db,
        candidate_project_ids=project_ids,
        operator=operator,
        is_admin=is_admin,
    )
    if scoped_project_ids is not None and not scoped_project_ids:
        # 非 admin 且无权限项目 → 直接返回空
        logger.warning(
            "[order-info] list_orders empty: operator=%r has no accessible projects "
            "(candidate_project_ids=%r, is_admin=%r)",
            operator,
            project_ids,
            is_admin,
        )
        return OrderInfoListResponse(
            items=[], total=0, page=safe_page, page_size=safe_page_size
        )

    # get_overview 复用 compute_stats 主聚合里的 total_orders（与本函数精确 count 等价），
    # 传入 known_total 时跳过 count 全扫描（4 次全扫描 → 3 次）。调用方仅在「未启用
    # fulfillment 过滤」或「SQL 可精确过滤 fulfillment」（PG 生产）时才传 known_total，
    # 故这里走纯 SQL 分页路径，不涉及 SQLite 应用层 fallback。known_total=None 时
    # （所有既有调用方）完全走下面的原有逻辑，行为不变。
    if known_total is not None:
        fc_set = {c for c in (fulfillment_channels or []) if c}
        stmt = _build_base_query()
        stmt = apply_sql_filters(
            stmt,
            project_ids=scoped_project_ids,
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
        if fc_set:
            fc_expr = _fulfillment_channel_sql_expr(db)
            fc_or_clauses = [fc_expr == channel for channel in fc_set]
            stmt = stmt.where(
                fc_or_clauses[0] if len(fc_or_clauses) == 1 else or_(*fc_or_clauses)
            )
        offset = (safe_page - 1) * safe_page_size
        page_rows = db.execute(stmt.limit(safe_page_size).offset(offset)).all()
        items = [
            serialize_order_row(row, project=project) for row, project in page_rows
        ]
        return OrderInfoListResponse(
            items=items,
            total=known_total,
            page=safe_page,
            page_size=safe_page_size,
        )

    # total: 应用层先按 SQL 过滤拿到候选总数，再按 fulfillment-channel 过滤得到精确 total
    # count_sql 单独构建，不走 _build_base_query；与行级 upsert 口径一致，不按
    # source_file 的当前版本指针过滤销售订单行（BEL-348）。
    count_sql = (
        select(func.count(AnalysisSalesOrderRow.id))
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
    )
    count_sql = apply_sql_filters(
        count_sql,
        project_ids=scoped_project_ids,
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
        fc_expr = _fulfillment_channel_sql_expr(db)
        fc_or_clauses = [fc_expr == channel for channel in fc_set]
        if len(fc_or_clauses) == 1:
            count_sql = count_sql.where(fc_or_clauses[0])
        else:
            count_sql = count_sql.where(or_(*fc_or_clauses))
        total = int(db.execute(count_sql).scalar() or 0)

        stmt = _build_base_query()
        stmt = apply_sql_filters(
            stmt,
            project_ids=scoped_project_ids,
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
            project_ids=scoped_project_ids,
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
            project_ids=scoped_project_ids,
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
    operator: str | None = None,
    is_admin: bool = True,
) -> OrderInfoStats:
    """顶部 stat bar：当前筛选条件下的 订单数 / 数量 / 金额（取主导币种）/ FBA·FBM 分布

    纯 SQL 聚合实现：所有指标都通过 COUNT / SUM / CASE WHEN 在数据库层算完，
    后端只收 1 行结果。**不**再 `LIMIT 10000` + Python 循环聚合——后者在
    `/dashboard/supply-chain/order-info` 频繁筛选时拉满 1 万行 ORM 对象，是
    该页面 timeout 的根因（参见测试 `TestComputeStatsSqlAggregate`）。
    """

    scoped_project_ids = _ensure_project_access_for_orders(
        db,
        candidate_project_ids=project_ids,
        operator=operator,
        is_admin=is_admin,
    )
    if scoped_project_ids is not None and not scoped_project_ids:
        logger.warning(
            "[order-info] compute_stats empty: operator=%r has no accessible projects "
            "(candidate_project_ids=%r, is_admin=%r)",
            operator,
            project_ids,
            is_admin,
        )
        return OrderInfoStats(
            total_orders=0,
            total_quantity=0,
            total_amount=0.0,
            currency=None,
            fba_count=0,
            fbm_count=0,
        )

    # ===== 1) 主聚合：COUNT / SUM / FBA·FBM case when =====
    # 聚合 filters 都落在销售行冗余列上；FK + ondelete=CASCADE 保证移除纯投影 join
    # 不改变集合基数。SELECT 单表避免主聚合与币种查询为每行重复 join。
    fc_expr = _fulfillment_channel_sql_expr(db)
    base = select(
        AnalysisSalesOrderRow.id,
        AnalysisSalesOrderRow.quantity,
        AnalysisSalesOrderRow.item_price,
        AnalysisSalesOrderRow.shipping_price,
        AnalysisSalesOrderRow.currency,
        AnalysisSalesOrderRow.raw_row,
    )

    stmt = apply_sql_filters(
        base,
        project_ids=scoped_project_ids,
        order_statuses=order_statuses,
        countries=countries,
        currencies=currencies,
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=date_from,
        date_to=date_to,
        include_order_by=False,
    )
    fc_set = {c for c in (fulfillment_channels or []) if c}
    if fc_set:
        if len(fc_set) == 1:
            stmt = stmt.where(fc_expr == next(iter(fc_set)))
        else:
            stmt = stmt.where(or_(*[fc_expr == c for c in fc_set]))

    total_orders = func.count(AnalysisSalesOrderRow.id)
    total_quantity = func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0)
    # BLF-566: 多国家筛选下按行 country 决定含税与否（DE/UK 含税、其余净额，均含运费）。
    total_amount_expr = func.coalesce(func.sum(sales_amount_expr_by_row()), 0.0)
    fba_count_expr = func.coalesce(func.sum(case((fc_expr == "Amazon", 1), else_=0)), 0)
    fbm_count_expr = func.coalesce(
        func.sum(case((fc_expr == "Merchant", 1), else_=0)), 0
    )

    # 把聚合列投影到已应用所有 WHERE 过滤的 stmt 上（用 with_only_columns），
    # 而不是新建一个 select(...)——后者会丢掉前面 where 进去的 fc / 日期等过滤条件。
    agg_stmt = stmt.with_only_columns(
        total_orders.label("total_orders"),
        total_quantity.label("total_quantity"),
        total_amount_expr.label("total_amount"),
        fba_count_expr.label("fba_count"),
        fbm_count_expr.label("fbm_count"),
    )
    agg_row = db.execute(agg_stmt).one()

    # ===== 2) 主导币种：GROUP BY currency + count + LIMIT 1 =====
    currency_count = func.count(AnalysisSalesOrderRow.id).label("c")
    currency_sub = apply_sql_filters(
        select(AnalysisSalesOrderRow.id, AnalysisSalesOrderRow.currency),
        project_ids=scoped_project_ids,
        order_statuses=order_statuses,
        countries=countries,
        currencies=currencies,
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=date_from,
        date_to=date_to,
        include_order_by=False,
    )
    if fc_set:
        if len(fc_set) == 1:
            currency_sub = currency_sub.where(fc_expr == next(iter(fc_set)))
        else:
            currency_sub = currency_sub.where(or_(*[fc_expr == c for c in fc_set]))
    # 把 GROUP BY / ORDER BY / LIMIT 投影到已应用 WHERE 的 currency_sub 上（用
    # with_only_columns），不要新建 select(...)——否则会丢掉 fc / 日期过滤。
    currency_stmt = (
        currency_sub.where(AnalysisSalesOrderRow.currency.is_not(None))
        .with_only_columns(
            AnalysisSalesOrderRow.currency.label("currency"),
            currency_count,
        )
        .group_by(AnalysisSalesOrderRow.currency)
        .order_by(currency_count.desc(), AnalysisSalesOrderRow.currency.asc())
        .limit(1)
    )
    currency_rows = db.execute(currency_stmt).all()
    dominant_currency: str | None = None
    if currency_rows:
        dominant_currency = str(currency_rows[0].currency)

    return OrderInfoStats(
        total_orders=int(agg_row.total_orders or 0),
        total_quantity=int(agg_row.total_quantity or 0),
        total_amount=round(float(agg_row.total_amount or 0.0), 2),
        currency=dominant_currency,
        fba_count=int(agg_row.fba_count or 0),
        fbm_count=int(agg_row.fbm_count or 0),
    )


def collect_filter_options(
    db: Session,
    *,
    operator: str | None = None,
    is_admin: bool = True,
) -> OrderInfoFilterOptions:
    """首屏渲染用的筛选项下拉数据。轻量 distinct 查询。

    - 项目下拉：委托给 `project_service.list_project_items`，与全站其他页面
      （daily-analysis / shipment-management / sku-info / auto-upload / report-upload /
      ai-insights）共用同一份逻辑，按 `Project.sort_order.asc(), Project.id.asc()`
      排序——避免这边再写一遍 SQL 后跟主页面顺序不一致。非 admin 自动按
      operator 缩到有权限的活跃项目，include_inactive=False。
    - 其他 distinct 覆盖所有行级 upsert 销售订单，不依赖 `source_files.is_current`。
    """

    from app.services import project_service

    project_rows = project_service.list_project_items(
        db,
        operator=operator,
        is_admin=is_admin,
        include_inactive=False,
    )

    project_options: list[FilterOption] = []
    seen_pid: set[int] = set()
    for row in project_rows:
        pid = int(row.id)
        if pid in seen_pid:
            continue
        seen_pid.add(pid)
        pname = str(row.project_name)
        brand = _safe_str(row.brand_name)
        label = pname
        if brand:
            label = f"{pname}（{brand}）"
        project_options.append(FilterOption(value=str(pid), label=label))

    # status / country / currency 按订单行本身取 distinct。销售上传已改为行级 upsert，
    # source_file.is_current 不再能代表哪些销售行可见，不能据此裁剪筛选项。
    order_statuses = db.execute(
        select(AnalysisSalesOrderRow.order_status)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .distinct()
        .order_by(AnalysisSalesOrderRow.order_status.asc())
    ).all()
    status_options = [
        FilterOption(
            value=str(row[0]), label=str(row[0]) or ORDER_STATUS_FALLBACK_LABEL
        )
        for row in order_statuses
        if row[0]
    ]

    fc_options = [
        FilterOption(value="Amazon", label=FULFILLMENT_LABEL_MAP["Amazon"]),
        FilterOption(value="Merchant", label=FULFILLMENT_LABEL_MAP["Merchant"]),
    ]

    countries = db.execute(
        select(AnalysisSalesOrderRow.country)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
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
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
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
    operator: str | None = None,
    is_admin: bool = True,
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
        operator=operator,
        is_admin=is_admin,
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
        operator=operator,
        is_admin=is_admin,
    )
    options = collect_filter_options(db, operator=operator, is_admin=is_admin)
    return OrderInfoPageData(
        items=listing.items,
        total=listing.total,
        page=listing.page,
        page_size=listing.page_size,
        stats=stats,
        filter_options=options,
    )


def get_overview(
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
    operator: str | None = None,
    is_admin: bool = True,
) -> OrderInfoOverview:
    """一次请求返回 列表 + 顶部统计（不含 filter_options，供筛选/翻页/排序复用）。

    相比前端分别调 /list + /stats：
    - 单次 HTTP / 单事务，消除两个重型请求并行重复过滤导致的 CPU/内存峰值；
    - compute_stats 主聚合里的 total_orders 与 list 的精确 total 等价，在「无
      fulfillment 过滤」或「SQL 可精确过滤 fulfillment」（PG 生产）时复用为
      known_total，省掉 list 的 count 全扫描（4 次全扫描 → 3 次）。
    """
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
        operator=operator,
        is_admin=is_admin,
    )
    fc_set = {c for c in (fulfillment_channels or []) if c}
    can_share_total = (not fc_set) or _fulfillment_filter_sql_supported(db)
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
        operator=operator,
        is_admin=is_admin,
        known_total=stats.total_orders if can_share_total else None,
    )
    return OrderInfoOverview(
        items=listing.items,
        total=listing.total,
        page=listing.page,
        page_size=listing.page_size,
        stats=stats,
    )


def parse_date_input(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.strptime(value.strip()[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


# ===== Live Stream · 今日出单流（BLF-839） =====


DEFAULT_LIVE_STREAM_LIMIT = 10
MAX_LIVE_STREAM_LIMIT = 50


def query_order_live_stream(
    db: Session,
    *,
    project_ids: list[int] | None = None,
    countries: Iterable[str] | None = None,
    limit: int = DEFAULT_LIVE_STREAM_LIMIT,
    operator: str | None = None,
    is_admin: bool = True,
) -> list[OrderLiveStreamItem]:
    """今日出单流：按订单去重后的最近 N 条出单事件（BLF-839）。

        口径（与 order-info 列表页 / ``counted_sales_where`` 一致）：

        * 只取 ``is_counted_sales`` 行，排除 Cancelled，含 Pending/Unshipped
          （已下单未发货也算出单事件）；
        * 窗口 = 各站点本地「今天」（``get_today_for_country``，US=PT/DE=Berlin/
      UK=London），打在 ``purchase_date_pt`` 上；
        * 同一订单多 SKU 行合并为一条事件（金额求和、数量求和）；
    * 排序键取组内最晚 ``purchase_at_utc``（真实购买瞬间，NOT NULL）；
    * 按行级销售数据口径取数；不依赖销售上传后已废弃的 ``source_file.is_current`` 指针。

        权限：复用 :func:`_ensure_project_access_for_orders`——admin 不限项目，
        非 admin 缩到自己运营的项目；无权限返回空列表。

        响应字段对齐前端 ``TerminalInspector`` 的 ``LiveStreamItem`` 插槽
        （PR #425）：``id`` / ``title`` / ``time_label`` 为最小集，其余为扩展上下文。
    """
    safe_limit = min(
        max(int(limit or DEFAULT_LIVE_STREAM_LIMIT), 1), MAX_LIVE_STREAM_LIMIT
    )

    scoped_project_ids = _ensure_project_access_for_orders(
        db,
        candidate_project_ids=project_ids,
        operator=operator,
        is_admin=is_admin,
    )
    if scoped_project_ids is not None and not scoped_project_ids:
        return []

    # 各站点本地「今天」：窗口下界取最早的站点今天，避免跨站点时漏掉
    # 已进入当地今天的行；上界用 date.max 兜底未来日期行（正常数据不会有）。
    today_min = min(get_today_for_country(c) for c in sorted(SUPPORTED_COUNTRIES))

    latest_utc = func.max(AnalysisSalesOrderRow.purchase_at_utc).label("latest_utc")
    stmt = (
        _build_base_query()
        .with_only_columns(
            AnalysisSalesOrderRow.project_id,
            AnalysisSalesOrderRow.amazon_order_id,
            latest_utc,
            func.sum(AnalysisSalesOrderRow.quantity).label("quantity"),
            func.sum(sales_amount_expr_by_row()).label("amount"),
            func.min(AnalysisSalesOrderRow.currency).label("currency"),
            func.min(AnalysisSalesOrderRow.country).label("country"),
            func.min(AnalysisSalesOrderRow.order_status).label("order_status"),
        )
        .where(AnalysisSalesOrderRow.is_counted_sales.is_(True))
        .where(AnalysisSalesOrderRow.order_status != "Cancelled")
        .where(AnalysisSalesOrderRow.purchase_date_pt >= today_min)
        .group_by(
            AnalysisSalesOrderRow.project_id,
            AnalysisSalesOrderRow.amazon_order_id,
        )
        .order_by(latest_utc.desc())
        .limit(safe_limit)
    )
    if scoped_project_ids is not None:
        stmt = stmt.where(AnalysisSalesOrderRow.project_id.in_(scoped_project_ids))

    country_list = [c for c in (countries or []) if c]
    if country_list:
        stmt = stmt.where(AnalysisSalesOrderRow.country.in_(country_list))

    rows = db.execute(stmt).all()
    if not rows:
        return []

    project_names = {
        p.id: p.project_name
        for p in db.query(Project)
        .filter(Project.id.in_({r.project_id for r in rows}))
        .all()
    }

    items: list[OrderLiveStreamItem] = []
    for r in rows:
        amount_value = r.amount if r.amount is not None else Decimal("0")
        currency = (r.currency or "").strip()
        amount_text = f"{round_money(amount_value):,.2f}"
        title = (
            f"订单 #{r.amazon_order_id} · {currency} {amount_text}"
            if currency
            else f"订单 #{r.amazon_order_id} · {amount_text}"
        )
        items.append(
            OrderLiveStreamItem(
                id=f"{r.project_id}:{r.amazon_order_id}",
                title=title,
                # 北京时间 HH:MM（与订单信息页展示口径一致）
                time_label=_beijing_hhmm(r.latest_utc),
                # timestamptz 真实瞬间；serializer 统一转 UTC ISO 输出
                occurred_at=r.latest_utc,
                project_id=int(r.project_id),
                project_name=project_names.get(int(r.project_id)),
                country=(r.country or "").upper() or None,
                currency=currency or None,
                amount=round_money(amount_value),
                quantity=int(r.quantity or 0),
                order_status=r.order_status or None,
            )
        )
    return items


# ===== Mutation (FBM 补录) =====


class OrderInfoNotFound(LookupError):
    """订单行 id 不存在"""


class OrderInfoForbidden(PermissionError):
    """operator 无权编辑该项目下的订单"""


def update_order_by_id(
    db: Session,
    order_id: int,
    payload,
    *,
    operator: str | None,
    is_admin: bool,
):
    """FBM 订单补录/编辑。

    - 仅允许更新迁移 200 新增的 4 个字段（carrier / tracking_no / shipped_at / updated_by）。
    - 权限：复用 _ensure_project_access_for_orders，admin 可改任何项目，operator 仅可改
      "运营关联" 项目下的订单；跨店铺访问 → 抛 OrderInfoForbidden。
    - 不修改 fulfilled_at/订单状态/任何只读字段。
    """
    from app.schemas.order_info import OrderInfoUpdate

    stmt = (
        select(AnalysisSalesOrderRow, Project)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .join(Project, Project.id == AnalysisSourceFile.project_id)
        .where(AnalysisSalesOrderRow.id == order_id)
    )
    result = db.execute(stmt).first()
    if not result:
        raise OrderInfoNotFound(f"order {order_id} not found")
    order_row, project = result

    # 权限校验（admin 透传；operator 必须对 project 有访问权）
    scoped = _ensure_project_access_for_orders(
        db,
        candidate_project_ids=[int(project.id)],
        operator=operator,
        is_admin=is_admin,
    )
    if scoped == [] or (scoped is not None and int(project.id) not in scoped):
        raise OrderInfoForbidden("无权限编辑该项目下的订单")

    if not isinstance(payload, OrderInfoUpdate):
        # 允许外部直接传 dict（兼容测试）
        payload = OrderInfoUpdate.model_validate(payload)

    data = payload.model_dump(exclude_unset=True)
    if "carrier" in data:
        order_row.carrier = _safe_str(data["carrier"])
    if "tracking_no" in data:
        order_row.tracking_no = _safe_str(data["tracking_no"])
    if "shipped_at" in data:
        # 允许传 null 表示清空
        order_row.shipped_at = data["shipped_at"]
    if "updated_by" in data:
        # payload 显式传空串/null → 清空；未传 → 留空（由 endpoint 兜底填 operator）
        order_row.updated_by = _safe_str(data["updated_by"])

    order_row.updated_at = datetime.now(timezone.utc)
    db.flush()
    return serialize_order_row(order_row, project=project)


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
    "物流商",
    "物流单号",
    "发货时间",
    "更新人",
    "更新时间",
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
    operator: str | None = None,
    is_admin: bool = True,
) -> tuple[str, str]:
    """导出当前筛选条件下的订单 CSV。返回 (filename, csv_text)。"""

    scoped_project_ids = _ensure_project_access_for_orders(
        db,
        candidate_project_ids=project_ids,
        operator=operator,
        is_admin=is_admin,
    )
    if scoped_project_ids is not None and not scoped_project_ids:
        # 非 admin 且无权限 → 返回只含表头的空 CSV
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(ORDER_CSV_HEADERS)
        filename = (
            f"order-info-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
        )
        return filename, buffer.getvalue()

    stmt = _build_base_query()
    stmt = apply_sql_filters(
        stmt,
        project_ids=scoped_project_ids,
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
                _fulfillment_channel_sql_expr(db) == next(iter(fc_set))
            )
        else:
            stmt = stmt.where(
                or_(
                    *[
                        _fulfillment_channel_sql_expr(db) == channel
                        for channel in fc_set
                    ]
                )
            )
    rows = db.execute(stmt.limit(max_rows)).all()
    if not (fc_set and _fulfillment_filter_sql_supported(db)):
        rows = _apply_app_filters(rows, fulfillment_channels=fulfillment_channels)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(ORDER_CSV_HEADERS)

    for row, project in rows:
        item = serialize_order_row(row, project=project)
        writer.writerow(
            [
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
                item.carrier or "",
                item.tracking_no or "",
                _to_beijing_str(item.shipped_at) if item.shipped_at else "",
                item.updated_by or "",
                _to_beijing_str(item.updated_at) if item.updated_at else "",
            ]
        )

    csv_text = buffer.getvalue()
    filename = f"order-info-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
    return filename, csv_text


__all__ = [
    "DEFAULT_PAGE_SIZE",
    "EXPORT_MAX_ROWS",
    "FULFILLMENT_LABEL_MAP",
    "MAX_PAGE_SIZE",
    "ORDER_CSV_HEADERS",
    "OrderInfoForbidden",
    "OrderInfoNotFound",
    "collect_filter_options",
    "compute_stats",
    "export_orders_to_csv",
    "get_overview",
    "get_page_data",
    "list_orders",
    "parse_date_input",
    "serialize_order_row",
    "update_order_by_id",
]
