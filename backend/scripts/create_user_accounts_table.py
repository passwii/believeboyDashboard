from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.session import engine

CREATE_USER_ACCOUNTS_TABLE_SQL = """
create table if not exists public.user_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  email text not null check (position('@' in email) > 1),
  password_hash text not null check (length(password_hash) >= 20),
  full_name text,
  operator_name_zh text,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  password_changed_at timestamptz not null default now()
);

alter table public.user_accounts add column if not exists operator_name_zh text;
alter table public.user_accounts add column if not exists full_name text;
alter table public.user_accounts add column if not exists password_changed_at timestamptz not null default now();

create unique index if not exists ux_user_accounts_email_ci
on public.user_accounts ((lower(email)));

create index if not exists idx_user_accounts_is_admin
on public.user_accounts (is_admin);

create index if not exists idx_user_accounts_is_active
on public.user_accounts (is_active);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_user_accounts_updated_at on public.user_accounts;
create trigger set_user_accounts_updated_at
before update on public.user_accounts
for each row execute function public.set_updated_at();
"""


def main() -> int:
    if engine.dialect.name != 'postgresql':
        print(
            'Create user_accounts table failed: this script requires PostgreSQL/Supabase. '
            'Please set DATABASE_URL to a Postgres connection.',
            file=sys.stderr,
        )
        return 1

    try:
        with engine.begin() as conn:
            conn.execute(text(CREATE_USER_ACCOUNTS_TABLE_SQL))
    except SQLAlchemyError as exc:
        print(f'Create user_accounts table failed: {exc}', file=sys.stderr)
        return 1

    print('User accounts table is ready: public.user_accounts')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
