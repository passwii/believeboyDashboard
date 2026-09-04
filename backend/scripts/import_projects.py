from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy.exc import OperationalError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app.models  # noqa: F401  # ensure model metadata is registered
from app.db.session import SessionLocal, engine
from app.services import project_service


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Import projects CSV into projects table.')
    parser.add_argument(
        '--file',
        type=Path,
        default=None,
        help='Optional custom CSV path. Defaults to Docs/ModelFiles/projects.csv',
    )
    return parser.parse_args()


def main() -> int:
    if engine.dialect.name != 'postgresql':
        print(
            'Import failed: this script requires PostgreSQL/Supabase. '
            'Please set DATABASE_URL to a Postgres connection.',
            file=sys.stderr,
        )
        return 1

    args = parse_args()
    session = SessionLocal()
    try:
        project_names, source_file, skipped, total = project_service.read_projects_csv_file(args.file)
        _, inserted, updated = project_service.bulk_upsert_projects(session, project_names, source_file)
        session.commit()
    except OperationalError as exc:  # pragma: no cover - entrypoint fallback
        session.rollback()
        print(
            'Import failed: database schema is not ready. '
            'Run `python scripts/create_projects_table.py` first.',
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:  # pragma: no cover - entrypoint fallback
        session.rollback()
        print(f'Import failed: {exc}', file=sys.stderr)
        return 1
    finally:
        session.close()

    print(
        f'Import finished. inserted={inserted}, updated={updated}, skipped={skipped}, '
        f'total={total}, source={source_file}'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
