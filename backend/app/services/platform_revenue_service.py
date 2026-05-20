from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import PlatformRevenue, Project


def list_revenues(
    db: Session,
    *,
    page: int = 1,
    page_size: int = 20,
    project_id: int | None = None,
    year: int | None = None,
    month: int | None = None,
    country: str | None = None,
    currency: str | None = None,
) -> tuple[list[PlatformRevenue], int]:
    """List platform revenues with filtering and pagination."""
    stmt = select(PlatformRevenue)

    if project_id is not None:
        stmt = stmt.where(PlatformRevenue.project_id == project_id)

    if year is not None:
        stmt = stmt.where(func.extract('year', PlatformRevenue.received_date) == year)

    if month is not None:
        stmt = stmt.where(func.extract('month', PlatformRevenue.received_date) == month)

    if country is not None:
        stmt = stmt.where(PlatformRevenue.country == country)

    if currency is not None:
        stmt = stmt.where(PlatformRevenue.currency == currency)

    # Get total count
    count_stmt = select(func.count(PlatformRevenue.id))
    total = db.execute(count_stmt).scalar_one()

    # Apply pagination and ordering
    stmt = stmt.order_by(
        PlatformRevenue.received_date.desc(),
        PlatformRevenue.id.desc(),
    )
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)

    rows = db.execute(stmt).scalars().all()
    return rows, total


def get_revenue(db: Session, revenue_id: int) -> PlatformRevenue:
    """Get a single platform revenue by ID."""
    row = db.execute(
        select(PlatformRevenue).where(PlatformRevenue.id == revenue_id)
    ).scalars().first()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="回款记录不存在",
        )
    return row


def create_revenue(
    db: Session,
    project_id: int,
    project_name: str,
    country: str,
    received_date: date,
    amount: Decimal,
    currency: str = "USD",
    exchange_rate: Decimal | None = None,
    note: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    operator: str | None = None,
) -> PlatformRevenue:
    """Create a new platform revenue record."""
    # Verify project exists
    project = db.execute(
        select(Project).where(Project.id == project_id)
    ).scalars().first()

    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        )

    row = PlatformRevenue(
        project_id=project_id,
        project_name=project_name or project.project_name,
        country=country,
        received_date=received_date,
        amount=amount,
        currency=currency,
        exchange_rate=exchange_rate,
        note=note,
        attachments=attachments or [],
        created_by=operator or "system",
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


def update_revenue(
    db: Session,
    revenue_id: int,
    country: str | None = None,
    received_date: date | None = None,
    amount: Decimal | None = None,
    currency: str | None = None,
    exchange_rate: Decimal | None = None,
    note: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
) -> PlatformRevenue:
    """Update an existing platform revenue record."""
    row = get_revenue(db, revenue_id)

    if country is not None:
        row.country = country
    if received_date is not None:
        row.received_date = received_date
    if amount is not None:
        row.amount = amount
    if currency is not None:
        row.currency = currency
    if exchange_rate is not None:
        row.exchange_rate = exchange_rate
    if note is not None:
        row.note = note
    if attachments is not None:
        row.attachments = attachments

    db.flush()
    db.refresh(row)
    return row


def delete_revenue(db: Session, revenue_id: int) -> None:
    """Delete a platform revenue record."""
    row = get_revenue(db, revenue_id)
    db.delete(row)
    db.flush()


def get_project_countries(db: Session, project_id: int) -> list[str]:
    """Get the list of countries (sites) for a project from product_costs table."""
    from app.models import SkuRecord

    stmt = (
        select(SkuRecord.country)
        .where(SkuRecord.project_id == project_id)
        .distinct()
        .order_by(SkuRecord.country)
    )
    rows = db.execute(stmt).scalars().all()
    return list(rows)