"""BLF-1038：``_load_latest_available_dates`` 查询精简后的语义等价测试。

背景：该函数原先把项目下三种 report_type 的
``(report_type, report_date, period_start_date, snapshot_at)`` 全量行拉回 Python
求 4 个最大值（生产单项目 ~450 行），改为 SQL 聚合（``max(...) filter (...)``，
1 行 3 列）。本文件锁定"改前改后同结果"的口径：

- ``sales_report`` → ``max(report_date)``（NULL 行忽略）；
- ``business_report`` → ``max(period_start_date)``；
- ``inventory_report`` → ``max(coalesce(report_date, snapshot_at::date))``
  （即"有 report_date 用 report_date，否则用 snapshot_at 当天"，再取最大）；
- ``ad_promoted_product_report``（来自 ad_upload_files）→ ``max(report_date)``；
- ``is_current=False`` 的历史版本一律不计。
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models import AdUploadFile, AnalysisSourceFile, Project
from app.services.daily.analysis import _load_latest_available_dates


@pytest.fixture
def project_with_sources():
    """一个项目 + 覆盖各分支的 source 文件行。"""
    suffix = uuid.uuid4().hex[:8]
    day = date(2026, 3, 10)
    db = SessionLocal()
    try:
        project = Project(
            project_name=f"blf1038-latest-{suffix}",
            project_operator=f"blf1038-op-{suffix}",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        pid = project.id

        def _source(
            *,
            report_type: str,
            report_date: date | None,
            period_start: date | None,
            period_end: date | None = None,
            snapshot_at: datetime | None = None,
            is_current: bool = True,
        ) -> None:
            db.add(
                AnalysisSourceFile(
                    project_id=pid,
                    country="US",
                    report_type=report_type,
                    upload_file_id=f"blf1038-{uuid.uuid4().hex[:8]}",
                    upload_file_path="reports/blf1038.csv",
                    original_filename="blf1038.csv",
                    stored_filename="blf1038.csv",
                    logical_filename="blf1038.csv",
                    storage_key="blf1038.csv",
                    report_date=report_date,
                    period_start_date=period_start,
                    period_end_date=period_end or period_start,
                    snapshot_at=snapshot_at,
                    is_current=is_current,
                    ingestion_status="success",
                    created_by="pytest",
                )
            )

        # sales：3 行（其中一行 report_date 为 NULL、一行 is_current=False）
        _source(
            report_type="sales_report",
            report_date=day,
            period_start=day,
            period_end=day,
        )
        _source(
            report_type="sales_report",
            report_date=day + timedelta(days=2),
            period_start=day + timedelta(days=2),
            period_end=day + timedelta(days=2),
        )
        # 注意：唯一约束含 (period_start_date, period_end_date, version)，
        # 因此 report_date=NULL 的这行必须换个周期，否则与上一行撞唯一键。
        _source(
            report_type="sales_report",
            report_date=None,
            period_start=day - timedelta(days=3),
            period_end=day - timedelta(days=3),
        )

        # inventory：当前行只有一个（部分唯一索引 uq_analysis_sources_inventory_current
        # 限定 (project_id, report_type) 只能有一行 current）：
        # report_date 优先于 snapshot_at 当天。
        _source(
            report_type="inventory_report",
            report_date=day + timedelta(days=4),
            period_start=None,
            period_end=None,
            snapshot_at=datetime(2026, 3, 6, 8, 30, tzinfo=UTC),
        )
        # is_current=False 且 snapshot 日期更大 → 不得进入结果
        _source(
            report_type="inventory_report",
            report_date=None,
            period_start=None,
            period_end=None,
            snapshot_at=datetime(2026, 4, 30, 8, 30, tzinfo=UTC),
            is_current=False,
        )

        # business：period_start_date 取最大
        _source(
            report_type="business_report",
            report_date=None,
            period_start=day - timedelta(days=6),
            period_end=day,
        )
        _source(
            report_type="business_report",
            report_date=None,
            period_start=day + timedelta(days=1),
            period_end=day + timedelta(days=1),
        )

        # ad（C 表）：1 行 current + 1 行历史版本
        for report_date, is_current in (
            (day + timedelta(days=3), True),
            (day + timedelta(days=20), False),
        ):
            db.add(
                AdUploadFile(
                    project_id=pid,
                    project_name=project.project_name,
                    report_type="ad_promoted_product_report",
                    report_label="广告推广商品报表",
                    country="US",
                    report_date=report_date,
                    period_start_date=report_date,
                    period_end_date=report_date,
                    is_current=is_current,
                    upload_file_id=f"blf1038-ad-{uuid.uuid4().hex[:8]}",
                    upload_file_path="reports/blf1038-ad.csv",
                    stored_filename="blf1038-ad.csv",
                    logical_filename="blf1038-ad.csv",
                    file_extension="csv",
                    matched_columns=[],
                    warnings=[],
                )
            )
        db.commit()
    finally:
        db.close()

    yield {"project_id": pid, "day": day}

    db = SessionLocal()
    try:
        db.execute(
            delete(AnalysisSourceFile).where(AnalysisSourceFile.project_id == pid)
        )
        db.execute(delete(AdUploadFile).where(AdUploadFile.project_id == pid))
        row = db.get(Project, pid)
        if row is not None:
            db.delete(row)
        db.commit()
    finally:
        db.close()


def test_latest_available_dates_matches_previous_semantics(project_with_sources):
    """四条口径各自取到正确的最大值（含 NULL / 历史版本 / coalesce 分支）。"""
    day: date = project_with_sources["day"]
    db = SessionLocal()
    try:
        result = _load_latest_available_dates(
            db, project_id=project_with_sources["project_id"], country="US"
        )
    finally:
        db.close()

    assert result == {
        # sales：day 与 day+2 取最大；report_date=None 的行忽略
        "latest_sales_date": (day + timedelta(days=2)).isoformat(),
        # inventory：report_date=day+4（3-14）优先于 snapshot_at 的 3-06
        "latest_inventory_date": (day + timedelta(days=4)).isoformat(),
        # business：day-6 与 day+1 取最大
        "latest_business_date": (day + timedelta(days=1)).isoformat(),
        # ad：day+3 为 current；day+20 是历史版本（is_current=False）→ 不计
        "latest_ad_date": (day + timedelta(days=3)).isoformat(),
    }


def test_latest_available_dates_inventory_snapshot_only():
    """inventory 只有 snapshot_at（report_date 为 NULL）时取 snapshot 当天。"""
    suffix = uuid.uuid4().hex[:8]
    db = SessionLocal()
    pid: int | None = None
    try:
        project = Project(
            project_name=f"blf1038-inv-{suffix}",
            project_operator=f"blf1038-op-{suffix}",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        pid = project.id
        db.add(
            AnalysisSourceFile(
                project_id=pid,
                country="US",
                report_type="inventory_report",
                upload_file_id=f"blf1038-inv-{suffix}",
                upload_file_path="reports/blf1038-inv.csv",
                original_filename="blf1038-inv.csv",
                stored_filename="blf1038-inv.csv",
                logical_filename="blf1038-inv.csv",
                storage_key="blf1038-inv.csv",
                report_date=None,
                period_start_date=None,
                period_end_date=None,
                snapshot_at=datetime(2026, 3, 5, 8, 30, tzinfo=UTC),
                is_current=True,
                ingestion_status="success",
                created_by="pytest",
            )
        )
        db.commit()

        result = _load_latest_available_dates(db, project_id=pid, country="US")
    finally:
        if pid is not None:
            db.execute(
                delete(AnalysisSourceFile).where(AnalysisSourceFile.project_id == pid)
            )
            row = db.get(Project, pid)
            if row is not None:
                db.delete(row)
            db.commit()
        db.close()

    assert result["latest_inventory_date"] == "2026-03-05"
    assert result["latest_sales_date"] is None
    assert result["latest_business_date"] is None


def test_latest_available_dates_empty_project(project_with_sources):
    """无任何 source 文件 → 四个字段均为 None（不是 NULL 聚合异常）。"""
    empty_suffix = uuid.uuid4().hex[:8]
    db = SessionLocal()
    pid: int | None = None
    try:
        project = Project(
            project_name=f"blf1038-empty-{empty_suffix}",
            project_operator=f"blf1038-op-{empty_suffix}",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        pid = project.id
        db.commit()

        result = _load_latest_available_dates(db, project_id=pid, country="US")
    finally:
        if pid is not None:
            db.execute(delete(AnalysisSourceFile).where(AnalysisSourceFile.project_id == pid))
            row = db.get(Project, pid)
            if row is not None:
                db.delete(row)
            db.commit()
        db.close()

    assert result == {
        "latest_sales_date": None,
        "latest_inventory_date": None,
        "latest_business_date": None,
        "latest_ad_date": None,
    }
