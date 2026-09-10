"""Seed project_shops seller identity from OPS-443 initialization JSON (BLF-1022).

Reads the seller-identity-initialization export (default: the OPS-443 file from
the issue) and upserts ``project_shops`` rows:

* ``active_candidate`` — always seeded (11 shops);
* ``local_known_not_in_current_api_snapshot`` — only with ``--include-local-known``
  (default skipped: API team must confirm re-activation first);
* ``excluded_pending_data`` / ``retired`` — never seeded.

Alias changes are audited to ``operation_audit_logs`` (action
``projects.shops.identity_change``); no passwords/tokens/emails are stored —
only Seller Central account-switcher visible aliases.

Usage:
    cd backend && python scripts/seed_seller_identity.py [--file PATH]
        [--include-local-known] [--operator NAME] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app.models  # noqa: F401  # ensure model metadata is registered
from app.db.session import SessionLocal
from app.models.project import Project
from app.services import project_service
from app.services.audit_log_service import append_operation_audit_log

DEFAULT_FILE = Path(
    '/Users/damon/DamonProjects/believeboyOps/runtime/exports/OPS-443-seller-identity-initialization.json'
)
ALLOWED_COUNTRIES = frozenset({'US', 'DE', 'UK'})
SEEDABLE = {'active_candidate', 'local_known_not_in_current_api_snapshot'}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', type=Path, default=DEFAULT_FILE)
    parser.add_argument(
        '--include-local-known',
        action='store_true',
        help='Also seed local_known_not_in_current_api_snapshot rows (default: skip).',
    )
    parser.add_argument('--operator', default='seed:seller-identity')
    parser.add_argument('--dry-run', action='store_true')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = json.loads(args.file.read_text(encoding='utf-8'))
    shops = payload.get('shops', [])

    session = SessionLocal()
    seeded = skipped_status = skipped_missing_project = 0
    audited = 0
    try:
        for shop in shops:
            status = shop.get('status')
            if status not in SEEDABLE:
                skipped_status += 1
                continue
            if status == 'local_known_not_in_current_api_snapshot' and not args.include_local_known:
                skipped_status += 1
                continue
            country = shop.get('country')
            if country not in ALLOWED_COUNTRIES:
                print(f'SKIP shop {shop.get("shop_name")}: country {country!r} not in US/DE/UK')
                skipped_status += 1
                continue
            project_id = shop.get('project_id')
            if session.get(Project, project_id) is None:
                print(f'SKIP shop {shop.get("shop_name")}: project_id={project_id} missing')
                skipped_missing_project += 1
                continue
            expected = (shop.get('expected_alias') or '').strip() or None
            if expected is None:
                print(f'SKIP shop {shop.get("shop_name")}: empty expected_alias')
                skipped_status += 1
                continue
            aliases = [a for a in (shop.get('aliases') or []) if isinstance(a, str) and a.strip()]
            if expected not in aliases:
                aliases = [expected, *aliases]

            before_rows = {
                row.country: row for row in project_service.list_project_shops(session, project_id)
            }
            before_row = before_rows.get(country)
            before_alias = (before_row.seller_identity_expected_alias or '').strip() if before_row else ''
            before_aliases = list(before_row.seller_identity_aliases or []) if before_row else []

            if args.dry_run:
                seeded += 1
                continue
            row = project_service.upsert_project_shop(
                session,
                project_id,
                country,
                shop.get('shop_id'),
                shop_name=shop.get('shop_name'),
                seller_identity_expected_alias=expected,
                seller_identity_aliases=aliases,
                seller_identity_source='OPS-443-seller-identity-initialization',
                seller_identity_required=True,
            )
            seeded += 1
            if before_alias != expected or before_aliases != aliases:
                append_operation_audit_log(
                    session,
                    action='projects.shops.identity_change',
                    target_type='project_shop',
                    target_id=row.id,
                    operator=args.operator,
                    before={'expected_alias': before_alias or None, 'aliases': before_aliases},
                    after={'expected_alias': expected, 'aliases': aliases},
                )
                audited += 1
        if not args.dry_run:
            session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

    print(
        f'seeded={seeded} audited_identity_changes={audited} '
        f'skipped_status={skipped_status} skipped_missing_project={skipped_missing_project} '
        f'dry_run={args.dry_run}'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
