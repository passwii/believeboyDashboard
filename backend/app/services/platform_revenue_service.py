from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import PlatformRevenue, Project
from app.services import project_service


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
    operator: str | None = None,
    is_admin: bool = False,
) -> tuple[list[PlatformRevenue], int]:
    """List platform revenues with filtering and pagination.

    Args:
        db: Database session
        page: Page number (1-indexed)
        page_size: Number of items per page
        project_id: Filter by project ID
        year: Filter by year
        month: Filter by month
        country: Filter by country
        currency: Filter by currency
        operator: Current operator name (for permission check)
        is_admin: Whether current user is admin

    Returns:
        Tuple of (rows, total_count)
    """
    # Get accessible project IDs based on permissions
    accessible_project_ids = project_service.list_accessible_project_ids(
        db, operator=operator, is_admin=is_admin
    )

    # If user has no accessible projects (non-admin without operator or no projects), return empty
    if accessible_project_ids is not None and len(accessible_project_ids) == 0:
        return [], 0

    stmt = select(PlatformRevenue)

    # Apply permission-based project filter for non-admin users
    if accessible_project_ids is not None:
        stmt = stmt.where(PlatformRevenue.project_id.in_(accessible_project_ids))

    if project_id is not None:
        # Validate project_id access for non-admin users
        if accessible_project_ids is not None and project_id not in accessible_project_ids:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="无权限访问该项目",
            )
        stmt = stmt.where(PlatformRevenue.project_id == project_id)

    if year is not None:
        stmt = stmt.where(func.extract('year', PlatformRevenue.received_date) == year)

    if month is not None:
        stmt = stmt.where(func.extract('month', PlatformRevenue.received_date) == month)

    if country is not None:
        stmt = stmt.where(PlatformRevenue.country == country)

    if currency is not None:
        stmt = stmt.where(PlatformRevenue.currency == currency)

    # Get total count with permission filter
    count_stmt = select(func.count(PlatformRevenue.id))
    if accessible_project_ids is not None:
        count_stmt = count_stmt.where(PlatformRevenue.project_id.in_(accessible_project_ids))
    if project_id is not None:
        count_stmt = count_stmt.where(PlatformRevenue.project_id == project_id)

    total = db.execute(count_stmt).scalar_one()

    # Apply pagination and ordering
    stmt = stmt.order_by(
        PlatformRevenue.received_date.desc(),
        PlatformRevenue.id.desc(),
    )
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)

    rows = db.execute(stmt).scalars().all()
    return rows, total


def get_revenue(
    db: Session,
    revenue_id: int,
    operator: str | None = None,
    is_admin: bool = False,
) -> PlatformRevenue:
    """Get a single platform revenue by ID with permission check."""
    row = db.execute(
        select(PlatformRevenue).where(PlatformRevenue.id == revenue_id)
    ).scalars().first()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="回款记录不存在",
        )

    # Check permission for non-admin users
    accessible_project_ids = project_service.list_accessible_project_ids(
        db, operator=operator, is_admin=is_admin
    )
    if accessible_project_ids is not None and row.project_id not in accessible_project_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="无权限访问该回款记录",
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
    revenue_type: str = "订单回款",
    note: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    screenshot_r2_key: str | None = None,
    screenshot_r2_url: str | None = None,
    operator: str | None = None,
    is_admin: bool = False,
) -> PlatformRevenue:
    """Create a new platform revenue record with permission check."""
    # Verify project exists
    project = db.execute(
        select(Project).where(Project.id == project_id)
    ).scalars().first()

    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        )

    # Check permission for non-admin users
    accessible_project_ids = project_service.list_accessible_project_ids(
        db, operator=operator, is_admin=is_admin
    )
    if accessible_project_ids is not None and project_id not in accessible_project_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="无权限在该项目下创建回款",
        )

    row = PlatformRevenue(
        project_id=project_id,
        project_name=project_name or project.project_name,
        country=country,
        received_date=received_date,
        amount=amount,
        currency=currency,
        exchange_rate=exchange_rate,
        revenue_type=revenue_type,
        note=note,
        attachments=attachments or [],
        screenshot_r2_key=screenshot_r2_key,
        screenshot_r2_url=screenshot_r2_url,
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
    revenue_type: str | None = None,
    note: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    screenshot_r2_key: str | None = None,
    screenshot_r2_url: str | None = None,
    operator: str | None = None,
    is_admin: bool = False,
) -> PlatformRevenue:
    """Update an existing platform revenue record with permission check."""
    row = get_revenue(db, revenue_id, operator=operator, is_admin=is_admin)

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
    if revenue_type is not None:
        row.revenue_type = revenue_type
    if note is not None:
        row.note = note
    if attachments is not None:
        row.attachments = attachments
    if screenshot_r2_key is not None:
        row.screenshot_r2_key = screenshot_r2_key
    if screenshot_r2_url is not None:
        row.screenshot_r2_url = screenshot_r2_url

    db.flush()
    db.refresh(row)
    return row


def delete_revenue(
    db: Session,
    revenue_id: int,
    operator: str | None = None,
    is_admin: bool = False,
) -> None:
    """Delete a platform revenue record with permission check."""
    row = get_revenue(db, revenue_id, operator=operator, is_admin=is_admin)
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