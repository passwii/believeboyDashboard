"""Regression tests for duplicate accounting-detail exports."""

from threading import Event, Thread

import pytest
from fastapi import HTTPException

from app.services.report import export as export_service


def test_accounting_export_guard_rejects_duplicate_key_and_releases_afterward():
    """A retry cannot start a second CPU-heavy workbook for the same report."""
    guard = getattr(export_service, "_accounting_export_guard", None)
    assert guard is not None, "export service must expose the duplicate-export guard"

    key = (18, "US", "2026-02", False)
    with guard(key), pytest.raises(HTTPException) as error, guard(key):
        pass

    assert error.value.status_code == 409

    # The failed duplicate attempt must not poison the registry forever.
    with guard(key):
        pass


def test_accounting_export_guard_serializes_different_reports():
    """A second workbook cannot compete for CPU with the active one."""
    guard = export_service._accounting_export_guard
    first_key = (18, "US", "2026-02", False)
    second_key = (19, "DE", "2026-02", False)

    with guard(first_key), pytest.raises(HTTPException) as error, guard(second_key):
        pass

    assert error.value.status_code == 429


def test_accounting_export_guard_releases_after_builder_exception():
    """An aborted workbook build must release its key for a later retry."""
    guard = export_service._accounting_export_guard
    key = (18, "US", "2026-02", False)

    with pytest.raises(RuntimeError, match="builder failed"), guard(key):
        raise RuntimeError("builder failed")

    with guard(key):
        pass


def test_public_accounting_export_rejects_a_concurrent_duplicate(monkeypatch):
    """The public export function must apply the guard around the builder."""
    started = Event()
    release = Event()

    def fake_build(*args, **kwargs):
        started.set()
        assert release.wait(timeout=2)
        return "report.xlsx", b"xlsx"

    monkeypatch.setattr(
        export_service,
        "_build_financial_accounting_detail_workbook",
        fake_build,
    )

    result: list[tuple[str, bytes]] = []

    def run_export():
        result.append(
            export_service.export_financial_accounting_detail_workbook(
                object(),
                project_id=18,
                country="US",
                report_month="2026-02",
            )
        )

    worker = Thread(target=run_export)
    worker.start()
    try:
        assert started.wait(timeout=2)

        with pytest.raises(HTTPException) as error:
            export_service.export_financial_accounting_detail_workbook(
                object(),
                project_id=18,
                country="US",
                report_month="2026-02",
            )

        assert error.value.status_code == 409
    finally:
        release.set()
        worker.join(timeout=2)

    assert not worker.is_alive()
    assert result == [("report.xlsx", b"xlsx")]
