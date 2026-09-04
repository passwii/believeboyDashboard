"""Unit tests for ``app.utils.persist_helpers`` — PERIODIC vs inventory
versioning and current-pointer semantics.

These tests pin the BEL-127 fix: ``replace_current_pointer`` for
``return_report`` (PERIODIC) must only supersede sources whose period
matches the new source's period. Runs against real PostgreSQL — sqlite
cannot render the JSONB columns in unrelated models that get pulled
into ``Base.metadata`` via ``app.models``'s package import.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import text

from app.db.session import SessionLocal
from app.models import AnalysisSourceFile
from app.models.project import Project
from app.utils.persist_helpers import next_version, replace_current_pointer


# ---------------------------------------------------------------------------
# DB fixtures
# ---------------------------------------------------------------------------


# 测试项目在生产库里必须 inactive — 即便单测中断漏清理,
# 正常的 list_project_items(include_inactive=False) 也不会把测试项目暴露到
# 前端下拉。兜底:整个 session 结束后再扫一次,按前缀清除所有测试项目。
# 用宽松正则 + case-insensitive,UUID hex 既可能大小写,fixture 之外的
# 手工污染也可能含非 hex 字符(如 PH-TEST-fakesimulate0001)。
_TEST_PROJECT_NAME_RE = r"^.*-TEST-.+$"


@pytest.fixture(autouse=True)
def _auto_cleanup_test_projects_on_teardown():
    """文件级 fixture:每条用例跑完后,清扫所有 *-TEST-* 测试项目及其子表。

    跑在生产库上的回归测试需要绝对保险 — 任何中断 / 异常 / 杀进程都不能
    留孤儿数据到生产下拉里。
    """
    yield
    with SessionLocal() as session:
        try:
            dirty_ids = session.execute(
                text("SELECT id FROM projects WHERE project_name ~* :re"),
                {"re": _TEST_PROJECT_NAME_RE},
            ).scalars().all()
            if not dirty_ids:
                return
            session.execute(
                text(
                    "DELETE FROM analysis_return_rows "
                    "WHERE project_id = ANY(:ids)"
                ),
                {"ids": list(dirty_ids)},
            )
            session.execute(
                text(
                    "DELETE FROM analysis_source_files "
                    "WHERE project_id = ANY(:ids)"
                ),
                {"ids": list(dirty_ids)},
            )
            session.execute(
                text("DELETE FROM projects WHERE id = ANY(:ids)"),
                {"ids": list(dirty_ids)},
            )
            session.commit()
        except Exception:
            session.rollback()
            raise


@pytest.fixture()
def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture()
def project_id(db_session):
    """Create a fresh Project, yield its id, cleanup on teardown.

    注:测试项目标 ``is_active=False`` — 即便单测中断漏清理,也不会污染生产下拉。
    """
    name = f"PH-TEST-{uuid.uuid4().hex[:10]}"
    project = Project(
        project_name=name,
        sort_order=0,
        # 测试项目在生产库里必须 inactive;泄漏到下拉的兜底防线
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id
    try:
        yield pid
    finally:
        db_session.execute(
            text("DELETE FROM analysis_source_files WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_return_source(
    db,
    *,
    project_id: int,
    country: str = "US",
    period_start: date,
    period_end: date,
    version: int = 1,
    is_current: bool = True,
) -> AnalysisSourceFile:
    """Insert a ``return_report`` AnalysisSourceFile (PERIODIC).

    ``id`` is left to the DB autoincrement so tests can be re-run without
    PK collisions across runs.
    """
    sf = AnalysisSourceFile(
        project_id=project_id,
        report_type="return_report",
        country=country,
        period_start_date=period_start,
        period_end_date=period_end,
        report_date=None,
        snapshot_at=None,
        version=version,
        is_current=is_current,
        superseded_at=None,
        upload_file_id=f"upload-return-{uuid.uuid4().hex[:8]}",
        upload_file_path="/tmp/upload-return.tsv",
        original_filename="return-report.tsv",
        stored_filename="return-report.tsv",
        logical_filename="return-report.tsv",
        storage_key=f"web_upload/return_report/{project_id}/{period_start}/{version}",
        ingestion_status="success",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(sf)
    db.flush()
    return sf


def _make_inventory_source(
    db,
    *,
    project_id: int,
    country: str = "US",
    snapshot_at: datetime,
    version: int = 1,
    is_current: bool = True,
) -> AnalysisSourceFile:
    """Insert an ``inventory_report`` AnalysisSourceFile (snapshot mode)."""
    sf = AnalysisSourceFile(
        project_id=project_id,
        report_type="inventory_report",
        country=country,
        period_start_date=None,
        period_end_date=None,
        report_date=snapshot_at.date(),
        snapshot_at=snapshot_at,
        version=version,
        is_current=is_current,
        superseded_at=None,
        upload_file_id=f"upload-inv-{uuid.uuid4().hex[:8]}",
        upload_file_path="/tmp/upload-inv.xlsx",
        original_filename="inv.xlsx",
        stored_filename="inv.xlsx",
        logical_filename="inv.xlsx",
        storage_key=f"s3://bucket/inv-{uuid.uuid4().hex[:8]}.xlsx",
        ingestion_status="success",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(sf)
    db.flush()
    return sf


# ---------------------------------------------------------------------------
# next_version — PERIODIC branching
# ---------------------------------------------------------------------------


def test_next_version_periodic_first_returns_one(db_session, project_id):
    """First PERIODIC source for a (project, type, country, period) tuple
    returns version=1.
    """
    n = next_version(
        db_session,
        project_id=project_id,
        report_type="return_report",
        country="US",
        period_start_date=date(2025, 9, 15),
        period_end_date=date(2025, 12, 31),
    )
    assert n == 1


def test_next_version_periodic_same_period_returns_increment(db_session, project_id):
    """Re-uploading the SAME period bumps the version."""
    _make_return_source(
        db_session,
        project_id=project_id,
        period_start=date(2025, 9, 15),
        period_end=date(2025, 12, 31),
        version=1,
        is_current=True,
    )
    db_session.commit()

    n = next_version(
        db_session,
        project_id=project_id,
        report_type="return_report",
        country="US",
        period_start_date=date(2025, 9, 15),
        period_end_date=date(2025, 12, 31),
    )
    assert n == 2


def test_next_version_periodic_different_period_returns_one(db_session, project_id):
    """Regression for BEL-127. PERIODIC versioning MUST be scoped on
    (project, type, country, period). A source existing in period A
    does NOT bump version for a new source in period B.
    """
    _make_return_source(
        db_session,
        project_id=project_id,
        period_start=date(2025, 9, 15),
        period_end=date(2025, 12, 31),
        version=1,
        is_current=True,
    )
    db_session.commit()

    n = next_version(
        db_session,
        project_id=project_id,
        report_type="return_report",
        country="US",
        period_start_date=date(2025, 1, 15),
        period_end_date=date(2025, 8, 31),
    )
    assert n == 1, (
        "different period must not see the version counter from another period"
    )


def test_next_version_inventory_type_ignores_period(db_session, project_id):
    """Inventory reports use snapshot_at, not period. Version is scoped
    on (project, type, country) only — different snapshots share the
    counter.
    """
    _make_inventory_source(
        db_session,
        project_id=project_id,
        snapshot_at=datetime(2025, 9, 15, tzinfo=timezone.utc),
        version=1,
        is_current=True,
    )
    _make_inventory_source(
        db_session,
        project_id=project_id,
        snapshot_at=datetime(2025, 10, 1, tzinfo=timezone.utc),
        version=2,
        is_current=False,
    )
    db_session.commit()

    n = next_version(
        db_session,
        project_id=project_id,
        report_type="inventory_report",
        country="US",
        period_start_date=None,
        period_end_date=None,
    )
    assert n == 3, "inventory_report version should be max+1 across all snapshots"


# ---------------------------------------------------------------------------
# replace_current_pointer — PERIODIC branching
# ---------------------------------------------------------------------------


def test_replace_current_pointer_periodic_only_touches_same_period(
    db_session, project_id
):
    """Core BEL-127 guard. Two current return_report sources in DIFFERENT
    periods must both stay ``is_current=True`` after one of them is
    re-uploaded — the old code collapsed them because period was set
    to ``upload_date`` for both.
    """
    src_a = _make_return_source(
        db_session,
        project_id=project_id,
        period_start=date(2025, 9, 15),
        period_end=date(2025, 12, 31),
        version=1,
        is_current=True,
    )
    src_b = _make_return_source(
        db_session,
        project_id=project_id,
        period_start=date(2025, 1, 15),
        period_end=date(2025, 8, 31),
        version=1,
        is_current=True,
    )
    new_src = _make_return_source(
        db_session,
        project_id=project_id,
        period_start=date(2025, 1, 15),
        period_end=date(2025, 8, 31),
        version=2,
        is_current=False,
    )
    db_session.commit()

    replace_current_pointer(db_session, new_src)
    db_session.commit()

    db_session.refresh(src_a)
    db_session.refresh(src_b)
    db_session.refresh(new_src)

    assert src_a.is_current is True, "different period must NOT be superseded"
    assert src_b.is_current is False, "same-period sibling must be superseded"
    assert src_b.superseded_at is not None
    assert new_src.is_current is False  # caller flips True after this call


def test_replace_current_pointer_inventory_uses_country_only(
    db_session, project_id
):
    """Inventory reports: replace_current_pointer matches on
    (project, type, country) — any snapshot, any snapshot_at.
    """
    old_snap = _make_inventory_source(
        db_session,
        project_id=project_id,
        snapshot_at=datetime(2025, 9, 15, tzinfo=timezone.utc),
        version=1,
        is_current=True,
    )
    new_snap = _make_inventory_source(
        db_session,
        project_id=project_id,
        snapshot_at=datetime(2025, 10, 1, tzinfo=timezone.utc),
        version=2,
        is_current=False,
    )
    db_session.commit()

    replace_current_pointer(db_session, new_snap)
    db_session.commit()

    db_session.refresh(old_snap)
    db_session.refresh(new_snap)
    assert old_snap.is_current is False
    assert old_snap.superseded_at is not None
    assert new_snap.is_current is False