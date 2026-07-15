"""Local sqlite smoke for the VAT invoice service.

Validates ``create_invoice`` (totals, invoice_no format), ``void_invoice``,
``attach_invoice_pdf`` (draft → issued), and ``list_invoices`` against a
real SQL engine without needing the production Postgres test DB.

    cd backend && DATABASE_URL=postgresql+psycopg://damon@/BLF_test?host=/tmp \\
        .venv/bin/python scripts/smoke_vat_invoice.py
"""
from __future__ import annotations
import os, sys, traceback
from datetime import date
from decimal import Decimal as D
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker


def main() -> int:
    engine = create_engine("sqlite:///:memory:")
    os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://x@/x?host=/tmp")
    from app.db.session import Base
    from app.models import Project, VatEntity, VatInvoice, VatInvoiceLine  # noqa: F401
    from app.services import vat_invoice as svc

    Base.metadata.create_all(engine, tables=[
        Project.__table__, VatEntity.__table__,
        VatInvoice.__table__, VatInvoiceLine.__table__,
    ])
    Session = sessionmaker(bind=engine)
    db = Session()
    try:
        # seed project + entity
        p = Project(project_name="VATshop", sort_order=1, vat_enabled=True)
        db.add(p); db.flush()
        seller = svc.upsert_entity(db, project_id=p.id, country="DE",
                                   company_name="ACME", vat_id="DE123456789")
        db.flush()

        # create invoice
        inv = svc.create_invoice(
            db,
            project_id=p.id, seller_entity_id=seller.id,
            currency="EUR", order_id="ORDER-1",
            invoice_date=date(2026, 7, 15),
            buyer={"name": "Buyer", "address_line": "X", "postal_code": "00000",
                   "city": "C", "country": "DE"},
            shipping_incl_vat=D("10.00"),
            lines=[{"description": "A", "asin": "A1", "qty": 2,
                    "unit_price_incl_vat": D("119.00"), "vat_rate": D("19")}],
            status="draft",
        )
        db.flush()
        assert inv.invoice_no.startswith("INV-DE123456789-2026-"), inv.invoice_no
        assert inv.invoice_no.endswith(f"{inv.id:06d}"), inv.invoice_no
        assert inv.total_incl == D("248.00"), inv.total_incl
        assert inv.status == "draft"
        assert len(inv.lines) == 1 and inv.lines[0].line_no == 1
        assert inv.seller_snapshot["vat_id"] == "DE123456789"
        print("✓ create_invoice: invoice_no, totals, snapshot")

        # attach PDF → draft becomes issued
        svc.attach_invoice_pdf(db, inv.id, r2_key="k", r2_url="https://r2/x.pdf")
        db.flush()
        reloaded = db.get(VatInvoice, inv.id)
        assert reloaded.status == "issued" and reloaded.r2_key == "k"
        print("✓ attach_invoice_pdf: draft → issued")

        # list filters
        rows = svc.list_invoices(db, project_id=p.id, status="issued")
        assert {r.id for r in rows} == {inv.id}
        rows2 = svc.list_invoices(db, project_id=p.id, status="draft")
        assert rows2 == []
        print("✓ list_invoices filters by project + status")

        # create + void
        inv2 = svc.create_invoice(
            db, project_id=p.id, seller_entity_id=seller.id,
            currency="EUR", order_id="ORDER-2",
            invoice_date=date(2026, 7, 16),
            buyer={"name": "B2", "address_line": "Y", "postal_code": "00001",
                   "city": "C", "country": "DE"},
            shipping_incl_vat=D("0"),
            lines=[{"description": "B", "asin": "B1", "qty": 1,
                    "unit_price_incl_vat": D("100"), "vat_rate": D("19")}],
        )
        db.flush()
        svc.void_invoice(db, inv2.id, reason="smoke")
        db.flush()
        assert db.get(VatInvoice, inv2.id).status == "voided"
        print("✓ void_invoice sets status")

        # invoice_no without seller → NA
        p2 = Project(project_name="NoSeller", sort_order=2, vat_enabled=True)
        db.add(p2); db.flush()
        inv3 = svc.create_invoice(
            db, project_id=p2.id, seller_entity_id=None,
            currency="EUR", order_id="ORDER-3",
            invoice_date=date(2026, 7, 17),
            buyer={"name": "B3", "address_line": "", "postal_code": "",
                   "city": "", "country": "DE"},
            shipping_incl_vat=D("0"),
            lines=[{"description": "C", "asin": "", "qty": 1,
                    "unit_price_incl_vat": D("10"), "vat_rate": D("19")}],
        )
        db.flush()
        assert inv3.invoice_no.startswith("INV-NA-2026-"), inv3.invoice_no
        print("✓ create_invoice with no seller → invoice_no uses NA")

        print("\nALL INVOICE SMOKE CHECKS PASSED")
        return 0
    except Exception:
        traceback.print_exc()
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
