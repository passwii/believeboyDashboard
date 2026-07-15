"""Local sqlite smoke for the VAT entity service.

Validates ``app.services.vat_invoice`` entity CRUD logic against a real
SQL engine without needing the production Postgres test DB. Run explicitly:

    cd backend && DATABASE_URL=postgresql+psycopg://damon@/BLF_test?host=/tmp \\
        .venv/bin/python scripts/smoke_vat_entity.py

This is NOT a pytest test and is NOT part of the official suite. The real
service tests live in ``tests/services/test_vat_invoice_service.py`` and
run against the dedicated test Postgres DB.
"""
from __future__ import annotations
import os, sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # backend/
sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker


def main() -> int:
    # Build a fresh sqlite engine with NO PG-only kwargs (avoid the app's
    # production engine builder). This validates the service SQL on sqlite.
    engine = create_engine("sqlite:///:memory:")
    # Import models (also imports app.db.session which tries to build the
    # production engine — provide a fake DATABASE_URL first).
    os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://x@/x?host=/tmp")
    from app.db.session import Base
    from app.models import Project, VatEntity  # noqa: F401
    from app.services import vat_invoice as svc

    Base.metadata.create_all(engine, tables=[Project.__table__, VatEntity.__table__])
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        # 1) upsert creates new
        p = Project(project_name="弥森", sort_order=1, vat_enabled=True)
        db.add(p); db.flush()
        e = svc.upsert_entity(db, project_id=p.id, country="DE",
                              company_name="ACME", vat_id="DE123")
        assert e.id is not None and e.country == "DE" and e.company_name == "ACME"
        print("✓ upsert_entity creates new")

        # 2) upsert on same (project, country) updates (unique constraint path)
        e2 = svc.upsert_entity(db, project_id=p.id, country="DE",
                               company_name="ACME GmbH", vat_id="DE999")
        assert e2.id == e.id, f"upsert should reuse row id {e.id}, got {e2.id}"
        rows = db.scalars(select(VatEntity).where(VatEntity.project_id == p.id)).all()
        assert len(rows) == 1 and rows[0].company_name == "ACME GmbH"
        print("✓ upsert_entity updates existing (unique constraint respected)")

        # 3) list_entities
        svc.upsert_entity(db, project_id=p.id, country="FR", company_name="ACME FR")
        listed = svc.list_entities(db, p.id)
        assert {x.country for x in listed} == {"DE", "FR"}
        print("✓ list_entities returns both")

        # 4) delete_entity
        svc.delete_entity(db, e.id)
        remaining = {x.country for x in svc.list_entities(db, p.id)}
        assert remaining == {"FR"}
        print("✓ delete_entity removes row")

        # 5) ensure_vat_enabled: enabled → ok
        out = svc.ensure_vat_enabled(db, p.id)
        assert out.id == p.id
        print("✓ ensure_vat_enabled passes when enabled")

        # 6) ensure_vat_enabled: disabled → 403
        from fastapi import HTTPException
        p2 = Project(project_name="Other", sort_order=2, vat_enabled=False)
        db.add(p2); db.flush()
        try:
            svc.ensure_vat_enabled(db, p2.id)
            raise AssertionError("expected HTTPException for disabled project")
        except HTTPException as exc:
            assert exc.status_code == 403, exc.status_code
        print("✓ ensure_vat_enabled raises 403 when disabled")

        # 7) ensure_vat_enabled: missing → 404
        try:
            svc.ensure_vat_enabled(db, 999999)
            raise AssertionError("expected HTTPException for missing project")
        except HTTPException as exc:
            assert exc.status_code == 404
        print("✓ ensure_vat_enabled raises 404 for missing project")

        print("\nALL SMOKE CHECKS PASSED")
        return 0
    except Exception:
        traceback.print_exc()
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
