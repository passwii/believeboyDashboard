"""物化订单履约渠道

Revision ID: 278
Revises: 277
Create Date: 2026-10-07 17:57:09.229158
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision: str = '278'
down_revision: Union[str, None] = '277'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name not in {'postgres', 'postgresql'}:
        # SQLite and other test/dev dialects keep using the JSON fallback.
        return

    # Fail fast rather than queuing behind ACCESS EXCLUSIVE and blocking ingest.
    # The stored-column backfill/rewrite also has a hard upper bound.
    op.execute(sa.text("SET LOCAL lock_timeout = '3s'"))
    op.execute(sa.text("SET LOCAL statement_timeout = '300s'"))
    op.execute(
        sa.text(
            "ALTER TABLE analysis_sales_order_rows "
            "ADD COLUMN fulfillment_channel text "
            "GENERATED ALWAYS AS (coalesce("
            "raw_row->>'fulfillment-channel', "
            "raw_row->>'fulfillment channel')) STORED"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name not in {'postgres', 'postgresql'}:
        return
    # Keep rollback bounded too: dropping a generated column requires an
    # ACCESS EXCLUSIVE lock, even though it does not need to recompute values.
    op.execute(sa.text("SET LOCAL lock_timeout = '3s'"))
    op.execute(sa.text("SET LOCAL statement_timeout = '300s'"))
    op.execute(
        sa.text(
            "ALTER TABLE analysis_sales_order_rows "
            "DROP COLUMN fulfillment_channel"
        )
    )
