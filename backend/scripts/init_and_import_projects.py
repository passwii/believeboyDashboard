from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app.models  # noqa: F401  # ensure model metadata is registered
from app.db.session import SessionLocal, engine
from app.services import project_service
from create_projects_table import CREATE_PROJECTS_TABLE_SQL


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Initialize projects table (if needed) and import projects CSV into Supabase.'
    )
    parser.add_argument(
        '--file',
        type=Path,
        default=None,
        help='Optional custom CSV path. Defaults to Docs/ModelFiles/projects.csv',
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if engine.dialect.name != 'postgresql':
        print(
            'Init+Import failed: this script requires PostgreSQL/Supabase. '
            'Please set DATABASE_URL to a Postgres connection.',
            file=sys.stderr,
        )
        return 1

    try:
        with engine.begin() as conn:
            conn.execute(text(CREATE_PROJECTS_TABLE_SQL))
    except SQLAlchemyError as exc:
        print(f'Init+Import failed during table initialization: {exc}', file=sys.stderr)
        return 1

    session = SessionLocal()
    try:
        project_names, source_file, skipped, total = project_service.read_projects_csv_file(args.file)
        _, inserted, updated = project_service.bulk_upsert_projects(session, project_names, source_file)
        session.commit()
    except Exception as exc:  # pragma: no cover - entrypoint fallback
        session.rollback()
        print(f'Init+Import failed during data import: {exc}', file=sys.stderr)
        return 1
    finally:
        session.close()

    print(
        f'Init+Import finished. inserted={inserted}, updated={updated}, skipped={skipped}, '
        f'total={total}, source={source_file}'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
