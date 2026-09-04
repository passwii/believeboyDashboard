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

from app.core.passwords import hash_password
from app.db.session import engine
from create_user_accounts_table import CREATE_USER_ACCOUNTS_TABLE_SQL

DEFAULT_ADMIN_EMAIL = 'yawei@believeboy.com'
DEFAULT_ADMIN_NAME = 'yawei'


def _load_env_file() -> None:
    """Populate os.environ from backend/.env (not committed) so secrets stay out of source."""
    env_path = ROOT / '.env'
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, val = line.partition('=')
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def parse_args() -> argparse.Namespace:
    _load_env_file()
    parser = argparse.ArgumentParser(description='Seed default admin user to Supabase user_accounts table.')
    parser.add_argument('--name', default=DEFAULT_ADMIN_NAME, help='Admin display name')
    parser.add_argument('--email', default=DEFAULT_ADMIN_EMAIL, help='Admin email')
    parser.add_argument(
        '--password',
        default=os.getenv('ADMIN_SEED_PASSWORD'),
        help='Admin password. Falls back to the ADMIN_SEED_PASSWORD env var. Required.',
    )
    parser.add_argument(
        '--reset-password',
        action='store_true',
        help='Force reset password when admin email already exists.',
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.password:
        print(
            'Seed admin user failed: no password provided. Pass --password '
            'or set the ADMIN_SEED_PASSWORD environment variable.',
            file=sys.stderr,
        )
        return 1

    if engine.dialect.name != 'postgresql':
        print(
            'Seed admin user failed: this script requires PostgreSQL/Supabase. '
            'Please set DATABASE_URL to a Postgres connection.',
            file=sys.stderr,
        )
        return 1

    if args.reset_password:
        upsert_sql = text(
            """
            insert into public.user_accounts (name, email, password_hash, is_admin, is_active)
            values (:name, :email, :password_hash, true, true)
            on conflict ((lower(email)))
            do update
            set
              name = excluded.name,
              is_admin = true,
              is_active = true,
              password_hash = excluded.password_hash,
              updated_at = now()
            """
        )
    else:
        upsert_sql = text(
            """
            insert into public.user_accounts (name, email, password_hash, is_admin, is_active)
            values (:name, :email, :password_hash, true, true)
            on conflict ((lower(email)))
            do update
            set
              name = excluded.name,
              is_admin = true,
              is_active = true,
              updated_at = now()
            """
        )

    try:
        with engine.begin() as conn:
            conn.execute(text(CREATE_USER_ACCOUNTS_TABLE_SQL))
            conn.execute(
                upsert_sql,
                {
                    'name': args.name.strip(),
                    'email': args.email.strip().lower(),
                    'password_hash': hash_password(args.password),
                },
            )
    except SQLAlchemyError as exc:
        print(f'Seed admin user failed: {exc}', file=sys.stderr)
        return 1

    action = 'created_or_updated_with_password_reset' if args.reset_password else 'created_or_updated_without_password_reset'
    print(f'Admin user is ready: {args.email.strip().lower()} ({action})')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
