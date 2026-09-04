"""add_role_type_to_user_accounts

Revision ID: 20260421_001
Revises: 20260420_098
Create Date: 2026-04-21 13:50:00.000000

Adds role_type column to user_accounts for business role classification:
  admin      = 管理员 (全局权限)
  operator   = 运营
  businessdev = 招商
  factory    = 工厂
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20260421_001'
down_revision: Union[str, None] = '20260420_098'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'user_accounts',
        sa.Column(
            'role_type',
            sa.String(length=32),
            server_default='operator',
            nullable=False,
            comment='Business role: operator | businessdev | factory',
        ),
    )
    op.create_index(
        'ix_user_accounts_role_type',
        'user_accounts',
        ['role_type'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index('ix_user_accounts_role_type', table_name='user_accounts')
    op.drop_column('user_accounts', 'role_type')
