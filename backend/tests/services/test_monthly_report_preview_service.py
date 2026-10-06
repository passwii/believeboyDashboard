"""Pure calculation boundary: no Job or formal report may be created."""
from __future__ import annotations

import csv
import hashlib
import json
from decimal import Decimal
from pathlib import Path

import pytest
from openpyxl import load_workbook


@pytest.fixture
def transaction_csv(tmp_path):
    path = tmp_path / "transactions.csv"
    row = {
        "date/time": "Oct 1, 2026 12:00:00 PM UTC", "type": "Order",
        "sku": "SKU-1", "quantity": "1", "fulfillment": "Amazon",
        "product sales": "12.34", "shipping credits": "0",
        "promotional rebates": "0", "other": "0", "selling fees": "-1.23",
        "fba fees": "-2.34", "total": "8.77", "marketplace": "amazon.com",
    }
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(row))
        writer.writeheader()
        writer.writerow(row)
    return path


def _hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _build(path, output):
    from app.services.monthly_report_preview_service import build_preview

    return build_preview(
        transaction_path=path, output_dir=output,
        project_name="Preview project", country="US", report_month="2026-10",
        expected_input_sha256=_hash(path),
    )


def test_build_uses_real_kernel_without_database(transaction_csv, tmp_path, monkeypatch):
    from sqlalchemy.orm import Session

    def forbidden(*args, **kwargs):
        pytest.fail("preview must not construct a database session")

    monkeypatch.setattr(Session, "__init__", forbidden)
    artifacts = _build(transaction_csv, tmp_path / "draft")
    from app.services.monthly_report_preview_service import load_preview

    result = load_preview(artifacts)
    assert result["pt3"]["income_total"] == Decimal("12.34")
    assert result["pt4"]["amazon_pay_back"] == Decimal("8.77")
    assert len(result["transactions"]) == 1
    assert artifacts.input_sha256 == _hash(transaction_csv)
    assert artifacts.calculation_version == 1
    workbook = load_workbook(artifacts.workbook_path)
    assert "报表核算" in workbook.sheetnames
    assert workbook["总览草稿"].cell(2, 13).value == "8.77"
    workbook.close()
    assert _hash(artifacts.payload_path) == artifacts.payload_sha256
    assert _hash(artifacts.workbook_path) == artifacts.workbook_sha256


def test_preview_matches_existing_kernel(transaction_csv, tmp_path):
    from app.tasks.scripts.monthly_report import run
    from app.services.monthly_report_preview_service import load_preview

    baseline = run(str(transaction_csv), str(tmp_path / "baseline"), {
        "project_name": "Preview project", "country": "US", "report_month": "2026-10",
    })
    result = load_preview(_build(transaction_csv, tmp_path / "draft"))
    assert result["pt3"] == baseline["pt3"]
    assert result["pt4"] == baseline["pt4"]
    assert result["transactions"] == baseline["transactions"]


def test_financial_json_roundtrip_preserves_decimal(transaction_csv, tmp_path):
    from app.services.monthly_report_preview_service import load_preview

    artifacts = _build(transaction_csv, tmp_path / "draft")
    serialized = json.loads(artifacts.payload_path.read_text())
    assert serialized["result"]["pt3"]["income_total"] == "12.34"
    assert isinstance(load_preview(artifacts)["pt3"]["income_total"], Decimal)
    assert not artifacts.payload_path.stat().st_mode & 0o077


def test_bad_input_hash_creates_no_output(transaction_csv, tmp_path):
    from app.services.monthly_report_preview_service import build_preview, PreviewIntegrityError

    output = tmp_path / "draft"
    with pytest.raises(PreviewIntegrityError):
        build_preview(transaction_path=transaction_csv, output_dir=output,
                      project_name="X", country="US", report_month="2026-10",
                      expected_input_sha256="0" * 64)
    assert not output.exists()


def test_changed_input_during_calculation_is_rejected(transaction_csv, tmp_path, monkeypatch):
    from app.services import monthly_report_preview_service as service

    original = service.monthly_report.run

    def change_input(*args, **kwargs):
        result = original(*args, **kwargs)
        transaction_csv.write_text("changed")
        return result

    monkeypatch.setattr(service.monthly_report, "run", change_input)
    with pytest.raises(service.PreviewIntegrityError):
        _build(transaction_csv, tmp_path / "draft")
    assert not (tmp_path / "draft").exists()


def test_kernel_failure_removes_only_new_directory(transaction_csv, tmp_path, monkeypatch):
    from app.services import monthly_report_preview_service as service

    other = tmp_path / "other"
    other.mkdir()
    (other / "keep").write_text("keep")

    def fail(*args, **kwargs):
        raise ValueError("calculation failed")

    monkeypatch.setattr(service.monthly_report, "run", fail)
    with pytest.raises(ValueError, match="calculation failed"):
        _build(transaction_csv, tmp_path / "draft")
    assert not (tmp_path / "draft").exists()
    assert (other / "keep").read_text() == "keep"


def test_existing_output_is_never_overwritten(transaction_csv, tmp_path):
    output = tmp_path / "draft"
    output.mkdir()
    (output / "keep").write_text("existing")
    with pytest.raises(FileExistsError):
        _build(transaction_csv, output)
    assert (output / "keep").read_text() == "existing"


@pytest.mark.parametrize("name", ["payload_path", "workbook_path"])
def test_tampered_artifact_is_rejected(transaction_csv, tmp_path, name):
    from app.services.monthly_report_preview_service import load_preview, PreviewIntegrityError

    artifacts = _build(transaction_csv, tmp_path / "draft")
    getattr(artifacts, name).write_bytes(b"tampered")
    with pytest.raises(PreviewIntegrityError):
        load_preview(artifacts)


@pytest.mark.parametrize("name", ["payload_path", "workbook_path"])
def test_missing_artifact_is_rejected(transaction_csv, tmp_path, name):
    from app.services.monthly_report_preview_service import load_preview, PreviewIntegrityError

    artifacts = _build(transaction_csv, tmp_path / "draft")
    getattr(artifacts, name).unlink()
    with pytest.raises(PreviewIntegrityError):
        load_preview(artifacts)


def test_loader_ignores_serialized_result_path(transaction_csv, tmp_path):
    from dataclasses import replace
    from app.services.monthly_report_preview_service import load_preview

    artifacts = _build(transaction_csv, tmp_path / "draft")
    body = json.loads(artifacts.payload_path.read_text())
    body["result"]["result_path"] = "/arbitrary/path.xlsx"
    artifacts.payload_path.write_text(json.dumps(body))
    updated = replace(artifacts, payload_sha256=_hash(artifacts.payload_path))
    assert load_preview(updated)["result_path"] == str(artifacts.workbook_path)


def test_unsupported_payload_version_is_rejected(transaction_csv, tmp_path):
    from dataclasses import replace
    from app.services.monthly_report_preview_service import load_preview, PreviewIntegrityError

    artifacts = _build(transaction_csv, tmp_path / "draft")
    body = json.loads(artifacts.payload_path.read_text())
    body["calculation_version"] = 2
    artifacts.payload_path.write_text(json.dumps(body))
    with pytest.raises(PreviewIntegrityError):
        load_preview(replace(artifacts, payload_sha256=_hash(artifacts.payload_path)))


def test_nonfinite_value_fails_closed_and_cleans_output(transaction_csv, tmp_path, monkeypatch):
    from app.services import monthly_report_preview_service as service

    original = service.monthly_report.run

    def nonfinite(*args, **kwargs):
        result = original(*args, **kwargs)
        result["pt3"]["income_total"] = Decimal("NaN")
        return result

    monkeypatch.setattr(service.monthly_report, "run", nonfinite)
    with pytest.raises(ValueError):
        _build(transaction_csv, tmp_path / "draft")
    assert not (tmp_path / "draft").exists()


@pytest.mark.parametrize("body", ["not json", "[]", '{"result": {}}'])
def test_invalid_payload_is_rejected(transaction_csv, tmp_path, body):
    from dataclasses import replace
    from app.services.monthly_report_preview_service import load_preview, PreviewIntegrityError

    artifacts = _build(transaction_csv, tmp_path / "draft")
    artifacts.payload_path.write_text(body)
    with pytest.raises(PreviewIntegrityError):
        load_preview(replace(artifacts, payload_sha256=_hash(artifacts.payload_path)))


@pytest.mark.parametrize("section,value", [
    ("transactions", [1]), ("pt3", []), ("pt3", {}),
    ("pt3", {"income_total": "NaN"}), ("pt4", {"amazon_pay_back": 1.1}),
])
def test_invalid_structure_is_rejected(transaction_csv, tmp_path, section, value):
    from dataclasses import replace
    from app.services.monthly_report_preview_service import load_preview, PreviewIntegrityError

    artifacts = _build(transaction_csv, tmp_path / "draft")
    body = json.loads(artifacts.payload_path.read_text())
    body["result"][section] = value
    artifacts.payload_path.write_text(json.dumps(body))
    with pytest.raises(PreviewIntegrityError):
        load_preview(replace(artifacts, payload_sha256=_hash(artifacts.payload_path)))


def test_missing_input_fails_before_output_created(tmp_path):
    from app.services.monthly_report_preview_service import build_preview, PreviewIntegrityError

    with pytest.raises(PreviewIntegrityError):
        build_preview(transaction_path=tmp_path / "missing.csv", output_dir=tmp_path / "draft",
                      project_name="X", country="US", report_month="2026-10",
                      expected_input_sha256="0" * 64)
    assert not (tmp_path / "draft").exists()
