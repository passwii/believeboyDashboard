"""create monthly report tables

Revision ID: 20260227_006
Revises: 20260226_005
Create Date: 2026-02-27 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '20260227_006'
down_revision: Union[str, None] = '20260226_005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def _money_column(name: str) -> sa.Column:
    return sa.Column(name, sa.Numeric(18, 2), nullable=False, server_default=sa.text('0'))


def _status_type(bind):
    if bind.dialect.name == 'postgresql':
        postgresql.ENUM('pending', 'running', 'success', 'failed', name='jobstatus').create(bind, checkfirst=True)
        return postgresql.ENUM('pending', 'running', 'success', 'failed', name='jobstatus', create_type=False)
    return sa.String(length=32)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    status_type = _status_type(bind)

    if not inspector.has_table('monthly_reports'):
        op.create_table(
            'monthly_reports',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('project_id', BIGINT_SQLITE, nullable=False),
            sa.Column('report_month', sa.Date(), nullable=False),
            sa.Column('transaction_file_id', sa.String(length=255), nullable=False),
            sa.Column('transaction_file_path', sa.String(length=1024), nullable=False),
            sa.Column('summary_pdf_file_id', sa.String(length=255), nullable=True),
            sa.Column('summary_pdf_file_path', sa.String(length=1024), nullable=True),
            sa.Column('result_file_path', sa.String(length=1024), nullable=True),
            sa.Column('settlement_id', sa.String(length=128), nullable=True),
            sa.Column('file_size', sa.BigInteger(), nullable=True),
            sa.Column('total_transactions', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('total_orders', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('total_refunds', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('total_adjustments', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('total_service_fees', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('total_trans_fees', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('status', status_type, nullable=False, server_default=sa.text("'pending'")),
            sa.Column('error_message', sa.Text(), nullable=True),
            sa.Column('calculation_version', sa.Integer(), nullable=False, server_default=sa.text('1')),
            sa.Column('computed_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('project_id', 'report_month', name='monthly_reports_project_month_key'),
        )
    op.execute('create index if not exists idx_monthly_reports_project_id on monthly_reports (project_id)')
    op.execute('create index if not exists idx_monthly_reports_report_month on monthly_reports (report_month)')
    op.execute('create index if not exists idx_monthly_reports_status on monthly_reports (status)')
    op.execute('create index if not exists idx_monthly_reports_project_month on monthly_reports (project_id, report_month)')

    if not inspector.has_table('monthly_report_transactions'):
        op.create_table(
            'monthly_report_transactions',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('report_id', BIGINT_SQLITE, nullable=False),
            sa.Column('source_row_no', sa.Integer(), nullable=False),
            sa.Column('transaction_date', sa.DateTime(timezone=True), nullable=False),
            sa.Column('settlement_id', sa.String(length=128), nullable=True),
            sa.Column('transaction_type', sa.String(length=64), nullable=False),
            sa.Column('order_id', sa.String(length=64), nullable=True),
            sa.Column('sku', sa.String(length=128), nullable=True),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column('quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('marketplace', sa.String(length=128), nullable=True),
            sa.Column('account_type', sa.String(length=128), nullable=True),
            sa.Column('fulfillment', sa.String(length=64), nullable=True),
            sa.Column('order_city', sa.String(length=128), nullable=True),
            sa.Column('order_state', sa.String(length=128), nullable=True),
            sa.Column('order_postal', sa.String(length=32), nullable=True),
            sa.Column('tax_collection_model', sa.String(length=128), nullable=True),
            _money_column('product_sales'),
            _money_column('product_sales_tax'),
            _money_column('shipping_credits'),
            _money_column('shipping_credits_tax'),
            _money_column('gift_wrap_credits'),
            _money_column('gift_wrap_credits_tax'),
            _money_column('regulatory_fee'),
            _money_column('regulatory_fee_tax'),
            _money_column('promotional_rebates'),
            _money_column('promotional_rebates_tax'),
            _money_column('marketplace_withheld_tax'),
            _money_column('selling_fees'),
            _money_column('fba_fees'),
            _money_column('other_transaction_fees'),
            _money_column('other_amount'),
            _money_column('total'),
            sa.Column('raw_row', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['report_id'], ['monthly_reports.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('report_id', 'source_row_no', name='monthly_report_transactions_report_row_key'),
        )
    op.execute('create index if not exists idx_monthly_transactions_report_id on monthly_report_transactions (report_id)')
    op.execute('create index if not exists idx_monthly_transactions_report_type on monthly_report_transactions (report_id, transaction_type)')
    op.execute('create index if not exists idx_monthly_transactions_report_date on monthly_report_transactions (report_id, transaction_date)')
    op.execute('create index if not exists idx_monthly_transactions_report_sku on monthly_report_transactions (report_id, sku)')
    op.execute('create index if not exists idx_monthly_transactions_report_order on monthly_report_transactions (report_id, order_id)')

    if not inspector.has_table('monthly_report_pt3_calculation'):
        op.create_table(
            'monthly_report_pt3_calculation',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('report_id', BIGINT_SQLITE, nullable=False),
            _money_column('income_product_sales_non_fba'),
            _money_column('income_product_sale_refunds_non_fba'),
            _money_column('income_fba_product_sales'),
            _money_column('income_fba_product_sale_refunds'),
            _money_column('income_fba_inventory_credit'),
            _money_column('income_fba_liquidation_proceeds'),
            _money_column('income_shipping_credits'),
            _money_column('income_shipping_credit_refunds'),
            _money_column('income_gift_wrap_credits'),
            _money_column('income_gift_wrap_credits_refunds'),
            _money_column('income_promotional_rebates'),
            _money_column('income_promotional_rebate_refunds'),
            _money_column('income_a_to_z_guarantee_claims'),
            _money_column('income_chargebacks'),
            _money_column('income_safe_t_reimbursement'),
            _money_column('income_total'),
            _money_column('expense_seller_fulfilled_selling_fees'),
            _money_column('expense_fba_selling_fees'),
            _money_column('expense_selling_fee_refunds'),
            _money_column('expense_fba_transaction_fees'),
            _money_column('expense_fba_transaction_fee_refunds'),
            _money_column('expense_other_transaction_fees'),
            _money_column('expense_other_transaction_fee_refunds'),
            _money_column('expense_fba_inventory_and_inbound_services_fees'),
            _money_column('expense_shipping_label_purchases'),
            _money_column('expense_shipping_label_refunds'),
            _money_column('expense_carrier_shipping_label_adjustments'),
            _money_column('expense_service_fees'),
            _money_column('expense_refund_administration_fees'),
            _money_column('expense_adjustments'),
            _money_column('expense_cost_of_advertising'),
            _money_column('expense_refund_for_advertiser'),
            _money_column('expense_liquidations_fees'),
            _money_column('expense_receivables'),
            _money_column('expense_deductions'),
            _money_column('expense_amazon_shipping_charge_adjustments'),
            _money_column('expense_total'),
            _money_column('amazon_pay_back'),
            sa.Column('advertising_percentage', sa.Numeric(8, 4), nullable=False, server_default=sa.text('0')),
            sa.Column('calculation_version', sa.Integer(), nullable=False, server_default=sa.text('1')),
            sa.Column('computed_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['report_id'], ['monthly_reports.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('report_id', name='monthly_report_pt3_report_key'),
        )
    op.execute('create index if not exists idx_monthly_pt3_report_id on monthly_report_pt3_calculation (report_id)')

    if not inspector.has_table('monthly_report_pt4_calculation'):
        op.create_table(
            'monthly_report_pt4_calculation',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('report_id', BIGINT_SQLITE, nullable=False),
            _money_column('income_sales'),
            _money_column('income_refund'),
            _money_column('income_adjustment'),
            _money_column('income_other'),
            _money_column('income_total'),
            _money_column('expense_selling_fee'),
            _money_column('expense_fba_fee'),
            _money_column('expense_inventory_fee'),
            _money_column('expense_service_fee'),
            _money_column('expense_advertising'),
            _money_column('expense_other_fees'),
            _money_column('expense_total'),
            _money_column('amazon_pay_back'),
            sa.Column('calculation_version', sa.Integer(), nullable=False, server_default=sa.text('1')),
            sa.Column('computed_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['report_id'], ['monthly_reports.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('report_id', name='monthly_report_pt4_report_key'),
        )
    op.execute('create index if not exists idx_monthly_pt4_report_id on monthly_report_pt4_calculation (report_id)')

    if not inspector.has_table('monthly_report_sku_stats'):
        op.create_table(
            'monthly_report_sku_stats',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('report_id', BIGINT_SQLITE, nullable=False),
            sa.Column('sku', sa.String(length=128), nullable=False),
            sa.Column('product_name', sa.Text(), nullable=True),
            sa.Column('sales_quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('sales_orders', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('fba_sales_quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('fba_sales_orders', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('fbm_sales_quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('fbm_sales_orders', sa.Integer(), nullable=False, server_default=sa.text('0')),
            _money_column('sales_amount'),
            _money_column('fba_sales_amount'),
            _money_column('fbm_sales_amount'),
            sa.Column('refund_quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('refund_orders', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('fba_refund_quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('fba_refund_orders', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('fbm_refund_quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('fbm_refund_orders', sa.Integer(), nullable=False, server_default=sa.text('0')),
            _money_column('refund_amount'),
            _money_column('fba_refund_amount'),
            _money_column('fbm_refund_amount'),
            sa.Column('net_quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            _money_column('net_amount'),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['report_id'], ['monthly_reports.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('report_id', 'sku', name='monthly_report_sku_stats_report_sku_key'),
        )
    op.execute('create index if not exists idx_monthly_sku_stats_report_id on monthly_report_sku_stats (report_id)')
    op.execute('create index if not exists idx_monthly_sku_stats_report_sku on monthly_report_sku_stats (report_id, sku)')


def downgrade() -> None:
    op.execute('drop index if exists idx_monthly_sku_stats_report_sku')
    op.execute('drop index if exists idx_monthly_sku_stats_report_id')
    op.execute('drop table if exists monthly_report_sku_stats')

    op.execute('drop index if exists idx_monthly_pt4_report_id')
    op.execute('drop table if exists monthly_report_pt4_calculation')

    op.execute('drop index if exists idx_monthly_pt3_report_id')
    op.execute('drop table if exists monthly_report_pt3_calculation')

    op.execute('drop index if exists idx_monthly_transactions_report_order')
    op.execute('drop index if exists idx_monthly_transactions_report_sku')
    op.execute('drop index if exists idx_monthly_transactions_report_date')
    op.execute('drop index if exists idx_monthly_transactions_report_type')
    op.execute('drop index if exists idx_monthly_transactions_report_id')
    op.execute('drop table if exists monthly_report_transactions')

    op.execute('drop index if exists idx_monthly_reports_project_month')
    op.execute('drop index if exists idx_monthly_reports_status')
    op.execute('drop index if exists idx_monthly_reports_report_month')
    op.execute('drop index if exists idx_monthly_reports_project_id')
    op.execute('drop table if exists monthly_reports')
