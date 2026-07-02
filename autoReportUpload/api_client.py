"""HTTP client for the autoReportUpload FastAPI ingest endpoints.

Replaces the direct SQLAlchemy session usage. Talks to the backend over
HTTPS (or HTTP on the internal VPS network) using the
``X-Internal-Token`` header.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)


class IngestError(Exception):
    """Raised when the backend returns 4xx/5xx for an ingest call."""


class APIClient:
    """Thin wrapper over ``requests.Session`` for the internal ingest API."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout_seconds: int = 60,
        max_retries: int = 3,
        retry_backoff_seconds: float = 2.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout_seconds
        self.max_retries = max_retries
        self.retry_backoff = retry_backoff_seconds
        self.session = requests.Session()
        self.session.headers.update(
            {
                "X-Internal-Token": self.token,
                "Content-Type": "application/json",
                "User-Agent": "autoReportUpload/1.0",
            }
        )

    def _request(self, method: str, path: str, json_body: dict[str, Any]) -> dict:
        url = f"{self.base_url}{path}"
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                resp = self.session.request(
                    method, url, json=json_body, timeout=self.timeout
                )
            except requests.RequestException as exc:
                last_exc = exc
                logger.warning(
                    f"[API] {method} {path} 第 {attempt}/{self.max_retries} 次网络错误: {exc}"
                )
                if attempt < self.max_retries:
                    time.sleep(self.retry_backoff * (2 ** (attempt - 1)))
                continue

            if resp.status_code >= 500:
                logger.warning(
                    f"[API] {method} {path} 第 {attempt}/{self.max_retries} 次 5xx: "
                    f"{resp.status_code} body={resp.text[:300]}"
                )
                last_exc = IngestError(f"5xx: {resp.text[:200]}")
                if attempt < self.max_retries:
                    time.sleep(self.retry_backoff * (2 ** (attempt - 1)))
                continue

            if resp.status_code >= 400:
                raise IngestError(
                    f"{method} {path} → {resp.status_code}: {resp.text[:500]}"
                )

            return resp.json()

        raise IngestError(
            f"{method} {path} 重试 {self.max_retries} 次仍失败: {last_exc}"
        )

    def recognize(
        self,
        *,
        folder_name: str,
        original_filename: str,
        country: str,
        report_type: str,
        matched_columns: list[str],
        row_count_preview: int,
        detected_date: str | None = None,
        detected_start_date: str | None = None,
        detected_end_date: str | None = None,
        warnings: list[str] | None = None,
    ) -> dict:
        return self._request(
            "POST",
            "/api/v1/internal/auto-report/recognize",
            {
                "folder_name": folder_name,
                "original_filename": original_filename,
                "country": country,
                "report_type": report_type,
                "matched_columns": matched_columns,
                "row_count_preview": row_count_preview,
                "detected_date": detected_date,
                "detected_start_date": detected_start_date,
                "detected_end_date": detected_end_date,
                "warnings": warnings or [],
            },
        )

    def ingest(
        self,
        *,
        report_type: str,
        project_id: int,
        country: str,
        original_filename: str,
        file_sha256: str,
        file_size_bytes: int,
        local_file_path: str,
        matched_columns: list[str],
        warnings: list[str],
        report_label: str,
        report_date: str | None,
        scopes: list[dict],
        operator: str = "autoReportUpload",
    ) -> dict:
        return self._request(
            "POST",
            "/api/v1/internal/auto-report/ingest",
            {
                "report_type": report_type,
                "project_id": project_id,
                "country": country,
                "original_filename": original_filename,
                "file_sha256": file_sha256,
                "file_size_bytes": file_size_bytes,
                "local_file_path": local_file_path,
                "matched_columns": matched_columns,
                "warnings": warnings,
                "report_label": report_label,
                "report_date": report_date,
                "scopes": scopes,
                "operator": operator,
            },
        )

    def heartbeat(
        self,
        *,
        instance_id: str,
        last_run_ts: str,
        last_status: str,
        detail: str = "",
        operator: str = "autoReportUpload",
    ) -> dict:
        return self._request(
            "POST",
            "/api/v1/internal/auto-report/heartbeat",
            {
                "instance_id": instance_id,
                "last_run_ts": last_run_ts,
                "last_status": last_status,
                "detail": detail,
                "operator": operator,
            },
        )
