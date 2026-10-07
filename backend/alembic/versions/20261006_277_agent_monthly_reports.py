"""Agent 月报写入流程临时状态表（BLF-1250 阶段一，revision 277）。

新增 4 张表（均只承载「临时上传 → 仅计算草稿 → 确认入库」的状态，不是正式
财务入库）：

- ``agent_monthly_report_uploads``：一次写入会话（归属 key/项目/国家/月份/期限）。
- ``agent_monthly_report_files``：会话内原始二进制输入（CSV 必选、PDF 可选）。
- ``agent_monthly_report_builds``：一次仅计算草稿（输入/结果摘要 + 状态 + report_id）。
- ``agent_monthly_report_idempotency``：写请求幂等台账（build 发起 / confirm 入库）。

状态列用 ``String`` 而非 DB enum：阶段一还要在 janitor/超时恢复里新增状态，
避免 Postgres 枚举类型反复 ALTER。主键统一 ``Integer``（对齐 ``alert_rule.py``）。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = '277'
down_revision: str | None = '276'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'agent_monthly_report_uploads',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('agent_api_key_id', sa.Integer(), nullable=False),
        sa.Column('agent_id', sa.String(length=64), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('project_name', sa.String(length=255), nullable=False),
        sa.Column('country', sa.String(length=2), nullable=False),
        sa.Column('report_month', sa.String(length=7), nullable=False),
        sa.Column('status', sa.String(length=16), server_default='open', nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['project_id'], ['projects.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'idx_amr_uploads_key', 'agent_monthly_report_uploads', ['agent_api_key_id']
    )
    op.create_index(
        'idx_amr_uploads_target',
        'agent_monthly_report_uploads',
        ['project_id', 'country', 'report_month'],
    )
    op.create_index(
        'idx_amr_uploads_status', 'agent_monthly_report_uploads', ['status']
    )

    op.create_table(
        'agent_monthly_report_files',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('upload_id', sa.Integer(), nullable=False),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('file_id', sa.String(length=64), nullable=False),
        sa.Column('original_filename', sa.String(length=255), nullable=False),
        sa.Column('stored_path', sa.String(length=1024), nullable=False),
        sa.Column('content_type', sa.String(length=128), nullable=True),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['upload_id'], ['agent_monthly_report_uploads.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('file_id', name='uq_amr_files_file_id'),
        sa.UniqueConstraint('upload_id', 'kind', name='uq_amr_files_upload_kind'),
    )
    op.create_index('idx_amr_files_upload', 'agent_monthly_report_files', ['upload_id'])

    op.create_table(
        'agent_monthly_report_builds',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('upload_id', sa.Integer(), nullable=False),
        sa.Column('agent_api_key_id', sa.Integer(), nullable=False),
        sa.Column('agent_id', sa.String(length=64), nullable=False),
        sa.Column(
            'status', sa.String(length=16), server_default='queued', nullable=False
        ),
        sa.Column('celery_task_id', sa.String(length=64), nullable=True),
        sa.Column('input_sha256', sa.String(length=64), nullable=False),
        sa.Column('summary_pdf_sha256', sa.String(length=64), nullable=True),
        sa.Column('result_dir', sa.String(length=1024), nullable=True),
        sa.Column('payload_path', sa.String(length=1024), nullable=True),
        sa.Column('payload_sha256', sa.String(length=64), nullable=True),
        sa.Column('workbook_path', sa.String(length=1024), nullable=True),
        sa.Column('workbook_sha256', sa.String(length=64), nullable=True),
        sa.Column('calculation_version', sa.Integer(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('attempt_count', sa.Integer(), server_default='0', nullable=False),
        sa.Column('idempotency_key', sa.String(length=64), nullable=True),
        sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('report_id', sa.Integer(), nullable=True),
        sa.Column('confirm_idempotency_key', sa.String(length=64), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['upload_id'], ['agent_monthly_report_uploads.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'idx_amr_builds_upload', 'agent_monthly_report_builds', ['upload_id']
    )
    op.create_index(
        'idx_amr_builds_key', 'agent_monthly_report_builds', ['agent_api_key_id']
    )
    op.create_index(
        'idx_amr_builds_status', 'agent_monthly_report_builds', ['status']
    )
    op.create_index(
        'idx_amr_builds_expires', 'agent_monthly_report_builds', ['expires_at']
    )

    op.create_table(
        'agent_monthly_report_idempotency',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('agent_api_key_id', sa.Integer(), nullable=False),
        sa.Column('action', sa.String(length=32), nullable=False),
        sa.Column('idempotency_key', sa.String(length=64), nullable=False),
        sa.Column('request_hash', sa.String(length=64), nullable=False),
        sa.Column('build_id', sa.Integer(), nullable=True),
        sa.Column('report_id', sa.Integer(), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'agent_api_key_id',
            'action',
            'idempotency_key',
            name='uq_amr_idempotency_key_action',
        ),
    )
    op.create_index(
        'idx_amr_idempotency_build',
        'agent_monthly_report_idempotency',
        ['build_id'],
    )


def downgrade() -> None:
    op.drop_index(
        'idx_amr_idempotency_build', table_name='agent_monthly_report_idempotency'
    )
    op.drop_table('agent_monthly_report_idempotency')

    op.drop_index('idx_amr_builds_expires', table_name='agent_monthly_report_builds')
    op.drop_index('idx_amr_builds_status', table_name='agent_monthly_report_builds')
    op.drop_index('idx_amr_builds_key', table_name='agent_monthly_report_builds')
    op.drop_index('idx_amr_builds_upload', table_name='agent_monthly_report_builds')
    op.drop_table('agent_monthly_report_builds')

    op.drop_index('idx_amr_files_upload', table_name='agent_monthly_report_files')
    op.drop_table('agent_monthly_report_files')

    op.drop_index('idx_amr_uploads_status', table_name='agent_monthly_report_uploads')
    op.drop_index('idx_amr_uploads_target', table_name='agent_monthly_report_uploads')
    op.drop_index('idx_amr_uploads_key', table_name='agent_monthly_report_uploads')
    op.drop_table('agent_monthly_report_uploads')
