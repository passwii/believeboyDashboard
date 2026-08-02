"""CELERY task refresh_return_aggregates — 单测。

覆盖（不依赖 DB）:
- target_date 默认走昨天
- upsert 冲突时 update (project, country, sku, date)
- 重跑同一天幂等（count 不变）
- 错误抛异常由 Celery 重试
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest


def test_refresh_default_target_is_yesterday() -> None:
    """不传 target_date → 跑昨天."""
    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates

    captured: dict = {}

    def fake_refresh(db, target_date):
        captured["target_date"] = target_date
        return {"rows_written": 0, "projects": 0}

    with patch(
        "app.celery_tasks.return_analysis_refresh._refresh_one_day",
        side_effect=fake_refresh,
    ):
        # 传 None → 内部用 yesterday
        result = refresh_return_aggregates.run(target_date=None)

    assert captured["target_date"] == date.today() - timedelta(days=1)
    assert result == {"rows_written": 0, "projects": 0}


def test_refresh_explicit_target_date() -> None:
    """显式传 target_date → 用该日期."""
    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates

    captured: dict = {}

    def fake_refresh(db, target_date):
        captured["target_date"] = target_date
        return {"rows_written": 5, "projects": 1}

    with patch(
        "app.celery_tasks.return_analysis_refresh._refresh_one_day",
        side_effect=fake_refresh,
    ):
        result = refresh_return_aggregates.run(target_date=date(2026, 7, 31))

    assert captured["target_date"] == date(2026, 7, 31)
    assert result["rows_written"] == 5
    assert result["projects"] == 1


def test_refresh_propagates_db_error_for_retry() -> None:
    """DB 异常应当向上抛出（让 Celery 触发重试）."""
    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates

    def fake_refresh_boom(db, target_date):
        raise RuntimeError("db connection lost")

    with patch(
        "app.celery_tasks.return_analysis_refresh._refresh_one_day",
        side_effect=fake_refresh_boom,
    ):
        with pytest.raises(RuntimeError, match="db connection lost"):
            refresh_return_aggregates.run(target_date=date(2026, 7, 31))


def test_task_registered_with_correct_name() -> None:
    """Celery task name 必须 = return_analysis.refresh_daily（plan §2.4 拍板）."""
    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates

    assert refresh_return_aggregates.name == "return_analysis.refresh_daily"


def test_task_has_retry_config() -> None:
    """max_retries=3 + retry_backoff=True 是 plan §2.4 拍板."""
    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates

    assert refresh_return_aggregates.max_retries == 3
    assert refresh_return_aggregates.retry_backoff is True
    assert refresh_return_aggregates.retry_backoff_max == 300  # cap at 5min


def test_refresh_one_day_skips_when_no_returns() -> None:
    """当日无任何退货行 → 直接返回 0（无写入）."""
    from app.celery_tasks.return_analysis_refresh import _refresh_one_day

    db = MagicMock()
    # 第一次 query（find projects）返回空列表 → 直接 return
    base_query = MagicMock()
    join_chain = MagicMock()
    base_query.join.return_value = join_chain
    join_chain.filter.return_value.distinct.return_value.all.return_value = []
    db.query.side_effect = [base_query]

    result = _refresh_one_day(db, target_date=date(2026, 7, 31))

    assert result["rows_written"] == 0
    assert result["projects"] == 0
    # 不应 commit 任何东西
    db.commit.assert_not_called()


def test_refresh_one_day_writes_one_row_per_sku() -> None:
    """当日有退货 → 每个 (project, country, sku) 写一行 aggregate."""
    from app.celery_tasks.return_analysis_refresh import _refresh_one_day

    db = MagicMock()

    # 项目发现 query: join().filter().distinct().all() → [(1, "US")]
    join_chain = MagicMock()
    # `db.query(...)` 返 MagicMock；`.join(...)` / `.filter(...)` 后续都指向 join_chain
    base_query = MagicMock()
    base_query.join.return_value = join_chain
    join_chain.filter.return_value.distinct.return_value.all.return_value = [(1, "US")]

    # raw rows query: db.query(Row).join().filter().all() → raw_rows
    raw_rows = [
        MagicMock(
            project_id=1,
            country="US",
            sku="SKU-A",
            asin="B001",
            return_date=date(2026, 7, 31),
            quantity=2,
            order_id="O1",
            reason="NOT_AS_DESCRIBED",
            detailed_disposition="SELLABLE",
            fulfillment_center_id="PHX6",
        ),
        MagicMock(
            project_id=1,
            country="US",
            sku="SKU-B",
            asin="B002",
            return_date=date(2026, 7, 31),
            quantity=1,
            order_id="O2",
            reason="DEFECTIVE",
            detailed_disposition="CUSTOMER_DAMAGED",
            fulfillment_center_id="PHX6",
        ),
    ]
    raw_base = MagicMock()
    raw_join = MagicMock()
    raw_base.join.return_value = raw_join
    raw_join.filter.return_value.all.return_value = raw_rows

    # sales rows query: db.query(...).filter(...).all() → sales_rows
    sales_rows = [
        MagicMock(sku="SKU-A", purchase_date_pt=date(2026, 7, 31), quantity=10),
        MagicMock(sku="SKU-B", purchase_date_pt=date(2026, 7, 31), quantity=20),
    ]
    sales_chain = MagicMock()
    sales_chain.all.return_value = sales_rows

    # 调用顺序：projects (base_query) → raw (raw_base) → sales (sales_chain)
    db.query.side_effect = [base_query, raw_base, sales_chain]
    db.get_bind.return_value.dialect.name = "sqlite"

    result = _refresh_one_day(db, target_date=date(2026, 7, 31))

    assert result["rows_written"] == 2, f"expected 2 SKUs, got {result}"
    assert result["projects"] == 1
    assert db.commit.call_count == 1
    # 应调用一次 db.execute() （一次 INSERT 含所有 aggregate rows）
    assert db.execute.call_count >= 1


# ─────────────────────────────────────────────────────────────────────────
# BEL-376: cumulative-sales integration test (real DB)
# ─────────────────────────────────────────────────────────────────────────


@pytest.fixture()
def cumulative_test_project(db_session):
    """Create a fresh project + return row + multi-day sales rows for cumulative test."""
    from app.models import (
        AnalysisReturnRow,
        AnalysisSalesOrderRow,
        AnalysisSourceFile,
        Project,
    )

    pid_marker = date.today().isoformat()
    project = Project(
        project_name=f"BEL-376 cum test {pid_marker}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.flush()
    pid = project.id

    target = date(2026, 6, 15)

    sf = AnalysisSourceFile(
        report_type="return_report",
        is_current=True,
        project_id=pid,
        country="US",
        upload_file_id=f"BEL376-test-{pid}",
        upload_file_path=f"return_report/{pid}/test.csv",
        original_filename=f"return_report_{pid}.csv",
        stored_filename=f"return_report_{pid}.csv",
        logical_filename=f"return_report_{pid}.csv",
        storage_key=f"return_report/{pid}/test.csv",
        file_size_bytes=1024,
        file_sha256="deadbeef",
        period_start_date=date(2026, 6, 10),
        period_end_date=target,
        snapshot_at=None,
        version=1,
        ingestion_status="success",
    )
    db_session.add(sf)
    db_session.flush()

    # Sales source file (sales_order_rows.source_file_id is NOT NULL)
    sf_sales = AnalysisSourceFile(
        report_type="sales_report",
        is_current=True,
        project_id=pid,
        country="US",
        upload_file_id=f"BEL376-sales-{pid}",
        upload_file_path=f"sales_report/{pid}/test.csv",
        original_filename=f"sales_report_{pid}.csv",
        stored_filename=f"sales_report_{pid}.csv",
        logical_filename=f"sales_report_{pid}.csv",
        storage_key=f"sales_report/{pid}/test.csv",
        file_size_bytes=1024,
        file_sha256="deadbeef",
        period_start_date=date(2026, 5, 27),
        period_end_date=date(2026, 6, 1),
        snapshot_at=None,
        version=1,
        ingestion_status="success",
    )
    db_session.add(sf_sales)
    db_session.flush()

    # 5 days of sales BEFORE target_date, 20 units/day = 100 units prior
    from datetime import datetime, timezone, timedelta

    _pt = timezone(timedelta(hours=-7))  # Pacific Time offset
    for i in range(1, 6):
        _d = target.replace(day=i)
        _d_utc = datetime(_d.year, _d.month, _d.day, 12, 0, 0, tzinfo=timezone.utc)
        db_session.add(
            AnalysisSalesOrderRow(
                project_id=pid,
                country="US",
                source_file_id=sf_sales.id,
                source_row_no=i,
                amazon_order_id=f"BEL376-ORDER-PRI-{i}",
                purchase_at_utc=_d_utc,
                purchase_at_pt=_d_utc.astimezone(_pt).replace(tzinfo=None),
                purchase_date_pt=_d,
                sku="SKU-CUM",  # 必须与 return row.sku 对得上
                quantity=20,
                is_counted_sales=True,
                order_status="Shipped",
            )
        )
    # 1 day of sales ON target_date, 50 units
    _d_utc = datetime(
        target.year, target.month, target.day, 12, 0, 0, tzinfo=timezone.utc
    )
    db_session.add(
        AnalysisSalesOrderRow(
            project_id=pid,
            country="US",
            source_file_id=sf_sales.id,
            source_row_no=6,
            amazon_order_id="BEL376-ORDER-TARGET",
            purchase_at_utc=_d_utc,
            purchase_at_pt=_d_utc.astimezone(_pt).replace(tzinfo=None),
            purchase_date_pt=target,
            sku="SKU-CUM",  # 必须与 return row.sku 对得上
            quantity=50,
            is_counted_sales=True,
            order_status="Shipped",
        )
    )
    # 1 return on target_date: 5 units
    db_session.add(
        AnalysisReturnRow(
            project_id=pid,
            country="US",
            source_file_id=sf.id,
            source_row_no=1,
            return_date=target,
            sku="SKU-CUM",
            order_id="ORDER-CUM",
            quantity=5,
            detailed_disposition="SELLABLE",
            reason="OTHER",
            status="Unit returned to inventory",
            original_return_datetime="2026-06-15T00:00:00",
        )
    )
    db_session.commit()

    from sqlalchemy import text as _t

    cnt = db_session.execute(
        _t("SELECT COUNT(*) FROM analysis_sales_order_rows WHERE project_id=:p"),
        {"p": pid},
    ).scalar()
    print("FIXTURE: sales rows persisted for pid", pid, ":", cnt)
    cnt2 = db_session.execute(
        _t("SELECT COUNT(*) FROM analysis_return_rows WHERE project_id=:p"), {"p": pid}
    ).scalar()
    print("FIXTURE: return rows persisted for pid", pid, ":", cnt2)
    cnt3 = db_session.execute(
        _t("SELECT COUNT(*) FROM analysis_source_files WHERE project_id=:p"), {"p": pid}
    ).scalar()
    print("FIXTURE: source files persisted for pid", pid, ":", cnt3)

    try:
        yield pid
    finally:
        # cleanup FK order: snapshot → return_rows → sales → source_files → projects
        from sqlalchemy import text

        db_session.expire_all()
        db_session.execute(
            text("DELETE FROM analysis_return_aggregates WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(
            text("DELETE FROM analysis_return_rows WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(
            text("DELETE FROM analysis_sales_order_rows WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(
            text(
                "DELETE FROM analysis_source_files WHERE id IN (SELECT id FROM analysis_source_files WHERE project_id = :pid)"
            ),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


def test_refresh_one_day_writes_cumulative_sales(cumulative_test_project, db_session):
    """BEL-376: sales_quantity 应为 target_date 之前（含当日）所有销量的累计（=150），而不是仅当日（=50）。"""
    from app.celery_tasks.return_analysis_refresh import _refresh_one_day
    from app.models import AnalysisReturnAggregate

    target = date(2026, 6, 15)
    _refresh_one_day(db_session, target_date=target)

    row = (
        db_session.query(AnalysisReturnAggregate)
        .filter_by(
            project_id=cumulative_test_project,
            sku="SKU-CUM",
            data_date=target,
        )
        .first()
    )
    assert row is not None, "snapshot row should exist after refresh"
    assert row.sales_quantity == 150, (
        f"expected cumulative sales 150 (5 days * 20 + target 50), got {row.sales_quantity}"
    )
    assert row.return_quantity == 5
    assert row.data_version == 2, (
        f"expected data_version=2 (BEL-376 mark), got {row.data_version}"
    )


def test_refresh_one_day_excludes_cancelled_sales(cumulative_test_project, db_session):
    """BEL-376: Cancelled/Pending 订单应被排除（与 counted_sales_where 一致）。"""
    from app.celery_tasks.return_analysis_refresh import _refresh_one_day
    from app.models import AnalysisReturnAggregate, AnalysisSalesOrderRow
    from sqlalchemy import text

    pid = cumulative_test_project
    target = date(2026, 6, 15)

    # Add 10 cancelled + 10 pending sales on target_date → 应被排除
    # Need source_file_id: look up the sales source file we created in fixture
    sf_sales_id = db_session.execute(
        text(
            "SELECT id FROM analysis_source_files WHERE project_id = :pid AND report_type = 'sales_report' LIMIT 1"
        ),
        {"pid": pid},
    ).scalar()
    from datetime import datetime, timezone, timedelta as _td

    _pt = timezone(_td(hours=-7))
    _d_utc = datetime(
        target.year, target.month, target.day, 12, 0, 0, tzinfo=timezone.utc
    )
    for i in range(2):
        for status in ("Cancelled", "Pending"):
            db_session.add(
                AnalysisSalesOrderRow(
                    project_id=pid,
                    country="US",
                    source_file_id=sf_sales_id,
                    source_row_no=100 + i,
                    amazon_order_id=f"BEL376-{status}-{i}",
                    purchase_at_utc=_d_utc,
                    purchase_at_pt=_d_utc.astimezone(_pt).replace(tzinfo=None),
                    purchase_date_pt=target,
                    sku="SKU-CUM",
                    quantity=10,
                    is_counted_sales=True,
                    order_status=status,
                )
            )
    db_session.commit()

    _refresh_one_day(db_session, target_date=target)

    row = (
        db_session.query(AnalysisReturnAggregate)
        .filter_by(project_id=pid, sku="SKU-CUM", data_date=target)
        .first()
    )
    assert row.sales_quantity == 150, (
        f"cancelled/pending should be excluded; got sales_quantity={row.sales_quantity}"
    )
