"""add scope_status to ad_upload_promoted_product_rows

Revision ID: 151
Revises: 150
Create Date: 2026-06-01
"""
from alembic import op
import sqlalchemy as sa


revision = "151"
down_revision = "150"
branch_labels = None
depends_on = None


_TABLE = "ad_upload_promoted_product_rows"


def upgrade() -> None:
    # 1) 加列 (NOT NULL + server_default 保证已有行有值)
    op.add_column(
        _TABLE,
        sa.Column(
            "scope_status",
            sa.String(32),
            nullable=False,
            server_default="included_product",
        ),
    )

    # 2) CHECK constraint
    op.create_check_constraint(
        "ck_ad_upload_promoted_product_rows_scope_status",
        _TABLE,
        "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
    )

    # 3) 索引
    op.create_index(
        "idx_ad_upload_promoted_product_rows_scope_status",
        _TABLE,
        ["scope_status"],
    )

    # 4) 回填已有 25,729 行: 从 raw_row.__meta__.old_scope_status 提取
    #    没 meta 的（理论上不会有，因为我们迁入时都加了）保持 server_default 'included_product'
    op.execute(
        f"""
        UPDATE {_TABLE}
        SET scope_status = COALESCE(
            raw_row->'__meta__'->>'old_scope_status',
            'included_product'
        )
        WHERE raw_row->>'__meta__' IS NOT NULL
          AND raw_row->'__meta__'->>'old_scope_status' IN
              ('included_product', 'excluded_store_level', 'excluded_unmapped')
        """
    )


def downgrade() -> None:
    op.drop_index("idx_ad_upload_promoted_product_rows_scope_status", table_name=_TABLE)
    op.drop_constraint(
        "ck_ad_upload_promoted_product_rows_scope_status", _TABLE, type_="check"
    )
    op.drop_column(_TABLE, "scope_status")
