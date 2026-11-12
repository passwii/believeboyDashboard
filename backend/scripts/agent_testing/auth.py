"""Robust Playwright authentication for the seeded test accounts.

The previous E2E login filled the NextAuth login form via UI selectors
(``#email`` / ``#password`` / "立即登录"), which was brittle and a frequent
source of flaky failures. This module performs the standard NextAuth v4
*credentials* sign-in over the REST API and persists the resulting session
as a Playwright ``storage_state``, so:

  * login is selector-free and deterministic (no UI waits / selectors);
  * the session is reused across tests — login happens once per role;
  * an expired / refreshed session is transparently re-established.

Prerequisites (the test DB + accounts must exist):
  * backend started with ``TEST_DATABASE_URL`` pointing at the test DB;
  * ``cd backend-go && go run ./cmd/setuptestdb`` has seeded the test accounts;
  * the frontend is running (``FRONTEND_URL``) and proxies to that backend;
  * ``TEST_ADMIN_PASSWORD`` / ``TEST_OPERATOR_PASSWORD`` /
    ``TEST_BUSINESSDEV_PASSWORD`` are set (e.g. in ``backend/.env.test``).

Usage (in a Playwright test that already receives the ``page`` fixture):

    from scripts.agent_testing.auth import login_as

    def test_x(page):
        login_as(page, "admin")                 # logs in (or reuses cached session)
        page.goto(f"{FRONTEND_URL}/dashboard/...")
        # ... assert ...

Standalone authenticated context (e.g. for API-only checks):

    from scripts.agent_testing.auth import get_authed_page

    page = get_authed_page(browser, "operator")
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page

from scripts.agent_testing.conftest import FRONTEND_URL, TEST_ACCOUNTS

# Cached sessions live here (gitignored). Set AGENT_TEST_REFRESH_AUTH=1 to
# force a fresh login and discard all cached sessions.
AUTH_DIR = Path(__file__).resolve().parent / ".auth"
AUTH_DIR.mkdir(parents=True, exist_ok=True)
REFRESH = os.environ.get("AGENT_TEST_REFRESH_AUTH") == "1"

_SESSION_COOKIE_NAMES = ("next-auth.session-token", "__Secure-next-auth.session-token")


def _state_path(role: str) -> Path:
    return AUTH_DIR / f"{role}.json"


def _role_by_email(email: str) -> str:
    target = email.strip().lower()
    for role, cfg in TEST_ACCOUNTS.items():
        if cfg["email"].strip().lower() == target:
            return role
    raise RuntimeError(f"No seeded test account matches email {email!r}.")


def login_via_nextauth(context: BrowserContext, role: str) -> None:
    """Sign ``role`` in via the NextAuth credentials REST flow (no UI)."""
    cfg = TEST_ACCOUNTS[role]
    base = FRONTEND_URL.rstrip("/")
    req = context.request

    csrf = req.get(f"{base}/api/auth/csrf")
    csrf_token = (csrf.json() or {}).get("csrfToken")
    if not csrf_token:
        raise RuntimeError(
            f"NextAuth CSRF fetch failed for {role}: {csrf.status} {csrf.text[:200]}"
        )

    resp = req.post(
        f"{base}/api/auth/callback/credentials",
        data={
            "csrfToken": csrf_token,
            "email": cfg["email"],
            "password": cfg["password"],
            "json": "true",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    # NextAuth returns 200 + {url:...} on success (json=true), or 302 redirect.
    if resp.status not in (200, 302):
        raise RuntimeError(
            f"NextAuth credentials login failed for {role}: "
            f"{resp.status} {resp.text[:200]}"
        )
    if not _has_session(context):
        raise RuntimeError(
            f"NextAuth login for {role} did not establish a session cookie."
        )


def _has_session(context: BrowserContext) -> bool:
    return any(c["name"] in _SESSION_COOKIE_NAMES for c in context.cookies())


def _session_valid(context: BrowserContext) -> bool:
    try:
        resp = context.request.get(f"{FRONTEND_URL}/api/auth/session")
        data = resp.json()
    except Exception:
        return False
    return bool(data and data.get("user", {}).get("id"))


def _load_cookies(role: str) -> list[dict] | None:
    path = _state_path(role)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("cookies")
    except Exception:
        return None


def _save_cookies(context: BrowserContext, role: str) -> None:
    state = context.storage_state()
    _state_path(role).write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def login_as(page: Page, *ident) -> None:
    """Log a test account into ``page.context``.

    ``ident`` is either a role key (``"admin"`` / ``"operator"`` /
    ``"businessdev"``) or the legacy ``(email, password)`` pair. Reuses a
    cached session when valid, otherwise performs the API login and caches it.
    """
    if len(ident) == 2 and "@" in str(ident[0]):
        role = _role_by_email(ident[0])
    else:
        role = ident[0]

    context = page.context
    if not REFRESH:
        cached = _load_cookies(role)
        if cached:
            context.add_cookies(cached)
            if _session_valid(context):
                return
    login_via_nextauth(context, role)
    _save_cookies(context, role)


def get_authed_context(browser: Browser, role: str, *, refresh: bool = False) -> BrowserContext:
    """Return a fresh context already authenticated as ``role`` (cached)."""
    context = browser.new_context()
    if not (refresh or REFRESH):
        cached = _load_cookies(role)
        if cached:
            context.add_cookies(cached)
            if _session_valid(context):
                return context
    login_via_nextauth(context, role)
    _save_cookies(context, role)
    return context


def get_authed_page(browser: Browser, role: str, *, refresh: bool = False) -> Page:
    """Return a ``Page`` on a context authenticated as ``role``."""
    return get_authed_context(browser, role, refresh=refresh).new_page()
