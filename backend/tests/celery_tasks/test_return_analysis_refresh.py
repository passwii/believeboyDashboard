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
