"""Add public dimensions (country/currency/retailer/portfolio_name) to 9 ad_upload_* tables
plus 5 budget-specific columns (campaign_type, targeting_type, bidding_strategy,
impressions, clicks).

Each new column is sourced from the verbatim ``raw_row`` JSON which already preserves
the original Excel/CSV header. The corresponding ingest helpers
(``backend/app/services/ad/upload/persistence.py``) are updated in a follow-up commit
to populate the columns on new uploads; the matching backfill SQL lives in
``.agent-contexts/ad-upload-column-diff/backfill.sql``.

Per-table additions (37 columns total):

  ad_upload_invalid_traffic_rows   : country, retailer
  ad_upload_purchased_product_rows : country, currency, retailer, portfolio_name
  ad_upload_placement_rows         : country, currency, retailer, portfolio_name
  ad_upload_campaign_rows          : country, currency, retailer
  ad_upload_target_rows            : country, currency, retailer, portfolio_name
  ad_upload_search_term_rows       : country, currency, retailer, portfolio_name
  ad_upload_search_term_share_rows : country, currency, portfolio_name
  ad_upload_promoted_product_rows  : country, currency, retailer, portfolio_name
  ad_upload_budget_rows            : country, currency, retailer, portfolio_name,
                                     campaign_type, targeting_type, bidding_strategy,
                                     impressions, clicks

All columns are added as nullable; backfill is a separate step that copies values from
``raw_row`` JSON. The decision to keep them nullable (rather than NOT NULL) matches the
ad_upload_* convention: the table may receive a row whose original file did not include
that header (e.g. an export without retailer).

Revision ID: 20260710_209
Revises: 20260710_208

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260710_209"
down_revision = "20260710_208"
branch_labels = None
depends_on = None


# (table, [(column_name, sa_type), ...])
_TABLE_COLUMNS: list[tuple[str, list[tuple[str, sa.types.TypeEngine]]]] = [
    (
        "ad_upload_invalid_traffic_rows",
        [
            ("country", sa.String(length=2)),
            ("retailer", sa.String(length=64)),
        ],
    ),
    (
        "ad_upload_purchased_product_rows",
        [
            ("country", sa.String(length=2)),
            ("currency", sa.String(length=8)),
            ("retailer", sa.String(length=64)),
            ("portfolio_name", sa.String(length=255)),
        ],
    ),
    (
        "ad_upload_placement_rows",
        [
            ("country", sa.String(length=2)),
            ("currency", sa.String(length=8)),
            ("retailer", sa.String(length=64)),
            ("portfolio_name", sa.String(length=255)),
        ],
    ),
    (
        "ad_upload_campaign_rows",
        [
            ("country", sa.String(length=2)),
            ("currency", sa.String(length=8)),
            ("retailer", sa.String(length=64)),
        ],
    ),
    (
        "ad_upload_target_rows",
        [
            ("country", sa.String(length=2)),
            ("currency", sa.String(length=8)),
            ("retailer", sa.String(length=64)),
            ("portfolio_name", sa.String(length=255)),
        ],
    ),
    (
        "ad_upload_search_term_rows",
        [
            ("country", sa.String(length=2)),
            ("currency", sa.String(length=8)),
            ("retailer", sa.String(length=64)),
            ("portfolio_name", sa.String(length=255)),
        ],
    ),
    (
        "ad_upload_search_term_share_rows",
        [
            ("country", sa.String(length=2)),
            ("currency", sa.String(length=8)),
            ("portfolio_name", sa.String(length=255)),
        ],
    ),
    (
        "ad_upload_promoted_product_rows",
        [
            ("country", sa.String(length=2)),
            ("currency", sa.String(length=8)),
            ("retailer", sa.String(length=64)),
            ("portfolio_name", sa.String(length=255)),
        ],
    ),
    (
        "ad_upload_budget_rows",
        [
            ("country", sa.String(length=2)),
            ("currency", sa.String(length=8)),
            ("retailer", sa.String(length=64)),
            ("portfolio_name", sa.String(length=255)),
            ("campaign_type", sa.String(length=64)),
            ("targeting_type", sa.String(length=64)),
            ("bidding_strategy", sa.String(length=128)),
            ("impressions", sa.Integer()),
            ("clicks", sa.Integer()),
        ],
    ),
]


def upgrade() -> None:
    for table, columns in _TABLE_COLUMNS:
        for col_name, col_type in columns:
            op.add_column(
                table,
                sa.Column(col_name, col_type, nullable=True),
            )


def downgrade() -> None:
    for table, columns in reversed(_TABLE_COLUMNS):
        for col_name, _col_type in reversed(columns):
            op.drop_column(table, col_name)
