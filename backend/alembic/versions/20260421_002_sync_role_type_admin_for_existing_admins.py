"""sync_role_type_admin_for_existing_admins

Revision ID: 20260421_002
Revises: 20260421_001
Create Date: 2026-04-21 16:00:00.000000

Syncs role_type = 'admin' for all users where is_admin = true.
Without this, existing admin users remain with role_type = 'operator'
and lose admin privileges after the role-system upgrade code is deployed.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20260421_002'
down_revision: Union[str, None] = '20260421_001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE public.user_accounts
            SET role_type = 'admin', updated_at = now()
            WHERE is_admin = true AND role_type != 'admin'
            """
        )
    )


def downgrade() -> None:
    # No meaningful downgrade — only syncs existing data forward
    pass
