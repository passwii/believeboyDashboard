"""BLF-788 回归测试：顾客反馈按退货事件去重。

背景：Amazon return report 的 ``customer-comments`` 是每事件一个单元格，
单元格内可含多段以 ``|`` 分隔的文本。旧实现按片段拆行，导致同一事件的
反馈被重复计入 feedback_rows / summary_text「共 N 条有评论」/ 原因占比
（玥涵 project_id=4 US 2026-08-09~22：1 条退货事件的 3 段评论被计成
3 条 100% 与描述不符）。

验收：
- 一条退货事件（order_id, sku, return_date）至多一行反馈；
- 多段文本去重合并，不出现「X | X」式重复；
- 重叠周期多份快照下同订单+评论只计一次；
- 其余统计字段口径不变。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import text

from app.celery_tasks.return_analysis_refresh import _refresh_one_day
from app.db.session import SessionLocal
from app.services.analysis.return_analysis import (
    build_return_analysis,
    build_return_analysis_from_snapshot,
)

# 玥涵复现案例的原始单元格（prod raw_row 实证）
REPRO_COMMENTS = (
    "Not as Expected|Supposed to be able to drill metal but can’t.|"
    "Rethink the abilities of product."
)


@pytest.fixture()
def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture()
def test_project(db_session):
    """独占测试项目 + teardown 显式清理（对齐 test_snapshot_endpoint 模式）。"""
    from app.models import Project

    project = Project(
        project_name=f"BLF-788 Test Project {uuid.uuid4().hex[:8]}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id

    try:
        yield pid
    finally:
        db_session.expire_all()
        for table in (
            "analysis_return_rows",
            "analysis_sales_order_rows",
            "analysis_source_files",
            "analysis_return_aggregates",
        ):
            db_session.execute(
                text(f"DELETE FROM {table} WHERE project_id = :pid"), {"pid": pid}
            )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


def _seed_return_source(
    db_session,
    project_id: int,
    tag: str,
    *,
    period_start: date | None = None,
    period_end: date | None = None,
):
    from app.models import AnalysisSourceFile

    sf = AnalysisSourceFile(
        project_id=project_id,
        country="US",
        report_type="return_report",
        upload_file_id=f"blf788_ret_{tag}_{project_id}",
        upload_file_path=f"/tmp/blf788_{tag}.csv",
        original_filename=f"blf788_{tag}.csv",
        stored_filename=f"blf788_{tag}.csv",
        logical_filename=f"blf788_{tag}.csv",
        storage_key=f"blf788/{tag}.csv",
        period_start_date=period_start or date.today() - timedelta(days=2),
        period_end_date=period_end or date.today(),
        is_current=True,
    )
    db_session.add(sf)
    db_session.commit()
    db_session.refresh(sf)
    return sf


def _add_return_row(
    db_session,
    *,
    source_file_id: int,
    project_id: int,
    order_id: str,
    sku: str,
    return_date,
    license_plate: str,
    customer_comments: str | None,
    reason: str = "NOT_AS_DESCRIBED",
    source_row_no: int = 1,
):
    from app.models import AnalysisReturnRow

    db_session.add(
        AnalysisReturnRow(
            project_id=project_id,
            country="US",
            source_file_id=source_file_id,
            source_row_no=source_row_no,
            return_date=return_date,
            order_id=order_id,
            sku=sku,
            asin="B0TEST",
            quantity=1,
            detailed_disposition="SELLABLE",
            reason=reason,
            status="Unit returned to inventory",
            license_plate_number=license_plate,
            original_return_datetime=return_date.isoformat() + "T10:00:00+00:00",
            customer_comments=customer_comments,
        )
    )
    db_session.commit()


def _window() -> tuple[str, str]:
    d = date.today()
    return (d - timedelta(days=2)).isoformat(), d.isoformat()


class TestFeedbackDedupByEvent:
    def test_multi_segment_comment_is_one_feedback_row(self, db_session, test_project):
        """单事件 3 段评论单元格 → 1 行反馈；summary 不再按片段放大。"""
        d = date.today() - timedelta(days=1)
        sf = _seed_return_source(db_session, test_project, "single")
        _add_return_row(
            db_session,
            source_file_id=sf.id,
            project_id=test_project,
            order_id="111-REPRO-1",
            sku="TWS-CS29SET",
            return_date=d,
            license_plate="LPNNG6XTVG4TJ",
            customer_comments=REPRO_COMMENTS,
            source_row_no=1,
        )
        _add_return_row(
            db_session,
            source_file_id=sf.id,
            project_id=test_project,
            order_id="112-REPRO-2",
            sku="TWS-CS29SET",
            return_date=d,
            license_plate="LPNPMGI2401659",
            customer_comments=None,
            reason="DEFECTIVE",
            source_row_no=2,
        )

        start, end = _window()
        result = build_return_analysis(
            db_session,
            project_id=test_project,
            country="US",
            start_date=start,
            end_date=end,
            sku="TWS-CS29SET",
        )

        assert len(result.feedback_rows) == 1
        row = result.feedback_rows[0]
        assert row.order_id == "111-REPRO-1"
        # 三段文本全部保留、按序合并为一条
        assert row.customer_comment == (
            "Not as Expected | Supposed to be able to drill metal but can’t. "
            "| Rethink the abilities of product."
        )
        # summary 口径：有评论的退货事件数 = 1（修复前为 3）
        assert "共 1 条有评论" in result.summary_text
        assert "共 3 条有评论" not in result.summary_text
        # 量化字段不受影响：仍是 2 笔退货、原因各 1 单
        assert result.summary.total_returns == 2
        reason_counts = {r.reason: r.return_count for r in result.reason_rows}
        assert reason_counts == {"NOT_AS_DESCRIBED": 1, "DEFECTIVE": 1}

    @pytest.mark.parametrize("use_snapshot", [False, True])
    def test_overlapping_snapshots_same_order_one_row(
        self, db_session, test_project, use_snapshot
    ):
        """重叠周期两份快照：同订单+sku+日期（不同 LPN 落两物理行）只计一次。

        对应验收标准 2：uq_return_event 含 license_plate，跨快照重复在存储层
        唯一可能的形态就是同事件键多物理行——两条路径都必须收敛为一行。
        """
        d = date.today() - timedelta(days=1)
        # 两份周期重叠（非全等，避免撞 period_version 唯一约束）的 is_current 快照：
        # snapA 覆盖 d-2..d-1，snapB 覆盖 d-1..today，事件落在重叠日 d-1。
        sf_a = _seed_return_source(
            db_session,
            test_project,
            "snapA",
            period_start=d - timedelta(days=1),
            period_end=d,
        )
        sf_b = _seed_return_source(
            db_session,
            test_project,
            "snapB",
            period_start=d,
            period_end=date.today(),
        )
        # 同一事件出现在 A/B 两份 is_current 快照中（LPN 不同→两个物理行）
        _add_return_row(
            db_session,
            source_file_id=sf_a.id,
            project_id=test_project,
            order_id="112-OVERLAP-1",
            sku="TWS-CS29SET",
            return_date=d,
            license_plate="LP-SNAP-A",
            customer_comments="Bad quality",
            source_row_no=1,
        )
        _add_return_row(
            db_session,
            source_file_id=sf_b.id,
            project_id=test_project,
            order_id="112-OVERLAP-1",
            sku="TWS-CS29SET",
            return_date=d,
            license_plate="LP-SNAP-B",
            customer_comments="Bad quality",
            source_row_no=1,
        )

        start, end = _window()
        builder = (
            build_return_analysis_from_snapshot
            if use_snapshot
            else build_return_analysis
        )
        if use_snapshot:
            _refresh_one_day(db_session, target_date=d)

        result = builder(
            db_session,
            project_id=test_project,
            country="US",
            start_date=start,
            end_date=end,
        )

        assert len(result.feedback_rows) == 1
        row = result.feedback_rows[0]
        assert row.order_id == "112-OVERLAP-1"
        # 同文本不拼接成 "Bad quality | Bad quality"
        assert row.customer_comment == "Bad quality"

    def test_duplicate_segments_within_cell_deduped(self, db_session, test_project):
        """单元格内重复片段（A|B|A）→ 合并后不重复。"""
        d = date.today() - timedelta(days=1)
        sf = _seed_return_source(db_session, test_project, "dupseg")
        _add_return_row(
            db_session,
            source_file_id=sf.id,
            project_id=test_project,
            order_id="113-DUPSEG-1",
            sku="SKU-DUP",
            return_date=d,
            license_plate="LP-DUP-1",
            customer_comments="Too small|Broken lid|Too small",
            source_row_no=1,
        )

        start, end = _window()
        result = build_return_analysis(
            db_session,
            project_id=test_project,
            country="US",
            start_date=start,
            end_date=end,
        )

        assert len(result.feedback_rows) == 1
        assert result.feedback_rows[0].customer_comment == "Too small | Broken lid"

    def test_snapshot_path_matches_fallback(self, db_session, test_project):
        """snapshot 与 fallback 两条路径的 feedback_rows 输出完全一致。"""
        d = date.today() - timedelta(days=1)
        sf = _seed_return_source(db_session, test_project, "parity")
        _add_return_row(
            db_session,
            source_file_id=sf.id,
            project_id=test_project,
            order_id="114-PARITY-1",
            sku="TWS-CS29SET",
            return_date=d,
            license_plate="LP-PARITY-1",
            customer_comments=REPRO_COMMENTS,
            source_row_no=1,
        )

        _refresh_one_day(db_session, target_date=d)

        start, end = _window()
        fb = build_return_analysis(
            db_session,
            project_id=test_project,
            country="US",
            start_date=start,
            end_date=end,
        )
        snap = build_return_analysis_from_snapshot(
            db_session,
            project_id=test_project,
            country="US",
            start_date=start,
            end_date=end,
        )

        assert len(fb.feedback_rows) == len(snap.feedback_rows) == 1
        assert fb.feedback_rows[0].customer_comment == (
            snap.feedback_rows[0].customer_comment
        )
