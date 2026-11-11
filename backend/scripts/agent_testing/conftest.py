"""Shared fixtures for agent testing (Playwright E2E against the test DB).

End-to-end flow (all defined in this repo, so AI agents can self-serve):

  1. One-time: build the dedicated test database + seed the test accounts
     (admin / operator / businessdev). See ``scripts/setup_test_db.py``
     (it clones the dev schema via pg_dump and seeds the accounts). The
     accounts and their passwords come from ``backend/.env.test``
     (TEST_ADMIN_EMAIL / TEST_*_PASSWORD, etc.).
  2. Start the backend with ``TEST_DATABASE_URL`` pointing at that DB, and
     the frontend (FRONTEND_URL) proxying to it.
  3. Write tests that call ``login_as(page, "admin" | "operator" |
     "businessdev")`` (from ``scripts.agent_testing.auth``). That helper
     performs a selector-free NextAuth credentials sign-in over the REST
     API and reuses a cached Playwright session per role — no brittle UI
     login. See ``auth.py`` / README.md for details.

``TEST_ACCOUNTS`` below holds the test-account credentials; passwords are
required from env (never hardcoded).
"""

import os
import sys
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

# Add backend root to path so we can import app modules
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8000")
BACKEND_API_BASE = f"{BACKEND_URL}/api/v1"


def _require(name: str) -> str:
    val = os.getenv(name)
    if not val:
        raise RuntimeError(
            f"Missing required env var {name}. Set it before running agent tests "
            "(e.g. in backend/.env, never commit real credentials)."
        )
    return val


# Test accounts — credentials MUST come from env, never hardcoded.
# Defaults point at the dedicated test-database accounts seeded by
# `backend-go/cmd/seedtestaccounts` (run `scripts/setup_test_db.py` once). To
# exercise these E2E tests against the test DB, start the backend with
# TEST_DATABASE_URL set to that DB and seed the accounts there.
#
# `user` is OPTIONAL: only included when both TEST_USER_EMAIL and
# TEST_USER_PASSWORD are set in backend/.env.test. This lets frontend
# Playwright E2E (frontend/tests/helpers/auth.ts) reuse a real account
# when the dev backend has it, without forcing every Python test to
# require those env vars. See docs/E2E-TESTING.md.
TEST_ACCOUNTS: dict[str, dict[str, str]] = {
    "admin": {
        "email": os.getenv("TEST_ADMIN_EMAIL", "test_admin@believeboy.com"),
        "password": _require("TEST_ADMIN_PASSWORD"),
    },
    "operator": {
        "email": os.getenv("TEST_OPERATOR_EMAIL", "test_operator@believeboy.com"),
        "password": _require("TEST_OPERATOR_PASSWORD"),
    },
    "businessdev": {
        "email": os.getenv("TEST_BUSINESSDEV_EMAIL", "test_businessdev@believeboy.com"),
        "password": _require("TEST_BUSINESSDEV_PASSWORD"),
    },
}
_user_email = os.getenv("TEST_USER_EMAIL")
_user_password = os.getenv("TEST_USER_PASSWORD")
if _user_email and _user_password:
    TEST_ACCOUNTS["user"] = {"email": _user_email, "password": _user_password}


@pytest.fixture(scope="session")
def browser():
    """Launch a single Chromium browser for the entire test session."""
    pw = sync_playwright().start()
    b = pw.chromium.launch(headless=True)
    yield b
    b.close()
    pw.stop()


@pytest.fixture(scope="function")
def page(browser):
    """Create a new browser context and page for each test."""
    context = browser.new_context()
    page = context.new_page()
    yield page
    context.close()


@pytest.fixture(scope="module")
def frontend_url():
    return FRONTEND_URL


@pytest.fixture(scope="module")
def backend_api_base():
    return BACKEND_API_BASE
