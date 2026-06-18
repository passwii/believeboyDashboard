"""add avatar_url to user_accounts

Revision ID: 20260618_166
Revises: 165
Create Date: 2026-06-18 12:00:00.000000

Adds avatar_url column to user_accounts. The avatar is stored on Cloudflare
R2 under the ``avatars/{user_id}/{uuid}.{ext}`` path; this column only
holds the public R2 URL.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20260618_166'
down_revision: Union[str, None] = '165'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'user_accounts',
        sa.Column(
            'avatar_url',
            sa.Text(),
            nullable=True,
            comment='Public URL of the user avatar stored in Cloudflare R2 (avatars/{user_id}/...)',
        ),
    )


def downgrade() -> None:
    op.drop_column('user_accounts', 'avatar_url')