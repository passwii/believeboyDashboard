from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ProjectRoleAssignment(Base):
    __tablename__ = 'project_role_assignments'
    __table_args__ = (
        UniqueConstraint(
            'project_id',
            'role_type',
            'person_name',
            'effective_from_month',
            name='project_role_assignments_unique_role_window',
        ),
        CheckConstraint("length(trim(role_type)) > 0", name='ck_project_role_assignments_role_type_nonempty'),
        CheckConstraint("effective_from_month LIKE '____-__'", name='ck_project_role_assignments_from_month_format'),
        CheckConstraint(
            "effective_to_month is null or effective_to_month LIKE '____-__'",
            name='ck_project_role_assignments_to_month_format',
        ),
        CheckConstraint(
            'effective_to_month is null or effective_to_month >= effective_from_month',
            name='ck_project_role_assignments_month_window',
        ),
        Index('idx_project_role_assignments_project_role', 'project_id', 'role_type'),
        Index('idx_project_role_assignments_month_window', 'effective_from_month', 'effective_to_month'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    role_type: Mapped[str] = mapped_column(String(16), nullable=False)
    person_name: Mapped[str] = mapped_column(String(255), nullable=False)
    effective_from_month: Mapped[str] = mapped_column(String(7), nullable=False)
    effective_to_month: Mapped[str | None] = mapped_column(String(7), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
