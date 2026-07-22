"""merge crm(215) + digital_employee_playback

Revision ID: 216
Revises: 215, 790a004efd39
Create Date: 2026-07-22 23:55:10.115241
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision: str = '216'
down_revision: Union[str, None] = ('215', '790a004efd39')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
