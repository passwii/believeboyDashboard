"""add vat_enabled and vat invoice tables

- projects.vat_enabled: 按店铺开关 VAT 功能（替代旧的 '弥森' 白名单常量）
- vat_entities: 按店铺×国家的 VAT 主体（company_name / vat_id / 地址...）
- vat_invoices / vat_invoice_lines: 发票存档与明细行，状态 draft/issued/voided

Revision ID: a1b2c3d4e5f6
Revises: 20260713_212
Create Date: 2026-07-15
"""
from __future__ import annotations
from alembic import op
import sqlalchemy as sa


revision = 'a1b2c3d4e5f6'
down_revision = '20260713_212'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) projects: 增 vat_enabled 列（默认 False，避免影响历史店铺）
    op.add_column(
        'projects',
        sa.Column('vat_enabled', sa.Boolean(), nullable=False, server_default=sa.text('0')),
    )

    # 2) vat_entities
    op.create_table(
        'vat_entities',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer, 'sqlite'), primary_key=True, autoincrement=True),
        sa.Column('project_id', sa.BigInteger().with_variant(sa.Integer, 'sqlite'),
                  sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('country', sa.String(length=2), nullable=False),
        sa.Column('company_name', sa.String(length=255), nullable=False),
        sa.Column('vat_id', sa.String(length=64), nullable=False, server_default=''),
        sa.Column('address_line', sa.String(length=512), nullable=False, server_default=''),
        sa.Column('postal_code', sa.String(length=32), nullable=False, server_default=''),
        sa.Column('city', sa.String(length=128), nullable=False, server_default=''),
        sa.Column('email', sa.String(length=255), nullable=False, server_default=''),
        sa.Column('is_default', sa.Boolean(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint('project_id', 'country', name='uq_vat_entities_project_country'),
    )
    op.create_index('idx_vat_entities_project', 'vat_entities', ['project_id'])

    # 3) vat_invoices
    op.create_table(
        'vat_invoices',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer, 'sqlite'), primary_key=True, autoincrement=True),
        sa.Column('invoice_no', sa.String(length=64), nullable=False),
        sa.Column('project_id', sa.BigInteger().with_variant(sa.Integer, 'sqlite'),
                  sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('seller_entity_id', sa.BigInteger().with_variant(sa.Integer, 'sqlite'),
                  sa.ForeignKey('vat_entities.id', ondelete='SET NULL'), nullable=True),
        sa.Column('seller_snapshot', sa.JSON(), nullable=False),
        sa.Column('buyer', sa.JSON(), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('order_id', sa.String(length=64), nullable=False, server_default=''),
        sa.Column('invoice_date', sa.Date(), nullable=False),
        sa.Column('shipping_incl_vat', sa.Numeric(18, 2), nullable=False, server_default='0'),
        sa.Column('subtotal_excl', sa.Numeric(18, 2), nullable=False, server_default='0'),
        sa.Column('total_vat', sa.Numeric(18, 2), nullable=False, server_default='0'),
        sa.Column('total_incl', sa.Numeric(18, 2), nullable=False, server_default='0'),
        sa.Column('summary_by_rate', sa.JSON(), nullable=False),
        sa.Column('r2_key', sa.String(length=512), nullable=True),
        sa.Column('r2_url', sa.String(length=1024), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='draft'),
        sa.Column('created_by', sa.String(length=128), nullable=True),
        sa.Column('void_reason', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint('project_id', 'invoice_no', name='uq_vat_invoices_project_no'),
        sa.CheckConstraint("status IN ('draft','issued','voided')", name='ck_vat_invoices_status'),
    )
    op.create_index('idx_vat_invoices_project', 'vat_invoices', ['project_id'])
    op.create_index('idx_vat_invoices_date', 'vat_invoices', ['invoice_date'])

    # 4) vat_invoice_lines
    op.create_table(
        'vat_invoice_lines',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer, 'sqlite'), primary_key=True, autoincrement=True),
        sa.Column('invoice_id', sa.BigInteger().with_variant(sa.Integer, 'sqlite'),
                  sa.ForeignKey('vat_invoices.id', ondelete='CASCADE'), nullable=False),
        sa.Column('line_no', sa.Integer(), nullable=False),
        sa.Column('description', sa.String(length=512), nullable=False, server_default=''),
        sa.Column('asin', sa.String(length=32), nullable=False, server_default=''),
        sa.Column('qty', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('unit_price_incl_vat', sa.Numeric(18, 2), nullable=False, server_default='0'),
        sa.Column('vat_rate', sa.Numeric(5, 2), nullable=False, server_default='0'),
        sa.Column('line_excl', sa.Numeric(18, 2), nullable=False, server_default='0'),
        sa.Column('line_vat', sa.Numeric(18, 2), nullable=False, server_default='0'),
        sa.Column('line_incl', sa.Numeric(18, 2), nullable=False, server_default='0'),
        sa.UniqueConstraint('invoice_id', 'line_no', name='uq_vat_invoice_lines_inv_no'),
    )
    op.create_index('idx_vat_invoice_lines_inv', 'vat_invoice_lines', ['invoice_id'])

    # 5) seed: 给历史 VAT 主体店铺（弥森）默认开启 VAT
    op.execute("UPDATE projects SET vat_enabled = 1 WHERE project_name = '弥森'")


def downgrade() -> None:
    op.drop_index('idx_vat_invoice_lines_inv', table_name='vat_invoice_lines')
    op.drop_table('vat_invoice_lines')
    op.drop_index('idx_vat_invoices_date', table_name='vat_invoices')
    op.drop_index('idx_vat_invoices_project', table_name='vat_invoices')
    op.drop_table('vat_invoices')
    op.drop_index('idx_vat_entities_project', table_name='vat_entities')
    op.drop_table('vat_entities')
    op.drop_column('projects', 'vat_enabled')
