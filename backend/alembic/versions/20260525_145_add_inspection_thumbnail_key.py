"""add_inspection_thumbnail_key

Revision ID: 145
Revises: 144
Create Date: 2026-05-25 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '145'
down_revision: Union[str, None] = '144'


def upgrade() -> None:
    op.add_column(
        'inspection_screenshots',
        sa.Column('thumbnail_key', sa.String(512), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('inspection_screenshots', 'thumbnail_key')
