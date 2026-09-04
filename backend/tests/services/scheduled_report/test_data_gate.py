"""Tests for BLF-533: 调度前"当日写文件动作门禁"（data_gate）。

覆盖：
- `coverage_date_range`：日报/周报/月报的覆盖日期范围。
- `has_write_action`：
  - report_upload_logs 判据命中（project_id + upload_date + country）
  - auto_report_upload_logs 判据命中（project_name + created_at 兜底）
  - 全部项目 × 全部国家：任一组合缺失 → False
  - 周报/月报：覆盖周期内任一日期命中即可
  - 异常安全：查询失败视为有数据放行
"""

from __future__ import annotations

from datetime import date, datetime, timezone, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.models.auto_report_upload_log import AutoReportUploadLog
from app.models.project import Project
from app.models.report_upload_log import ReportUploadLog
from app.services.scheduled_report.data_gate import (
    coverage_date_range,
    has_write_action,
)

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine, autoflush=False, autocommit=False, future=True
    )
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def add_project(db, pid: int, name: str) -> Project:
    proj = Project(id=pid, project_name=name, sort_order=pid)
    db.add(proj)
    db.commit()
    db.refresh(proj)
    return proj


def add_upload_log(
    db, *, project_id: int, country: str, upload_date: date
) -> ReportUploadLog:
    log = ReportUploadLog(
        project_id=project_id,
        report_type="sales_report",
        country=country,
        upload_date=upload_date,
        has_real_data=True,
    )
    db.add(log)
    db.commit()
    return log


def add_auto_upload_log(
    db, *, project_name: str, country: str, created_at: datetime
) -> AutoReportUploadLog:
    log = AutoReportUploadLog(
        run_id="auto-20260808_150000",
        status="success",
        country=country,
        project_name=project_name,
        report_type_label="所有订单",
        created_at=created_at,
    )
    db.add(log)
    db.commit()
    return log


# ── coverage_date_range ───────────────────────────────────────────────────────


def test_coverage_daily_is_single_day():
    assert coverage_date_range("daily", "2026-08-08") == (
        date(2026, 8, 8),
        date(2026, 8, 8),
    )


def test_coverage_weekly_is_previous_natural_week():
    # 2026-08-10 是周一 → 覆盖 2026-08-03 ~ 2026-08-09
    assert coverage_date_range("weekly", "2026-08-10") == (
        date(2026, 8, 3),
        date(2026, 8, 9),
    )


def test_coverage_monthly_is_previous_month():
    assert coverage_date_range("monthly", "2026-08-08") == (
        date(2026, 7, 1),
        date(2026, 7, 31),
    )


# ── has_write_action：report_upload_logs 判据 ────────────────────────────────


def test_has_write_action_true_when_upload_log_matches(db):
    add_project(db, 15, "测试店铺A")
    add_upload_log(db, project_id=15, country="US", upload_date=date(2026, 8, 8))
    assert has_write_action(
        db, project_ids=[15], country="US", frequency="daily", report_date="2026-08-08"
    )


def test_has_write_action_false_when_no_write_log(db):
    add_project(db, 15, "测试店铺A")
    assert not has_write_action(
        db, project_ids=[15], country="US", frequency="daily", report_date="2026-08-08"
    )


def test_has_write_action_all_countries_required(db):
    """用户拍板：多国家订阅必须全部国家都有写动作。"""
    add_project(db, 15, "测试店铺A")
    add_upload_log(db, project_id=15, country="US", upload_date=date(2026, 8, 8))
    # DE 无写动作 → False
    assert not has_write_action(
        db,
        project_ids=[15],
        country="US,DE",
        frequency="daily",
        report_date="2026-08-08",
    )
    # 补上 DE → True
    add_upload_log(db, project_id=15, country="DE", upload_date=date(2026, 8, 8))
    assert has_write_action(
        db,
        project_ids=[15],
        country="US,DE",
        frequency="daily",
        report_date="2026-08-08",
    )


def test_has_write_action_all_projects_required(db):
    """用户拍板：多项目订阅必须全部项目都有写动作。"""
    add_project(db, 15, "测试店铺A")
    add_project(db, 16, "测试店铺B")
    add_upload_log(db, project_id=15, country="US", upload_date=date(2026, 8, 8))
    # B 无写动作 → False
    assert not has_write_action(
        db,
        project_ids=[15, 16],
        country="US",
        frequency="daily",
        report_date="2026-08-08",
    )
    add_upload_log(db, project_id=16, country="US", upload_date=date(2026, 8, 8))
    assert has_write_action(
        db,
        project_ids=[15, 16],
        country="US",
        frequency="daily",
        report_date="2026-08-08",
    )


def test_has_write_action_star_projects_uses_all_projects(db):
    """project_ids=None（"*" 全部项目）→ 任一缺失即 False。"""
    add_project(db, 15, "测试店铺A")
    add_project(db, 16, "测试店铺B")
    add_upload_log(db, project_id=15, country="US", upload_date=date(2026, 8, 8))
    assert not has_write_action(
        db, project_ids=None, country="US", frequency="daily", report_date="2026-08-08"
    )
    add_upload_log(db, project_id=16, country="US", upload_date=date(2026, 8, 8))
    assert has_write_action(
        db, project_ids=None, country="US", frequency="daily", report_date="2026-08-08"
    )


def test_has_write_action_wrong_date_not_counted(db):
    """upload_date 不是调度日当天 → 不算命中（日报）。"""
    add_project(db, 15, "测试店铺A")
    add_upload_log(db, project_id=15, country="US", upload_date=date(2026, 8, 5))
    assert not has_write_action(
        db, project_ids=[15], country="US", frequency="daily", report_date="2026-08-08"
    )


# ── has_write_action：auto_report_upload_logs 兜底判据 ───────────────────────


def test_has_write_action_auto_log_fallback(db):
    """report_upload_logs 无记录但 auto_report_upload_logs 有 → 兜底命中。"""
    add_project(db, 15, "测试店铺A")
    add_auto_upload_log(
        db,
        project_name="测试店铺A",
        country="US",
        created_at=datetime(2026, 8, 8, 10, 0, tzinfo=SHANGHAI_TZ),
    )
    assert has_write_action(
        db, project_ids=[15], country="US", frequency="daily", report_date="2026-08-08"
    )


def test_has_write_action_weekly_any_date_in_period(db):
    """周报：覆盖周期（上一自然周）内任一日期命中即可。"""
    add_project(db, 15, "测试店铺A")
    # 周一 2026-08-03 命中（覆盖周期 08-03~08-09）→ True
    add_upload_log(db, project_id=15, country="US", upload_date=date(2026, 8, 3))
    assert has_write_action(
        db, project_ids=[15], country="US", frequency="weekly", report_date="2026-08-10"
    )


def test_has_write_action_weekly_outside_period_fails(db):
    add_project(db, 15, "测试店铺A")
    # 08-10 是下一周 → 不在覆盖周期 08-03~08-09 内 → False
    add_upload_log(db, project_id=15, country="US", upload_date=date(2026, 8, 10))
    assert not has_write_action(
        db, project_ids=[15], country="US", frequency="weekly", report_date="2026-08-10"
    )


def test_has_write_action_monthly_any_date_in_period(db):
    """月报：覆盖周期（上一自然月）内任一日期命中即可。"""
    add_project(db, 15, "测试店铺A")
    add_upload_log(db, project_id=15, country="US", upload_date=date(2026, 7, 31))
    assert has_write_action(
        db,
        project_ids=[15],
        country="US",
        frequency="monthly",
        report_date="2026-08-08",
    )


def test_has_write_action_exception_is_fail_open(db, monkeypatch):
    """门禁异常应放行（不阻断正常调度）。"""
    add_project(db, 15, "测试店铺A")

    def boom(*args, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(
        "app.services.scheduled_report.data_gate.resolve_project_ids", boom
    )
    assert has_write_action(
        db, project_ids=[15], country="US", frequency="daily", report_date="2026-08-08"
    )
