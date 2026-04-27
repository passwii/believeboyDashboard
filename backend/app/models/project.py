from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, Numeric, String, Text, UniqueConstraint, CheckConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class Project(Base):
    __tablename__ = 'projects'
    __table_args__ = (
        UniqueConstraint('project_name', name='projects_project_name_key'),
        CheckConstraint('sort_order >= 0', name='projects_sort_order_check'),
        CheckConstraint(
            "commission_basis is null or commission_basis in ('sales_amount', 'cash_received', 'profit_margin')",
            name='projects_commission_basis_check',
        ),
        CheckConstraint(
            'commission_rate is null or (commission_rate >= 0 and commission_rate <= 1)',
            name='projects_commission_rate_check',
        ),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    project_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    brand_name: Mapped[str | None] = mapped_column(String, nullable=True)
    store_address: Mapped[str | None] = mapped_column(String, nullable=True)
    project_operator: Mapped[str | None] = mapped_column(Text, nullable=True)
    assistant_operator: Mapped[str | None] = mapped_column(Text, nullable=True)
    commission_basis: Mapped[str | None] = mapped_column(String, nullable=True)
    commission_rate: Mapped[Decimal | None] = mapped_column(Numeric(7, 4), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source_file: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
