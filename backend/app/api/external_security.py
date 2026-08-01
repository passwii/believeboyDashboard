"""Application-layer security for the ``/api/v1/external/*`` namespace (BEL-377).

Two router-level dependencies live here:

* :func:`require_external_api_key` — validates the caller. During the
  rollout it is a no-op unless ``external_api_require_auth`` is on, so
  deploying the code never breaks existing consumers. Accepted credentials,
  in precedence order: ``?skip_auth=true`` (transition bypass), the master
  ``settings.api_key`` (backward compat), then a DB-issued key from
  ``external_api_keys``.
* :func:`require_external_rate_limit` — slowapi per-key (per-IP fallback)
  limiting, gated by ``external_api_rate_limit_enabled``.

The authenticated key id is stashed on ``request.state`` so the rate-limit
key function and the audit middleware can reuse it without re-parsing.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import Settings, get_settings
from app.db.session import SessionLocal
from app.services.external import api_key_service

logger = logging.getLogger(__name__)


@dataclass
class ExternalKeyContext:
    """Resolved credential for one external request."""

    key_id: int | None = None
    label: str | None = None
    # "db" (external_api_keys row) | "master" (settings.api_key) |
    # "skip" (?skip_auth=true) | "none" (anonymous / unauthenticated).
    source: str = "none"


def extract_candidates(request: Request) -> list[str]:
    """Collect credential candidates from a request.

    Mirrors ``app.core.security.require_api_key``: ``Authorization: Bearer``,
    ``X-API-Key`` header, and the ``?api_key=`` query fallback (Vercel edge
    strips auth headers but preserves query params).
    """
    candidates: list[str] = []
    authorization = request.headers.get("authorization")
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[len("Bearer ") :].strip()
        if token:
            candidates.append(token)
    x_api_key = request.headers.get("x-api-key")
    if x_api_key:
        candidates.append(x_api_key)
    api_key = request.query_params.get("api_key")
    if api_key:
        candidates.append(api_key)
    return candidates


def _stash(request: Request, ctx: ExternalKeyContext) -> None:
    request.state.external_key_context = ctx
    request.state.external_api_key_id = ctx.key_id


def require_external_api_key(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> ExternalKeyContext:
    """Validate the external-API caller (see module docstring)."""
    candidates = extract_candidates(request)
    skip_requested = (request.query_params.get("skip_auth") or "").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    # 1) Transition bypass — honoured while `external_api_allow_skip_auth`.
    if skip_requested and settings.external_api_allow_skip_auth:
        ctx = ExternalKeyContext(source="skip")
        _stash(request, ctx)
        return ctx

    # 2) Master key backward-compat (the P0 shared secret).
    if candidates and settings.api_key in candidates:
        ctx = ExternalKeyContext(source="master")
        _stash(request, ctx)
        return ctx

    # 3) DB-issued keys.
    verdict = None
    if candidates:
        db = SessionLocal()
        try:
            verdict = api_key_service.resolve_key(db, candidates)
            if verdict.ok:
                db.commit()
                ctx = ExternalKeyContext(
                    key_id=verdict.key.id,
                    label=verdict.key.label,
                    source="db",
                )
                _stash(request, ctx)
                return ctx
            db.rollback()
        except Exception:  # noqa: BLE001 — fail closed on unexpected DB error
            logger.exception("external API key resolution failed")
            db.rollback()
            verdict = None
        finally:
            db.close()

    # Not enforcing → preserve P0 behaviour (allow through, best-effort ctx).
    if not settings.external_api_require_auth:
        ctx = ExternalKeyContext(source="none")
        _stash(request, ctx)
        return ctx

    # Enforcing → precise 401s.
    if verdict is not None and verdict.status == "expired":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="API key expired"
        )
    if candidates:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key"
        )
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing API key"
    )


def get_api_key_or_ip(request: Request) -> str:
    """Rate-limit key: validated DB key id, else client IP.

    Falls back to IP for master-key / skip / anonymous traffic (the
    transition period) so a single shared secret can't exhaust one bucket
    for everyone, yet unauthenticated callers are still bounded per IP.
    """
    key_id = getattr(request.state, "external_api_key_id", None)
    if key_id:
        return f"apikey:{key_id}"
    return get_remote_address(request)


# In-memory storage (no storage_uri) — matches the existing limiters in
# ``main.py`` / ``page_render.py`` and needs no Redis, so it fails open
# trivially and works in tests. The gateway IP allowlist is the backstop.
external_limiter = Limiter(key_func=get_api_key_or_ip, default_limits=[])


def _rate_limit_exempt() -> bool:
    return not get_settings().external_api_rate_limit_enabled


def _rate_limit_value() -> str:
    return get_settings().external_api_rate_limit


@external_limiter.limit(_rate_limit_value, exempt_when=_rate_limit_exempt)
def require_external_rate_limit(
    request: Request,  # required by slowapi's @limiter.limit
    _ctx: ExternalKeyContext = Depends(require_external_api_key),
) -> None:
    """Router-level rate limit; pulls in auth via its own dependency.

    slowapi raises ``RateLimitExceeded`` on breach, which ``main.py``'s
    registered handler turns into a 429 JSON response.
    """
    return None
