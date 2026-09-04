"""shop_calculation 改 append-only：加 observed_at / source / deleted_at

Revision ID: 229
Revises: 228
Create Date: 2026-08-03

BEL-378 店铺核算「按行追加 + 时间字段」改造（用户拍板：全部采纳建议）：

把 ``shop_calculation`` 从「(project_id, sku, country) upsert 覆盖」改成
**append-only 时间序列**，让手动编辑 / AI Agent 抓价 / 外部 API 写入共用一张表，
每次写入新增一行并带时间戳，历史可回溯。

1. ``observed_at``（DateTime tz, NOT NULL, default now()）—— 写入时刻。
   backfill 已有行 = ``COALESCE(updated_at, created_at, now())``，保留原始时间。
2. ``source``（String(32), NOT NULL, default 'manual'）—— 写入来源。
   backfill 已有行 = 'manual_legacy'；未来手动='manual'、Agent='agent_listing_pull'、
   外部='external_api'。
3. ``deleted_at``（DateTime tz, nullable）—— 软删除标记（用户拍板：软删除）。
   NULL = 有效；非 NULL = 已删除，"当前态"查询会过滤掉。

**为什么迁移只是加列、不复制行**：upsert 语义下每个 (project_id, sku, country)
本来就只有一行，现有行即"初始历史"，加列 + backfill 即可，无需 INSERT 新行。
未来写入才追加新行。

**"当前态"读取**：应用层用 ``MAX(id) GROUP BY (project_id, sku, country)``
（append-only 下 id 单调递增 = 最新）+ ``deleted_at IS NULL`` 过滤，
跨 SQLite / Postgres 可用，不依赖 DB VIEW。

索引：
- ``idx_shop_calculation_latest`` (project_id, sku, country) —— 支撑 latest 子查询
- ``idx_shop_calculation_deleted`` (deleted_at) —— 软删除过滤
"""

from alembic import op
import sqlalchemy as sa


revision = "229"
down_revision = "228"
branch_labels = None
depends_on = None


LEGACY_SOURCE_SENTINEL = "manual_legacy"
DEFAULT_SOURCE = "manual"


def upgrade() -> None:
    # 0) 删除 (project_id, sku, country) 唯一约束 —— append-only 允许同 SKU 多行历史
    #    （该约束由迁移 113 建，名为 uq_shop_calculation_project_sku_country，
    #     未在 model __table_args__ 声明，prod/test 均存在）
    op.drop_constraint(
        "uq_shop_calculation_project_sku_country", "shop_calculation", type_="unique"
    )

    # 1) observed_at：先加 nullable 列，backfill 原始时间，最后 NOT NULL + default now()
    with op.batch_alter_table("shop_calculation") as batch_op:
        batch_op.add_column(
            sa.Column(
                "observed_at",
                sa.DateTime(timezone=True),
                nullable=True,
                comment="写入时刻；append-only 每次新增一行都带时间戳，历史可回溯",
            )
        )
    op.execute(
        "UPDATE shop_calculation "
        "SET observed_at = COALESCE(updated_at, created_at, now()) "
        "WHERE observed_at IS NULL"
    )
    with op.batch_alter_table("shop_calculation") as batch_op:
        batch_op.alter_column(
            "observed_at", nullable=False, server_default=sa.func.now()
        )

    # 2) source：加列 + backfill 历史行为 'manual_legacy'，未来默认 'manual'
    with op.batch_alter_table("shop_calculation") as batch_op:
        batch_op.add_column(
            sa.Column(
                "source",
                sa.String(length=32),
                nullable=True,
                comment=(
                    "写入来源：manual / agent_listing_pull / external_api / "
                    "manual_legacy（迁移前的历史行）"
                ),
            )
        )
    op.execute(
        f"UPDATE shop_calculation SET source = '{LEGACY_SOURCE_SENTINEL}' "
        "WHERE source IS NULL"
    )
    with op.batch_alter_table("shop_calculation") as batch_op:
        batch_op.alter_column("source", nullable=False, server_default=DEFAULT_SOURCE)

    # 3) deleted_at：软删除标记，nullable
    with op.batch_alter_table("shop_calculation") as batch_op:
        batch_op.add_column(
            sa.Column(
                "deleted_at",
                sa.DateTime(timezone=True),
                nullable=True,
                comment="软删除时刻；NULL=有效，非 NULL=已删除（当前态查询会过滤）",
            )
        )

    # 4) 索引
    op.create_index(
        "idx_shop_calculation_latest",
        "shop_calculation",
        ["project_id", "sku", "country"],
    )
    op.create_index(
        "idx_shop_calculation_deleted",
        "shop_calculation",
        ["deleted_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_shop_calculation_deleted", table_name="shop_calculation")
    op.drop_index("idx_shop_calculation_latest", table_name="shop_calculation")
    with op.batch_alter_table("shop_calculation") as batch_op:
        batch_op.drop_column("deleted_at")
        batch_op.drop_column("source")
        batch_op.drop_column("observed_at")
    # 恢复唯一约束前先除重（只留每组最新一行，否则历史行会令建约束失败）
    op.execute(
        "DELETE FROM shop_calculation WHERE id NOT IN ("
        "SELECT MAX(id) FROM shop_calculation GROUP BY project_id, sku, country)"
    )
    op.create_unique_constraint(
        "uq_shop_calculation_project_sku_country",
        "shop_calculation",
        ["project_id", "sku", "country"],
    )
