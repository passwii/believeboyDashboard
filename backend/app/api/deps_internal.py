"""Internal-only API dependencies.

The endpoints guarded by these dependencies are intended for service-to-service
calls (e.g. the autoReportUpload daemon) and are NOT exposed to the public
frontend. Authentication is a static shared secret in the
``X-Internal-Token`` header, validated against the
``INTERNAL_INGEST_TOKEN`` env var.
"""
from __future__ import annotations

from fastapi import Header, HTTPException, status

from app.core.config import Settings, get_settings


def require_internal_token(
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
    settings: Settings = None,  # type: ignore[assignment]
) -> None:
    """Verify the caller presents the configured internal token.

    Returns nothing on success; raises 401 on missing/mismatched token.
    """
    if settings is None:
        settings = get_settings()
    expected = (settings.internal_ingest_token or "").strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="INTERNAL_INGEST_TOKEN is not configured on the server",
        )
    if not x_internal_token or x_internal_token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Token",
        )
