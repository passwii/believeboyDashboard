"""crm owner_id/created_by 改为 UUID 字符串

Revision ID: 217
Revises: 216
Create Date: 2026-07-22 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "217"
down_revision: Union[str, None] = "216"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (表, 列) — 用户 id 列，Integer → VARCHAR(36)（user_accounts.id UUID）
_USER_ID_COLUMNS = [
    ("crm_customers", "owner_id"),
    ("crm_customers", "created_by"),
    ("crm_leads", "owner_id"),
    ("crm_leads", "created_by"),
    ("crm_opportunities", "owner_id"),
    ("crm_opportunities", "created_by"),
    ("crm_follows", "created_by"),
]


def upgrade() -> None:
    for table, column in _USER_ID_COLUMNS:
        op.alter_column(
            table,
            column,
            type_=sa.String(36),
            postgresql_using=f"{column}::varchar",
            existing_type=sa.Integer(),
        )


def downgrade() -> None:
    for table, column in _USER_ID_COLUMNS:
        op.alter_column(
            table,
            column,
            type_=sa.Integer(),
            postgresql_using=f"{column}::integer",
            existing_type=sa.String(36),
        )
