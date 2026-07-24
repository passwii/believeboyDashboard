"""export_service 纯逻辑测试（不碰数据库，可本地运行）。

覆盖 CSV 表头、行映射、时间格式化（UTC→上海时区）、UTF-8 BOM、空结果。
DB 相关的 build_*_csv 查询函数由 tests/api/crm/test_export_api.py 覆盖（主 agent 串行跑）。
"""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone

from app.schemas.crm import CustomerItem, LeadItem
from app.services.crm.export_service import (
    CUSTOMER_CSV_HEADERS,
    LEAD_CSV_HEADERS,
    build_customer_csv,
    build_lead_csv,
    customer_row,
    format_dt,
    lead_row,
)

# UTF-8 BOM（Excel 识别中文编码用）
BOM = "\ufeff"


def _customer(**kw) -> CustomerItem:
    base = dict(
        id=1,
        name="客户A",
        rating="A",
        status="active",
        created_at=datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
        updated_at=datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
    )
    base.update(kw)
    return CustomerItem(**base)


def _lead(**kw) -> LeadItem:
    base = dict(
        id=1,
        name="联系人A",
        status="new",
        intent="high",
        created_at=datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
        updated_at=datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
    )
    base.update(kw)
    return LeadItem(**base)


# ── 表头 ─────────────────────────────────────────────────────────────────────


def test_customer_headers_match_spec():
    assert CUSTOMER_CSV_HEADERS == [
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


def test_lead_headers_match_spec():
    assert LEAD_CSV_HEADERS == [
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


# ── 时间格式化 ───────────────────────────────────────────────────────────────


def test_format_dt_none_returns_empty():
    assert format_dt(None) == ""


def test_format_dt_converts_utc_to_shanghai():
    # UTC 2026-01-01 16:00 → 上海（+8）2026-01-02 00:00
    dt = datetime(2026, 1, 1, 16, 0, 0, tzinfo=timezone.utc)
    assert format_dt(dt) == "2026-01-02 00:00"


def test_format_dt_naive_treated_as_is():
    # naive datetime 不带时区，按原样格式化
    dt = datetime(2026, 7, 24, 3, 0, 0)
    assert format_dt(dt) == "2026-07-24 03:00"


# ── 行映射 ───────────────────────────────────────────────────────────────────


def test_customer_row_maps_all_columns():
    item = _customer(
        short_name="简称A",
        industry="制造业",
        customer_type="工厂",
        interested_service="代运营",
        owner_name="张三",
        contact_name="李四",
        contact_phone="13800000000",
        contact_wechat="wx_lisi",
        last_follow_at=datetime(2026, 1, 1, 16, 0, 0, tzinfo=timezone.utc),
        next_follow_at=datetime(2026, 1, 2, 16, 0, 0, tzinfo=timezone.utc),
    )
    row = customer_row(item)
    assert row[0] == "客户A"
    assert row[1] == "简称A"
    assert row[2] == "制造业"
    assert row[3] == "工厂"
    assert row[4] == "代运营"
    assert row[5] == "A"
    assert row[6] == "active"
    assert row[7] == "张三"
    assert row[8] == "李四"
    assert row[9] == "13800000000"
    assert row[10] == "wx_lisi"
    assert row[11] == "2026-01-02 00:00"  # UTC→上海
    assert row[12] == "2026-01-03 00:00"
    assert len(row) == len(CUSTOMER_CSV_HEADERS)


def test_customer_row_none_fields_become_empty():
    row = customer_row(_customer())
    assert row[1] == ""  # short_name None
    assert row[7] == ""  # owner_name None
    assert row[11] == ""  # last_follow_at None


def test_lead_row_maps_all_columns():
    item = _lead(
        company="公司A",
        phone="13900000000",
        wechat="wx_a",
        source="referral",
        customer_type="贸易商",
        interested_service="AI运营",
        owner_name="王五",
        next_follow_at=datetime(2026, 1, 1, 16, 0, 0, tzinfo=timezone.utc),
    )
    row = lead_row(item)
    assert row[0] == "联系人A"
    assert row[1] == "公司A"
    assert row[2] == "13900000000"
    assert row[3] == "wx_a"
    assert row[4] == "referral"
    assert row[5] == "贸易商"
    assert row[6] == "AI运营"
    assert row[7] == "new"
    assert row[8] == "high"
    assert row[9] == "王五"
    assert row[10] == "2026-01-02 00:00"
    assert len(row) == len(LEAD_CSV_HEADERS)


# ── CSV 组装 ─────────────────────────────────────────────────────────────────


def _parse_csv(content: str) -> list[list[str]]:
    # 去掉 BOM 后用 csv 解析
    assert content.startswith(BOM), "CSV 必须以 UTF-8 BOM 开头"
    return list(csv.reader(io.StringIO(content[len(BOM) :])))


def test_build_customer_csv_header_and_rows():
    content = build_customer_csv([_customer(name="客户A"), _customer(name="客户B")])
    rows = _parse_csv(content)
    assert rows[0] == CUSTOMER_CSV_HEADERS
    assert rows[1][0] == "客户A"
    assert rows[2][0] == "客户B"
    assert len(rows) == 3


def test_build_customer_csv_empty_has_header_only():
    rows = _parse_csv(build_customer_csv([]))
    assert rows == [CUSTOMER_CSV_HEADERS]


def test_build_lead_csv_quotes_commas():
    # 含逗号/引号的字段需被 csv 正确转义
    content = build_lead_csv([_lead(company="公司,含逗号")])
    rows = _parse_csv(content)
    assert rows[1][1] == "公司,含逗号"


def test_build_lead_csv_empty_has_header_only():
    rows = _parse_csv(build_lead_csv([]))
    assert rows == [LEAD_CSV_HEADERS]
