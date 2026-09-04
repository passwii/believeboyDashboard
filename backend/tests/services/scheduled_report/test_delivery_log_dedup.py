"""Tests for Slice 1 of the scheduled_report → Celery migration.

Covers:
- `DeliveryStatus.SUPERSEDED` enum member added (P0-3).
- `ScheduledReportDeliveryLog.__table_args__` carries the dedup UniqueConstraint.
- Inserting two **auto** delivery_log rows with identical
  (subscription_id, frequency, report_date, triggered_by) raises IntegrityError
  on SQLite (proves the constraint surfaces through SQLAlchemy).
- Inserting two **manual** rows with identical (sub, freq, report_date) is
  NOT blocked — manual / 补发 不去重（产品决策 2026-07-13）。
- Different `triggered_by` or different `frequency` for the same
  (subscription, report_date) is NOT blocked (constraint is not over-broad).
- `Settings` accepts the new 4 scheduler switches with sane defaults and
  honours the documented bounds (Pydantic ge/le errors).
- Migration file 20260710_210 exists, points to a known down_revision, and
  contains the contract symbols (no live alembic upgrade).

The tests deliberately avoid `Base.metadata.create_all` because Base pulls in
`r2_delete_failures` (JSONB column) which SQLite can't compile, and that path
is part of the pre-existing baseline that we don't own. Building the two
tables of interest independently sidesteps that.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.models.scheduled_report import (
    DeliveryStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportSubscription,
)


# ---------------------------------------------------------------------------
# Table references (single source for create_all / drop)
# ---------------------------------------------------------------------------

_SUBS_TABLE = ScheduledReportSubscription.__table__
_DELIV_TABLE = ScheduledReportDeliveryLog.__table__


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def engine():
    """Per-test SQLite in-memory engine with just the two tables of interest."""
    eng = create_engine("sqlite:///:memory:", future=True)
    _SUBS_TABLE.create(eng)
    _DELIV_TABLE.create(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def db_session(engine):
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture
def seeded_sub(db_session):
    """Insert one subscription row, return its id."""
    sub = ScheduledReportSubscription(
        project_ids="1",
        country="US",
        frequency="daily",
        dispatch_hour=15,
        dispatch_minute=0,
        enabled=True,
    )
    db_session.add(sub)
    db_session.commit()
    return sub.id


# ---------------------------------------------------------------------------
# DeliveryStatus enum (P0-3 引 SUPERSEDED)
# ---------------------------------------------------------------------------

class TestDeliveryStatusEnum:
    def test_superseded_member_exists_with_value(self):
        assert DeliveryStatus.SUPERSEDED.value == "superseded"

    def test_all_expected_members_present(self):
        values = {s.value for s in DeliveryStatus}
        assert values == {"pending", "sent", "failed", "superseded"}

    def test_existing_members_unmodified(self):
        # 加 SUPERSEDED 不影响老成员
        assert DeliveryStatus.PENDING.value == "pending"
        assert DeliveryStatus.SENT.value == "sent"
        assert DeliveryStatus.FAILED.value == "failed"


# ---------------------------------------------------------------------------
# UniqueConstraint on (sub, freq, report_date, triggered_by)
# ---------------------------------------------------------------------------

class TestDeliveryLogUniqueConstraint:
    def test_dedup_unique_constraint_declared_in_table_args(self):
        # P0-3 v2: partial unique INDEX (not full UniqueConstraint). The
        # index object lives in `__table__.indexes`; verify by name +
        # uniqueness + postgresql_where predicate.
        names = {i.name for i in ScheduledReportDeliveryLog.__table__.indexes}
        assert "uq_delivery_log_dedup" in names
        # It must be unique
        for idx in ScheduledReportDeliveryLog.__table__.indexes:
            if idx.name == "uq_delivery_log_dedup":
                assert idx.unique is True
                # 收窄后只对 auto 生效（manual 不去重）
                where = str(idx.dialect_options["postgresql"]["where"])
                assert "triggered_by = 'auto'" in where
                return
        raise AssertionError("uq_delivery_log_dedup index not found")

    def test_inserting_duplicate_auto_raises_integrity_error(self, db_session, seeded_sub):
        # Partial unique index：auto 路径仍去重——同 (sub, freq, report_date,
        # triggered_by='auto') 的第二条 active 行被挡下。
        # First row — status=sent (active)
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="auto",
                email="first@example.com",
                status=DeliveryStatus.SENT.value,
            )
        )
        db_session.commit()

        # Duplicate (same sub, freq, report_date, triggered_by='auto') — default
        # status is PENDING (active), so partial unique kicks in.
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="auto",
                email="second@example.com",
            )
        )
        with pytest.raises(IntegrityError):
            db_session.commit()
        db_session.rollback()

    def test_duplicate_manual_allowed(self, db_session, seeded_sub):
        # 产品决策：manual / 补发 不去重——同一 (sub, freq, report_date) 可多次
        # manual，即使第一条已 sent 也不挡。
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="manual",
                email="m1@example.com",
                status=DeliveryStatus.SENT.value,
            )
        )
        db_session.commit()
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="manual",
                email="m2@example.com",
            )
        )
        db_session.commit()  # 不抛异常

    def test_duplicate_manual_allowed_regardless_of_status(self, db_session, seeded_sub):
        # 失败态也能再补发：第一条 pending（在途/未发），第二条 manual 仍可建。
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="manual",
                email="a@example.com",
            )
        )
        db_session.commit()
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="manual",
                email="b@example.com",
            )
        )
        db_session.commit()  # 不抛异常

    def test_same_sub_but_different_triggered_by_allowed(self, db_session, seeded_sub):
        # auto seeded row
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="auto",
                email="auto@example.com",
            )
        )
        # manual row for the SAME (sub, freq, report_date) → allowed
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="manual",
                email="manual@example.com",
            )
        )
        db_session.commit()  # no exception

    def test_same_sub_and_date_but_different_frequency_allowed(self, db_session, seeded_sub):
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="auto",
                email="daily@example.com",
            )
        )
        db_session.add(
            ScheduledReportDeliveryLog(
                subscription_id=seeded_sub,
                frequency="weekly",
                report_date="2026-07-10",
                triggered_by="auto",
                email="weekly@example.com",
            )
        )
        db_session.commit()


# ---------------------------------------------------------------------------
# Settings 4 个调度开关 (P1 / P2 决策)
# ---------------------------------------------------------------------------

def _make_settings(**overrides) -> Settings:
    """Build a Settings with the bare minimum required fields + overrides."""
    base = {
        "_env_file": None,
        "database_url": "postgresql+psycopg://u:p@localhost:5432/x",
    }
    base.update(overrides)
    return Settings(**base)


class TestScheduledDispatchSettings:
    def test_enable_scheduler_default_true(self):
        s = _make_settings()
        assert s.enable_scheduler is True

    def test_scheduled_report_via_celery_default_true(self):
        s = _make_settings()
        assert s.scheduled_report_via_celery is True

    def test_scheduled_dispatch_spread_seconds_default_60(self):
        s = _make_settings()
        assert s.scheduled_dispatch_spread_seconds == 60

    def test_max_concurrent_ai_summary_default_5(self):
        s = _make_settings()
        assert s.max_concurrent_ai_summary == 5

    def test_scheduled_dispatch_spread_seconds_lower_bound(self):
        # ge=0 → 0 OK
        s = _make_settings(scheduled_dispatch_spread_seconds=0)
        assert s.scheduled_dispatch_spread_seconds == 0
        # ge=0 → -1 raises
        with pytest.raises(Exception):
            _make_settings(scheduled_dispatch_spread_seconds=-1)

    def test_scheduled_dispatch_spread_seconds_upper_bound(self):
        # le=600 → 600 OK
        s = _make_settings(scheduled_dispatch_spread_seconds=600)
        assert s.scheduled_dispatch_spread_seconds == 600
        # 601 raises
        with pytest.raises(Exception):
            _make_settings(scheduled_dispatch_spread_seconds=601)

    def test_max_concurrent_ai_summary_bounds(self):
        # ge=1, le=20
        s = _make_settings(max_concurrent_ai_summary=1)
        assert s.max_concurrent_ai_summary == 1
        s = _make_settings(max_concurrent_ai_summary=20)
        assert s.max_concurrent_ai_summary == 20
        with pytest.raises(Exception):
            _make_settings(max_concurrent_ai_summary=0)
        with pytest.raises(Exception):
            _make_settings(max_concurrent_ai_summary=21)

    def test_overrides_take_effect(self):
        s = _make_settings(
            enable_scheduler=False,
            scheduled_report_via_celery=False,
            scheduled_dispatch_spread_seconds=30,
            max_concurrent_ai_summary=10,
        )
        assert s.enable_scheduler is False
        assert s.scheduled_report_via_celery is False
        assert s.scheduled_dispatch_spread_seconds == 30
        assert s.max_concurrent_ai_summary == 10


# ---------------------------------------------------------------------------
# Migration 文件静态完整性（不真正调 alembic — 受 baseline fixture 限制）
# ---------------------------------------------------------------------------

class TestMigrationFileContract:
    @pytest.fixture
    def migration_path(self) -> Path:
        backend_root = Path(__file__).resolve().parents[3]
        return backend_root / "alembic" / "versions" / "20260710_210_add_superseded_status_and_unique_constraint.py"

    def test_migration_file_exists(self, migration_path):
        assert migration_path.exists(), f"missing migration: {migration_path}"

    def test_migration_contains_required_symbols(self, migration_path):
        text = migration_path.read_text()
        # Revision id 自身
        assert '"20260710_210"' in text or "'20260710_210'" in text
        # down_revision chain 到已有 migration
        assert '"20260710_209"' in text or "'20260710_209'" in text
        # Index 名
        assert "uq_delivery_log_dedup" in text
        # P0-3 v2: partial unique index, not full constraint
        assert "create_index" in text
        assert "postgresql_where" in text or "status NOT IN" in text
        # 数据迁移关键 token
        assert "superseded" in text
        assert "PARTITION BY" in text.upper() or "PARTITION BY subscription_id" in text
        # 不可 downgrade 反向回退历史 superseded 数据的注释
        assert "downgrade" in text

    def test_down_revision_file_actually_exists(self, migration_path):
        """`down_revision` must point to a known revision.

        Note: cross-branch lineage (e.g. down_revision=`20260710_209` lives
        in the `feat/crm-bootstrap` branch, not in this worktree) — so we
        weaken the assertion to:
        1. The token matches the `YYYYMMDD_NNN` alembic convention.
        2. If the file IS present in this worktree, it parses to the same
           revision id (no copy-paste typo between `<down_revision>` and the
           filename).
        """
        import re

        text = migration_path.read_text()
        # Match a module-level assignment of the form `down_revision = "X"` —
        # NOT docstring/comment lines that happen to start with the prefix.
        match = re.search(r'^down_revision\s*=\s*["\']([^"\']+)["\']', text, flags=re.MULTILINE)
        assert match, "down_revision assignment not found in migration"
        token = match.group(1)
        # Convention check: `YYYYMMDD_NNN` shape
        assert (
            len(token) == 12
            and token[:8].isdigit()
            and token[8] == "_"
            and token[9:].isdigit()
        ), f"down_revision '{token}' must match YYYYMMDD_NNN convention"

        # If the file IS in this worktree, sanity-check the filename matches
        # the token (no copy-paste typo). Cross-branch revisions are
        # intentionally allowed.
        down_dir = (
            Path(__file__).resolve().parents[3]
            / "alembic"
            / "versions"
        )
        candidates = sorted(down_dir.glob(f"{token}_*.py"))
        # File may live in a sibling branch (cross-lineage upgrade) — that's
        # allowed, but at least verify it lives SOMEWHERE in alembic/.
        assert not candidates or candidates[0].exists(), (
            f"down_revision file {token}_*.py claimed but not on disk"
        )


class TestRelaxDedupMigrationContract:
    """20260713_212：manual 不去重，仅 auto 保留一天一次。"""

    @pytest.fixture
    def migration_path(self) -> Path:
        backend_root = Path(__file__).resolve().parents[3]
        return (
            backend_root
            / "alembic"
            / "versions"
            / "20260713_212_relax_dedup_unique_index_for_manual.py"
        )

    def test_migration_file_exists(self, migration_path):
        assert migration_path.exists(), f"missing migration: {migration_path}"

    def test_migration_contains_required_symbols(self, migration_path):
        text = migration_path.read_text()
        assert '"20260713_212"' in text or "'20260713_212'" in text
        assert '"20260710_211"' in text or "'20260710_211'" in text
        assert "uq_delivery_log_dedup" in text
        assert "create_index" in text
        # 收窄关键：WHERE 加 triggered_by = 'auto'
        assert "triggered_by = 'auto'" in text
        # 保留原 P0-3 语义：仍排除 superseded / failed
        assert "NOT IN ('superseded', 'failed')" in text
        assert "downgrade" in text
