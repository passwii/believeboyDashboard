"""Ad-specific report specs (10 subtypes).

This module defines recognition specs for Amazon advertising reports that are
NOT handled by the shared ``backend/app/utils/recognition/`` engine.

Architecture note — why a separate recognition system?
────────────────────────────────────────────────────────
The core recognition engine (``app.utils.recognition.recognizers``) handles 7
general report types (inventory, sales, business, payment, ad_product,
ad_search_term, return).  It was designed for daily operational reports with
simple column signatures.

Amazon's advertising console exports 10+ report subtypes with overlapping but
distinct Chinese column headers (e.g. 广告活动名称, 广告SKU, 广告ASIN).  These
reports use superset matching on Chinese columns, which is incompatible with the
core engine's lowercase-normalized English matching.

Therefore, ad upload recognition lives here — intentionally independent.
If you add a new ad report subtype, add a ``ReportSpec`` entry below.
Do NOT merge this into ``app.utils.recognition`` — the column normalization
strategies differ (this module preserves Chinese columns as-is; the core
engine lowercases everything).
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

OPENPYXL_MISSING_DEFAULT_STYLE_WARNING = (
    'Workbook contains no default style, apply openpyxl\'s default'
)
ALLOWED_EXTENSIONS = {'.csv', '.xlsx'}
DECIMAL_ZERO = Decimal('0')


@dataclass(frozen=True)
class ReportSpec:
    report_type: str
    report_label: str
    extensions: tuple[str, ...]
    required_columns: tuple[str, ...]
    project_match_fields: tuple[tuple[str, str], ...] = ()


REPORT_SPECS: tuple[ReportSpec, ...] = (
    ReportSpec(
        report_type='ad_search_term_share_report',
        report_label='搜索词展示量份额',
        extensions=('.csv',),
        required_columns=('开始日期', '结束日期', '客户搜索词', '搜索词展示量排名', '搜索词展示量份额'),
    ),
    ReportSpec(
        report_type='ad_budget_report',
        report_label='预算',
        extensions=('.csv',),
        required_columns=('开始日期', '结束日期', '广告活动名称', '建议预算', '预算范围内的平均时间'),
    ),
    ReportSpec(
        report_type='ad_campaign_report',
        report_label='广告活动',
        extensions=('.csv',),
        required_columns=('开始日期', '结束日期', '广告活动名称', '预算', '定位类型', '竞价策略'),
    ),
    ReportSpec(
        report_type='ad_purchased_product_report',
        report_label='已购买商品',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '广告SKU', '广告ASIN', '已购买的ASIN'),
        project_match_fields=(('sku', '广告SKU'), ('asin', '广告ASIN')),
    ),
    ReportSpec(
        report_type='ad_promoted_product_report',
        report_label='推广的商品',
        # BLF-975 复测：agent 同事把 xlsx 转 CSV 再校验也被拒 → 放开 .csv。
        extensions=('.xlsx', '.csv'),
        required_columns=('开始日期', '结束日期', '广告SKU', '广告ASIN', '广告活动名称', '广告组名称'),
        project_match_fields=(('sku', '广告SKU'), ('asin', '广告ASIN')),
    ),
    ReportSpec(
        report_type='ad_invalid_traffic_report',
        report_label='总流量和无效流量',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '广告活动名称', '总展示量', '无效展示量', '无效点击'),
    ),
    ReportSpec(
        report_type='ad_placement_report',
        report_label='广告位',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '广告活动名称', '放置'),
    ),
    ReportSpec(
        report_type='ad_target_report',
        report_label='搜索词投放',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '投放', '匹配类型', '搜索结果首页首位展示量份额'),
    ),
    ReportSpec(
        report_type='ad_search_term_report',
        report_label='搜索词',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '投放', '匹配类型', '客户搜索词'),
    ),
    ReportSpec(
        report_type='ad_time_trend_report',
        report_label='按时间查看效果',
        extensions=('.xlsx',),
        required_columns=('开始日期', '结束日期', '国家/地区', '货币', '点击量', '单次点击成本 (CPC)', '花费'),
    ),
)


def _periodic_required_columns(spec: ReportSpec) -> tuple[str, ...]:
    columns = list(spec.required_columns)
    while columns and columns[0] in {'开始日期', '结束日期'}:
        columns.pop(0)
    return ('日期', *columns)
