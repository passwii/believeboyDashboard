"""One-command setup for the dedicated test database.

Builds the persistent test Postgres database targeted by ``TEST_DATABASE_URL``
and seeds the test accounts into it. After this runs once, the test suite
(pytest + E2E Playwright) and the dev backend can be pointed at the test DB
via that env var — no repeated setup required.

The schema is cloned from the source database (``DATABASE_URL``) with
``pg_dump --schema-only``. This guarantees the test DB matches the dev/prod
schema exactly without replaying the full alembic chain (the chain assumes the
bootstrap tables already exist, so a from-scratch ``alembic upgrade head`` is
not reliable). Seeding then inserts migration-owned reference data (CRM
categories and workflow templates) plus the test accounts on top.

Usage:
    cd backend && source .venv/bin/activate

    # backend/.env holds DATABASE_URL (source); backend/.env.test holds
    # TEST_DATABASE_URL + TEST_*_PASSWORD:
    python scripts/setup_test_db.py

    # Also force-reset account passwords on (re)seed:
    python scripts/setup_test_db.py --reset-password
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine, make_url

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_env_files() -> None:
    """Load backend/.env then backend/.env.test; .env.test OVERRIDES .env."""
    for name, override in ((".env", False), (".env.test", True)):
        env_path = ROOT / name
        if not env_path.exists():
            continue
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if override or key not in os.environ:
                os.environ[key] = val


def _require_test_database_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "")
    if not url:
        print(
            "setup_test_db failed: TEST_DATABASE_URL is not set.\n"
            "Add it to backend/.env.test, e.g.\n"
            "  TEST_DATABASE_URL=postgresql+psycopg://<user>:<pass>@<host>:5432/BLF_test",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return url


def _require_source_database_url() -> str:
    """The schema source — the dev/prod DATABASE_URL, not the test DB."""
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        print(
            "setup_test_db failed: DATABASE_URL (the schema source) is not set.\n"
            "It must point at the dev/prod database whose schema the test DB "
            "will clone. Set it in backend/.env or the shell.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return url


def _create_database_if_missing(test_url: str) -> None:
    """Best-effort CREATE DATABASE against the maintenance `postgres` DB.

    No-ops when the DB already exists. For managed providers (Supabase) the
    CREATE will fail — create the DB in the cloud console, then re-run.
    """
    url = make_url(test_url)
    db_name = url.database
    if not db_name:
        print("setup_test_db failed: TEST_DATABASE_URL has no database name.", file=sys.stderr)
        raise SystemExit(1)

    admin_url = url.set(database="postgres")
    print(f"[1/4] Ensuring database '{db_name}' exists (best-effort)...")
    admin_engine = None
    try:
        admin_engine = create_engine(admin_url, future=True)
        with admin_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.exec_driver_sql(f'CREATE DATABASE "{db_name}"')
        print(f"      created '{db_name}'")
    except Exception as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if "already exists" in msg:
            print(f"      '{db_name}' already exists — skipping create")
        else:
            print(
                f"      create skipped ({type(exc).__name__}: {exc}).\n"
                f"      For managed DBs (Supabase) create '{db_name}' in the cloud console, "
                f"then re-run this script.",
                file=sys.stderr,
            )
    finally:
        if admin_engine is not None:
            admin_engine.dispose()


def _libpq_url(url: str) -> str:
    """Convert a SQLAlchemy URL (postgresql+psycopg://) to a libpq URL.

    pg_dump/psql use libpq, which does not understand the ``+psycopg`` driver
    suffix in the scheme.
    """
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def _clone_schema(source_url: str, test_url: str) -> None:
    """Clone the source DB schema (no data) into the test DB via pg_dump|psql."""
    print("[2/4] Cloning schema from source database (pg_dump --schema-only)...")
    # --clean --if-exists drops existing objects first so re-runs are idempotent.
    dump = subprocess.run(
        ["pg_dump", "-d", _libpq_url(source_url), "--schema-only", "--no-owner",
         "--no-privileges", "--clean", "--if-exists"],
        env=os.environ,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if dump.returncode != 0:
        print("setup_test_db failed: pg_dump exited non-zero:\n" + dump.stderr, file=sys.stderr)
        raise SystemExit(dump.returncode)

    load = subprocess.run(
        ["psql", "-d", _libpq_url(test_url), "--single-transaction", "--quiet"],
        env=os.environ,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        input=dump.stdout,
    )
    if load.returncode != 0:
        print("setup_test_db failed: psql restore exited non-zero:\n" + load.stderr, file=sys.stderr)
        raise SystemExit(load.returncode)
    print("      schema cloned")


def _seed_accounts(reset_password: bool) -> None:
    go_dir = str(ROOT.parent / "backend-go")
    print("[3/4] Seeding test reference data (CRM categories + workflow templates)...")
    subprocess.run(["go", "run", "./cmd/seedtestreference"], cwd=go_dir, env=os.environ, check=True)
    print("[4/4] Seeding test accounts (admin / operator / businessdev)...")
    command = ["go", "run", "./cmd/seedtestaccounts"]
    if reset_password:
        command.append("--reset-password")
    subprocess.run(command, cwd=go_dir, env=os.environ, check=True)
    print("      accounts ready")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Set up the dedicated test database.")
    parser.add_argument(
        "--reset-password",
        action="store_true",
        help="Force-reset test account passwords on (re)seed.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    _load_env_files()
    test_url = _require_test_database_url()
    source_url = _require_source_database_url()
    _create_database_if_missing(test_url)
    _clone_schema(source_url, test_url)
    _seed_accounts(args.reset_password)
    print("\nTest database is ready. To run the test suites against it, set:")
    print("  export TEST_DATABASE_URL=<same value as in .env.test>")
    print("and start the backend with that env before running E2E Playwright tests.")


if __name__ == "__main__":
    main()
