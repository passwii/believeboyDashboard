"""Seed test accounts (operator, businessdev) for permission testing.

Usage:
    cd backend && source .venv/bin/activate
    python scripts/seed_test_accounts.py

    # Reset passwords for existing accounts:
    python scripts/seed_test_accounts.py --reset-password
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.passwords import hash_password
from app.db.session import engine
from create_user_accounts_table import CREATE_USER_ACCOUNTS_TABLE_SQL

DEFAULT_TEST_PASSWORD = "TestPassword123"

TEST_ACCOUNTS = [
    {
        "email": "test_operator@believeboy.com",
        "name": "测试运营",
        "operator_name_zh": "测试运营",
        "role_type": "operator",
    },
    {
        "email": "test_businessdev@believeboy.com",
        "name": "测试招商",
        "operator_name_zh": "测试招商",
        "role_type": "businessdev",
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed test accounts for permission testing.")
    parser.add_argument(
        "--reset-password",
        action="store_true",
        help="Force reset password when account already exists.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if engine.dialect.name != "postgresql":
        print(
            "This script requires PostgreSQL. Please set DATABASE_URL.",
            file=sys.stderr,
        )
        return 1

    with engine.begin() as conn:
        conn.execute(text(CREATE_USER_ACCOUNTS_TABLE_SQL))

        for account in TEST_ACCOUNTS:
            if args.reset_password:
                upsert_sql = text(
                    """
                    INSERT INTO public.user_accounts
                        (name, email, password_hash, is_admin, is_active, role_type, operator_name_zh)
                    VALUES
                        (:name, :email, :password_hash, false, true, :role_type, :operator_name_zh)
                    ON CONFLICT ((lower(email)))
                    DO UPDATE SET
                        name = excluded.name,
                        role_type = excluded.role_type,
                        operator_name_zh = excluded.operator_name_zh,
                        is_active = true,
                        is_admin = false,
                        password_hash = excluded.password_hash,
                        updated_at = now()
                    """
                )
            else:
                upsert_sql = text(
                    """
                    INSERT INTO public.user_accounts
                        (name, email, password_hash, is_admin, is_active, role_type, operator_name_zh)
                    VALUES
                        (:name, :email, :password_hash, false, true, :role_type, :operator_name_zh)
                    ON CONFLICT ((lower(email)))
                    DO UPDATE SET
                        name = excluded.name,
                        role_type = excluded.role_type,
                        operator_name_zh = excluded.operator_name_zh,
                        is_active = true,
                        is_admin = false,
                        updated_at = now()
                    """
                )

            try:
                conn.execute(
                    upsert_sql,
                    {
                        "name": account["name"],
                        "email": account["email"].lower(),
                        "password_hash": hash_password(DEFAULT_TEST_PASSWORD),
                        "role_type": account["role_type"],
                        "operator_name_zh": account["operator_name_zh"],
                    },
                )
                print(
                    f"  [OK] {account['role_type']:12s} {account['email']} (password: {DEFAULT_TEST_PASSWORD})"
                )
            except SQLAlchemyError as exc:
                print(
                    f"  [FAIL] {account['role_type']:12s} {account['email']} — {exc}",
                    file=sys.stderr,
                )
                return 1

    print("\nAll test accounts ready. Update conftest.py env vars if needed:")
    print(f"  TEST_OPERATOR_EMAIL=test_operator@believeboy.com")
    print(f"  TEST_BUSINESSDEV_EMAIL=test_businessdev@believeboy.com")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())