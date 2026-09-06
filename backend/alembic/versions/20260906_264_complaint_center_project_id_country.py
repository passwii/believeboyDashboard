"""客诉中心 shop_id 改为 project_id + country（BLF-981）

Revision ID: 264
Revises: 263
Create Date: 2026-09-06 05:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '264'
down_revision: Union[str, None] = '263'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── shop_checks：shop_id → project_id + country ────────────────
    op.drop_index('idx_shop_checks_shop_id', table_name='shop_checks')
    op.drop_constraint('uq_shop_checks_run_shop', 'shop_checks', type_='unique')

    op.add_column(
        'shop_checks',
        sa.Column(
            'project_id',
            sa.BigInteger().with_variant(sa.Integer(), 'sqlite'),
            sa.ForeignKey('projects.id', ondelete='CASCADE'),
            nullable=False,
            server_default='0',
        ),
    )
    op.add_column(
        'shop_checks',
        sa.Column('country', sa.String(length=2), nullable=False, server_default='US'),
    )
    op.create_unique_constraint(
        'uq_shop_checks_run_project_country', 'shop_checks',
        ['run_id', 'project_id', 'country'],
    )
    op.create_index('idx_shop_checks_project', 'shop_checks', ['project_id'])
    op.create_index('idx_shop_checks_project_country', 'shop_checks', ['project_id', 'country'])

    op.drop_column('shop_checks', 'shop_id')
    op.drop_column('shop_checks', 'shop_name')
    op.drop_column('shop_checks', 'site')
    op.drop_column('shop_checks', 'seller_identity')

    # ── complaints：shop_id → project_id + country ────────────────
    op.drop_index('uq_complaints_no_order', table_name='complaints')
    op.drop_index('uq_complaints_with_order', table_name='complaints')
    op.drop_index('idx_complaints_shop_id', table_name='complaints')

    op.add_column(
        'complaints',
        sa.Column(
            'project_id',
            sa.BigInteger().with_variant(sa.Integer(), 'sqlite'),
            sa.ForeignKey('projects.id', ondelete='CASCADE'),
            nullable=False,
            server_default='0',
        ),
    )
    op.add_column(
        'complaints',
        sa.Column('country', sa.String(length=2), nullable=False, server_default='US'),
    )
    op.create_index('idx_complaints_project', 'complaints', ['project_id'])
    op.create_index('idx_complaints_project_country', 'complaints', ['project_id', 'country'])

    op.create_index(
        'uq_complaints_with_order',
        'complaints',
        ['project_id', 'country', 'buyer_name', 'message_date'],
        unique=True,
        postgresql_where=sa.text('has_order = true'),
        sqlite_where=sa.text('has_order = 1'),
    )
    op.create_index(
        'uq_complaints_no_order',
        'complaints',
        ['project_id', 'country', 'buyer_name', 'message_date', 'subject'],
        unique=True,
        postgresql_where=sa.text('has_order = false'),
        sqlite_where=sa.text('has_order = 0'),
    )

    op.drop_column('complaints', 'shop_id')
    op.drop_column('complaints', 'shop_name')
    op.drop_column('complaints', 'site')


def downgrade() -> None:
    # ── complaints ──────────────────────────────────────────────────
    op.drop_index('uq_complaints_no_order', table_name='complaints')
    op.drop_index('uq_complaints_with_order', table_name='complaints')
    op.drop_index('idx_complaints_project_country', table_name='complaints')
    op.drop_index('idx_complaints_project', table_name='complaints')

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

    op.add_column('shop_checks', sa.Column('seller_identity', sa.String(length=128), nullable=True))
    op.add_column('shop_checks', sa.Column('site', sa.String(length=2), nullable=False, server_default='US'))
    op.add_column('shop_checks', sa.Column('shop_name', sa.String(length=128), nullable=False, server_default=''))
    op.add_column('shop_checks', sa.Column('shop_id', sa.String(length=64), nullable=False, server_default=''))

    op.create_unique_constraint('uq_shop_checks_run_shop', 'shop_checks', ['run_id', 'shop_id'])
    op.create_index('idx_shop_checks_shop_id', 'shop_checks', ['shop_id'])
    op.drop_column('shop_checks', 'country')
    op.drop_column('shop_checks', 'project_id')
