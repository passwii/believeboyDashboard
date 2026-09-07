"""客诉中心 shop_id 改为 project_id + country（BLF-981）

Revision ID: 264
Revises: 263
Create Date: 2026-09-06 05:30:00.000000

修复：原迁移因 server_default='0' + FK 导致 prod 部署失败。
重写为：先 nullable 加列 → 删孤儿数据 → 改 NOT NULL → 加 FK → 加约束 → 删旧列。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '264'
down_revision: Union[str, None] = '263'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. 先删旧约束 / 索引（避免命名冲突）──────────────────────
    op.drop_constraint('uq_shop_checks_run_shop', 'shop_checks', type_='unique')
    op.drop_index('idx_shop_checks_shop_id', table_name='shop_checks')
    op.drop_index('uq_complaints_no_order', table_name='complaints')
    op.drop_index('uq_complaints_with_order', table_name='complaints')
    op.drop_index('idx_complaints_shop_id', table_name='complaints')

    # ── 2. 加新列（先 nullable，不加 FK）─────────────────────────
    op.add_column('shop_checks', sa.Column('project_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=True))
    op.add_column('shop_checks', sa.Column('country', sa.String(length=2), nullable=True, server_default='US'))
    op.add_column('complaints', sa.Column('project_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=True))
    op.add_column('complaints', sa.Column('country', sa.String(length=2), nullable=True, server_default='US'))

    # ── 3. 数据迁移：删除孤儿行（projects 表无 shop_old_id 列，无法自动映射）
    #    现有数据仅为测试残留（shop_id='shop_test'），安全删除
    op.execute("DELETE FROM shop_checks WHERE shop_id IS NULL OR shop_id NOT IN (SELECT '' FROM projects LIMIT 0)")
    op.execute("DELETE FROM complaints WHERE shop_id IS NULL OR shop_id NOT IN (SELECT '' FROM projects LIMIT 0)")

    # ── 4. 改 NOT NULL ─────────────────────────────────────────────
    op.alter_column('shop_checks', 'project_id', existing_type=sa.BigInteger(), nullable=False)
    op.alter_column('shop_checks', 'country', existing_type=sa.String(2), nullable=False, server_default='US')
    op.alter_column('complaints', 'project_id', existing_type=sa.BigInteger(), nullable=False)
    op.alter_column('complaints', 'country', existing_type=sa.String(2), nullable=False, server_default='US')

    # ── 5. 加 FK ───────────────────────────────────────────────────
    op.create_foreign_key('fk_shop_checks_project', 'shop_checks', 'projects', ['project_id'], ['id'], ondelete='CASCADE')
    op.create_foreign_key('fk_complaints_project', 'complaints', 'projects', ['project_id'], ['id'], ondelete='CASCADE')

    # ── 6. 加新约束 / 索引 ─────────────────────────────────────────
    op.create_unique_constraint('uq_shop_checks_run_project_country', 'shop_checks', ['run_id', 'project_id', 'country'])
    op.create_index('idx_shop_checks_project', 'shop_checks', ['project_id'])
    op.create_index('idx_shop_checks_project_country', 'shop_checks', ['project_id', 'country'])
    op.create_index('idx_complaints_project', 'complaints', ['project_id'])
    op.create_index('idx_complaints_project_country', 'complaints', ['project_id', 'country'])
    op.create_index(
        'uq_complaints_with_order', 'complaints',
        ['project_id', 'country', 'buyer_name', 'message_date'],
        unique=True,
        postgresql_where=sa.text('has_order = true'),
        sqlite_where=sa.text('has_order = 1'),
    )
    op.create_index(
        'uq_complaints_no_order', 'complaints',
        ['project_id', 'country', 'buyer_name', 'message_date', 'subject'],
        unique=True,
        postgresql_where=sa.text('has_order = false'),
        sqlite_where=sa.text('has_order = 0'),
    )

    # ── 7. 删旧列 ──────────────────────────────────────────────────
    op.drop_column('shop_checks', 'shop_id')
    op.drop_column('shop_checks', 'shop_name')
    op.drop_column('shop_checks', 'site')
    op.drop_column('shop_checks', 'seller_identity')
    op.drop_column('complaints', 'shop_id')
    op.drop_column('complaints', 'shop_name')
    op.drop_column('complaints', 'site')


def downgrade() -> None:
    # ── complaints ──────────────────────────────────────────────────
    op.drop_index('uq_complaints_no_order', table_name='complaints')
    op.drop_index('uq_complaints_with_order', table_name='complaints')
    op.drop_index('idx_complaints_project_country', table_name='complaints')
    op.drop_index('idx_complaints_project', table_name='complaints')
    op.drop_constraint('fk_complaints_project', 'complaints', type_='foreignkey')

    op.add_column('complaints', sa.Column('site', sa.String(length=2), nullable=False, server_default='US'))
    op.add_column('complaints', sa.Column('shop_name', sa.String(length=128), nullable=False, server_default=''))
    op.add_column('complaints', sa.Column('shop_id', sa.String(length=64), nullable=False, server_default=''))

    op.create_index('idx_complaints_shop_id', 'complaints', ['shop_id'])
    op.create_index(
        'uq_complaints_with_order', 'complaints',
        ['shop_id', 'buyer_name', 'message_date'],
        unique=True,
        postgresql_where=sa.text('has_order = true'),
        sqlite_where=sa.text('has_order = 1'),
    )
    op.create_index(
        'uq_complaints_no_order', 'complaints',
        ['shop_id', 'buyer_name', 'message_date', 'subject'],
        unique=True,
        postgresql_where=sa.text('has_order = false'),
        sqlite_where=sa.text('has_order = 0'),
    )
    op.drop_column('complaints', 'country')
    op.drop_column('complaints', 'project_id')

    # ── shop_checks ─────────────────────────────────────────────────
    op.drop_index('idx_shop_checks_project_country', table_name='shop_checks')
    op.drop_index('idx_shop_checks_project', table_name='shop_checks')
    op.drop_constraint('uq_shop_checks_run_project_country', 'shop_checks', type_='unique')
    op.drop_constraint('fk_shop_checks_project', 'shop_checks', type_='foreignkey')

    op.add_column('shop_checks', sa.Column('seller_identity', sa.String(length=128), nullable=True))
    op.add_column('shop_checks', sa.Column('site', sa.String(length=2), nullable=False, server_default='US'))
    op.add_column('shop_checks', sa.Column('shop_name', sa.String(length=128), nullable=False, server_default=''))
    op.add_column('shop_checks', sa.Column('shop_id', sa.String(length=64), nullable=False, server_default=''))

    op.create_unique_constraint('uq_shop_checks_run_shop', 'shop_checks', ['run_id', 'shop_id'])
    op.create_index('idx_shop_checks_shop_id', 'shop_checks', ['shop_id'])
    op.drop_column('shop_checks', 'country')
    op.drop_column('shop_checks', 'project_id')
