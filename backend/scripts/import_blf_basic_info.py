from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy.exc import OperationalError

import app.models  # noqa: F401  # ensure model metadata is registered
from app.db.session import Base, SessionLocal, engine
from app.services.data.sku_info import bulk_upsert_sku_records, read_sku_record_csv_file


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Import BLF Basic Info CSV into sku_info table.')
    parser.add_argument(
        '--file',
        type=Path,
        default=None,
        help='Optional custom CSV path. Defaults to Docs/ModelFiles/BLF_Basic_Info.csv',
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session = SessionLocal()
    try:
                items, source_file = read_sku_record_csv_file(args.file)
        _, inserted, updated = bulk_upsert_sku_records(session, items, source_file)
        session.commit()
    except OperationalError as exc:  # pragma: no cover - entrypoint fallback
        session.rollback()
        print(
            'Import failed: database schema is not ready. '
            'Run `alembic upgrade head` or check DATABASE_URL.',
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

    print(f'Import finished. inserted={inserted}, updated={updated}, total={inserted + updated}, source={source_file}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
