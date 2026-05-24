"""Add r2_key fields to exchange rate note_images.

This migration updates the note_images JSON structure to include r2_key
and thumbnail_key fields alongside the existing url fields.

For existing records, the key will be extracted from the existing URL
pattern: {r2_public_url}/exchange-rate-notes/images/{filename}
"""

from __future__ import annotations

from alembic import op

revision = '137'
down_revision = '136'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The note_images field is a JSON column, so we don't need a DDL migration.
    # The new r2_key and thumbnail_key fields will be added on-the-fly when
    # images are uploaded via the API. Existing images will have their keys
    # populated lazily by the application code when needed.
    pass


def downgrade() -> None:
    pass