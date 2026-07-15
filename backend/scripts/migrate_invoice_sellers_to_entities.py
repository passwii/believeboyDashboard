"""One-shot migration: ``projects.project_context.invoice_sellers`` JSON →
``vat_entities`` table.

Usage:
    # dry-run (default): print what would be inserted, no writes
    python scripts/migrate_invoice_sellers_to_entities.py

    # actually insert (idempotent: re-running is safe — duplicates skipped)
    python scripts/migrate_invoice_sellers_to_entities.py --commit
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]  # backend/
sys.path.insert(0, str(ROOT))

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.project import Project
from app.models.vat_entity import VatEntity


def extract_seller_plan(db: Session) -> list[tuple[int, str, dict[str, Any]]]:
    """Scan all Projects' ``project_context.invoice_sellers`` and return the
    dedup'd list of (project_id, project_name, seller) to insert.

    Dedup key is (project_id, country). Rows missing ``company_name`` or
    ``country`` are skipped.
    """
    projects = db.scalars(select(Project)).all()
    seen: set[tuple[int, str]] = set()
    plan: list[tuple[int, str, dict[str, Any]]] = []
    for p in projects:
        ctx = p.project_context or {}
        sellers = ctx.get("invoice_sellers") or []
        if not sellers:
            continue
        for s in sellers:
            if not s.get("company_name") or not s.get("country"):
                continue
            key = (p.id, s["country"])
            if key in seen:
                continue
            seen.add(key)
            plan.append((p.id, p.project_name, s))
    return plan


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true",
                    help="Actually insert into vat_entities (default dry-run).")
    args = ap.parse_args()

    with SessionLocal() as db:
        plan = extract_seller_plan(db)

        # Also report existing vat_entities so the operator sees overlap.
        existing = db.scalars(select(VatEntity)).all()
        existing_keys = {(e.project_id, e.country) for e in existing}

        print(f"Projects with invoice_sellers context: {len({pid for pid, _, _ in plan})}")
        print(f"Would insert {len(plan)} VatEntity rows "
              f"({sum(1 for k in ({(p, c) for p, _, s in plan for c in [s['country']]}) if k in existing_keys)} already exist).")
        for pid, name, s in plan[:10]:
            marker = " (exists)" if (pid, s["country"]) in existing_keys else ""
            print(f"  - project={name} country={s['country']} "
                  f"company={s['company_name']} vat_id={s.get('vat_id','')}{marker}")
        if len(plan) > 10:
            print(f"  ... and {len(plan) - 10} more")

        if args.commit:
            inserted = 0
            for pid, _, s in plan:
                if (pid, s["country"]) in existing_keys:
                    continue
                db.add(VatEntity(
                    project_id=pid,
                    country=s["country"].upper()[:2],
                    company_name=s["company_name"][:255],
                    vat_id=(s.get("vat_id") or "")[:64],
                    address_line=(s.get("address_line") or "")[:512],
                    postal_code=(s.get("postal_code") or "")[:32],
                    city=(s.get("city") or "")[:128],
                    email=(s.get("email") or "")[:255],
                ))
                inserted += 1
            db.commit()
            print(f"\nCommitted {inserted} new VatEntity rows.")
        else:
            print("\nDry-run only. Re-run with --commit to write.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
