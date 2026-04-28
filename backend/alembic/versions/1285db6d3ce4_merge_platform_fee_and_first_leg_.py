"""merge platform_fee and first_leg migrations

Revision ID: 1285db6d3ce4
Revises: 20260428_096, 20260428_107
Create Date: 2026-04-28 10:37:07.566570
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision: str = '1285db6d3ce4'
down_revision: Union[str, None] = ('20260428_096', '20260428_107')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
