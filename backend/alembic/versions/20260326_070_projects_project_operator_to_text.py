"""expand projects operator columns to text

Revision ID: 20260326_070
Revises: 20260325_069
Create Date: 2026-03-26 10:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260326_070"
down_revision: Union[str, None] = "20260325_069"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.alter_column(
            "projects",
            "project_operator",
            existing_type=sa.String(length=255),
            type_=sa.Text(),
            existing_nullable=True,
        )
        op.alter_column(
            "projects",
            "assistant_operator",
            existing_type=sa.String(length=255),
            type_=sa.Text(),
            existing_nullable=True,
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.alter_column(
            "projects",
            "project_operator",
            existing_type=sa.Text(),
            type_=sa.String(length=255),
            existing_nullable=True,
        )
        op.alter_column(
            "projects",
            "assistant_operator",
            existing_type=sa.Text(),
            type_=sa.String(length=255),
            existing_nullable=True,
        )
