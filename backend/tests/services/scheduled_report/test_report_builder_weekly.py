"""Tests for app.services.scheduled_report.report_builder_weekly._get_inventory_alerts.

These tests pin the BEL-130 fix: the weekly report inventory-alerts query
must use the "latest ``report_date`` snapshot per (project, country)"
口径 (aligned with ``inventory_analysis_service._get_inventory_source``),
and must NOT depend on the ``is_current`` flag. Before the fix, the query
filtered ``is_current=True``, which silently dropped every snapshot whose
``is_current`` was False (BEL-104-era legacy data, 手工回填 rows, etc.),
so the weekly report showed 0 inventory alerts for every project.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.models import AnalysisSourceFile, InventorySnapshotRow
from app.models.project import Project
from app.services.scheduled_report import report_builder_weekly


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def db():
    """In-memory SQLite session with the schema needed for the test rows.

    We import the relevant models so ``Base.metadata.create_all`` builds
    only the tables this test file touches; we keep the fixture isolated
    to avoid pulling the whole model graph into a sqlite-only schema.
    """
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _make_project(db, project_id: int, name: str = "测试项目") -> Project:
    project = Project(
        id=project_id,
        project_name=f"{name}-{project_id}",
        sort_order=0,
        is_active=True,
    )
    db.add(project)
    db.flush()
    return project


def _make_inventory_source(
    db,
    *,
    source_id: int,
    project_id: int,
    country: str = "US",
    report_date: date,
    version: int = 1,
    is_current: bool = False,
    snapshot_at: datetime | None = None,
) -> AnalysisSourceFile:
    """Insert a minimal ``AnalysisSourceFile`` row that satisfies the table's
    CHECK constraints for ``report_type = 'inventory_report'``.

    NOTE: We bypass the model's defaults because sqlite does not honor the
    PG server_default for the ``is_current`` boolean column. The point of
    the test is to exercise the weekly builder's query, not the
    persistence layer.
    """
    if snapshot_at is None:
        snapshot_at = datetime(
            report_date.year,
            report_date.month,
            report_date.day,
            tzinfo=timezone.utc,
        )
    sf = AnalysisSourceFile(
        id=source_id,
        project_id=project_id,
        report_type="inventory_report",
        country=country,
        report_date=report_date,
        snapshot_at=snapshot_at,
        version=version,
        is_current=is_current,
        upload_file_id=f"upload-{source_id}",
        upload_file_path=f"/tmp/upload-{source_id}.xlsx",
        original_filename=f"inv-{source_id}.xlsx",
        stored_filename=f"inv-{source_id}.xlsx",
        logical_filename=f"inv-{source_id}.xlsx",
        storage_key=f"s3://bucket/inv-{source_id}.xlsx",
        ingestion_status="success",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(sf)
    db.flush()
    return sf


def _make_snapshot_row(
    db,
    *,
    source_id: int,
    sku: str,
    available_qty: int,
    stock_status: str = "in_stock",
    source_row_no: int = 1,
) -> InventorySnapshotRow:
    row = InventorySnapshotRow(
        source_file_id=source_id,
        source_row_no=source_row_no,
        sku=sku,
        available_qty=available_qty,
        stock_status=stock_status,
        aging_status="fresh",
    )
    db.add(row)
    db.flush()
    return row


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_uses_latest_snapshot_when_is_current_is_false(db) -> None:
    """BEL-130 regression guard.

    Two inventory_report snapshots for the same (project, country):
      * older snapshot, ``is_current=True``   (would be picked by the OLD query)
      * newer snapshot, ``is_current=False``  (this is the one the NEW query must pick)

    The OLD code filtered ``is_current=True`` and would return zero rows.
    The NEW code picks the snapshot with the largest ``report_date`` and
    must surface the newer snapshot's SKU.
    """
    _make_project(db, project_id=1)

    older = _make_inventory_source(
        db,
        source_id=10,
        project_id=1,
        report_date=date(2026, 6, 10),
        version=1,
        is_current=True,
    )
    _make_snapshot_row(db, source_id=older.id, sku="SKU-OLD", available_qty=2)

    newer = _make_inventory_source(
        db,
        source_id=11,
        project_id=1,
        report_date=date(2026, 6, 15),
        version=1,
        is_current=False,
    )
    _make_snapshot_row(db, source_id=newer.id, sku="SKU-NEW", available_qty=3)

    db.commit()

    alerts = report_builder_weekly._get_inventory_alerts(
        db, project_ids=[1], country="US"
    )

    assert [a["sku"] for a in alerts] == ["SKU-NEW"]
    assert alerts[0]["available_qty"] == 3
    assert alerts[0]["level"] == "low"


def test_filters_by_project_ids(db) -> None:
    """Multi-project: alerts must only come from the requested project_ids.

    Two projects, each with one snapshot. The caller asks for
    ``project_ids=[1]`` — only SKU-A from project 1 should come back,
    not SKU-B from project 2.
    """
    _make_project(db, project_id=1)
    _make_project(db, project_id=2)

    sf_a = _make_inventory_source(
        db,
        source_id=20,
        project_id=1,
        report_date=date(2026, 6, 14),
    )
    _make_snapshot_row(db, source_id=sf_a.id, sku="SKU-A", available_qty=1)

    sf_b = _make_inventory_source(
        db,
        source_id=21,
        project_id=2,
        report_date=date(2026, 6, 14),
    )
    _make_snapshot_row(db, source_id=sf_b.id, sku="SKU-B", available_qty=1)

    db.commit()

    alerts = report_builder_weekly._get_inventory_alerts(
        db, project_ids=[1], country="US"
    )

    assert [a["sku"] for a in alerts] == ["SKU-A"]


def test_no_snapshot_returns_empty_and_warns(
    db, caplog: pytest.LogCaptureFixture
) -> None:
    """No inventory_report snapshot at all → ``[]`` + fallback warning log.

    Before the fix, this case was silent — the function returned ``[]``
    without any log, so an outage (no snapshot uploaded for a project)
    was indistinguishable from "no alerts needed". The fallback warning
    log is the new affordance that surfaces this state.
    """
    import logging

    with caplog.at_level(logging.WARNING, logger=report_builder_weekly.logger.name):
        alerts = report_builder_weekly._get_inventory_alerts(
            db, project_ids=[99], country="US"
        )

    assert alerts == []
    assert "BEL-130" in caplog.text
    assert "no inventory alerts found" in caplog.text


def test_threshold_and_limit(db) -> None:
    """Only ``available_qty <= 10`` count as alerts, max 20 entries.

    Insert 25 low-stock rows (qty=5) and 1 healthy row (qty=50). Verify:
      * the healthy row is NOT included,
      * the alert list is capped at 20,
      * all included rows have ``available_qty <= 10``.
    """
    _make_project(db, project_id=1)

    sf = _make_inventory_source(
        db,
        source_id=30,
        project_id=1,
        report_date=date(2026, 6, 16),
    )
    for i in range(25):
        _make_snapshot_row(
            db,
            source_id=sf.id,
            sku=f"SKU-LOW-{i:02d}",
            available_qty=5,
            source_row_no=i + 1,
        )
    _make_snapshot_row(
        db,
        source_id=sf.id,
        sku="SKU-HEALTHY",
        available_qty=50,
        source_row_no=999,
    )

    db.commit()

    alerts = report_builder_weekly._get_inventory_alerts(
        db, project_ids=[1], country="US"
    )

    assert len(alerts) == 20
    skus = {a["sku"] for a in alerts}
    assert "SKU-HEALTHY" not in skus
    assert all(a["available_qty"] <= 10 for a in alerts)
    # All rows had identical qty=5 so level must be "low".
    assert all(a["level"] == "low" for a in alerts)


def test_oos_vs_low_classification(db) -> None:
    """``available_qty <= 0`` OR ``stock_status='out_of_stock'`` → ``level='oos'``;
    everything else with ``available_qty <= 10`` → ``level='low'``.

    Boundary cases covered:
      * qty = 0,  stock_status='in_stock'       → oos (qty<=0 rule)
      * qty = 10, stock_status='in_stock'       → low
      * qty = 3,  stock_status='out_of_stock'   → oos (status rule)
      * qty = -1, stock_status='out_of_stock'   → oos (both rules agree)
    """
    _make_project(db, project_id=1)
    sf = _make_inventory_source(
        db,
        source_id=40,
        project_id=1,
        report_date=date(2026, 6, 16),
    )
    cases = [
        ("SKU-ZERO-IN", 0, "in_stock"),
        ("SKU-TEN-LOW", 10, "in_stock"),
        ("SKU-OOS-STATUS", 3, "out_of_stock"),
        ("SKU-NEG-OOS", -1, "out_of_stock"),
    ]
    for idx, (sku, qty, status) in enumerate(cases):
        _make_snapshot_row(
            db,
            source_id=sf.id,
            sku=sku,
            available_qty=qty,
            stock_status=status,
            source_row_no=idx + 1,
        )
    db.commit()

    alerts = report_builder_weekly._get_inventory_alerts(
        db, project_ids=[1], country="US"
    )

    by_sku = {a["sku"]: a for a in alerts}
    assert by_sku["SKU-ZERO-IN"]["level"] == "oos"
    assert by_sku["SKU-TEN-LOW"]["level"] == "low"
    assert by_sku["SKU-OOS-STATUS"]["level"] == "oos"
    assert by_sku["SKU-NEG-OOS"]["level"] == "oos"
    # Ordered by available_qty ASC: -1, 0, 3, 10.
    assert [a["sku"] for a in alerts] == [
        "SKU-NEG-OOS",
        "SKU-ZERO-IN",
        "SKU-OOS-STATUS",
        "SKU-TEN-LOW",
    ]


# ---------------------------------------------------------------------------
# BEL-131: tests for _get_inventory_summary
# ---------------------------------------------------------------------------


def test_inventory_summary_basic_counts(db) -> None:
    """BEL-131: 一份含 OOS / low / healthy 的快照，summary 各字段正确。

    验证：
      * ``sku_count`` = 行数（3）
      * ``total_available`` = 0 + 5 + 100 = 105
      * ``low_stock_count`` = 1（qty 5）
      * ``oos_count`` = 1（qty 0）
    阈值与月报 ``_get_inventory_summary`` 对齐：low ≤ 20，oos ≤ 0 或
    ``stock_status='out_of_stock'``。
    """
    _make_project(db, project_id=1)
    sf = _make_inventory_source(
        db,
        source_id=50,
        project_id=1,
        report_date=date(2026, 6, 16),
    )
    _make_snapshot_row(db, source_id=sf.id, sku="SKU-OOS", available_qty=0, stock_status="in_stock", source_row_no=1)
    _make_snapshot_row(db, source_id=sf.id, sku="SKU-LOW", available_qty=5, stock_status="in_stock", source_row_no=2)
    _make_snapshot_row(db, source_id=sf.id, sku="SKU-HEALTHY", available_qty=100, stock_status="in_stock", source_row_no=3)
    db.commit()

    summary = report_builder_weekly._get_inventory_summary(
        db, project_ids=[1], country="US"
    )

    assert summary == {
        "sku_count": 3,
        "total_available": 105,
        "low_stock_count": 1,
        "oos_count": 1,
    }


def test_inventory_summary_low_threshold_is_20(db) -> None:
    """BEL-131: low 阈值是 ``0 < qty <= 20``，超过 20 不算 low。

    边界用例：
      * qty = 1  → low
      * qty = 20 → low
      * qty = 21 → healthy
    """
    _make_project(db, project_id=1)
    sf = _make_inventory_source(
        db,
        source_id=51,
        project_id=1,
        report_date=date(2026, 6, 16),
    )
    _make_snapshot_row(db, source_id=sf.id, sku="SKU-ONE", available_qty=1, source_row_no=1)
    _make_snapshot_row(db, source_id=sf.id, sku="SKU-TWENTY", available_qty=20, source_row_no=2)
    _make_snapshot_row(db, source_id=sf.id, sku="SKU-TWENTY-ONE", available_qty=21, source_row_no=3)
    db.commit()

    summary = report_builder_weekly._get_inventory_summary(
        db, project_ids=[1], country="US"
    )

    assert summary["sku_count"] == 3
    assert summary["low_stock_count"] == 2
    assert summary["oos_count"] == 0


def test_inventory_summary_oos_via_stock_status(db) -> None:
    """BEL-131: ``stock_status='out_of_stock'`` 即使 qty>0 仍算 OOS。

    复核：qty=8、status=out_of_stock 应当 OOS，而不是 low。
    """
    _make_project(db, project_id=1)
    sf = _make_inventory_source(
        db,
        source_id=52,
        project_id=1,
        report_date=date(2026, 6, 16),
    )
    _make_snapshot_row(
        db,
        source_id=sf.id,
        sku="SKU-OOS-STATUS",
        available_qty=8,
        stock_status="out_of_stock",
        source_row_no=1,
    )
    db.commit()

    summary = report_builder_weekly._get_inventory_summary(
        db, project_ids=[1], country="US"
    )

    assert summary["oos_count"] == 1
    assert summary["low_stock_count"] == 0
    assert summary["total_available"] == 8


def test_inventory_summary_uses_latest_snapshot(db) -> None:
    """BEL-131: 与 BEL-130 一致——按 ``(project, country)`` 最新
    ``report_date`` 快照取数，不依赖 ``is_current`` 标志。

    两个快照，``is_current=True`` 的更老、``is_current=False`` 的更新；
    summary 必须只统计新快照的数据。
    """
    _make_project(db, project_id=1)

    older = _make_inventory_source(
        db,
        source_id=60,
        project_id=1,
        report_date=date(2026, 6, 10),
        version=1,
        is_current=True,
    )
    _make_snapshot_row(
        db, source_id=older.id, sku="SKU-OLD",
        available_qty=999, stock_status="in_stock", source_row_no=1,
    )

    newer = _make_inventory_source(
        db,
        source_id=61,
        project_id=1,
        report_date=date(2026, 6, 15),
        version=1,
        is_current=False,
    )
    _make_snapshot_row(
        db, source_id=newer.id, sku="SKU-NEW-A",
        available_qty=10, stock_status="in_stock", source_row_no=1,
    )
    _make_snapshot_row(
        db, source_id=newer.id, sku="SKU-NEW-B",
        available_qty=3, stock_status="in_stock", source_row_no=2,
    )
    db.commit()

    summary = report_builder_weekly._get_inventory_summary(
        db, project_ids=[1], country="US"
    )

    # 不应该把旧快照的 999 算进来
    assert summary["sku_count"] == 2
    assert summary["total_available"] == 13
    assert summary["low_stock_count"] == 2  # qty=10 和 qty=3 都 <= 20


def test_inventory_summary_filters_by_project(db) -> None:
    """BEL-131: 多项目时 summary 只统计请求范围内的项目。

    项目 1 三个 SKU 共 30 件，项目 2 两个 SKU 共 50 件。
    请求 ``project_ids=[1]`` 时，summary 应只反映项目 1。
    """
    _make_project(db, project_id=1)
    _make_project(db, project_id=2)

    sf1 = _make_inventory_source(
        db, source_id=70, project_id=1, report_date=date(2026, 6, 14),
    )
    _make_snapshot_row(db, source_id=sf1.id, sku="S1-A", available_qty=10, source_row_no=1)
    _make_snapshot_row(db, source_id=sf1.id, sku="S1-B", available_qty=15, source_row_no=2)
    _make_snapshot_row(db, source_id=sf1.id, sku="S1-C", available_qty=5, source_row_no=3)

    sf2 = _make_inventory_source(
        db, source_id=71, project_id=2, report_date=date(2026, 6, 14),
    )
    _make_snapshot_row(db, source_id=sf2.id, sku="S2-A", available_qty=30, source_row_no=1)
    _make_snapshot_row(db, source_id=sf2.id, sku="S2-B", available_qty=20, source_row_no=2)

    db.commit()

    summary = report_builder_weekly._get_inventory_summary(
        db, project_ids=[1], country="US"
    )

    assert summary["sku_count"] == 3
    assert summary["total_available"] == 30
    assert summary["low_stock_count"] == 3  # 10 / 15 / 5 都 <= 20


def test_inventory_summary_filters_by_country(db) -> None:
    """BEL-131: 不同国家的快照互不干扰。"""
    _make_project(db, project_id=1)

    sf_us = _make_inventory_source(
        db, source_id=80, project_id=1, country="US", report_date=date(2026, 6, 14),
    )
    _make_snapshot_row(db, source_id=sf_us.id, sku="US-A", available_qty=10, source_row_no=1)

    sf_de = _make_inventory_source(
        db, source_id=81, project_id=1, country="DE", report_date=date(2026, 6, 14),
    )
    _make_snapshot_row(db, source_id=sf_de.id, sku="DE-A", available_qty=999, source_row_no=1)

    db.commit()

    summary = report_builder_weekly._get_inventory_summary(
        db, project_ids=None, country="US"
    )

    assert summary["sku_count"] == 1
    assert summary["total_available"] == 10
    # DE 站点的 999 不应被 US 报告计入


def test_inventory_summary_no_data_returns_zeros(db) -> None:
    """BEL-131: 没数据时返回零值 dict（不是 ``None``、不是抛异常）。"""
    summary = report_builder_weekly._get_inventory_summary(
        db, project_ids=[99], country="US"
    )

    assert summary == {
        "sku_count": 0,
        "total_available": 0,
        "low_stock_count": 0,
        "oos_count": 0,
    }


def test_build_weekly_report_data_includes_inventory_summary(monkeypatch) -> None:
    """BEL-131 端到端回归保护：``build_weekly_report_data`` 返回的 dict
    必须包含 ``inventory_summary`` 键（邮件模板依赖它）。

    整个 build 函数会跑 AI 摘要等外部依赖，我们通过 monkeypatch
    把它们 stub 掉，只验证 dict 结构。"""
    from app.services.scheduled_report import report_builder_weekly as rb

    # 关键：构造一个 _get_inventory_summary 的 mock，返回固定值
    captured: dict = {}

    def fake_inventory_summary(db, project_ids, country):
        captured["called"] = True
        return {
            "sku_count": 7,
            "total_available": 42,
            "low_stock_count": 2,
            "oos_count": 1,
        }

    monkeypatch.setattr(rb, "_get_inventory_summary", fake_inventory_summary)

    # 把所有外部副作用 stub 掉
    monkeypatch.setattr(rb, "_aggregate_weekly_sales", lambda *a, **k: {
        "qty": 0, "amount": 0.0, "orders": 0, "avg_price": 0.0,
        "start_date": "2026-06-08", "end_date": "2026-06-14",
    })
    monkeypatch.setattr(rb, "_analyze_sku_attribution", lambda *a, **k: [])
    monkeypatch.setattr(rb, "_get_top_skus_with_comparison", lambda *a, **k: [])
    monkeypatch.setattr(rb, "_get_inventory_alerts", lambda *a, **k: [])
    monkeypatch.setattr(rb, "_get_ads_comparison", lambda *a, **k: {
        "spend": {"current": 0, "prev": 0, "change": 0},
        "roas": {"current": 0, "prev": 0, "change": 0},
        "acos": {"current": 0, "prev": 0, "change": 0},
        "ctr": {"current": 0, "prev": 0, "change": 0},
    })
    monkeypatch.setattr(rb, "_get_weekly_returns", lambda *a, **k: {"qty": 0, "rate": 0.0, "top_returns": []})
    monkeypatch.setattr(rb, "_get_daily_sales_trend", lambda *a, **k: [])
    monkeypatch.setattr(rb, "_query_sku_sales_detail", lambda *a, **k: [])

    # AI / context helpers
    from app.services.scheduled_report import ai_enhancer_weekly, context_helpers
    monkeypatch.setattr(ai_enhancer_weekly, "generate_weekly_ai_summary", lambda *a, **k: "stub")
    monkeypatch.setattr(ai_enhancer_weekly, "generate_weekly_attribution_analysis", lambda *a, **k: "stub")
    monkeypatch.setattr(ai_enhancer_weekly, "generate_weekly_alert_insights", lambda *a, **k: "stub")
    monkeypatch.setattr(ai_enhancer_weekly, "generate_weekly_action_items", lambda *a, **k: [])
    monkeypatch.setattr(ai_enhancer_weekly, "detect_weekly_anomalies", lambda *a, **k: [])
    monkeypatch.setattr(context_helpers, "fetch_multi_project_context", lambda *a, **k: ({}, {}))
    monkeypatch.setattr(context_helpers, "fetch_and_format_sku_factory_info", lambda *a, **k: "")

    # DB session 不会被真正查询（所有调用都被 stub 替换）
    class _FakeDB:
        def query(self, *args, **kwargs):
            return self
        def filter(self, *args, **kwargs):
            return self
        def filter_by(self, *args, **kwargs):
            return self
        def execute(self, *args, **kwargs):
            return self
        def scalars(self, *args, **kwargs):
            return self
        def all(self):
            return []
        def first(self):
            return None

    data = rb.build_weekly_report_data(
        db=_FakeDB(),
        project_ids=[1],
        country="US",
        project_name="测试项目",
        reference_date=date(2026, 6, 18),  # 周四 → 上周 6/8-6/14
    )

    assert captured.get("called") is True
    assert "inventory_summary" in data, (
        "BEL-131: build_weekly_report_data must include 'inventory_summary' "
        "so the email template's 📦 库存状态 card can render real numbers"
    )
    assert data["inventory_summary"] == {
        "sku_count": 7,
        "total_available": 42,
        "low_stock_count": 2,
        "oos_count": 1,
    }
