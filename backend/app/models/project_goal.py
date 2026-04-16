from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ProjectGoal(Base):
    __tablename__ = 'project_goals'
    __table_args__ = (
        UniqueConstraint(
            'project_id', 'country', 'goal_type', 'metric_type', 'period_year', 'period_month',
            name='project_goals_unique_period',
        ),
        Index('idx_project_goals_project_year', 'project_id', 'period_year'),
        CheckConstraint(
            "goal_type IN ('monthly', 'annual')",
            name='project_goals_goal_type_check',
        ),
        CheckConstraint(
            "metric_type = 'sales_amount'",
            name='project_goals_metric_type_check',
        ),
        CheckConstraint(
            "country IN ('US', 'DE', 'UK')",
            name='project_goals_country_check',
        ),
        CheckConstraint(
            'period_month IS NULL OR (period_month >= 1 AND period_month <= 12)',
            name='project_goals_month_check',
        ),
        CheckConstraint(
            'target_amount >= 0',
            name='project_goals_target_amount_check',
        ),
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
    )
    country: Mapped[str] = mapped_column(String, nullable=False, default='US')
    goal_type: Mapped[str] = mapped_column(String, nullable=False)  # 'monthly' | 'annual'
    metric_type: Mapped[str] = mapped_column(String, nullable=False, default='sales_amount')  # 目标维度，扩展用
    period_year: Mapped[int] = mapped_column(Integer, nullable=False)
    period_month: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 1-12, only for monthly
    target_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )
