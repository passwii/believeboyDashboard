"""新增意向客户工作台（crm_intent）表

Revision ID: 285
Revises: 284

8 张表：批次 / 企业 / 手机号 / 跟进 / 跟进事件 / 待筛池 / 导入幂等台账 / 轮询 rev。
只新增表与索引，不改现有表；crm_intent_meta 初始化单行 id=1。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "285"
down_revision: str | None = "284"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "crm_intent_batches",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("batch_date", sa.Date(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("source_file_name", sa.String(length=255), nullable=True),
        sa.Column("r2_key", sa.String(length=1024), nullable=True),
        sa.Column("content_sha256", sa.String(length=64), nullable=True),
        sa.Column(
            "result_json",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'::json"),
        ),
        sa.Column(
            "total_companies", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("total_pool", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "skipped_locked_count", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("rejected_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="processing"
        ),
        sa.Column("error_detail", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "source IN ('ai','manual')",
            name="ck_crm_intent_batches_source",
        ),
        sa.CheckConstraint(
            "status IN ('processing','completed','failed')",
            name="ck_crm_intent_batches_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_crm_intent_batches_date", "crm_intent_batches", ["batch_date"]
    )

    op.create_table(
        "crm_intent_companies",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("batch_id", sa.Integer(), nullable=True),
        sa.Column("external_id", sa.String(length=128), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("name_key", sa.String(length=200), nullable=False),
        sa.Column("credit_code", sa.String(length=32), nullable=True),
        sa.Column("legal_person", sa.String(length=100), nullable=True),
        sa.Column("province", sa.String(length=50), nullable=True),
        sa.Column("city", sa.String(length=50), nullable=True),
        sa.Column("founded_year", sa.Integer(), nullable=True),
        sa.Column("registered_capital_wan", sa.Numeric(14, 2), nullable=True),
        sa.Column("products", sa.Text(), nullable=True),
        sa.Column("category", sa.String(length=50), nullable=True),
        sa.Column("channel", sa.String(length=50), nullable=True),
        sa.Column(
            "channels",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
        sa.Column("channel_source", sa.String(length=255), nullable=True),
        sa.Column(
            "trademarks",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
        sa.Column("trademark_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "intent_level", sa.String(length=1), nullable=False, server_default="D"
        ),
        sa.Column("intent_score", sa.Integer(), nullable=True),
        sa.Column("intent_basis", sa.Text(), nullable=True),
        sa.Column("amazon_fit", sa.Text(), nullable=True),
        sa.Column("walmart_fit", sa.Text(), nullable=True),
        sa.Column(
            "sources", sa.JSON(), nullable=False, server_default=sa.text("'[]'::json")
        ),
        sa.Column("risks", sa.Text(), nullable=True),
        sa.Column("screened_at", sa.Date(), nullable=True),
        sa.Column("phone_note", sa.Text(), nullable=True),
        sa.Column("owner_id", sa.String(length=36), nullable=True),
        sa.Column("human_touched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("human_touched_by", sa.String(length=36), nullable=True),
        sa.Column("converted_customer_id", sa.Integer(), nullable=True),
        sa.Column("converted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["crm_intent_batches.id"],
            name="fk_crm_intent_companies_batch",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["converted_customer_id"],
            ["crm_customers.id"],
            name="fk_crm_intent_companies_customer",
            ondelete="SET NULL",
        ),
        sa.CheckConstraint(
            "intent_level IN ('A','B','C','D')",
            name="ck_crm_intent_companies_level",
        ),
        sa.CheckConstraint(
            "intent_score IS NULL OR (intent_score >= 0 AND intent_score <= 100)",
            name="ck_crm_intent_companies_score",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_crm_intent_companies_credit_code",
        "crm_intent_companies",
        ["credit_code"],
        unique=True,
        postgresql_where=sa.text(
            "credit_code IS NOT NULL AND credit_code <> ''"
        ),
    )
    op.create_index(
        "uq_crm_intent_companies_name_key",
        "crm_intent_companies",
        ["name_key"],
        unique=True,
    )
    op.create_index(
        "idx_crm_intent_companies_owner", "crm_intent_companies", ["owner_id"]
    )
    op.create_index(
        "idx_crm_intent_companies_level", "crm_intent_companies", ["intent_level"]
    )
    op.create_index(
        "idx_crm_intent_companies_category", "crm_intent_companies", ["category"]
    )
    op.create_index(
        "idx_crm_intent_companies_region",
        "crm_intent_companies",
        ["province", "city"],
    )
    op.create_index(
        "idx_crm_intent_companies_screened", "crm_intent_companies", ["screened_at"]
    )
    op.create_index(
        "idx_crm_intent_companies_updated", "crm_intent_companies", ["updated_at"]
    )
    op.create_index(
        "idx_crm_intent_companies_touched",
        "crm_intent_companies",
        ["human_touched_at"],
    )

    op.create_table(
        "crm_intent_pool",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("batch_id", sa.Integer(), nullable=True),
        sa.Column("external_id", sa.String(length=128), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("name_key", sa.String(length=200), nullable=False),
        sa.Column("legal_person", sa.String(length=100), nullable=True),
        sa.Column("website", sa.String(length=300), nullable=True),
        sa.Column("channel", sa.String(length=50), nullable=True),
        sa.Column(
            "channels", sa.JSON(), nullable=False, server_default=sa.text("'[]'::json")
        ),
        sa.Column("channel_source", sa.String(length=255), nullable=True),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="pending"
        ),
        sa.Column("screened_company_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["crm_intent_batches.id"],
            name="fk_crm_intent_pool_batch",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["screened_company_id"],
            ["crm_intent_companies.id"],
            name="fk_crm_intent_pool_company",
            ondelete="SET NULL",
        ),
        sa.CheckConstraint(
            "status IN ('pending','screened','ignored')",
            name="ck_crm_intent_pool_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_crm_intent_pool_status", "crm_intent_pool", ["status"])
    op.create_index("idx_crm_intent_pool_batch", "crm_intent_pool", ["batch_id"])
    op.create_index(
        "uq_crm_intent_pool_name_key", "crm_intent_pool", ["name_key"], unique=True
    )

    op.create_table(
        "crm_intent_phones",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("company_id", sa.Integer(), nullable=True),
        sa.Column("pool_id", sa.Integer(), nullable=True),
        sa.Column("phone_raw", sa.String(length=50), nullable=False),
        sa.Column("phone_normalized", sa.String(length=32), nullable=False),
        sa.Column(
            "source", sa.String(length=16), nullable=False, server_default="list"
        ),
        sa.Column("is_valid", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["crm_intent_companies.id"],
            name="fk_crm_intent_phones_company",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["pool_id"],
            ["crm_intent_pool.id"],
            name="fk_crm_intent_phones_pool",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "(company_id IS NOT NULL)::int + (pool_id IS NOT NULL)::int = 1",
            name="ck_crm_intent_phones_owner",
        ),
        sa.CheckConstraint(
            "source IN ('list','manual','ai')",
            name="ck_crm_intent_phones_source",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_crm_intent_phones_normalized", "crm_intent_phones", ["phone_normalized"]
    )
    op.create_index(
        "uq_crm_intent_phones_company_phone",
        "crm_intent_phones",
        ["company_id", "phone_normalized"],
        unique=True,
        postgresql_where=sa.text("company_id IS NOT NULL"),
    )
    op.create_index(
        "uq_crm_intent_phones_pool_phone",
        "crm_intent_phones",
        ["pool_id", "phone_normalized"],
        unique=True,
        postgresql_where=sa.text("pool_id IS NOT NULL"),
    )

    op.create_table(
        "crm_intent_followups",
        sa.Column("company_id", sa.Integer(), nullable=False),
        sa.Column(
            "state", sa.String(length=20), nullable=False, server_default="none"
        ),
        sa.Column("note", sa.Text(), nullable=False, server_default=sa.text("''")),
        sa.Column("last_contact_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_contact_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_by", sa.String(length=36), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "state IN ('none','contacted','wechat','quoted','negotiating',"
            "'won','hold','mismatch')",
            name="ck_crm_intent_followups_state",
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["crm_intent_companies.id"],
            name="fk_crm_intent_followups_company",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("company_id"),
    )
    op.create_index(
        "idx_crm_intent_followups_next", "crm_intent_followups", ["next_contact_at"]
    )

    op.create_table(
        "crm_intent_followup_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("company_id", sa.Integer(), nullable=False),
        sa.Column("from_state", sa.String(length=20), nullable=True),
        sa.Column("to_state", sa.String(length=20), nullable=True),
        sa.Column("note_snapshot", sa.Text(), nullable=True),
        sa.Column("actor_id", sa.String(length=36), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["crm_intent_companies.id"],
            name="fk_crm_intent_followup_events_company",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_crm_intent_followup_events_company",
        "crm_intent_followup_events",
        ["company_id", "created_at"],
    )

    op.create_table(
        "crm_intent_import_requests",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("actor_kind", sa.String(length=8), nullable=False),
        sa.Column("actor_id", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="processing"
        ),
        sa.Column("response_json", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "actor_kind IN ('agent','user')",
            name="ck_crm_intent_import_requests_actor_kind",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "actor_kind",
            "actor_id",
            "idempotency_key",
            name="uq_crm_intent_import_requests_key",
        ),
    )
    op.create_index(
        "idx_crm_intent_import_requests_created",
        "crm_intent_import_requests",
        ["created_at"],
    )

    op.create_table(
        "crm_intent_meta",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("data_rev", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("followup_rev", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_crm_intent_meta_single_row"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(
        sa.text(
            "INSERT INTO crm_intent_meta (id, data_rev, followup_rev) "
            "VALUES (1, 0, 0)"
        )
    )


def downgrade() -> None:
    op.drop_table("crm_intent_meta")
    op.drop_index(
        "idx_crm_intent_import_requests_created",
        table_name="crm_intent_import_requests",
    )
    op.drop_table("crm_intent_import_requests")
    op.drop_index(
        "idx_crm_intent_followup_events_company",
        table_name="crm_intent_followup_events",
    )
    op.drop_table("crm_intent_followup_events")
    op.drop_index("idx_crm_intent_followups_next", table_name="crm_intent_followups")
    op.drop_table("crm_intent_followups")
    op.drop_index("uq_crm_intent_phones_pool_phone", table_name="crm_intent_phones")
    op.drop_index("uq_crm_intent_phones_company_phone", table_name="crm_intent_phones")
    op.drop_index("idx_crm_intent_phones_normalized", table_name="crm_intent_phones")
    op.drop_table("crm_intent_phones")
    op.drop_index("uq_crm_intent_pool_name_key", table_name="crm_intent_pool")
    op.drop_index("idx_crm_intent_pool_batch", table_name="crm_intent_pool")
    op.drop_index("idx_crm_intent_pool_status", table_name="crm_intent_pool")
    op.drop_table("crm_intent_pool")
    op.drop_index("idx_crm_intent_companies_touched", table_name="crm_intent_companies")
    op.drop_index("idx_crm_intent_companies_updated", table_name="crm_intent_companies")
    op.drop_index("idx_crm_intent_companies_screened", table_name="crm_intent_companies")
    op.drop_index("idx_crm_intent_companies_region", table_name="crm_intent_companies")
    op.drop_index("idx_crm_intent_companies_category", table_name="crm_intent_companies")
    op.drop_index("idx_crm_intent_companies_level", table_name="crm_intent_companies")
    op.drop_index("idx_crm_intent_companies_owner", table_name="crm_intent_companies")
    op.drop_index("uq_crm_intent_companies_name_key", table_name="crm_intent_companies")
    op.drop_index(
        "uq_crm_intent_companies_credit_code", table_name="crm_intent_companies"
    )
    op.drop_table("crm_intent_companies")
    op.drop_index("idx_crm_intent_batches_date", table_name="crm_intent_batches")
    op.drop_table("crm_intent_batches")
