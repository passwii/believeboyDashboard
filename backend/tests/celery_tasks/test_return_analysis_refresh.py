"""CELERY task refresh_return_aggregates — 单测。

覆盖（不依赖 DB 的窗口/缺口机制用 mock；真实写入走 BLF_test 集成测试）:
- 默认回看近 DEFAULT_LOOKBACK_DAYS 天（止于昨天）
- 显式 target_date → 窗口止于该日
- lookback_days 覆盖 / 缺口日期合并进重算列表
- upsert 冲突时 update (project, country, sku, date)
- 重跑同一天幂等（count 不变）
- 错误抛异常由 Celery 重试
- 缺口补齐：raw 有而快照缺的旧日期被自动补算（BLF-805 根治回归）
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest


def _run_task(**kwargs):
    """统一入口：patch 掉真实 DB 依赖后跑任务，返回 (result, captured_dates)."""
    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates

    captured: dict = {"dates": []}

    def fake_refresh(db, target_date):
        captured["dates"].append(target_date)
        return {"rows_written": 0, "projects": 0}

    def fake_no_gaps(db, *, window_start):
        return []

    patches = [
        patch(
            "app.celery_tasks.return_analysis_refresh._refresh_one_day",
            side_effect=fake_refresh,
        ),
        patch(
            "app.celery_tasks.return_analysis_refresh._find_gap_dates",
            side_effect=fake_no_gaps,
        ),
    ]
    with patches[0], patches[1]:
        result = refresh_return_aggregates.run(**kwargs)
    return result, captured["dates"]


def test_refresh_default_lookback_window_ends_yesterday() -> None:
    """不传参数 → 回看近 7 天，止于昨天."""
    yesterday = date.today() - timedelta(days=1)
    expected = [yesterday - timedelta(days=i) for i in range(6, -1, -1)]

    result, dates = _run_task()

    assert dates == expected
    assert result["range_start"] == expected[0].isoformat()
    assert result["range_end"] == yesterday.isoformat()
    assert result["days_processed"] == 7
    assert result["backfilled_dates"] == []


def test_refresh_explicit_target_date_ends_window_there() -> None:
    """显式传 target_date → 窗口止于该日（手动补跑场景）."""
    end = date(2026, 7, 31)
    expected = [end - timedelta(days=i) for i in range(6, -1, -1)]

    result, dates = _run_task(target_date=end)

    assert dates == expected
    assert result["target_date"] == end.isoformat()


def test_refresh_accepts_iso_string_target_date() -> None:
    """target_date 也接受 ISO 字符串."""
    _, dates = _run_task(target_date="2026-07-31")

    assert dates[-1] == date(2026, 7, 31)


def test_refresh_lookback_days_override() -> None:
    """lookback_days=1 → 只重算窗口末日一天."""
    end = date(2026, 7, 31)

    result, dates = _run_task(target_date=end, lookback_days=1)

    assert dates == [end]
    assert result["days_processed"] == 1


def test_refresh_clamps_out_of_range_lookback() -> None:
    """lookback_days 越界被夹到 [1, 90]."""
    _, dates_small = _run_task(target_date=date(2026, 7, 31), lookback_days=-5)
    _, dates_big = _run_task(target_date=date(2026, 7, 31), lookback_days=999)

    assert len(dates_small) == 1
    assert len(dates_big) == 90


def test_refresh_merges_and_sorts_gap_dates() -> None:
    """缺口日期（早于窗口）应并入重算列表且整体升序去重."""
    end = date(2026, 7, 31)
    gaps = [date(2026, 7, 10), date(2026, 7, 12)]

    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates

    captured: dict = {"dates": []}

    def fake_refresh(db, target_date):
        captured["dates"].append(target_date)
        return {"rows_written": 0, "projects": 0}

    with (
        patch(
            "app.celery_tasks.return_analysis_refresh._refresh_one_day",
            side_effect=fake_refresh,
        ),
        patch(
            "app.celery_tasks.return_analysis_refresh._find_gap_dates",
            return_value=gaps,
        ),
    ):
        result = refresh_return_aggregates.run(target_date=end, lookback_days=2)

    # 窗口 = [7-30, 7-31]；缺口 = [7-10, 7-12] → 合并升序
    assert captured["dates"] == [
        date(2026, 7, 10),
        date(2026, 7, 12),
        date(2026, 7, 30),
        date(2026, 7, 31),
    ]
    assert result["days_processed"] == 4
    assert result["backfilled_dates"] == ["2026-07-10", "2026-07-12"]


def test_refresh_propagates_db_error_for_retry() -> None:
    """DB 异常应当向上抛出（让 Celery 触发重试）."""
    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates

    def fake_refresh_boom(db, target_date):
        raise RuntimeError("db connection lost")

    with (
        patch(
            "app.celery_tasks.return_analysis_refresh._refresh_one_day",
            side_effect=fake_refresh_boom,
        ),
        patch(
            "app.celery_tasks.return_analysis_refresh._find_gap_dates",
            return_value=[],
        ),
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


# ─────────────────────────────────────────────────────────────────────────
# BLF-805: 缺口补齐 integration test (real DB) — 根治回归
# ─────────────────────────────────────────────────────────────────────────


@pytest.fixture()
def gap_test_project(db_session):
    """Create a project whose only return row sits on an OLD date with NO
    aggregate row — simulating the frozen-snapshot state BLF-805 found."""
    from app.models import AnalysisReturnRow, AnalysisSourceFile, Project

    pid_marker = date.today().isoformat()
    project = Project(
        project_name=f"BLF-805 gap test {pid_marker}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.flush()
    pid = project.id

    old_date = date.today() - timedelta(days=40)

    sf = AnalysisSourceFile(
        report_type="return_report",
        is_current=True,
        project_id=pid,
        country="US",
        upload_file_id=f"BLF805-test-{pid}",
        upload_file_path=f"return_report/{pid}/test.csv",
        original_filename=f"return_report_{pid}.csv",
        stored_filename=f"return_report_{pid}.csv",
        logical_filename=f"return_report_{pid}.csv",
        storage_key=f"return_report/{pid}/test.csv",
        file_size_bytes=1024,
        file_sha256="deadbeef",
        period_start_date=old_date,
        period_end_date=old_date,
        snapshot_at=None,
        version=1,
        ingestion_status="success",
    )
    db_session.add(sf)
    db_session.flush()

    db_session.add(
        AnalysisReturnRow(
            project_id=pid,
            country="US",
            source_file_id=sf.id,
            source_row_no=1,
            return_date=old_date,
            sku="SKU-GAP",
            order_id="ORDER-GAP",
            quantity=3,
            detailed_disposition="SELLABLE",
            reason="OTHER",
            status="Unit returned to inventory",
            original_return_datetime=f"{old_date.isoformat()}T00:00:00",
        )
    )
    db_session.commit()

    try:
        yield pid, old_date
    finally:
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
            text("DELETE FROM analysis_source_files WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


def test_gap_backfill_recovers_missing_old_date(gap_test_project, db_session):
    """BLF-805 根治回归：raw 有退货而快照缺行的旧日期，每日任务自动补算.

    场景复刻事故形态：40 天前有一笔退货，但快照表没有该日聚合行（当年
    单日增量扑空且无补算机制）。窗口止于 old_date+5（不含缺口日），任务
    应靠缺口检测把 old_date 补出来。
    """
    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates
    from app.models import AnalysisReturnAggregate

    pid, old_date = gap_test_project
    window_end = old_date + timedelta(days=5)  # 窗口本身不覆盖 old_date

    result = refresh_return_aggregates.run(
        target_date=window_end.isoformat(), lookback_days=1
    )

    assert result["backfilled_dates"] == [old_date.isoformat()], result
    assert result["days_processed"] == 2  # 窗口 1 天 + 缺口 1 天

    row = (
        db_session.query(AnalysisReturnAggregate)
        .filter_by(project_id=pid, sku="SKU-GAP", data_date=old_date)
        .first()
    )
    assert row is not None, "gap date should be backfilled into snapshot"
    assert row.return_quantity == 3


def test_gap_backfill_is_idempotent_on_rerun(gap_test_project, db_session):
    """补算完成后重跑：缺口消失、行数不变（自愈后不再重复处理）."""
    from sqlalchemy import text

    from app.celery_tasks.return_analysis_refresh import refresh_return_aggregates

    pid, old_date = gap_test_project
    window_end = old_date + timedelta(days=5)

    refresh_return_aggregates.run(target_date=window_end.isoformat(), lookback_days=1)

    def _count() -> int:
        return db_session.execute(
            text(
                "SELECT COUNT(*) FROM analysis_return_aggregates WHERE project_id = :pid"
            ),
            {"pid": pid},
        ).scalar()

    cnt_before = _count()
    assert cnt_before == 1

    result2 = refresh_return_aggregates.run(
        target_date=window_end.isoformat(), lookback_days=1
    )

    assert result2["backfilled_dates"] == [], (
        "second run must no longer treat the backfilled date as a gap"
    )
    assert _count() == cnt_before
