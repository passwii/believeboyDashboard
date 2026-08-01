"""External API key service (BEL-377).

Credential management + verification for the ``/api/v1/external/*``
namespace. Keys are generated with ``secrets`` and stored as SHA-256
hashes; the plaintext is returned exactly once at creation.

Verification is deliberately tolerant of ordering: ``resolve_key`` returns
the first stored key whose hash matches any candidate and reports *why* it
is not usable (revoked / expired) so the caller can emit a precise 401.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.external_api_key import ExternalApiKey

# Human-friendly prefix so operators can recognise an external key in logs.
KEY_PREFIX = "bbx_"
# Bytes of randomness for the secret portion (32 → 43 url-safe chars).
KEY_SECRET_BYTES = 32


def hash_key(plaintext: str) -> str:
    """SHA-256 hex digest used for storage and lookup."""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def generate_key() -> tuple[str, str, str]:
    """Return ``(plaintext, key_hash, key_prefix)`` for a brand-new key."""
    plaintext = f"{KEY_PREFIX}{secrets.token_urlsafe(KEY_SECRET_BYTES)}"
    # Prefix shows the label-bearing head of the key without leaking the
    # secret tail (first 12 chars, e.g. ``bbx_ab12cd34``).
    return plaintext, hash_key(plaintext), plaintext[:12]


@dataclass
class KeyVerdict:
    """Outcome of matching candidate secrets against stored keys."""

    status: str  # "ok" | "expired" | "revoked" | "not_found"
    key: ExternalApiKey | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def create_api_key(
    db: Session,
    *,
    label: str,
    created_by: str,
    scope: str = "read",
    expires_at: datetime | None = None,
) -> tuple[ExternalApiKey, str]:
    """Create a key and return ``(record, plaintext)``.

    The plaintext is only available here — the stored row holds the hash.
    Caller commits.
    """
    plaintext, key_hash, key_prefix = generate_key()
    record = ExternalApiKey(
        key_hash=key_hash,
        key_prefix=key_prefix,
        label=label[:128],
        scope=scope[:64],
        expires_at=expires_at,
        created_by=created_by[:128],
    )
    db.add(record)
    db.flush()  # populate record.id before the caller commits
    return record, plaintext


def list_api_keys(db: Session) -> list[ExternalApiKey]:
    """All keys, newest first (admin list view)."""
    return list(
        db.scalars(select(ExternalApiKey).order_by(ExternalApiKey.created_at.desc()))
    )


def get_api_key(db: Session, key_id: int) -> ExternalApiKey | None:
    return db.get(ExternalApiKey, key_id)


def revoke_api_key(db: Session, key_id: int) -> ExternalApiKey | None:
    """Soft-revoke a key (idempotent). Caller commits."""
    record = db.get(ExternalApiKey, key_id)
    if record is None:
        return None
    record.is_revoked = True
    return record


def resolve_key(db: Session, candidates: list[str]) -> KeyVerdict:
    """Match candidate secrets to a stored key and classify the result.

    On a usable match the key's ``last_used_at`` is stamped (dirty on the
    session — caller commits). Revoked / expired keys are reported with
    their specific status so the API layer can return a clear 401.
    """
    if not candidates:
        return KeyVerdict(status="not_found")

    hashes = [hash_key(c) for c in candidates]
    # Deterministic precedence: earliest-created key wins if two candidates
    # happen to match (they won't in practice — hashes are unique).
    rows = list(
        db.scalars(
            select(ExternalApiKey)
            .where(ExternalApiKey.key_hash.in_(hashes))
            .order_by(ExternalApiKey.id.asc())
        )
    )
    if not rows:
        return KeyVerdict(status="not_found")

    key = rows[0]
    if key.is_revoked:
        return KeyVerdict(status="revoked", key=key)
    if key.expires_at is not None:
        expires = key.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= datetime.now(timezone.utc):
            return KeyVerdict(status="expired", key=key)

    key.last_used_at = datetime.now(timezone.utc)
    return KeyVerdict(status="ok", key=key)
