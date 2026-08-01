"""Return analysis endpoint integration test (BEL-373 acceptance).

Sub-issue 1 验收：内部 `/api/v1/return-analysis` 行为不变。
- snapshot 路径产出 schema 与 fallback 路径完全一致
- 缓存命中直接返回
- Celery 未跑 → 自动 fallback 现场跑

依赖：test DB (TEST_DATABASE_URL)。
隔离：每个测试独占 project（is_active=False）+ teardown 显式 DELETE。
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import text

from app.celery_tasks.return_analysis_refresh import _refresh_one_day
from app.db.session import SessionLocal
from app.services.analysis.return_analysis import (
    build_return_analysis,
    build_return_analysis_from_snapshot,
    is_snapshot_fresh_for_range,
)


@pytest.fixture()
def db_session():
    """Per-test session — rollback at end."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture()
def test_project(db_session):
    """Create a unique Project for this test; cleanup everything on teardown."""
    from app.models import Project

    # 用 PID 而不是名字查找（避免 name 重名）
    pid_seq_name = f"bel_373_test_pid_{date.today().isoformat()}"
    # 每次 insert 都会拿到新 id，无需 sequence hack；走 model 自增
    project = Project(
        project_name=f"BEL-373 Test Project {pid_seq_name}",
        sort_order=0,
        is_active=False,  # 测试项目永远 inactive，防止污染生产下拉
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id

    # Seed minimal data
    _ensure_test_data(db_session, project_id=pid)

    try:
        yield pid
    finally:
        # 清理：rows → source_files → projects（FK 顺序）
        db_session.expire_all()
        db_session.execute(
            text("DELETE FROM analysis_return_rows WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(
            text("DELETE FROM analysis_sales_order_rows WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(
            text("DELETE FROM analysis_source_files WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(
            text("DELETE FROM analysis_return_aggregates WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


def _ensure_test_data(db_session, project_id: int) -> None:
    """Seed minimal data so build_return_analysis() returns non-empty result."""
    from app.models import (
        AnalysisReturnRow,
        AnalysisSalesOrderRow,
        AnalysisSourceFile,
    )

    yesterday = date.today() - timedelta(days=1)
    sf_ret = AnalysisSourceFile(
        project_id=project_id,
        country="US",
        report_type="return_report",
        upload_file_id=f"test_upload_ret_{project_id}",
        upload_file_path="/tmp/test_ret.csv",
        original_filename="test_ret.csv",
        stored_filename="test_ret.csv",
        logical_filename="test_ret.csv",
        storage_key="test_ret.csv",
        period_start_date=yesterday,
        period_end_date=yesterday,
        is_current=True,
    )
    db_session.add(sf_ret)
    db_session.commit()
    db_session.refresh(sf_ret)

    sf_sales = AnalysisSourceFile(
        project_id=project_id,
        country="US",
        report_type="sales_report",
        upload_file_id=f"test_upload_sales_{project_id}",
        upload_file_path="/tmp/test_sales.csv",
        original_filename="test_sales.csv",
        stored_filename="test_sales.csv",
        logical_filename="test_sales.csv",
        storage_key="test_sales.csv",
        period_start_date=yesterday,
        period_end_date=yesterday,
        is_current=True,
    )
    db_session.add(sf_sales)
    db_session.commit()
    db_session.refresh(sf_sales)

    for i, (oid, qty) in enumerate([("O-1", 2), ("O-2", 1)]):
        db_session.add(
            AnalysisReturnRow(
                project_id=project_id,
                country="US",
                source_file_id=sf_ret.id,
                source_row_no=i + 1,
                return_date=yesterday,
                order_id=oid,
                sku="BEL-373-SKU",
                asin="B999",
                quantity=qty,
                detailed_disposition="SELLABLE",
                reason="NOT_AS_DESCRIBED",
                status="PROCESSED",
                license_plate_number="LP001",
                original_return_datetime=yesterday.isoformat() + "T10:00:00+00:00",
            )
        )
    db_session.commit()

    for i in range(20):
        db_session.add(
            AnalysisSalesOrderRow(
                project_id=project_id,
                country="US",
                source_file_id=sf_sales.id,
                source_row_no=i + 1,
                amazon_order_id=f"S-{i}",
                purchase_at_utc=yesterday,
                purchase_at_pt=yesterday,
                purchase_date_pt=yesterday,
                order_status="Shipped",
                sku="BEL-373-SKU",
                asin="B999",
                quantity=1,
                item_price=10.0,
                shipping_price=0.0,
                is_counted_sales=True,
            )
        )
    db_session.commit()


def test_fallback_returns_data_when_no_snapshot(db_session, test_project) -> None:
    """没有 snapshot 数据时，build_return_analysis() 现场跑应返回数据."""
    pid = test_project
    result = build_return_analysis(
        db_session,
        project_id=pid,
        country="US",
        start_date=(date.today() - timedelta(days=2)).isoformat(),
        end_date=date.today().isoformat(),
    )

    assert result.project_id == pid
    assert result.country == "US"
    assert result.summary.total_returns >= 2
    assert result.summary.total_quantity >= 3


def test_is_snapshot_fresh_returns_false_when_no_data(db_session, test_project) -> None:
    """没有任何 aggregate 行时 → snapshot 不新鲜（走 fallback）."""
    pid = test_project
    fresh = is_snapshot_fresh_for_range(
        db_session,
        project_id=pid,
        country="US",
        start_date=(date.today() - timedelta(days=2)).isoformat(),
        end_date=date.today().isoformat(),
    )
    assert fresh is False


def test_is_snapshot_fresh_returns_true_after_refresh(db_session, test_project) -> None:
    """跑完 _refresh_one_day 后 → snapshot 是新鲜的."""
    pid = test_project
    yesterday = date.today() - timedelta(days=1)

    result = _refresh_one_day(db_session, target_date=yesterday)
    assert result["rows_written"] >= 1

    fresh = is_snapshot_fresh_for_range(
        db_session,
        project_id=pid,
        country="US",
        start_date=(date.today() - timedelta(days=2)).isoformat(),
        end_date=date.today().isoformat(),
    )
    assert fresh is True


def test_snapshot_path_returns_same_schema_as_fallback(
    db_session, test_project
) -> None:
    """关键验收：snapshot 路径与 fallback 路径输出 schema 完全一致."""
    pid = test_project
    yesterday = date.today() - timedelta(days=1)

    _refresh_one_day(db_session, target_date=yesterday)

    fb = build_return_analysis(
        db_session,
        project_id=pid,
        country="US",
        start_date=yesterday.isoformat(),
        end_date=yesterday.isoformat(),
    )
    snap = build_return_analysis_from_snapshot(
        db_session,
        project_id=pid,
        country="US",
        start_date=yesterday.isoformat(),
        end_date=yesterday.isoformat(),
    )

    # schema 完全一致
    assert type(fb).__name__ == type(snap).__name__
    assert fb.project_id == snap.project_id
    assert fb.country == snap.country
    assert fb.start_date == snap.start_date
    assert fb.end_date == snap.end_date

    # summary 数字应基本一致
    assert fb.summary.total_quantity == snap.summary.total_quantity
    assert fb.summary.unique_skus == snap.summary.unique_skus

    # 关键字段在两边都存在
    for field in [
        "ranking_rows",
        "reason_rows",
        "trend_rows",
        "disposition_rows",
        "status_rows",
        "feedback_rows",
        "weekday_rows",
        "fulfillment_center_rows",
        "multi_item_return_count",
        "multi_item_return_quantity",
        "summary_text",
    ]:
        assert hasattr(fb, field), f"fallback missing {field}"
        assert hasattr(snap, field), f"snapshot missing {field}"


def test_compute_risk_level_at_thresholds() -> None:
    """锁定 risk_level 阈值（plan §1 拍板）."""
    from app.utils.stats import compute_risk_level

    # no_data: sales < 15
    risk, _ = compute_risk_level(return_quantity=5, sales_quantity=10)
    assert risk == "no_data"

    # normal: Wilson < 6%
    risk, _ = compute_risk_level(return_quantity=3, sales_quantity=100)
    assert risk == "normal"

    # critical: Wilson >= 10%
    risk, wilson = compute_risk_level(return_quantity=20, sales_quantity=100)
    assert risk == "critical"
    assert wilson >= 10.0
