"""店铺身份对照：project_shops 加 shop_name/别名列，shop_checks 加身份留存列（BLF-1022）

Revision ID: 267
Revises: 266
Create Date: 2026-09-10 00:00:00.000000

R0 需要 project_shops 返回 shop_name（KJVS 首选启动参数，唯一名称解析值）
与 seller_identity_*（Seller Central 账户切换器 alias 对照）；
W1 需要 shop_checks 随行留存 identity_* 观测值以便追溯串店。
不存密码/token/邮箱；alias 变更走 operation_audit_logs 审计（应用层），
不在此迁移建表。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '267'
down_revision: Union[str, None] = '266'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── project_shops：启动名称 + 身份对照 ──────────────────────────
    op.add_column('project_shops', sa.Column('shop_name', sa.String(length=128), nullable=True))
    op.add_column(
        'project_shops',
        sa.Column('seller_identity_expected_alias', sa.String(length=128), nullable=True),
    )
    op.add_column(
        'project_shops',
        sa.Column('seller_identity_aliases', sa.JSON(), nullable=False, server_default='[]'),
    )
    op.add_column(
        'project_shops',
        sa.Column('seller_identity_source', sa.String(length=128), nullable=True),
    )
    op.add_column(
        'project_shops',
        sa.Column('seller_identity_required', sa.Boolean(), nullable=False, server_default='1'),
    )
    op.create_unique_constraint(
        'uq_project_shops_shop_name', 'project_shops', ['shop_name']
    )
    # BLF-1022 实测：'identity_mismatch' 17 字符，旧 VARCHAR(16) 会 500，做宽。
    op.alter_column(
        'shop_checks', 'check_status',
        existing_type=sa.String(length=16),
        type_=sa.String(length=32),
        existing_nullable=False,
    )
    op.add_column(
        'shop_checks', sa.Column('identity_expected_alias', sa.String(length=128), nullable=True)
    )
    op.add_column(
        'shop_checks', sa.Column('identity_observed_alias', sa.String(length=128), nullable=True)
    )
    op.add_column(
        'shop_checks',
        sa.Column('identity_observed_country', sa.JSON(), nullable=False, server_default='[]'),
    )
    op.add_column('shop_checks', sa.Column('identity_verified', sa.Boolean(), nullable=True))
    op.add_column(
        'shop_checks', sa.Column('identity_source', sa.String(length=128), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('shop_checks', 'identity_source')
    op.drop_column('shop_checks', 'identity_verified')
    op.drop_column('shop_checks', 'identity_observed_country')
    op.drop_column('shop_checks', 'identity_observed_alias')
    op.drop_column('shop_checks', 'identity_expected_alias')
    op.alter_column(
        'shop_checks', 'check_status',
        existing_type=sa.String(length=32),
        type_=sa.String(length=16),
        existing_nullable=False,
    )

    op.drop_constraint('uq_project_shops_shop_name', 'project_shops', type_='unique')
    op.drop_column('project_shops', 'seller_identity_required')
    op.drop_column('project_shops', 'seller_identity_source')
    op.drop_column('project_shops', 'seller_identity_aliases')
    op.drop_column('project_shops', 'seller_identity_expected_alias')
    op.drop_column('project_shops', 'shop_name')
