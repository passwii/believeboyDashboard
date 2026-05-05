"""marker_migration_country_columns

Revision ID: 20260504_114
Revises: 20260429_113
Create Date: 2026-05-04 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '20260504_114'
down_revision: Union[str, None] = '20260429_113'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Placeholder migration - country columns were added manually."""
    pass


def downgrade() -> None:
    """No-op downgrade."""
    pass