"""backfill US income_sales_with_tax to net (v3.1: read income_sales from PT4)

[BEL-125 v2 → v3.1 fix] Alembic 165 was authored assuming
``income_sales`` lives on ``monthly_report_pt3_calculation`` — but the
column is actually on ``monthly_report_pt4_calculation`` (PT4). PT3 only
carries the two income-side VAT columns added by alembic 160
(``income_vat_total``, ``income_sales_with_tax``).

Running v3.0 of this migration against production raised::

    sqlalchemy.exc.ProgrammingError: (psycopg.errors.UndefinedColumn)
    column pt3.income_sales does not exist
    LINE 7: AND pt3.income_sales_with_tax <> pt3.income_sales

The v3.1 fix joins ``monthly_report_pt4_calculation`` and reads
``pt4.income_sales`` (where the net figure actually lives), then writes
it back to ``pt3.income_sales_with_tax``. Same end state, correct join.

Revision ID: 165
Revises: 164
Create Date: 2026-06-17 00:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = '165'
down_revision: Union[str, None] = '164'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE monthly_report_pt3_calculation AS pt3
        SET income_sales_with_tax = pt4.income_sales
        FROM monthly_reports AS r
        JOIN monthly_report_pt4_calculation AS pt4
          ON pt4.report_id = r.id
        WHERE pt3.report_id = r.id
          AND r.country = 'US'
          AND pt3.income_sales_with_tax <> pt4.income_sales
        """
    )


def downgrade() -> None:
    # No-op: we cannot reliably reverse the backfill. See the v3.0
    # downgrade note — the historical 0 values are no longer
    # distinguishable from rows that were never touched.
    pass

