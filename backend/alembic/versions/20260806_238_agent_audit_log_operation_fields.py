"""agent_api_audit_log 补 project_id / operation_type 列（BLF-460）

读操作明细完善：每条 agent/external 访问记录解析并回填：
* ``project_id``：从 path 正则 ``/projects/(\\d+)`` 提取；
* ``operation_type``：从 path 片段映射业务域（与
  ``middleware/agent_api_audit.py`` 的 ``AGENT_PATH_DOMAIN_MAP`` 保持同步，
  本文件内联一份镜像，避免迁移依赖运行时模块）。

Revision ID: 238
Revises: 237
Create Date: 2026-08-06
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "238"
down_revision: Union[str, None] = "237"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 与 middleware/agent_api_audit.py 的 AGENT_PATH_DOMAIN_MAP 同步（长片段优先）。
_PATH_DOMAIN_MAP: tuple[tuple[str, str], ...] = (
    ("/new-product-calculations", "new_product_calculations"),
    ("/pricing-snapshots", "new_product_calculations"),
    ("/shop-calculation", "shop_calculations"),
    ("/return-analysis", "return_analysis"),
    ("/replenishment-analysis", "inventory_ledger"),
    ("/inventory-ledger", "inventory_ledger"),
    ("/sku-info", "inventory_ledger"),
    ("/business-summary", "finance_profit"),
    ("/orders/", "finance_profit"),
    ("/ad-", "ad_analysis"),
    ("/shipments", "shipments"),
)

_PROJECT_RE = __import__("re").compile(r"/projects/(\d+)")


def _parse_path(path: str) -> tuple[int | None, str | None]:
    match = _PROJECT_RE.search(path)
    project_id = int(match.group(1)) if match else None
    operation_type = None
    for fragment, domain in _PATH_DOMAIN_MAP:
        if fragment in path:
            operation_type = domain
            break
    return project_id, operation_type


def upgrade() -> None:
    op.add_column(
        "agent_api_audit_log", sa.Column("project_id", sa.Integer(), nullable=True)
    )
    op.add_column(
        "agent_api_audit_log",
        sa.Column("operation_type", sa.String(length=32), nullable=True),
    )
    op.create_index("idx_aaal_project_id", "agent_api_audit_log", ["project_id"])
    op.create_index(
        "idx_aaal_operation_type", "agent_api_audit_log", ["operation_type"]
    )

    # 存量行回填（幂等；表保留期 90 天，量可控，直接全量遍历 Python 侧解析）
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, path FROM agent_api_audit_log")).fetchall()
    for row_id, path in rows:
        project_id, operation_type = _parse_path(path or "")
        bind.execute(
            sa.text(
                "UPDATE agent_api_audit_log "
                "SET project_id = :pid, operation_type = :op WHERE id = :id"
            ),
            {"pid": project_id, "op": operation_type, "id": row_id},
        )


def downgrade() -> None:
    op.drop_index("idx_aaal_project_id", table_name="agent_api_audit_log")
    op.drop_index("idx_aaal_operation_type", table_name="agent_api_audit_log")
    op.drop_column("agent_api_audit_log", "operation_type")
    op.drop_column("agent_api_audit_log", "project_id")
