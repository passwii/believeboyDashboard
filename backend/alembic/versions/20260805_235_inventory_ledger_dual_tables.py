"""库存分类账双表（summary + detail）+ 批次元数据表

BEL-428：库存分类账切换新报表。本迁移一次创建 3 张表：

1. inventory_ledger_ingest_batch —— 每次 CSV 上传的批次元数据
   （排查时按 batch 定位：哪天上传 / 谁上传 / 哪个文件 / 多少行 / 状态 / 对账结果）
2. inventory_ledger_summary —— 亚马逊 Inventory Ledger Summary 视图（22 列）
   真相源：Summary 是日聚合快照，重复导入按 natural key upsert 幂等
3. inventory_ledger_detail —— 亚马逊 Inventory Ledger Detailed 视图（16 列）
   事件级行；真实数据存在合法重复事件元组（同一天同一 SKU 多次同值事件），
   故不设事件元组唯一约束，去重落在批次表 file_hash 层

旧表 inventory_ledger_raw 暂留不动（用户决定，等新表稳定后再单独迁移 drop）。

Revision ID: 235
Revises: 234
Create Date: 2026-08-05
"""

from alembic import op
import sqlalchemy as sa

revision = "235"
down_revision = "234"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. 批次元数据表（summary/detail 的 batch_id 引用它，先建） ──
    op.create_table(
        "inventory_ledger_ingest_batch",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("report_month", sa.Date(), nullable=False),
        # === 上传信息 ===
        sa.Column("source_filename", sa.String(256), nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=False),
        sa.Column("file_size_bytes", sa.Integer(), nullable=False),
        sa.Column(
            "file_kind",
            sa.String(20),
            nullable=False,
            server_default="unknown",
            comment="summary / detail / unknown (按列头自动识别)",
        ),
        # === 上传者 ===
        sa.Column("loaded_by", sa.String(36), nullable=True),
        sa.Column(
            "loaded_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # === 执行结果 ===
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="pending",
            comment="pending / running / success / failed / partial",
        ),
        sa.Column("rows_parsed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "rows_written_summary", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "rows_written_detail", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "rows_skipped_duplicate", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "rows_failed_validation", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "consistency_check",
            sa.String(20),
            nullable=True,
            comment="ok / mismatch / not_run (跨表对账结果)",
        ),
        sa.Column(
            "consistency_mismatch_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "project_id",
            "report_month",
            "source_filename",
            "file_hash",
            name="uq_batch_natural_key",
        ),
    )
    op.create_index(
        "ix_batch_project_month",
        "inventory_ledger_ingest_batch",
        ["project_id", "report_month"],
    )
    op.create_index(
        "ix_batch_loaded_at", "inventory_ledger_ingest_batch", ["loaded_at"]
    )
    op.create_index("ix_batch_status", "inventory_ledger_ingest_batch", ["status"])

    # ── 2. Summary 表（22 列，natural key 与旧 raw 相同） ──
    op.create_table(
        "inventory_ledger_summary",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column(
            "report_month",
            sa.Date(),
            nullable=False,
            comment="YYYY-MM-01, ETL partition key",
        ),
        sa.Column("date", sa.Date(), nullable=False, comment="Business date from CSV"),
        sa.Column("fnsku", sa.String(20), nullable=True),
        sa.Column("asin", sa.String(15), nullable=True),
        sa.Column("msku", sa.String(30), nullable=False),
        sa.Column("title", sa.String(500), nullable=True),
        sa.Column(
            "disposition",
            sa.String(20),
            nullable=False,
            comment="SELLABLE / CUSTOMER_DAMAGED / CARRIER_DAMAGED / WAREHOUSE_DAMAGED",
        ),
        sa.Column(
            "location", sa.String(10), nullable=False, comment="FBA warehouse code"
        ),
        sa.Column("starting_balance", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "in_transit_between", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("receipts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "customer_shipments", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("customer_returns", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("vendor_returns", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "warehouse_transfer_io", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("found", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lost", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("damaged", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("disposed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("other_events", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("ending_balance", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("unknown_events", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("store", sa.String(50), nullable=True),
        sa.Column("batch_id", sa.Integer(), nullable=True),
        sa.Column(
            "loaded_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["inventory_ledger_ingest_batch.id"],
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint(
            "project_id",
            "report_month",
            "date",
            "msku",
            "disposition",
            "location",
            name="uq_ledger_summary_natural_key",
        ),
    )
    op.create_index(
        "idx_summary_project_month",
        "inventory_ledger_summary",
        ["project_id", "report_month"],
    )
    op.create_index(
        "idx_summary_project_month_msku",
        "inventory_ledger_summary",
        ["project_id", "report_month", "msku"],
    )
    op.create_index(
        "idx_summary_project_month_location",
        "inventory_ledger_summary",
        ["project_id", "report_month", "location"],
    )
    op.create_index("idx_summary_batch_id", "inventory_ledger_summary", ["batch_id"])

    # ── 3. Detail 表（16 列，事件级，append-only） ──
    op.create_table(
        "inventory_ledger_detail",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column(
            "report_month",
            sa.Date(),
            nullable=False,
            comment="YYYY-MM-01, ETL partition key",
        ),
        sa.Column("date", sa.Date(), nullable=False, comment="Business date from CSV"),
        sa.Column("fnsku", sa.String(20), nullable=True),
        sa.Column("asin", sa.String(15), nullable=True),
        sa.Column("msku", sa.String(30), nullable=False),
        sa.Column("title", sa.String(500), nullable=True),
        sa.Column("event_type", sa.String(40), nullable=False),
        sa.Column("reference_id", sa.String(64), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column(
            "fulfillment_center",
            sa.String(10),
            nullable=False,
            comment="FBA warehouse code",
        ),
        sa.Column(
            "disposition",
            sa.String(20),
            nullable=False,
            comment="SELLABLE / CUSTOMER_DAMAGED / CARRIER_DAMAGED / WAREHOUSE_DAMAGED",
        ),
        sa.Column("reason", sa.String(20), nullable=True),
        sa.Column("country", sa.String(10), nullable=True),
        sa.Column("reconciled_quantity", sa.Integer(), nullable=True),
        sa.Column("unreconciled_quantity", sa.Integer(), nullable=True),
        sa.Column("date_and_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("store", sa.String(50), nullable=True),
        sa.Column("batch_id", sa.Integer(), nullable=True),
        sa.Column(
            "loaded_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["inventory_ledger_ingest_batch.id"],
            ondelete="SET NULL",
        ),
        # 注意：无事件元组唯一约束 —— 真实数据存在合法重复事件
        # （同一天同一 SKU 多次同值事件），去重落在批次表 file_hash 层
    )
    op.create_index(
        "idx_detail_project_month",
        "inventory_ledger_detail",
        ["project_id", "report_month"],
    )
    op.create_index(
        "idx_detail_project_month_msku",
        "inventory_ledger_detail",
        ["project_id", "report_month", "msku"],
    )
    op.create_index(
        "idx_detail_project_month_location",
        "inventory_ledger_detail",
        ["project_id", "report_month", "fulfillment_center"],
    )
    op.create_index("idx_detail_batch_id", "inventory_ledger_detail", ["batch_id"])


def downgrade() -> None:
    op.drop_index("idx_detail_batch_id", table_name="inventory_ledger_detail")
    op.drop_index(
        "idx_detail_project_month_location", table_name="inventory_ledger_detail"
    )
    op.drop_index("idx_detail_project_month_msku", table_name="inventory_ledger_detail")
    op.drop_index("idx_detail_project_month", table_name="inventory_ledger_detail")
    op.drop_table("inventory_ledger_detail")

    op.drop_index("idx_summary_batch_id", table_name="inventory_ledger_summary")
    op.drop_index(
        "idx_summary_project_month_location", table_name="inventory_ledger_summary"
    )
    op.drop_index(
        "idx_summary_project_month_msku", table_name="inventory_ledger_summary"
    )
    op.drop_index("idx_summary_project_month", table_name="inventory_ledger_summary")
    op.drop_table("inventory_ledger_summary")

    op.drop_index("ix_batch_status", table_name="inventory_ledger_ingest_batch")
    op.drop_index("ix_batch_loaded_at", table_name="inventory_ledger_ingest_batch")
    op.drop_index("ix_batch_project_month", table_name="inventory_ledger_ingest_batch")
    op.drop_table("inventory_ledger_ingest_batch")
