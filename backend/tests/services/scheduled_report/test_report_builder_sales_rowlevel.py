"""BEL-348 收尾：定时报告销售查询须按行级口径聚合，不依赖 is_current。

回归测试：把销售订单行改成行级 upsert 后，日/周/月报的「销售快照」查询若仍
JOIN analysis_source_files 且过滤 is_current=True，只会统计「最后上传那一版」文件的行、
漏掉更早更全版本里、后续版本没再重传的订单（即 BEL-348 要解决的丢单，
泄漏进定时报告）。

本测试针对 daily 构建器的核心销售快照 ``_query_sales_snapshot``：
- v1（较早、更全）：订单 A, B, C
- v2（最新、is_current=True）：重传 A, B + 新单 D（C 在最新一次拉取里被丢弃）
经 upsert 后表里保留 A,B,C,D 四行（C 来自 v1、v2 没重传故留存）。
断言快照聚合出**全部 4 单**，而非仅 is_current 版本 v2 的 3 单（A,B,D）。

真实 Postgres（schema 由 cmd/setuptestdb 从 DATABASE_URL 克隆，含 5 列唯一约束）。
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timezone

import pytest
from sqlalchemy import text

from app.db.session import SessionLocal
from app.models import AnalysisSourceFile
from app.models.project import Project
from app.services.scheduled_report import report_builder_daily
from app.utils.persist_helpers import upsert_sales_order_rows

_TEST_PROJECT_RE = r"^.*-TEST-.+$"


@pytest.fixture(autouse=True)
def _auto_cleanup(db_session):
    yield
    with SessionLocal() as session:
        try:
            dirty = session.execute(
                text("SELECT id FROM projects WHERE project_name ~* :re"),
                {"re": _TEST_PROJECT_RE},
            ).scalars().all()
            if not dirty:
                return
            session.execute(
                text("DELETE FROM analysis_sales_order_rows WHERE project_id = ANY(:ids)"),
                {"ids": list(dirty)},
            )
            session.execute(
                text("DELETE FROM analysis_source_files WHERE project_id = ANY(:ids)"),
                {"ids": list(dirty)},
            )
            session.execute(
                text("DELETE FROM projects WHERE id = ANY(:ids)"),
                {"ids": list(dirty)},
            )
            session.commit()
        except Exception:
            session.rollback()
            raise


@pytest.fixture()
def db_session():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture()
def project_id(db_session):
    name = f"PH-TEST-{uuid.uuid4().hex[:10]}"
    p = Project(project_name=name, sort_order=0, is_active=False)
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    pid = p.id
    try:
        yield pid
    finally:
        db_session.execute(
            text("DELETE FROM analysis_sales_order_rows WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(
            text("DELETE FROM analysis_source_files WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


def _make_source(db, *, project_id, version, is_current, report_date=date(2026, 7, 15)):
    sf = AnalysisSourceFile(
        project_id=project_id,
        report_type="sales_report",
        country="UK",
        report_date=report_date,
        period_start_date=report_date,
        period_end_date=report_date,
        snapshot_at=None,
        version=version,
        is_current=is_current,
        superseded_at=None,
        upload_file_id=f"upload-sales-{uuid.uuid4().hex[:8]}",
        upload_file_path="/tmp/sales.tsv",
        original_filename="sales.tsv",
        stored_filename="sales.tsv",
        logical_filename="sales.tsv",
        storage_key=f"web_upload/sales/{project_id}/{report_date}",
        ingestion_status="success",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(sf)
    db.flush()
    return sf


def _row_dict(*, project_id, source_file_id, order_id, purchase_date=date(2026, 7, 15), qty=1):
    return {
        "project_id": project_id,
        "source_file_id": source_file_id,
        "source_row_no": 1,
        "amazon_order_id": order_id,
        "purchase_at_utc": datetime.combine(purchase_date, time(12, 0), tzinfo=timezone.utc),
        "purchase_at_pt": datetime.combine(purchase_date, time(5, 0)),
        "purchase_date_pt": purchase_date,
        "order_status": "Shipped",
        "country": "UK",
        "sku": "SKU-A",
        "asin": "ASIN1",
        "quantity": qty,
        "item_price": "18.99",
        "shipping_price": "0.00",
        "item_tax": "0.00",
        "shipping_tax": "0.00",
        "currency": "GBP",
        "is_counted_sales": True,
        "status_rule_version": 1,
        "raw_row": {},
        "carrier": None,
        "tracking_no": None,
        "shipped_at": None,
        "updated_by": None,
        "updated_at": None,
    }


def test_sales_snapshot_aggregates_all_versions_not_just_current(
    db_session, project_id
):
    """Same day: v1 has A,B,C; v2 (is_current) re-sends A,B + new D.
    After upsert the table keeps A,B,C,D (C dropped by v2 but persisted from v1).
    Row-level aggregation must yield 4 distinct orders, NOT v2's 3 (A,B,D).
    """
    v1 = _make_source(db_session, project_id=project_id, version=1, is_current=False)
    v2 = _make_source(db_session, project_id=project_id, version=2, is_current=True)
    db_session.commit()

    upsert_sales_order_rows(db_session, [
        _row_dict(project_id=project_id, source_file_id=v1.id, order_id="026-AAAAAA-AAAAAA"),
        _row_dict(project_id=project_id, source_file_id=v1.id, order_id="026-BBBBBB-BBBBBB"),
        _row_dict(project_id=project_id, source_file_id=v1.id, order_id="026-CCCCCC-CCCCCC"),
    ])
    upsert_sales_order_rows(db_session, [
        _row_dict(project_id=project_id, source_file_id=v2.id, order_id="026-AAAAAA-AAAAAA"),
        _row_dict(project_id=project_id, source_file_id=v2.id, order_id="026-BBBBBB-BBBBBB"),
        _row_dict(project_id=project_id, source_file_id=v2.id, order_id="026-DDDDDD-DDDDDD"),
    ])
    db_session.commit()

    # 7 天窗口（与真实日报表一致），end_date=07-15，断言其当日单数。
    snap, _, total_qty = report_builder_daily._query_sales_snapshot(
        db_session, [project_id], "UK", date(2026, 7, 9), date(2026, 7, 15)
    )

    # 行级口径：A,B,C,D 全部计入 = 4 单；
    # 旧 is_current 口径只算 v2 的 A,B,D = 3 单（C 在最新拉取被丢弃却仍应留存）。
    assert snap["today_order_qty"] == 4, (
        f"定时报告销售快照应按行级口径聚合全部版本，得到 4 单，"
        f"实际 {snap['today_order_qty']}（疑似仍只统计 is_current 版本）"
    )
    assert total_qty == 4

