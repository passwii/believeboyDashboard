from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, String, UniqueConstraint, CheckConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class Project(Base):
    __tablename__ = 'projects'
    __table_args__ = (
        UniqueConstraint('project_name', name='projects_project_name_key'),
        CheckConstraint('sort_order >= 0', name='projects_sort_order_check'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    project_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    brand_name: Mapped[str | None] = mapped_column(String, nullable=True)
    store_address: Mapped[str | None] = mapped_column(String, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    source_file: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
