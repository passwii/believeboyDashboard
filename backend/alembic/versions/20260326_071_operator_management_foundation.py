"""operator management foundation

Revision ID: 20260326_071
Revises: 20260326_070
Create Date: 2026-03-26 13:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260326_071"
down_revision: Union[str, None] = "20260326_070"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.drop_constraint("ck_project_role_assignments_role_type", "project_role_assignments", type_="check")
    op.create_check_constraint(
        "ck_project_role_assignments_role_type_nonempty",
        "project_role_assignments",
        "length(trim(role_type)) > 0",
    )

    op.create_table(
        "operator_performance_records",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("report_month", sa.String(length=7), nullable=False),
        sa.Column("week_index", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_name", sa.String(length=255), nullable=False),
        sa.Column("person_name", sa.String(length=255), nullable=False),
        sa.Column("role_type", sa.String(length=32), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("updated_by", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint(
            "report_month",
            "week_index",
            "project_id",
            "person_name",
            "role_type",
            name="operator_performance_records_unique_scope",
        ),
        sa.CheckConstraint("report_month LIKE '____-__'", name="ck_operator_performance_records_report_month_format"),
        sa.CheckConstraint("week_index >= 1 and week_index <= 5", name="ck_operator_performance_records_week_index"),
        sa.CheckConstraint("score >= 0 and score <= 100", name="ck_operator_performance_records_score"),
        sa.CheckConstraint("length(trim(role_type)) > 0", name="ck_operator_performance_records_role_type_nonempty"),
    )
    op.create_index("idx_operator_performance_records_month", "operator_performance_records", ["report_month"])
    op.create_index(
        "idx_operator_performance_records_person_month",
        "operator_performance_records",
        ["person_name", "report_month"],
    )
    op.create_index(
        "idx_operator_performance_records_project_month",
        "operator_performance_records",
        ["project_id", "report_month"],
    )
    op.execute(
        sa.text(
            """
            drop trigger if exists set_operator_performance_records_updated_at on public.operator_performance_records;
            create trigger set_operator_performance_records_updated_at
            before update on public.operator_performance_records
            for each row execute function public.set_updated_at();
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.execute("drop trigger if exists set_operator_performance_records_updated_at on public.operator_performance_records")
    op.drop_index("idx_operator_performance_records_project_month", table_name="operator_performance_records")
    op.drop_index("idx_operator_performance_records_person_month", table_name="operator_performance_records")
    op.drop_index("idx_operator_performance_records_month", table_name="operator_performance_records")
    op.drop_table("operator_performance_records")

    op.drop_constraint("ck_project_role_assignments_role_type_nonempty", "project_role_assignments", type_="check")
    op.create_check_constraint(
        "ck_project_role_assignments_role_type",
        "project_role_assignments",
        "role_type in ('operator', 'assistant')",
    )
