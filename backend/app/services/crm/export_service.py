"""CRM CSV 导出服务（P3b）。

按当前 scope/keyword 过滤导出客户/线索清单为 CSV（不分页，导出全部命中）。
- 复用 list_customers / list_leads 的过滤逻辑（page_size 放大取全量）。
- CSV 用 UTF-8 BOM 打头，Excel 打开中文不乱码。
- 时间统一转上海时区展示（YYYY-MM-DD HH:MM）。

纯逻辑函数（headers / row / format_dt / build_*_csv）不碰数据库，
由 tests/services/crm/test_export_service.py 覆盖；build_*_csv 的查询
部分由 tests/api/crm/test_export_api.py 覆盖。
"""

from __future__ import annotations

import csv
import io
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.schemas.crm import CustomerItem, LeadItem
from app.services.crm import customer_service, lead_service

SH = ZoneInfo("Asia/Shanghai")
BOM = "\ufeff"

# 导出上限（page_size 上限），CRM 数据量远小于此，足够全量导出。
_EXPORT_LIMIT = 100000

# 客户导出列（顺序即 CSV 列顺序）
CUSTOMER_CSV_HEADERS = [
    "名称",
    "简称",
    "行业",
    "对象类型",
    "意向服务",
    "评级",
    "状态",
    "负责人",
    "主联系人",
    "主联系人电话",
    "主联系人微信",
    "最近跟进",
    "下次跟进",
    "创建时间",
]

# 线索导出列
LEAD_CSV_HEADERS = [
    "联系人名",
    "公司",
    "电话",
    "微信",
    "来源",
    "对象类型",
    "意向服务",
    "状态",
    "意向度",
    "负责人",
    "下次跟进",
    "创建时间",
]


def format_dt(dt: datetime | None) -> str:
    """时间格式化为上海时区 'YYYY-MM-DD HH:MM'；None → 空串。

    aware datetime 转上海时区；naive datetime 按原样格式化。
    """
    if dt is None:
        return ""
    if dt.tzinfo is not None:
        dt = dt.astimezone(SH)
    return dt.strftime("%Y-%m-%d %H:%M")


def customer_row(item: CustomerItem) -> list[str]:
    """客户 item → CSV 一行（与 CUSTOMER_CSV_HEADERS 对齐）。"""
    return [
        item.name,
        item.short_name or "",
        item.industry or "",
        item.customer_type or "",
        item.interested_service or "",
        item.rating,
        item.status,
        item.owner_name or "",
        item.contact_name or "",
        item.contact_phone or "",
        item.contact_wechat or "",
        format_dt(item.last_follow_at),
        format_dt(item.next_follow_at),
        format_dt(item.created_at),
    ]


def lead_row(item: LeadItem) -> list[str]:
    """线索 item → CSV 一行（与 LEAD_CSV_HEADERS 对齐）。"""
    return [
        item.name,
        item.company or "",
        item.phone or "",
        item.wechat or "",
        item.source or "",
        item.customer_type or "",
        item.interested_service or "",
        item.status,
        item.intent,
        item.owner_name or "",
        format_dt(item.next_follow_at),
        format_dt(item.created_at),
    ]


def _render_csv(headers: list[str], rows: list[list[str]]) -> str:
    """表头 + 数据行 → 带 BOM 的 CSV 文本（csv 模块处理引号/逗号转义）。"""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    writer.writerows(rows)
    return BOM + buf.getvalue()


def build_customer_csv(items: list[CustomerItem]) -> str:
    """客户列表 → CSV 文本（含 BOM）。"""
    return _render_csv(CUSTOMER_CSV_HEADERS, [customer_row(i) for i in items])


def build_lead_csv(items: list[LeadItem]) -> str:
    """线索列表 → CSV 文本（含 BOM）。"""
    return _render_csv(LEAD_CSV_HEADERS, [lead_row(i) for i in items])


def export_customers_csv(
    db: Session, *, user_id: str | None, scope: str, keyword: str | None
) -> str:
    """按 scope/keyword 导出全部命中客户为 CSV（不分页）。"""
    items, _ = customer_service.list_customers(
        db,
        user_id=user_id,
        scope=scope,
        keyword=keyword,
        page=1,
        page_size=_EXPORT_LIMIT,
    )
    return build_customer_csv(items)


def export_leads_csv(
    db: Session, *, user_id: str | None, scope: str, keyword: str | None
) -> str:
    """按 scope/keyword 导出全部命中线索为 CSV（不分页）。"""
    items, _ = lead_service.list_leads(
        db,
        user_id=user_id,
        scope=scope,
        keyword=keyword,
        page=1,
        page_size=_EXPORT_LIMIT,
    )
    return build_lead_csv(items)
