"""Root pytest fixtures for the dedicated test database.

This conftest makes the whole ``backend/tests`` suite run against the
dedicated test Postgres database (BEL: test isolation) instead of the dev/prod
DB. It:

  * loads ``backend/.env.test`` (gitignored) so ``TEST_DATABASE_URL`` and the
    test-account passwords are available without exporting them each run;
  * skips DB-touching tests when ``TEST_DATABASE_URL`` is not set, so we never
    silently run against the dev/prod database;
  * exposes `db_session` (rolled back per test) and fixtures for the seeded
    test accounts (admin / operator / businessdev) plus ready-made auth headers.

The target DB is configured once via `backend-go/cmd/setuptestdb` and is
persistent — it is NOT dropped/recreated per run.
"""
from __future__ import annotations

import os
import base64
import sys
from pathlib import Path
from typing import Iterator

import pytest
from sqlalchemy import make_url, text
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]  # backend/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_env_test() -> None:
    """Load ``backend/.env.test`` so the test DB URL is available.

    ``.env.test`` is gitignored; it holds ``TEST_DATABASE_URL`` and the
    ``TEST_*_PASSWORD`` values. Loading it here (before importing ``app``)
    means the SQLAlchemy engine built in ``app.db.session`` resolves to the
    test database with no shell exports required.
    """
    env_path = ROOT / ".env.test"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_env_test()


def _test_database_url_from_fallback(database_url: str | None) -> str | None:
    """Promote ``DATABASE_URL`` only when it is explicitly the local BLF_test DB."""
    if not database_url:
        return None
    try:
        database = make_url(database_url).database
    except Exception:  # noqa: BLE001 - malformed config must fail closed
        return None
    return database_url if (database or "").casefold() == "blf_test" else None


# Older local .env.test files only define DATABASE_URL. Promote that value only
# after checking the DB name; dev/prod URLs must continue to trigger the guard.
if not os.environ.get("TEST_DATABASE_URL"):
    fallback_test_url = _test_database_url_from_fallback(
        os.environ.get("DATABASE_URL")
    )
    if fallback_test_url:
        os.environ["TEST_DATABASE_URL"] = fallback_test_url

# Known before importing app (engine is built from get_settings() at import).
HAS_TEST_DATABASE = bool(os.environ.get("TEST_DATABASE_URL"))


def _require_test_database() -> None:
    """Skip DB-touching tests when no dedicated test DB is configured.

    Protection mechanism, not a "no local testing" rule: the local machine
    normally has ``TEST_DATABASE_URL`` set (backend/.env.test → BLF_test),
    so this skip only fires on machines without a configured test DB —
    preventing accidental writes to the dev/prod DB.
    """
    if not HAS_TEST_DATABASE:
        pytest.skip(
            "TEST_DATABASE_URL is not set — tests would hit the dev/prod DB. "
            "Run `cd backend-go && go run ./cmd/setuptestdb` (creates + migrates + seeds "
            "the test DB) and set TEST_DATABASE_URL in backend/.env.test."
        )


@pytest.fixture(scope="session")
def settings():
    """App settings — reflects TEST_DATABASE_URL override."""
    from app.core.config import get_settings

    return get_settings()


@pytest.fixture
def db_session() -> Iterator[Session]:
    """Yield a transactional session bound to the test DB; roll back at end."""
    _require_test_database()
    from app.db.session import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _fetch_account(db: Session, email: str) -> dict:
    """Fetch a seeded test account by email, failing clearly if missing."""
    row = (
        db.execute(
            text(
                """
                select id::text as id, email, name, full_name,
                       is_admin, is_active, role_type, avatar_url
                from public.user_accounts
                where lower(email) = lower(:email)
                limit 1
                """
            ),
            {"email": email},
        )
        .mappings()
        .first()
    )
    if row is None:
        pytest.fail(
            f"Test account {email!r} not found in the test DB. "
            f"Seed it with `python backend-go/cmd/seedtestaccounts`."
        )
    return dict(row)


def _auth_headers(settings, account: dict) -> dict:
    """Build the backend auth headers for a test account (header-based auth).

    Non-ASCII header values (the Chinese name) are base64-encoded, matching
    what the frontend proxy sends — `app.api.deps._decode_header_value` decodes
    it back. This keeps the httpx TestClient happy (header values must be
    latin-1) and mirrors production.
    """
    is_admin = bool(account["is_admin"])
    encoded_name = base64.b64encode(str(account["name"]).encode("utf-8")).decode("ascii")
    return {
        "X-API-Key": settings.api_key,
        "X-User-Id": str(account["id"]),
        "X-User-Email": account["email"],
        "X-User-Name": encoded_name,
        "X-Operator": encoded_name,
        "X-Is-Admin": "true" if is_admin else "false",
        "X-Role-Type": account.get("role_type") or ("admin" if is_admin else "operator"),
    }


@pytest.fixture(scope="session")
def _seed_accounts() -> dict[str, dict]:
    """Read the three seeded identities once per pytest session."""
    _require_test_database()
    from app.core.config import get_settings
    from app.db.session import SessionLocal

    settings = get_settings()
    db = SessionLocal()
    try:
        return {
            "admin": _fetch_account(db, settings.test_admin_email),
            "operator": _fetch_account(db, settings.test_operator_email),
            "businessdev": _fetch_account(db, settings.test_businessdev_email),
        }
    finally:
        db.close()


@pytest.fixture
def test_admin(_seed_accounts) -> dict:
    """The seeded test admin account (is_admin=true)."""
    return dict(_seed_accounts["admin"])


@pytest.fixture
def test_operator(_seed_accounts) -> dict:
    """The seeded test operator account (role_type=operator)."""
    return dict(_seed_accounts["operator"])


@pytest.fixture
def test_businessdev(_seed_accounts) -> dict:
    """The seeded test businessdev account (role_type=businessdev)."""
    return dict(_seed_accounts["businessdev"])


@pytest.fixture
def admin_headers(test_admin, settings) -> dict:
    return _auth_headers(settings, test_admin)


@pytest.fixture
def operator_headers(test_operator, settings) -> dict:
    return _auth_headers(settings, test_operator)


@pytest.fixture
def businessdev_headers(test_businessdev, settings) -> dict:
    return _auth_headers(settings, test_businessdev)
