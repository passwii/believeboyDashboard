"""Private, calculation-only monthly report artifacts.

This module never prepares a Job or a formal MonthlyReport. Authorization,
resource ownership, expiry and confirmation belong to its caller. Artifact
paths and hashes are trusted server metadata, never client-supplied values.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import shutil
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from app.tasks.scripts import monthly_report

logger = logging.getLogger(__name__)
CALCULATION_VERSION = 1


class PreviewIntegrityError(ValueError):
    """An input or draft no longer matches its trusted server metadata."""


@dataclass(frozen=True)
class PreviewArtifacts:
    payload_path: Path
    payload_sha256: str
    workbook_path: Path
    workbook_sha256: str
    input_sha256: str
    calculation_version: int = CALCULATION_VERSION


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_value(value: Any) -> Any:
    """Keep finance exact; reject unsupported and nonfinite values."""
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Nonfinite preview value")
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Nonfinite preview value")
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise ValueError("Unsupported preview value")


def build_preview(
    *,
    transaction_path: Path,
    output_dir: Path,
    project_name: str,
    country: str,
    report_month: str,
    expected_input_sha256: str,
) -> PreviewArtifacts:
    """Compute a new private draft; remove only our new directory on failure.

    Inputs must already have passed upload validation. The caller must keep
    uploads immutable and provide a unique build directory. PDF is deliberately
    absent: it is an optional attachment and not a calculation input.
    """
    try:
        input_hash = _file_sha256(transaction_path)
    except OSError as exc:
        raise PreviewIntegrityError("Preview input unavailable") from exc
    if input_hash != expected_input_sha256:
        raise PreviewIntegrityError("Preview input changed")

    # Exclusivity is important: failed retries must never remove older results.
    output_dir = output_dir.resolve()
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    try:
        result = monthly_report.run(str(transaction_path), str(output_dir), {
            "project_name": project_name, "country": country,
            "report_month": report_month,
        })
        if _file_sha256(transaction_path) != input_hash:
            raise PreviewIntegrityError("Preview input changed")
        workbook_path = Path(result["result_path"]).resolve()
        if workbook_path.parent != output_dir or not workbook_path.is_file():
            raise PreviewIntegrityError("Preview workbook outside build directory")
        workbook_path.chmod(0o600)
        # Do not serialize a server path. Readers use the trusted artifact path.
        payload = {
            "calculation_version": CALCULATION_VERSION,
            "input_sha256": input_hash,
            "result": _json_value({k: v for k, v in result.items() if k != "result_path"}),
        }
        payload_path = output_dir / "preview.json"
        with payload_path.open("x", encoding="utf-8") as stream:
            payload_path.chmod(0o600)
            json.dump(payload, stream, ensure_ascii=False, allow_nan=False, sort_keys=True)
        artifacts = PreviewArtifacts(
            payload_path=payload_path,
            payload_sha256=_file_sha256(payload_path),
            workbook_path=workbook_path,
            workbook_sha256=_file_sha256(workbook_path),
            input_sha256=input_hash,
        )
        load_preview(artifacts)
        return artifacts
    except BaseException:
        # Includes worker soft timeouts; only the exclusively-created directory.
        try:
            shutil.rmtree(output_dir)
        except OSError:
            # Preserve the calculation/timeout failure; the lifecycle janitor
            # must retry cleanup of the abandoned private build directory.
            logger.exception("Failed to clean monthly report preview")
        raise


def load_preview(artifacts: PreviewArtifacts) -> dict[str, Any]:
    """Verify immutable artifacts and restore exact PT3/PT4 Decimal values.

    Does not recompute or persist anything. Expiry, permission and current
    report preconditions must be checked separately by the caller.
    """
    try:
        raw = artifacts.payload_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != artifacts.payload_sha256:
            raise PreviewIntegrityError("Preview payload changed")
        if _file_sha256(artifacts.workbook_path) != artifacts.workbook_sha256:
            raise PreviewIntegrityError("Preview workbook changed")
        payload = json.loads(raw)
        if (
            artifacts.calculation_version != CALCULATION_VERSION
            or payload["calculation_version"] != artifacts.calculation_version
            or payload["input_sha256"] != artifacts.input_sha256
        ):
            raise PreviewIntegrityError("Preview metadata mismatch")
        result = payload["result"]
        if not isinstance(result, dict) or not isinstance(result["transactions"], list):
            raise PreviewIntegrityError("Invalid preview transactions")
        if not all(isinstance(row, dict) for row in result["transactions"]):
            raise PreviewIntegrityError("Invalid preview transaction row")
        for name in ("pt3", "pt4"):
            if not isinstance(result[name], dict) or not result[name]:
                raise PreviewIntegrityError("Invalid preview calculation")
            metrics = {}
            for key, value in result[name].items():
                # Our writer uses strings for Decimal, never float conversion.
                if not isinstance(value, str):
                    raise PreviewIntegrityError("Invalid preview metric type")
                number = Decimal(value)
                if not number.is_finite():
                    raise PreviewIntegrityError("Invalid preview metric")
                metrics[key] = number
            result[name] = metrics
        result["result_path"] = str(artifacts.workbook_path)
        return result
    except (OSError, ValueError, TypeError, KeyError, InvalidOperation) as exc:
        raise PreviewIntegrityError("Preview artifacts invalid or unavailable") from exc
