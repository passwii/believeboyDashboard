"""Seed test accounts (admin, operator, businessdev) into the database.

The target database is whichever `database_url` resolves to. When
``TEST_DATABASE_URL`` is set (e.g. in ``backend/.env.test``), it seeds the
dedicated test database instead of the dev/prod DB — see ``app/core/config.py``
and ``scripts/setup_test_db.py``.

Accounts seeded (emails/passwords come from env via ``app.core.config``):
  * test_admin@believeboy.com      (is_admin=true,  role_type=admin)
  * test_operator@believeboy.com   (role_type=operator)
  * test_businessdev@believeboy.com(role_type=businessdev)

Usage:
    cd backend && source .venv/bin/activate

    # Seed into the test DB (TEST_DATABASE_URL set in .env.test):
    python scripts/seed_test_accounts.py

    # Reset passwords for existing accounts:
    python scripts/seed_test_accounts.py --reset-password
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# This file is imported both as `python scripts/seed_test_accounts.py` (where
# the script dir is auto-added to sys.path) and as `scripts.seed_test_accounts`
# (e.g. from setup_test_db.py). Ensure its own directory is always importable
# so `from create_user_accounts_table import ...` works in both modes.
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _load_env_files() -> None:
    """Populate os.environ from backend/.env then backend/.env.test.

    ``.env.test`` OVERRIDES ``.env`` so the test DB URL / test passwords take
    precedence without editing the committed ``.env``. Secrets stay out of
    source control.
    """
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


_load_env_files()

from app.core.config import get_settings  # noqa: E402
from app.core.passwords import hash_password  # noqa: E402
from app.db.session import engine  # noqa: E402
from create_user_accounts_table import CREATE_USER_ACCOUNTS_TABLE_SQL  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed test accounts for testing.")
    parser.add_argument(
        "--reset-password",
        action="store_true",
        help="Force reset password when an account already exists.",
    )
    return parser.parse_args()


def _resolve_password(settings, role: str, legacy: str | None) -> str:
    """Pick a password for ``role`` from settings, falling back to legacy env."""
    value = {
        "admin": settings.test_admin_password,
        "operator": settings.test_operator_password,
        "businessdev": settings.test_businessdev_password,
    }.get(role, "")
    if not value and legacy:
        return legacy
    return value or ""


def main() -> int:
    args = parse_args()
    settings = get_settings()

    if engine.dialect.name != "postgresql":
        print(
            "Seed test accounts failed: this script requires PostgreSQL. "
            "Set DATABASE_URL or TEST_DATABASE_URL.",
            file=sys.stderr,
        )
        return 1

    # Per-role password resolution. Legacy TEST_ACCOUNT_PASSWORD is accepted
    # as a fallback so existing automation keeps working.
    legacy = os.getenv("TEST_ACCOUNT_PASSWORD")
    passwords = {role: _resolve_password(settings, role, legacy) for role in ("admin", "operator", "businessdev")}
    missing = [role for role, pw in passwords.items() if not pw]
    if missing:
        print(
            "Seed test accounts failed: missing password(s) for "
            + ", ".join(missing)
            + ". Set TEST_*_PASSWORD (or TEST_ACCOUNT_PASSWORD) in env / .env.test.",
            file=sys.stderr,
        )
        return 1

    TEST_ACCOUNTS = [
        {
            "email": settings.test_admin_email,
            "name": "测试管理员",
            "full_name": "测试管理员",
            "operator_name_zh": "测试管理员",
            "role_type": "admin",
            "is_admin": True,
        },
        {
            "email": settings.test_operator_email,
            "name": "测试运营",
            "full_name": "测试运营",
            "operator_name_zh": "测试运营",
            "role_type": "operator",
            "is_admin": False,
        },
        {
            "email": settings.test_businessdev_email,
            "name": "测试招商",
            "full_name": "测试招商",
            "operator_name_zh": "测试招商",
            "role_type": "businessdev",
            "is_admin": False,
        },
    ]

    with engine.begin() as conn:
        conn.execute(text(CREATE_USER_ACCOUNTS_TABLE_SQL))

        for account in TEST_ACCOUNTS:
            role = account["role_type"]
            if args.reset_password:
                upsert_sql = text(
                    """
                    INSERT INTO public.user_accounts
                        (name, email, full_name, password_hash, is_admin, is_active, role_type, operator_name_zh)
                    VALUES
                        (:name, :email, :full_name, :password_hash, :is_admin, true, :role_type, :operator_name_zh)
                    ON CONFLICT ((lower(email)))
                    DO UPDATE SET
                        name = excluded.name,
                        full_name = excluded.full_name,
                        role_type = excluded.role_type,
                        operator_name_zh = excluded.operator_name_zh,
                        is_active = true,
                        is_admin = excluded.is_admin,
                        password_hash = excluded.password_hash,
                        updated_at = now()
                    """
                )
            else:
                upsert_sql = text(
                    """
                    INSERT INTO public.user_accounts
                        (name, email, full_name, password_hash, is_admin, is_active, role_type, operator_name_zh)
                    VALUES
                        (:name, :email, :full_name, :password_hash, :is_admin, true, :role_type, :operator_name_zh)
                    ON CONFLICT ((lower(email)))
                    DO UPDATE SET
                        name = excluded.name,
                        full_name = excluded.full_name,
                        role_type = excluded.role_type,
                        operator_name_zh = excluded.operator_name_zh,
                        is_active = true,
                        is_admin = excluded.is_admin,
                        updated_at = now()
                    """
                )

            try:
                conn.execute(
                    upsert_sql,
                    {
                        "name": account["name"],
                        "full_name": account["full_name"],
                        "email": account["email"].lower(),
                        "password_hash": hash_password(passwords[role]),
                        "is_admin": account["is_admin"],
                        "role_type": account["role_type"],
                        "operator_name_zh": account["operator_name_zh"],
                    },
                )
                print(
                    f"  [OK] {account['role_type']:12s} {account['email']} "
                    f"(password: {passwords[role]})"
                )
            except SQLAlchemyError as exc:
                print(
                    f"  [FAIL] {account['role_type']:12s} {account['email']} — {exc}",
                    file=sys.stderr,
                )
                return 1

    print("\nAll test accounts ready. Update conftest env vars if needed:")
    print(f"  TEST_ADMIN_EMAIL={settings.test_admin_email}")
    print(f"  TEST_OPERATOR_EMAIL={settings.test_operator_email}")
    print(f"  TEST_BUSINESSDEV_EMAIL={settings.test_businessdev_email}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
