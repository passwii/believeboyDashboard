"""Add project_tier column to projects table.

Revision ID: 149
Down Revision: 148
"""

from alembic import op
import sqlalchemy as sa

revision: str = "149"
down_revision: str = "148"


def upgrade() -> None:
    op.add_column("projects", sa.Column("project_tier", sa.String(8), nullable=True))
    op.create_check_constraint(
        "projects_project_tier_check",
        "projects",
        "project_tier is null or project_tier in ('T1','T2','T3','T4')",
    )


def downgrade() -> None:
    op.drop_constraint("projects_project_tier_check", "projects", type_="check")
    op.drop_column("projects", "project_tier")
