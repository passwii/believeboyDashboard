"""BLF-1074 回归测试：退货分析 summary 必须带中文「Top 退货原因」。

背景：`dashboard/operations/return-analysis` 的统计磁贴「Top 退货原因」此前由
前端 ``RETURN_REASON_LABELS`` 自行翻译，那份表只有 14 个 code；退回原因里的
其余 code（生产库实测 16 个，如 ``DAMAGED_BY_FC`` / ``NO_REASON_GIVEN`` /
``NOT_COMPATIBLE``）落回英文原文直接显示。

修法是让后端产出：``summary.top_return_reason_display`` 与
``reason_rows[].reason_display`` 同源（同一 ``translate_return_field``），
前端不再重复维护对照表。

验收：
- both 路径（现场 fallback / 物化 snapshot）都填 ``top_return_reason_display``；
- 该字段与 ``reason_rows[0].reason_display`` 逐字一致（不出现「磁贴英文、
  表格中文」的自相矛盾）；
- 原先漏译的 code 也拿到中文（用 ``DAMAGED_BY_FC`` 覆盖——它是 14 个 code
  之外、且实测出现在某项目 top1 的原因）。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import text

from app.db.session import SessionLocal
from app.services.analysis.return_analysis import (
    build_return_analysis,
    build_return_analysis_from_snapshot,
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
    """独占测试项目 + 显式 teardown（对齐 test_feedback_dedup 模式）。"""
    from app.models import Project

    project = Project(
        project_name=f"BLF-1074 Test Project {uuid.uuid4().hex[:8]}",
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


def _seed_source(db_session, project_id: int, tag: str):
    from app.models import AnalysisSourceFile

    sf = AnalysisSourceFile(
        project_id=project_id,
        country="US",
        report_type="return_report",
        upload_file_id=f"blf1074_ret_{tag}_{project_id}",
        upload_file_path=f"/tmp/blf1074_{tag}.csv",
        original_filename=f"blf1074_{tag}.csv",
        stored_filename=f"blf1074_{tag}.csv",
        logical_filename=f"blf1074_{tag}.csv",
        storage_key=f"blf1074/{tag}.csv",
        period_start_date=date.today() - timedelta(days=2),
        period_end_date=date.today(),
        is_current=True,
    )
    db_session.add(sf)
    db_session.commit()
    db_session.refresh(sf)
    return sf


def _add_row(
    db_session,
    *,
    source_file_id: int,
    project_id: int,
    order_id: str,
    sku: str,
    return_date,
    license_plate: str,
    reason: str,
    row_no: int,
):
    from app.models import AnalysisReturnRow

    db_session.add(
        AnalysisReturnRow(
            project_id=project_id,
            country="US",
            source_file_id=source_file_id,
            source_row_no=row_no,
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
            customer_comments=None,
        )
    )
    db_session.commit()


def _window() -> tuple[str, str]:
    d = date.today()
    return (d - timedelta(days=2)).isoformat(), d.isoformat()


class TestTopReturnReasonDisplay:
    def test_fallback_path_fills_chinese_display(self, db_session, test_project):
        """现场 fallback 路径：top_return_reason_display 必须是中文。"""
        d = date.today() - timedelta(days=1)
        sf = _seed_source(db_session, test_project, "fallback")
        # DAMAGED_BY_FC 是 BLF-1074 之前漏译的 code 之一（不在前端旧表 14 个里）
        _add_row(
            db_session, source_file_id=sf.id, project_id=test_project,
            order_id="O-FC-1", sku="S-1", return_date=d,
            license_plate="LP-FC-1", reason="DAMAGED_BY_FC", row_no=1,
        )
        _add_row(
            db_session, source_file_id=sf.id, project_id=test_project,
            order_id="O-FC-2", sku="S-1", return_date=d,
            license_plate="LP-FC-2", reason="DAMAGED_BY_FC", row_no=2,
        )
        _add_row(
            db_session, source_file_id=sf.id, project_id=test_project,
            order_id="O-FC-3", sku="S-1", return_date=d,
            license_plate="LP-FC-3", reason="UNWANTED_ITEM", row_no=3,
        )

        start, end = _window()
        result = build_return_analysis(
            db_session,
            project_id=test_project,
            country="US",
            start_date=start,
            end_date=end,
            sku=None,
        )

        assert result.summary.top_return_reason == "DAMAGED_BY_FC"
        assert result.summary.top_return_reason_display == "仓库致损"
        # 与 reason_rows 同源：磁贴与表格不能一个中文一个英文
        assert (
            result.summary.top_return_reason_display
            == result.reason_rows[0].reason_display
        )

    @pytest.mark.parametrize("use_snapshot", [False, True])
    def test_both_paths_agree_on_display(
        self, db_session, test_project, use_snapshot
    ):
        """快照路径与现场路径对同一数据给出同一个 display（双段式一致性）。"""
        from app.celery_tasks.return_analysis_refresh import _refresh_one_day

        d = date.today() - timedelta(days=1)
        sf = _seed_source(db_session, test_project, f"agree{int(use_snapshot)}")
        for i, reason in enumerate(
            ("NO_REASON_GIVEN", "NO_REASON_GIVEN", "NOT_COMPATIBLE"), start=1
        ):
            _add_row(
                db_session, source_file_id=sf.id, project_id=test_project,
                order_id=f"O-AG-{i}", sku="S-1", return_date=d,
                license_plate=f"LP-AG-{i}", reason=reason, row_no=i,
            )
        # 物化聚合表 —— snapshot 路径的数据来源
        _refresh_one_day(db_session, target_date=d)

        start, end = _window()
        if use_snapshot:
            result = build_return_analysis_from_snapshot(
                db_session,
                project_id=test_project,
                country="US",
                start_date=start,
                end_date=end,
                sku=None,
            )
        else:
            result = build_return_analysis(
                db_session,
                project_id=test_project,
                country="US",
                start_date=start,
                end_date=end,
                sku=None,
            )

        assert result.summary.top_return_reason == "NO_REASON_GIVEN"
        # NO_REASON_GIVEN 也在旧前端表的覆盖范围外
        assert result.summary.top_return_reason_display == "未说明原因"
        assert (
            result.summary.top_return_reason_display
            == result.reason_rows[0].reason_display
        )

    def test_no_returns_gives_none_display(self, db_session, test_project):
        """空周期：display 为 None（不能变成空串或原文残留）。"""
        sf = _seed_source(db_session, test_project, "empty")
        assert sf.id  # 只要源文件、不要行
        start, end = _window()
        result = build_return_analysis(
            db_session,
            project_id=test_project,
            country="US",
            start_date=start,
            end_date=end,
            sku=None,
        )
        assert result.summary.top_return_reason is None
        assert result.summary.top_return_reason_display is None
