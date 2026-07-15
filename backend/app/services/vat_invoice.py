from __future__ import annotations
import uuid
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable


CENT = Decimal('0.01')


def _q(x: Decimal) -> Decimal:
    return x.quantize(CENT, rounding=ROUND_HALF_UP)


def split_vat(incl: Decimal, rate_pct: Decimal) -> dict[str, Decimal]:
    """含税价 + VAT 率(%) → {excl, vat, incl}。

    与前端 ``frontend/app/dashboard/finance/vat-invoice/lib/vat-calc.ts``
    的 ``splitVat`` 对齐：excl = round2(incl / (1 + rate/100))，
    vat = round2(incl - excl)，incl 原样返回。
    """
    r = rate_pct / Decimal(100)
    excl = _q(incl / (Decimal(1) + r))
    vat = _q(incl - excl)
    return {'excl': excl, 'vat': vat, 'incl': _q(incl)}


def _first_rate(lines: list[dict]) -> Decimal:
    return lines[0]['vat_rate'] if lines else Decimal(0)


def compute_invoice_totals(
    lines: list[dict],
    *,
    shipping_incl_vat: Decimal,
) -> dict:
    """按 VAT 率分桶聚合（含运费归入第一行 VAT 桶）。

    镜像前端 ``summarizeByRate`` + ``computeInvoiceTotal``。
    返回 ``subtotal_excl / total_vat / total_incl / summary_by_rate``。
    ``summary_by_rate`` 按 rate 升序，每行
    ``{rate, item_excl, item_vat, shipping_excl, shipping_vat, total}``。
    """
    buckets: dict[Decimal, dict] = {}
    items_total = Decimal(0)
    for it in lines:
        sub = split_vat(it['unit_price_incl_vat'] * it['qty'], it['vat_rate'])
        items_total = _q(items_total + sub['incl'])
        b = buckets.setdefault(
            it['vat_rate'],
            {
                'rate': it['vat_rate'], 'item_excl': Decimal(0), 'item_vat': Decimal(0),
                'shipping_excl': Decimal(0), 'shipping_vat': Decimal(0),
            },
        )
        b['item_excl'] = _q(b['item_excl'] + sub['excl'])
        b['item_vat'] = _q(b['item_vat'] + sub['vat'])

    if lines:
        ship = split_vat(shipping_incl_vat, _first_rate(lines))
        b = buckets.setdefault(
            _first_rate(lines),
            {
                'rate': _first_rate(lines), 'item_excl': Decimal(0), 'item_vat': Decimal(0),
                'shipping_excl': Decimal(0), 'shipping_vat': Decimal(0),
            },
        )
        b['shipping_excl'] = _q(b['shipping_excl'] + ship['excl'])
        b['shipping_vat'] = _q(b['shipping_vat'] + ship['vat'])

    summary = []
    for rate in sorted(buckets.keys()):
        b = buckets[rate]
        total = _q(b['item_excl'] + b['item_vat'] + b['shipping_excl'] + b['shipping_vat'])
        summary.append({**b, 'total': total})

    total_incl = _q(items_total + shipping_incl_vat)
    subtotal_excl = _q(Decimal(0))
    for row in summary:
        subtotal_excl = _q(subtotal_excl + row['item_excl'] + row['shipping_excl'])
    total_vat = _q(total_incl - subtotal_excl)
    return {
        'subtotal_excl': subtotal_excl,
        'total_vat': total_vat,
        'total_incl': total_incl,
        'summary_by_rate': summary,
    }


# ---------------------------------------------------------------------------
# VAT entity service
# ---------------------------------------------------------------------------

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.vat_entity import VatEntity
from app.models.project import Project


def ensure_vat_enabled(db: Session, project_id: int) -> Project:
    """Raise 403 if the project's VAT feature is not enabled.

    Returns the Project row on success. Used as a guard on every
    VAT-scoped endpoint.
    """
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail='project not found')
    if not p.vat_enabled:
        raise HTTPException(
            status_code=403, detail='VAT feature is not enabled for this project'
        )
    return p


def list_entities(db: Session, project_id: int) -> list[VatEntity]:
    return list(
        db.scalars(
            select(VatEntity)
            .where(VatEntity.project_id == project_id)
            .order_by(VatEntity.country)
        ).all()
    )


def upsert_entity(
    db: Session,
    *,
    project_id: int,
    country: str,
    company_name: str,
    vat_id: str = '',
    address_line: str = '',
    postal_code: str = '',
    city: str = '',
    email: str = '',
    is_default: bool = False,
) -> VatEntity:
    """Create or update the (project_id, country) entity.

    The unique constraint ``uq_vat_entities_project_country`` means there is at
    most one entity per (project, country). An upsert overwrites the fields.
    """
    row = db.scalar(
        select(VatEntity).where(
            VatEntity.project_id == project_id, VatEntity.country == country
        )
    )
    if row is None:
        row = VatEntity(
            project_id=project_id,
            country=country,
            company_name=company_name,
            vat_id=vat_id,
            address_line=address_line,
            postal_code=postal_code,
            city=city,
            email=email,
            is_default=is_default,
        )
        db.add(row)
    else:
        row.company_name = company_name
        row.vat_id = vat_id
        row.address_line = address_line
        row.postal_code = postal_code
        row.city = city
        row.email = email
        row.is_default = is_default
    db.flush()
    return row


def delete_entity(db: Session, entity_id: int) -> None:
    row = db.get(VatEntity, entity_id)
    if row is None:
        raise HTTPException(status_code=404, detail='vat entity not found')
    db.delete(row)
    db.flush()


# ---------------------------------------------------------------------------
# VAT invoice service
# ---------------------------------------------------------------------------

from typing import Any  # noqa: E402

from fastapi import HTTPException  # noqa: E402
from sqlalchemy import select  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.models.vat_invoice import VatInvoice, VatInvoiceLine  # noqa: E402


def _snapshot_entity(e: VatEntity | None) -> dict[str, Any]:
    if e is None:
        return {}
    return {
        'country': e.country,
        'company_name': e.company_name,
        'vat_id': e.vat_id,
        'address_line': e.address_line,
        'postal_code': e.postal_code,
        'city': e.city,
        'email': e.email,
    }


def _assign_invoice_no(inv: VatInvoice) -> str:
    """格式: INV-{VAT号}-{year}-{id:06d}。无主体时用 NA 兜底，VAT 号去空格。"""
    year = inv.invoice_date.year
    vat = (inv.seller_snapshot or {}).get('vat_id') or 'NA'
    vat = str(vat).replace(' ', '')
    seq = inv.id
    return f"INV-{vat}-{year}-{seq:06d}"


def create_invoice(
    db: Session,
    *,
    project_id: int,
    seller_entity_id: int | None,
    currency: str,
    order_id: str,
    invoice_date,
    buyer: dict,
    shipping_incl_vat,
    lines: list[dict],
    status: str = 'draft',
) -> VatInvoice:
    if not lines:
        raise ValueError('lines must not be empty')

    seller = db.get(VatEntity, seller_entity_id) if seller_entity_id is not None else None

    shipping_dec = Decimal(shipping_incl_vat)
    totals = compute_invoice_totals(lines, shipping_incl_vat=shipping_dec)

    inv = VatInvoice(
        project_id=project_id,
        seller_entity_id=seller_entity_id,
        seller_snapshot=_snapshot_entity(seller),
        buyer=dict(buyer),
        currency=currency,
        order_id=order_id,
        invoice_date=invoice_date,
        shipping_incl_vat=shipping_dec,
        subtotal_excl=totals['subtotal_excl'],
        total_vat=totals['total_vat'],
        total_incl=totals['total_incl'],
        summary_by_rate=[
            {k: (str(v) if isinstance(v, Decimal) else v) for k, v in row.items()}
            for row in totals['summary_by_rate']
        ],
        status=status,
        # placeholder: must satisfy NOT NULL + uq(project, invoice_no) at INSERT;
        # replaced with real invoice_no after flush (id known).
        invoice_no=f"DRAFT-{uuid.uuid4().hex}",
    )
    db.add(inv)
    db.flush()
    inv.invoice_no = _assign_invoice_no(inv)
    db.flush()

    for idx, ln in enumerate(lines, start=1):
        unit = Decimal(ln['unit_price_incl_vat'])
        qty = int(ln['qty'])
        rate = Decimal(ln['vat_rate'])
        sub = split_vat(unit * qty, rate)
        db.add(VatInvoiceLine(
            invoice_id=inv.id,
            line_no=idx,
            description=str(ln.get('description', ''))[:512],
            asin=str(ln.get('asin', ''))[:32],
            qty=qty,
            unit_price_incl_vat=unit,
            vat_rate=rate,
            line_excl=sub['excl'],
            line_vat=sub['vat'],
            line_incl=sub['incl'],
        ))
    db.flush()
    return inv


def get_invoice_or_404(db: Session, invoice_id: int) -> VatInvoice:
    from fastapi import HTTPException
    row = db.get(VatInvoice, invoice_id)
    if row is None:
        raise HTTPException(status_code=404, detail='vat invoice not found')
    return row


def list_invoices(
    db: Session,
    *,
    project_id: int | None = None,
    status: str | None = None,
    q: str | None = None,
    date_from=None,
    date_to=None,
    limit: int = 100,
    offset: int = 0,
) -> list[VatInvoice]:
    from sqlalchemy import select  # local to avoid lint warnings
    stmt = select(VatInvoice)
    if project_id is not None:
        stmt = stmt.where(VatInvoice.project_id == project_id)
    if status:
        stmt = stmt.where(VatInvoice.status == status)
    if date_from:
        stmt = stmt.where(VatInvoice.invoice_date >= date_from)
    if date_to:
        stmt = stmt.where(VatInvoice.invoice_date <= date_to)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(VatInvoice.invoice_no.like(like) | VatInvoice.order_id.like(like))
    stmt = (
        stmt.order_by(VatInvoice.invoice_date.desc(), VatInvoice.id.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(db.scalars(stmt).all())


def attach_invoice_pdf(db: Session, invoice_id: int, *, r2_key: str, r2_url: str) -> VatInvoice:
    inv = get_invoice_or_404(db, invoice_id)
    inv.r2_key = r2_key
    inv.r2_url = r2_url
    if inv.status == 'draft':
        inv.status = 'issued'
    db.flush()
    return inv


def void_invoice(db: Session, invoice_id: int, *, reason: str = '') -> VatInvoice:
    inv = get_invoice_or_404(db, invoice_id)
    if inv.status != 'voided':
        inv.status = 'voided'
        inv.void_reason = reason
    db.flush()
    return inv


# Decimal used at top of file; imported here for the service signature/cast.
