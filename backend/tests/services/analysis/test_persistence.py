"""Regression tests for ``app.services.analysis.return_analysis.persistence``.

These tests pin the BEL-127 fix: ``_persist_single_country_return_report``
must use the **CSV return-date range** as ``period_start_date`` /
``period_end_date``, **not** the upload date. The old behaviour caused
``replace_current_pointer`` (PERIODIC, scoped on period) to collapse two
uploads of non-overlapping date ranges (e.g. Sep-Dec followed by Jan-Aug)
into a single ``is_current`` slot, silently hiding half the rows from
``build_return_analysis``.

Runs against the real PostgreSQL test DB (see ``test_internal.py`` for
the same pattern). Each test uses a unique ``project_id`` so it cannot
collide with production data; cleanup runs in the autouse fixture.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import text

from app.db.session import SessionLocal
from app.models import AnalysisReturnRow, AnalysisSourceFile
from app.models.project import Project
from app.services.analysis.return_analysis.persistence import (
    persist_return_report,
)


# ---------------------------------------------------------------------------
# Test isolation helpers
# ---------------------------------------------------------------------------


def _make_project_name(prefix: str = "BEL127-TEST") -> str:
    """Generate a project_name that cannot collide with anything in prod."""
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


# 测试项目在生产库里必须标 inactive,即使单测中断漏清理,
# 正常的 list_project_items(include_inactive=False) 也不会把测试项目暴露到前端下拉。
# 兜底:整个测试 session 结束后再扫一次,按前缀清除所有测试项目(双保险)。
# 用宽松正则 + case-insensitive,UUID hex 既可能大小写,fixture 之外的
# 手工污染也可能含非 hex 字符(如 PH-TEST-fakesimulate0001)。
_TEST_PROJECT_NAME_RE = r"^.*-TEST-.+$"


@pytest.fixture(autouse=True)
def _auto_cleanup_test_projects_on_teardown():
    """文件级 fixture:每条用例跑完后,清扫所有 *-TEST-* 测试项目及其子表。

    跑在生产库上的回归测试(`test_persist_helpers` / `test_persistence`)需要
    绝对保险 — 任何中断 / 异常 / 杀进程都不能留孤儿数据。
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
            # 子表清理顺序:先 leaf 再 parent,避免外键约束
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
            session.execute(
                text(
                    "DELETE FROM report_upload_logs "
                    "WHERE project_id = ANY(:ids)"
                ),
                {"ids": list(dirty_ids)},
            )
            session.commit()
        except Exception:
            session.rollback()
            raise


@pytest.fixture()
def project_id(db_session):
    """Create a fresh Project, yield its id, and clean up everything we
    wrote under it on teardown.

    注:测试项目标 ``is_active=False`` — 即便单测中断漏清理,也不会污染生产下拉。
    """
    name = _make_project_name()
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
        yield pid, name
    finally:
        # Clean up everything under this test's project_id. Order matters:
        # rows first (FK), then source_files, then the project itself.
        # ``expire_all`` first so SQLAlchemy doesn't try to flush ORM
        # objects from earlier queries (e.g. ``build_return_analysis``)
        # that may already have been deleted.
        db_session.expire_all()
        db_session.execute(
            text(
                "DELETE FROM analysis_return_rows WHERE project_id = :pid"
            ),
            {"pid": pid},
        )
        db_session.execute(
            text(
                "DELETE FROM analysis_source_files WHERE project_id = :pid"
            ),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.execute(
            text(
                "DELETE FROM report_upload_logs WHERE project_id = :pid"
            ),
            {"pid": pid},
        )
        db_session.commit()


# ---------------------------------------------------------------------------
# DB fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture()
def frozen_now(monkeypatch):
    """Freeze ``datetime.now(UTC)`` inside the persistence module to 2026-07-07."""
    from app.services.analysis.return_analysis import persistence

    fake_now = datetime(2026, 7, 7, 12, 0, 0, tzinfo=timezone.utc)

    class _FrozenDatetime:
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return fake_now.replace(tzinfo=None)
            return fake_now.astimezone(tz)

        @classmethod
        def utcnow(cls):
            return fake_now

    monkeypatch.setattr(persistence, "datetime", _FrozenDatetime)
    return fake_now


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_return_tsv(tmp_path: Path, rows: list[dict]) -> str:
    """Write a minimal return-report TSV that ``parse_return_rows`` accepts.

    Required columns: ``return-date``, ``sku`` (per ``parsers.py:629``).
    """
    columns = [
        "return-date",
        "order-id",
        "sku",
        "asin",
        "quantity",
        "detailed-disposition",
        "reason",
        "status",
        "license-plate-number",
    ]
    path = tmp_path / "return.tsv"
    with path.open("w", encoding="utf-8") as f:
        f.write("\t".join(columns) + "\n")
        for row in rows:
            f.write("\t".join(str(row.get(c, "")) for c in columns) + "\n")
    return str(path)


def _query_source(db, source_id: int) -> AnalysisSourceFile:
    return db.get(AnalysisSourceFile, source_id)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_period_uses_csv_date_range_not_upload_date(
    db_session, project_id, tmp_path, frozen_now
):
    """Core regression: period must reflect the CSV's return-date span,
    not the upload date.

    Setup: fake upload date is 2026-07-07. CSV contains return-dates in
    2025-09-15 .. 2025-12-31. Asserting period = (2025-09-15, 2025-12-31)
    and ``is_current=True`` proves the fix works.
    """
    pid, name = project_id

    csv_path = _write_return_tsv(
        tmp_path,
        [
            {
                "return-date": "2025-09-15T10:00:00+00:00",
                "order-id": "111-1111111-1111111",
                "sku": "MJQ-TR250E",
                "quantity": 1,
                "detailed-disposition": "SELLABLE",
                "reason": "DEFECTIVE",
                "status": "Processed",
                "license-plate-number": "LP-A",
            },
            {
                "return-date": "2025-12-31T10:00:00+00:00",
                "order-id": "111-2222222-2222222",
                "sku": "MJQ-TR250E",
                "quantity": 2,
                "detailed-disposition": "SELLABLE",
                "reason": "BUYER_REMORSE",
                "status": "Processed",
                "license-plate-number": "LP-B",
            },
        ],
    )

    outcome = persist_return_report(
        db_session, project_name=name, country="US", file_path=csv_path
    )
    assert outcome["success"] is True, outcome

    source = _query_source(db_session, outcome["source_id"])
    assert source.period_start_date == date(2025, 9, 15), (
        f"expected period_start=2025-09-15 from CSV, got {source.period_start_date}"
    )
    assert source.period_end_date == date(2025, 12, 31), (
        f"expected period_end=2025-12-31 from CSV, got {source.period_end_date}"
    )
    assert source.is_current is True
    assert source.period_start_date != frozen_now.date()


def test_period_fallback_to_upload_date_when_csv_empty(
    db_session, project_id, tmp_path, frozen_now
):
    """Empty CSV (header only) → period falls back to upload_date."""
    pid, name = project_id
    csv_path = _write_return_tsv(tmp_path, [])

    outcome = persist_return_report(
        db_session, project_name=name, country="US", file_path=csv_path
    )
    assert outcome["success"] is True

    source = _query_source(db_session, outcome["source_id"])
    assert source.period_start_date == frozen_now.date()
    assert source.period_end_date == frozen_now.date()
    assert source.is_current is True
    assert source.row_count_total == 0


def test_same_period_reupload_creates_new_version_and_supersedes_old(
    db_session, project_id, tmp_path, frozen_now
):
    """Re-uploading the SAME period bumps version and flips old's
    ``is_current`` to False. Guards the 订正 workflow that ``is_current``
    was designed for.
    """
    pid, name = project_id

    def _upload(return_date_iso: str, order_id: str, reason: str) -> int:
        csv_path = _write_return_tsv(
            tmp_path,
            [
                {
                    "return-date": return_date_iso,
                    "order-id": order_id,
                    "sku": "MJQ-TR250E",
                    "quantity": 1,
                    "detailed-disposition": "SELLABLE",
                    "reason": reason,
                    "status": "Processed",
                    "license-plate-number": "LP-1",
                }
            ],
        )
        return persist_return_report(
            db_session, project_name=name, country="US", file_path=csv_path
        )["source_id"]

    first = _upload("2025-09-15T10:00:00+00:00", "111-1111111-1111111", "DEFECTIVE")
    second = _upload("2025-09-15T10:00:00+00:00", "111-1111111-1111111", "WRONG_SIZE")

    first_src = _query_source(db_session, first)
    second_src = _query_source(db_session, second)

    assert first_src.version == 1
    assert second_src.version == 2
    assert first_src.period_start_date == second_src.period_start_date == date(2025, 9, 15)
    assert first_src.is_current is False
    assert first_src.superseded_at is not None
    assert second_src.is_current is True


def test_different_period_two_uploads_both_current(
    db_session, project_id, tmp_path, frozen_now
):
    """User's exact scenario: upload Sep-Dec, then upload Jan-Aug. Both
    source_files must end up ``is_current=True`` because their periods
    differ — the OLD code collapsed both into a single current slot.
    """
    pid, name = project_id

    def _upload(rows: list[dict], prefix: str) -> int:
        rows = [
            {**r, "order-id": f"{prefix}-{i:04d}", "license-plate-number": f"LP-{prefix}-{i}"}
            for i, r in enumerate(rows)
        ]
        csv_path = _write_return_tsv(tmp_path, rows)
        return persist_return_report(
            db_session, project_name=name, country="US", file_path=csv_path
        )["source_id"]

    first_id = _upload(
        [
            {
                "return-date": "2025-09-15T10:00:00+00:00",
                "sku": "MJQ-TR250E",
                "quantity": 1,
                "detailed-disposition": "SELLABLE",
                "reason": "DEFECTIVE",
                "status": "Processed",
            },
            {
                "return-date": "2025-12-31T10:00:00+00:00",
                "sku": "MJQ-TR250E",
                "quantity": 1,
                "detailed-disposition": "SELLABLE",
                "reason": "DEFECTIVE",
                "status": "Processed",
            },
        ],
        prefix="111",
    )

    second_id = _upload(
        [
            {
                "return-date": "2025-01-15T10:00:00+00:00",
                "sku": "MJQ-TR250E",
                "quantity": 1,
                "detailed-disposition": "SELLABLE",
                "reason": "DEFECTIVE",
                "status": "Processed",
            },
            {
                "return-date": "2025-08-31T10:00:00+00:00",
                "sku": "MJQ-TR250E",
                "quantity": 1,
                "detailed-disposition": "SELLABLE",
                "reason": "DEFECTIVE",
                "status": "Processed",
            },
        ],
        prefix="222",
    )

    first_src = _query_source(db_session, first_id)
    second_src = _query_source(db_session, second_id)

    assert first_src.period_start_date == date(2025, 9, 15)
    assert first_src.period_end_date == date(2025, 12, 31)
    assert second_src.period_start_date == date(2025, 1, 15)
    assert second_src.period_end_date == date(2025, 8, 31)
    assert first_src.is_current is True, (
        "first source's period is distinct; it must NOT be superseded"
    )
    assert second_src.is_current is True

    # All 4 rows must be visible from the analysis_query path.
    visible = (
        db_session.query(AnalysisReturnRow)
        .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisReturnRow.source_file_id)
        .filter(
            AnalysisSourceFile.project_id == pid,
            AnalysisSourceFile.country == "US",
            AnalysisSourceFile.report_type == "return_report",
            AnalysisSourceFile.is_current.is_(True),
        )
        .all()
    )
    assert len(visible) == 4, (
        f"expected all 4 rows visible under is_current=True, got {len(visible)}"
    )


def test_parse_failure_returns_error_no_current_source_persisted(
    db_session, project_id, tmp_path, frozen_now
):
    """Missing required column triggers ``ValueError``. Persistence must
    return ``success=False`` and not leave any ``is_current=True`` source
    behind for this project.
    """
    pid, name = project_id

    path = tmp_path / "broken.tsv"
    path.write_text("order-id\tquantity\n111-1111111-1111111\t1\n", encoding="utf-8")

    outcome = persist_return_report(
        db_session, project_name=name, country="US", file_path=str(path)
    )

    assert outcome["success"] is False
    assert "缺少必要字段" in outcome["error_message"]

    current_sources = (
        db_session.query(AnalysisSourceFile)
        .filter(
            AnalysisSourceFile.project_id == pid,
            AnalysisSourceFile.report_type == "return_report",
            AnalysisSourceFile.is_current.is_(True),
        )
        .all()
    )
    assert current_sources == []


def test_uq_return_event_upsert_updates_existing_row_in_place(
    db_session, project_id, tmp_path, frozen_now
):
    """Re-uploading a row that already exists (same business key) must
    hit ``ON CONFLICT DO UPDATE``: existing row updated in place, row
    count stays at 1, ``source_file_id`` points at the NEW source.
    """
    pid, name = project_id

    base = {
        "return-date": "2025-09-15T10:00:00+00:00",
        "order-id": "111-1111111-1111111",
        "sku": "MJQ-TR250E",
        "quantity": 1,
        "detailed-disposition": "SELLABLE",
        "status": "Processed",
        "license-plate-number": "LP-SAME",
    }

    first_csv = _write_return_tsv(
        tmp_path, [{**base, "reason": "DEFECTIVE"}]
    )
    first_outcome = persist_return_report(
        db_session, project_name=name, country="US", file_path=first_csv
    )
    assert first_outcome["success"] is True

    second_csv = _write_return_tsv(
        tmp_path, [{**base, "reason": "WRONG_SIZE"}]
    )
    second_outcome = persist_return_report(
        db_session, project_name=name, country="US", file_path=second_csv
    )
    assert second_outcome["success"] is True

    rows = (
        db_session.query(AnalysisReturnRow)
        .filter(AnalysisReturnRow.order_id == base["order-id"])
        .all()
    )
    assert len(rows) == 1
    assert rows[0].reason == "WRONG_SIZE"
    assert rows[0].source_file_id == second_outcome["source_id"]

    first_src = _query_source(db_session, first_outcome["source_id"])
    second_src = _query_source(db_session, second_outcome["source_id"])
    assert first_src.version == 1
    assert second_src.version == 2
    assert first_src.is_current is False
    assert second_src.is_current is True
    assert first_src.period_start_date == second_src.period_start_date == date(2025, 9, 15)


def test_query_layer_returns_all_periods_when_each_source_is_current(
    db_session, project_id, tmp_path, frozen_now
):
    """End-to-end regression for the user-reported scenario. Upload two
    complementary files and run ``build_return_analysis`` for the full
    year — assert it covers BOTH periods. Under the OLD code the
    service-layer query returned only the most-recently-uploaded source.
    """
    from app.services.analysis.return_analysis.analysis import (
        build_return_analysis,
    )

    pid, name = project_id

    def _upload(return_dates: list[str], order_prefix: str) -> int:
        rows = [
            {
                "return-date": rd,
                "order-id": f"{order_prefix}-{i:04d}",
                "sku": "MJQ-TR250E",
                "quantity": 1,
                "detailed-disposition": "SELLABLE",
                "reason": "DEFECTIVE",
                "status": "Processed",
                "license-plate-number": f"LP-{order_prefix}-{i}",
            }
            for i, rd in enumerate(return_dates)
        ]
        csv_path = _write_return_tsv(tmp_path, rows)
        return persist_return_report(
            db_session, project_name=name, country="US", file_path=csv_path
        )["source_id"]

    upload_a = _upload(
        [
            "2025-09-01T10:00:00+00:00",
            "2025-10-15T10:00:00+00:00",
            "2025-12-31T10:00:00+00:00",
        ],
        "111",
    )
    upload_b = _upload(
        [
            "2025-01-15T10:00:00+00:00",
            "2025-04-20T10:00:00+00:00",
            "2025-08-31T10:00:00+00:00",
        ],
        "222",
    )

    assert upload_a != upload_b
    src_a = _query_source(db_session, upload_a)
    src_b = _query_source(db_session, upload_b)
    assert src_a.is_current is True
    assert src_b.is_current is True

    response = build_return_analysis(
        db_session,
        project_id=pid,
        country="US",
        start_date="2025-01-01",
        end_date="2025-12-31",
    )

    assert response.summary.total_returns == 6, (
        f"expected 6 unique return events across both files, "
        f"got {response.summary.total_returns}"
    )
    trend_dates = {row.date for row in response.trend_rows}
    assert "2025-01-15" in trend_dates, "Jan row missing — file B not visible"
    assert "2025-09-01" in trend_dates, "Sep row missing — file A not visible"
    assert "2025-12-31" in trend_dates, "Dec row missing"
    assert "2025-08-31" in trend_dates, "Aug row missing"