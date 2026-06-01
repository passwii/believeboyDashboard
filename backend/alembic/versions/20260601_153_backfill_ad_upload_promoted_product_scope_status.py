"""backfill scope_status from raw_row.__meta__.old_scope_status

alembic 151 升级时 (加 scope_status 列) 通常还没数据, 所以它内置的回填 SQL 跑了 0 行。
migrate_ad_product_to_upload.py 写数据时, scope_status 用 server_default='included_product',
但 raw_row 里的 __meta__.old_scope_status 才是真实 scope (included_product / excluded_store_level / excluded_unmapped)。

这个 migration 在 alembic 152 之后跑 (即 migrate 数据写入 + A 表删除 都完成之后),
把 scope_status 列更新为 raw_row.__meta__.old_scope_status, 保证列值跟实际 scope 一致。

修订 ID: 153
Revises: 152
Create Date: 2026-06-01
"""
from alembic import op


revision = "153"
down_revision = "152"
branch_labels = None
depends_on = None


_TABLE = "ad_upload_promoted_product_rows"


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE {_TABLE}
        SET scope_status = raw_row->'__meta__'->>'old_scope_status'
        WHERE raw_row->>'__meta__' IS NOT NULL
          AND raw_row->'__meta__'->>'old_scope_status' IN
              ('included_product', 'excluded_store_level', 'excluded_unmapped')
          AND scope_status != raw_row->'__meta__'->>'old_scope_status'
        """
    )


def downgrade() -> None:
    # 不可逆: 已经更新过的 scope_status 列值无法恢复
    # 但 schema (列结构) 不变, 所以只清掉函数体即可
    pass
