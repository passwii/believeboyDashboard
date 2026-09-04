"""migrate_factory_role_to_operator

Revision ID: 20260624_169
Revises: 20260622_168
Create Date: 2026-06-24 10:00:00.000000

Removes the legacy 'factory' role from the user_accounts.role_type column.

History:
  20260421_001 introduced the role_type column with four values:
    admin / operator / businessdev / factory
  The 'factory' role has been deprecated: the dedicated FactoryDashboard
  has been removed, the factory-specific category-research access control
  (`_check_factory_can_access`) has been deleted, and the factory option has
  been dropped from the account-management UI. Only three roles remain:
    admin / operator / businessdev

This migration:
  1. Backfills any existing `role_type='factory'` rows to `'operator'` so
     that those users can still authenticate (the new enum does not
     contain 'factory').
  2. Updates the column comment to reflect the new role set.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '20260624_169'
down_revision: Union[str, None] = '20260622_168'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Backfill legacy factory role to operator before tightening the
    #    comment / downstream validation.
    op.execute(
        "UPDATE user_accounts SET role_type = 'operator' WHERE role_type = 'factory'"
    )
    # 2. Update the column comment to document the surviving role values.
    op.execute(
        "COMMENT ON COLUMN user_accounts.role_type IS "
        "'Business role: admin | operator | businessdev'"
    )


def downgrade() -> None:
    # The downgrade restores the original comment, but cannot restore the
    # original factory rows — they have been collapsed into 'operator'.
    op.execute(
        "COMMENT ON COLUMN user_accounts.role_type IS "
        "'Business role: operator | businessdev | factory'"
    )
