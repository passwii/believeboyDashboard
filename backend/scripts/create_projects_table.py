from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.session import engine

CREATE_PROJECTS_TABLE_SQL = """
create table if not exists public.projects (
  id bigint generated always as identity primary key,
  project_name text not null,
  brand_name text,
  store_address text,
  sort_order integer not null check (sort_order >= 0),
  source_file text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_project_name_key unique (project_name)
);

create index if not exists idx_projects_sort_order on public.projects (sort_order);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at
before update on public.projects
for each row execute function public.set_updated_at();
"""


def main() -> int:
    if engine.dialect.name != 'postgresql':
        print(
            'Create projects table failed: this script requires PostgreSQL/Supabase. '
            'Please set DATABASE_URL to a Postgres connection.',
            file=sys.stderr,
        )
        return 1

    try:
        with engine.begin() as conn:
            conn.execute(text(CREATE_PROJECTS_TABLE_SQL))
    except SQLAlchemyError as exc:
        print(f'Create projects table failed: {exc}', file=sys.stderr)
        return 1

    print('Projects table is ready: public.projects')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
