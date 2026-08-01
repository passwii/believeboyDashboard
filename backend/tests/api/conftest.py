"""Shared fixtures for ``tests/api`` (BEL-377 external API security).

The external-API feature flags live on the lru-cached ``Settings`` singleton
and the slowapi limiter keeps in-memory state for the whole process, so both
leak across tests unless reset. The autouse fixture below snapshots the flags
and clears the limiter before/after every test in this package — tests are
then free to mutate ``get_settings()`` directly.
"""

from __future__ import annotations

import pytest

_EXTERNAL_FLAGS = (
    "external_api_require_auth",
    "external_api_allow_skip_auth",
    "external_api_rate_limit_enabled",
    "external_api_rate_limit",
    "external_api_audit_enabled",
    "external_api_audit_retention_days",
)


@pytest.fixture(autouse=True)
def _restore_external_state():
    from app.api.external_security import external_limiter
    from app.core.config import get_settings

    settings = get_settings()
    snapshot = {name: getattr(settings, name) for name in _EXTERNAL_FLAGS}
    try:
        external_limiter.reset()
    except Exception:  # noqa: BLE001 — reset is best-effort
        pass
    yield
    for name, value in snapshot.items():
        setattr(settings, name, value)
    try:
        external_limiter.reset()
    except Exception:  # noqa: BLE001
        pass


@pytest.fixture
def make_api_key():
    """Factory: create a committed DB key; clean up afterwards.

    The auth path opens its own session, so the key must be committed (not
    rolled back) to be visible to it.
    """
    from app.db.session import SessionLocal
    from app.models.external_api_key import ExternalApiKey
    from app.services.external import api_key_service

    created_ids: list[int] = []

    def _make(
        *,
        label: str = "test-key",
        expires_at=None,
        revoked: bool = False,
    ) -> dict:
        db = SessionLocal()
        try:
            record, plaintext = api_key_service.create_api_key(
                db, label=label, created_by="pytest", expires_at=expires_at
            )
            if revoked:
                record.is_revoked = True
            db.commit()
            created_ids.append(record.id)
            return {"id": record.id, "plaintext": plaintext}
        finally:
            db.close()

    yield _make

    db = SessionLocal()
    try:
        for key_id in created_ids:
            obj = db.get(ExternalApiKey, key_id)
            if obj is not None:
                db.delete(obj)
        db.commit()
    finally:
        db.close()
