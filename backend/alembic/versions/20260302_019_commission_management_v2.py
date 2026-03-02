"""commission management v2 tables and commission record hardening

Revision ID: 20260302_019
Revises: 20260302_018
Create Date: 2026-03-02 23:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260302_019'
down_revision: Union[str, None] = '20260302_018'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(col['name'] == column_name for col in inspector.get_columns(table_name))


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get('name') == index_name for idx in inspector.get_indexes(table_name))


def _has_fk(inspector: sa.Inspector, table_name: str, fk_name: str) -> bool:
    return any(fk.get('name') == fk_name for fk in inspector.get_foreign_keys(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if _has_table(inspector, 'project_role_assignments') is False:
        op.create_table(
            'project_role_assignments',
            sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column('project_id', sa.BigInteger(), nullable=False),
            sa.Column('role_type', sa.String(length=16), nullable=False),
            sa.Column('person_name', sa.String(length=255), nullable=False),
            sa.Column('effective_from_month', sa.String(length=7), nullable=False),
            sa.Column('effective_to_month', sa.String(length=7), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint(
                'project_id',
                'role_type',
                'person_name',
                'effective_from_month',
                name='project_role_assignments_unique_role_window',
            ),
            sa.CheckConstraint("role_type in ('operator', 'assistant')", name='ck_project_role_assignments_role_type'),
            sa.CheckConstraint("effective_from_month LIKE '____-__'", name='ck_project_role_assignments_from_month_format'),
            sa.CheckConstraint(
                "effective_to_month is null or effective_to_month LIKE '____-__'",
                name='ck_project_role_assignments_to_month_format',
            ),
            sa.CheckConstraint(
                'effective_to_month is null or effective_to_month >= effective_from_month',
                name='ck_project_role_assignments_month_window',
            ),
        )
        op.create_index('idx_project_role_assignments_project_role', 'project_role_assignments', ['project_id', 'role_type'], unique=False)
        op.create_index('idx_project_role_assignments_month_window', 'project_role_assignments', ['effective_from_month', 'effective_to_month'], unique=False)
        op.create_index('ix_project_role_assignments_project_id', 'project_role_assignments', ['project_id'], unique=False)

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'commission_project_months') is False:
        op.create_table(
            'commission_project_months',
            sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column('report_month', sa.String(length=7), nullable=False),
            sa.Column('project_id', sa.BigInteger(), nullable=False),
            sa.Column('project_name', sa.String(length=255), nullable=False),
            sa.Column('income_total_usd', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('factory_commission_rate', sa.Numeric(8, 6), nullable=False, server_default=sa.text('0')),
            sa.Column('usd_to_rmb_rate', sa.Numeric(18, 8), nullable=False, server_default=sa.text('0')),
            sa.Column('factory_commission_usd', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('factory_commission_rmb', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('payment_status', sa.String(length=16), nullable=False, server_default=sa.text("'unpaid'")),
            sa.Column('received_rmb', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('payment_confirmed_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('payment_confirmed_by', sa.String(length=255), nullable=True),
            sa.Column('note', sa.String(length=500), nullable=True),
            sa.Column('computed_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('report_month', 'project_id', name='commission_project_months_unique_month_project'),
            sa.CheckConstraint("report_month LIKE '____-__'", name='ck_commission_project_months_report_month_format'),
            sa.CheckConstraint(
                "payment_status in ('unpaid', 'partial', 'paid')",
                name='ck_commission_project_months_payment_status',
            ),
            sa.CheckConstraint('income_total_usd >= 0', name='ck_commission_project_months_income_total_usd'),
            sa.CheckConstraint(
                'factory_commission_rate >= 0 and factory_commission_rate <= 1',
                name='ck_commission_project_months_factory_rate',
            ),
            sa.CheckConstraint('usd_to_rmb_rate >= 0', name='ck_commission_project_months_exchange_rate'),
            sa.CheckConstraint('factory_commission_usd >= 0', name='ck_commission_project_months_factory_commission_usd'),
            sa.CheckConstraint('factory_commission_rmb >= 0', name='ck_commission_project_months_factory_commission_rmb'),
            sa.CheckConstraint('received_rmb >= 0', name='ck_commission_project_months_received_rmb'),
        )
        op.create_index('idx_commission_project_months_month', 'commission_project_months', ['report_month'], unique=False)
        op.create_index('idx_commission_project_months_payment_status', 'commission_project_months', ['payment_status'], unique=False)
        op.create_index('ix_commission_project_months_project_id', 'commission_project_months', ['project_id'], unique=False)

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'commission_ratio_overrides') is False:
        op.create_table(
            'commission_ratio_overrides',
            sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column('report_month', sa.String(length=7), nullable=False),
            sa.Column('project_id', sa.BigInteger(), nullable=False),
            sa.Column('project_name', sa.String(length=255), nullable=False),
            sa.Column('person_name', sa.String(length=255), nullable=False),
            sa.Column('income_category', sa.String(length=16), nullable=False),
            sa.Column('override_ratio', sa.Numeric(8, 6), nullable=False),
            sa.Column('reason', sa.String(length=500), nullable=True),
            sa.Column('updated_by', sa.String(length=255), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint(
                'report_month',
                'project_id',
                'person_name',
                'income_category',
                name='commission_ratio_overrides_unique_month_project_person_category',
            ),
            sa.CheckConstraint("report_month LIKE '____-__'", name='ck_commission_ratio_overrides_report_month_format'),
            sa.CheckConstraint("income_category in ('operator', 'assistant')", name='ck_commission_ratio_overrides_income_category'),
            sa.CheckConstraint('override_ratio >= 0 and override_ratio <= 1', name='ck_commission_ratio_overrides_ratio'),
        )
        op.create_index('idx_commission_ratio_overrides_month', 'commission_ratio_overrides', ['report_month'], unique=False)
        op.create_index('idx_commission_ratio_overrides_person_month', 'commission_ratio_overrides', ['person_name', 'report_month'], unique=False)
        op.create_index('ix_commission_ratio_overrides_project_id', 'commission_ratio_overrides', ['project_id'], unique=False)

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'commission_records'):
        if _has_column(inspector, 'commission_records', 'project_month_id') is False:
            op.add_column('commission_records', sa.Column('project_month_id', sa.BigInteger(), nullable=True))
        if _has_column(inspector, 'commission_records', 'ratio_source') is False:
            op.add_column('commission_records', sa.Column('ratio_source', sa.String(length=16), nullable=False, server_default=sa.text("'rule'")))
        if _has_column(inspector, 'commission_records', 'manual_ratio') is False:
            op.add_column('commission_records', sa.Column('manual_ratio', sa.Numeric(8, 6), nullable=True))
        if _has_column(inspector, 'commission_records', 'is_locked') is False:
            op.add_column('commission_records', sa.Column('is_locked', sa.Boolean(), nullable=False, server_default=sa.text('false')))
        if _has_column(inspector, 'commission_records', 'locked_at') is False:
            op.add_column('commission_records', sa.Column('locked_at', sa.DateTime(timezone=True), nullable=True))
        if _has_column(inspector, 'commission_records', 'locked_by') is False:
            op.add_column('commission_records', sa.Column('locked_by', sa.String(length=255), nullable=True))
        if _has_column(inspector, 'commission_records', 'is_active') is False:
            op.add_column('commission_records', sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.text('true')))
        if _has_column(inspector, 'commission_records', 'deactivated_at') is False:
            op.add_column('commission_records', sa.Column('deactivated_at', sa.DateTime(timezone=True), nullable=True))

        inspector = sa.inspect(bind)
        if _has_index(inspector, 'commission_records', 'idx_commission_records_month_active') is False:
            op.create_index('idx_commission_records_month_active', 'commission_records', ['report_month', 'is_active'], unique=False)
        if _has_index(inspector, 'commission_records', 'ix_commission_records_project_month_id') is False:
            op.create_index('ix_commission_records_project_month_id', 'commission_records', ['project_month_id'], unique=False)

        if dialect == 'postgresql':
            op.execute("alter table commission_records drop constraint if exists ck_commission_records_ratio_source")
            op.execute(
                "alter table commission_records add constraint ck_commission_records_ratio_source "
                "check (ratio_source in ('rule', 'manual'))"
            )
            op.execute("alter table commission_records drop constraint if exists ck_commission_records_manual_ratio")
            op.execute(
                "alter table commission_records add constraint ck_commission_records_manual_ratio "
                "check (manual_ratio is null or (manual_ratio >= 0 and manual_ratio <= 1))"
            )

        inspector = sa.inspect(bind)
        if dialect != 'sqlite' and _has_fk(inspector, 'commission_records', 'fk_commission_records_project_month_id') is False:
            op.create_foreign_key(
                'fk_commission_records_project_month_id',
                'commission_records',
                'commission_project_months',
                ['project_month_id'],
                ['id'],
                ondelete='SET NULL',
            )

        op.execute(
            sa.text(
                '''
                insert into commission_project_months (
                    report_month,
                    project_id,
                    project_name,
                    income_total_usd,
                    factory_commission_rate,
                    usd_to_rmb_rate,
                    factory_commission_usd,
                    factory_commission_rmb,
                    payment_status,
                    received_rmb,
                    payment_confirmed_at,
                    payment_confirmed_by,
                    computed_at,
                    created_at,
                    updated_at
                )
                select
                    r.report_month,
                    r.project_id,
                    max(r.project_name) as project_name,
                    max(r.income_total_usd) as income_total_usd,
                    max(r.factory_commission_rate) as factory_commission_rate,
                    max(r.usd_to_rmb_rate) as usd_to_rmb_rate,
                    round(max(r.income_total_usd) * max(r.factory_commission_rate), 2) as factory_commission_usd,
                    round(max(r.income_total_usd) * max(r.factory_commission_rate) * max(r.usd_to_rmb_rate), 2) as factory_commission_rmb,
                    case
                        when sum(case when r.payment_status = 'paid' then 1 else 0 end) = count(*) then 'paid'
                        when sum(case when r.payment_status = 'paid' then 1 else 0 end) > 0 then 'partial'
                        else 'unpaid'
                    end as payment_status,
                    case
                        when sum(case when r.payment_status = 'paid' then 1 else 0 end) = count(*)
                            then round(max(r.income_total_usd) * max(r.factory_commission_rate) * max(r.usd_to_rmb_rate), 2)
                        else 0
                    end as received_rmb,
                    max(r.payment_confirmed_at) as payment_confirmed_at,
                    max(r.payment_confirmed_by) as payment_confirmed_by,
                    CURRENT_TIMESTAMP as computed_at,
                    CURRENT_TIMESTAMP as created_at,
                    CURRENT_TIMESTAMP as updated_at
                from commission_records r
                group by r.report_month, r.project_id
                on conflict (report_month, project_id)
                do update set
                    project_name = excluded.project_name,
                    income_total_usd = excluded.income_total_usd,
                    factory_commission_rate = excluded.factory_commission_rate,
                    usd_to_rmb_rate = excluded.usd_to_rmb_rate,
                    factory_commission_usd = excluded.factory_commission_usd,
                    factory_commission_rmb = excluded.factory_commission_rmb,
                    computed_at = excluded.computed_at,
                    updated_at = excluded.updated_at
                '''
            )
        )

        if dialect == 'sqlite':
            op.execute(
                sa.text(
                    '''
                    update commission_records
                    set project_month_id = (
                        select m.id
                        from commission_project_months m
                        where commission_records.project_month_id is null
                          and commission_records.report_month = m.report_month
                          and commission_records.project_id = m.project_id
                        limit 1
                    )
                    where project_month_id is null
                    '''
                )
            )
        else:
            op.execute(
                sa.text(
                    '''
                    update commission_records r
                    set project_month_id = m.id
                    from commission_project_months m
                    where r.project_month_id is null
                      and r.report_month = m.report_month
                      and r.project_id = m.project_id
                    '''
                )
            )
        op.execute(sa.text("update commission_records set ratio_source = 'rule' where ratio_source is null"))
        op.execute(sa.text('update commission_records set is_active = true where is_active is null'))
        op.execute(sa.text('update commission_records set is_locked = false where is_locked is null'))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if _has_table(inspector, 'commission_records'):
        if _has_index(inspector, 'commission_records', 'ix_commission_records_project_month_id'):
            op.drop_index('ix_commission_records_project_month_id', table_name='commission_records')
        if _has_index(inspector, 'commission_records', 'idx_commission_records_month_active'):
            op.drop_index('idx_commission_records_month_active', table_name='commission_records')

        if dialect == 'postgresql':
            op.execute('alter table commission_records drop constraint if exists fk_commission_records_project_month_id')
            op.execute('alter table commission_records drop constraint if exists ck_commission_records_manual_ratio')
            op.execute('alter table commission_records drop constraint if exists ck_commission_records_ratio_source')

        inspector = sa.inspect(bind)
        for column_name in ['deactivated_at', 'is_active', 'locked_by', 'locked_at', 'is_locked', 'manual_ratio', 'ratio_source', 'project_month_id']:
            if _has_column(inspector, 'commission_records', column_name):
                op.drop_column('commission_records', column_name)

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'commission_ratio_overrides'):
        if _has_index(inspector, 'commission_ratio_overrides', 'ix_commission_ratio_overrides_project_id'):
            op.drop_index('ix_commission_ratio_overrides_project_id', table_name='commission_ratio_overrides')
        if _has_index(inspector, 'commission_ratio_overrides', 'idx_commission_ratio_overrides_person_month'):
            op.drop_index('idx_commission_ratio_overrides_person_month', table_name='commission_ratio_overrides')
        if _has_index(inspector, 'commission_ratio_overrides', 'idx_commission_ratio_overrides_month'):
            op.drop_index('idx_commission_ratio_overrides_month', table_name='commission_ratio_overrides')
        op.drop_table('commission_ratio_overrides')

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'project_role_assignments'):
        if _has_index(inspector, 'project_role_assignments', 'ix_project_role_assignments_project_id'):
            op.drop_index('ix_project_role_assignments_project_id', table_name='project_role_assignments')
        if _has_index(inspector, 'project_role_assignments', 'idx_project_role_assignments_month_window'):
            op.drop_index('idx_project_role_assignments_month_window', table_name='project_role_assignments')
        if _has_index(inspector, 'project_role_assignments', 'idx_project_role_assignments_project_role'):
            op.drop_index('idx_project_role_assignments_project_role', table_name='project_role_assignments')
        op.drop_table('project_role_assignments')

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'commission_project_months'):
        if _has_index(inspector, 'commission_project_months', 'ix_commission_project_months_project_id'):
            op.drop_index('ix_commission_project_months_project_id', table_name='commission_project_months')
        if _has_index(inspector, 'commission_project_months', 'idx_commission_project_months_payment_status'):
            op.drop_index('idx_commission_project_months_payment_status', table_name='commission_project_months')
        if _has_index(inspector, 'commission_project_months', 'idx_commission_project_months_month'):
            op.drop_index('idx_commission_project_months_month', table_name='commission_project_months')
        op.drop_table('commission_project_months')
