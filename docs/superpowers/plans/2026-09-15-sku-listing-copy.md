# SKU Info 产品文案 Tab + Agent API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/dashboard/operations/sku-info` 新增第 6 个 Tab「产品文案」，承载亚马逊 Listing 文案（标题 / 5 点描述 / Description / 卖点提炼），文案数据成为 `product_costs` 主表的一部分，并开通供 Agent 读取与写入文案的 Agent API。

**Architecture:** 直接给 `product_costs` 加 10 列（文案 8 字段 + 2 溯源列，全部 nullable 无回填），读侧免费获得（主列表序列化 + Agent R1/R2 同函数），写侧内部走新批量端点 `POST /sku-info/batch-update-listing-copy`、Agent 侧走既有 W2 读-改-写合并 + 新增 W6 批量端点；导出加 `export_type=listing` CSV 分支；前端新增 Tab 复用页面已加载 items。

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic + Alembic（后端，pytest 打 `BLF_test` 库）；Next.js App Router + React + TypeScript（前端）。

**Spec:** `docs/superpowers/specs/2026-09-15-sku-listing-copy-design.md`（本计划唯一需求来源，冲突以 spec 为准）

---

## Global Constraints

- **文案字段零下游消费**——PT4 财务汇总 / 货件费用核算 / 补货分析 / 定时报表都不读文案，本计划**不得**给它们加文案读取。
- **既有模板不动**——成本/尺寸 两个 CSV 导出分支的表头与行内容**逐字节不变**（有回归测试锁）。
- **既有 Agent 契约向后兼容**——R1/R2 只新增响应 key；W1/W2 只新增可选请求字段；既有字段语义与校验不变。
- **`source` 溯源纪律**（沿用 BLF-579 D4）：Agent 写路径 `source` 枚举必填（禁 `manual`），`listing_copy_updated_by` 落 `agent_id`，`source_file` 服务端派生 `agent:<agent_id>`。
- **只做后端**（BLF-555 职责边界）：`backend/` 与 `docs/` 是本计划的可写范围；`frontend/` 改动**只出规格、由前端工程师 Seth 实施**（Stage 1 内以子 issue 转交）。
- **迁移命名**：文件名 `20260915_273_add_sku_listing_copy.py`，revision id 纯数字短 ID `'273'`，`down_revision='272'`；建前已确认单 head（`272 (head)`）。
- **测试库纪律**：pytest 一律打 `BLF_test`，绝不写 `BLF`。
- **提交纪律**：只用显式路径 `git add <file>...`；**禁止** `git add -A` / `git add .` / `git commit -a`。
- **提交规范**：中文 + Conventional Commits，scope 用中文，subject 动宾短语 ≤50 字、无句号。

## 环境准备（已实测完成，执行者不要重复创建）

工作目录固定在 worktree，**所有命令的 `<WT>` = `/Users/damon/multica_workspaces_desktop-api.multica.ai/believeboy-de24655df25f/blf-1080-42624ab5e452/worktree`**：

| 项 | 状态 |
| --- | --- |
| worktree / 分支 | `agent/damon/blf-1080`，基线 = `origin/main`（已 rebase，HEAD 含 `f3cd4cc2`） |
| `backend/.env`、`backend/.env.test` | 已软链到主 checkout（`.gitignore` 匹配软链，`git status` 不污染） |
| `backend` python | 本 worktree 无 `.venv`；用 `python3`（已装 fastapi/sqlalchemy/pytest 9.1.1）或主 checkout 绝对路径 `/Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python` |
| `BLF_test` 库 | 常驻，schema 用 `pg_dump --schema-only` 同步（**不要** `alembic upgrade head` 从零建） |
| alembic | 单 head `272`；`python3 scripts/check_alembic.py` 通过 |

**本计划使用的命令：**

```bash
# 后端单测（cwd 必须是 worktree 的 backend，import 才会取 worktree 代码）
cd <WT>/backend && python3 -m pytest tests/<path> -q
# 迁移图检查
cd <WT>/backend && python3 scripts/check_alembic.py
# 人工把新迁移同步到 BLF_test（schema 化，见 Task 1 Step 4）
psql -d BLF_test -f /tmp/blf1080_listing_copy.sql
# OpenAPI 契约重生成（会改 frontend/types/api-generated/，属契约文件，后端可提交）
cd <WT>/backend && python3 -m scripts.openapi_export --out ../frontend/types/api-generated/openapi.json
```

---

## Stage 划分与交棒

| Stage | 范围 | 交付 | 状态 |
| --- | --- | --- | --- |
| **S0 设计定稿** | spec + plan（本文件） | `docs/superpowers/specs/2026-09-15-sku-listing-copy-design.md` | 本 PR |
| **S1 后端基础** | 迁移 + 模型 + schema + 内部读写（列表/批量写/导出）+ 测试 | 本文 Task 1–4 | 本 PR |
| **S2 前端 Tab** | 新 Tab + 表格 + 编辑 Sheet + 导出按钮 + 前端测试 | 转交前端工程师 Seth（子 issue，Stage 2） | 待转交 |
| **S3 Agent API** | R1/R2 补字段 + W1/W2 补字段 + W6 批量端点 + 测试 | 本文 Task 5–7（在 S1 合入后） | 待排 |

**交棒纪律**（AGENTS.md BLF-555）：S1 完成后由 Damon 在 issue 评论写明「交付了什么 / 验证结果 / 下一步谁做什么」，并以子 issue `[@前端工程师 Seth](mention://agent/335e68d0-8b7b-461e-b8d8-dee19030cbd6)` 携带 Stage 2 规格转交；S3 由 Damon 在 S1 落地后自行推进。

---

## 任务总览（S1）

| # | 交付物 | 提交信息 |
| --- | --- | --- |
| 1 | Alembic 迁移 273 + 模型加列 | `feat(SKU主数据): 新增产品文案列与迁移 273` |
| 2 | Pydantic schema（item/create/update/批量请求响应） | `feat(SKU主数据): 产品文案 schema 与序列化` |
| 3 | 服务层批量写 + 内部批量端点 | `feat(SKU主数据): 新增产品文案批量更新端点` |
| 4 | 导出 `export_type=listing` 分支 + 后端测试 | `feat(SKU主数据): 导出新增产品文案模板` |
| 5 | OpenAPI 契约重生成 | `chore(契约): 同步产品文案字段 OpenAPI 与生成类型` |

---

### Task 1: Alembic 迁移 273 + 模型加列

**Files:**

- Create: `backend/alembic/versions/20260915_273_add_sku_listing_copy.py`
- Modify: `backend/app/models/sku_info.py`
- Test: `backend/tests/test_check_alembic.py`（既有守护，自动覆盖新文件命名/单 head）

**Interfaces:**

- Consumes: 无（最底层）
- Produces: `product_costs` 的 10 列（见 spec §2.1）；`SkuRecord` 上对应的 10 个 `Mapped[...]` 属性，供 Task 2/3 读写。

- [ ] **Step 1: 写迁移文件**

创建 `backend/alembic/versions/20260915_273_add_sku_listing_copy.py`：

```python
"""SKU 产品文案列：标题/五点描述/Description/卖点（BLF-1080）

Revision ID: 273
Revises: 272
Create Date: 2026-09-15 00:00:00.000000

`product_costs` 新增亚马逊 Listing 文案字段组，作为 SKU Info 主数据的一部分
（前端「产品文案」Tab，docs/superpowers/specs/2026-09-15-sku-listing-copy-design.md）。
全部可空、无 server_default、**不做回填**——存量行 NULL 语义即「未录入文案」。
bullet 拆 5 列（而非 JSON）以便导出成列 + 单点校验（spec §2.2）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '273'
down_revision: Union[str, None] = '272'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('product_costs', sa.Column('listing_title', sa.String(length=500), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_1', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_2', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_3', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_4', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_5', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_description', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_selling_points', sa.Text(), nullable=True))
    op.add_column(
        'product_costs',
        sa.Column('listing_copy_updated_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'product_costs',
        sa.Column('listing_copy_updated_by', sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('product_costs', 'listing_copy_updated_by')
    op.drop_column('product_costs', 'listing_copy_updated_at')
    op.drop_column('product_costs', 'listing_selling_points')
    op.drop_column('product_costs', 'listing_description')
    op.drop_column('product_costs', 'listing_bullet_5')
    op.drop_column('product_costs', 'listing_bullet_4')
    op.drop_column('product_costs', 'listing_bullet_3')
    op.drop_column('product_costs', 'listing_bullet_2')
    op.drop_column('product_costs', 'listing_bullet_1')
    op.drop_column('product_costs', 'listing_title')
```

- [ ] **Step 2: 模型加列**

`backend/app/models/sku_info.py`：`String` / `Text` 需加入既有 import；在
`sku_factory_info_updated_by` 之后（资源列之前）插入文案列组，形态对齐
`sku_factory_info_updated_{at,by}`：

```python
    # ── 产品文案（Listing Copy，BLF-1080）─────────────────────────────
    # 亚马逊 Listing 文案字段组：标题 + 5 点描述（拆 5 列，便于导出成列与
    # 单点校验）+ Description + 卖点提炼；全部可空（未录入 = NULL）。
    # updated_{at,by} 对齐 sku_factory_info_updated_{at,by} 溯源先例。
    listing_title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    listing_bullet_1: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_bullet_2: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_bullet_3: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_bullet_4: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_bullet_5: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_selling_points: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_copy_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    listing_copy_updated_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
```

- [ ] **Step 3: 跑迁移图守护 + 确认单 head**

```bash
cd <WT>/backend && python3 scripts/check_alembic.py && alembic heads
```

期望：`✓ Alembic 迁移图检查通过` + `273 (head)`。

- [ ] **Step 4: 把新列同步到 BLF_test**

`BLF_test` 用 pg_dump 同步 schema（TESTING.md 约定 3：**不要** `alembic upgrade head`）。
用 `--sql` 生成 DDL 后直接施加，并同步 `alembic_version`：

```bash
cd <WT>/backend && python3 -m alembic upgrade 272:273 --sql > /tmp/blf1080_listing_copy.sql
psql -d BLF_test -f /tmp/blf1080_listing_copy.sql
psql -d BLF_test -c "update alembic_version set version_num='273';"
psql -d BLF_test -c "\d product_costs" | grep listing_
```

期望：10 个 `listing_*` 列出现；`alembic_version` 为 `273`。
（`--sql` 离线模式产出的 `UPDATE alembic_version` 语句可能不带 WHERE，肉眼确认后执行。）

---

### Task 2: Pydantic schema 与序列化

**Files:**

- Modify: `backend/app/schemas/sku_info.py`
- Modify: `backend/app/api/v1/endpoints/sku_info.py`（`_serialize_sku_record`）
- Test: `backend/tests/api/test_sku_listing_copy.py`（新建）

**Interfaces:**

- Consumes: Task 1 的 `SkuRecord.listing_*` 属性
- Produces:
  - `SkuRecordItem` 新增 10 个可选字段（读侧）；`marketplace_url` 之后追加。
  - `SkuRecordCreate` / `SkuRecordUpdate` 新增 8 个文案字段（写侧，全 Optional —— 复用 `model_fields_set` 语义）。
  - `BatchUpdateListingCopyItem` / `BatchUpdateListingCopyRequest` / `BatchUpdateListingCopyResponse`（Task 3 端点用）。
  - `LISTING_COPY_FIELDS: tuple[str, ...]` 常量（8 个文案字段名，服务层 / 导出 / 测试共用单一事实源）。

**常量落点**：`backend/app/schemas/sku_info.py` 顶部定义
`LISTING_COPY_FIELDS = ("listing_title", "listing_bullet_1", ..., "listing_selling_points")`（8 项，不含溯源列）。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/api/test_sku_listing_copy.py`：

```python
"""SKU 产品文案（Listing Copy）字段组测试（BLF-1080，spec §2/§3）。

覆盖：
* 读：主列表返回 listing_* 全字段（存量行为 null）。
* 写：批量端点只更新显式提供字段（只改标题不清空 bullets）；显式 null 清空；
  未知 id → skipped；空 items → 422；写入刷新 updated_at/by。
* 导出：export_type=listing 表头与行；既有 cost/dimension 两分支逐字节不变。
* Agent：R1/R2 返回文案字段；W2 只改 listing_title 不重置其它文案字段。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.main import app
from app.models.project import Project
from app.models.sku_info import SkuRecord
from app.schemas.sku_info import LISTING_COPY_FIELDS

from conftest import shipment_env  # noqa: F401 — fixture reuse


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _ensure_sku(
    *,
    project_name: str = "文案测试项目",
    sku: str = "LISTING-SKU-001",
    asin: str = "B0LISTING01",
    **listing: str | None,
) -> int:
    """幂等建一条 SKU 记录，返回 id（测试库持久，先清同键旧行）。"""
    db = SessionLocal()
    try:
        project = (
            db.execute(select(Project).where(Project.project_name == project_name))
            .scalars()
            .first()
        )
        if project is None:
            project = Project(project_name=project_name, sort_order=0)
            db.add(project)
            db.commit()
            db.refresh(project)

        db.execute(
            delete(SkuRecord).where(
                SkuRecord.project_id == project.id, SkuRecord.sku == sku
            )
        )
        db.commit()

        row = SkuRecord(
            project_id=project.id,
            project_name=project_name,
            sku=sku,
            asin=asin,
            fob_unit_cost=1.0,
            first_leg_cost_rmb=2.0,
            country="US",
            sort_order=1,
            is_active=True,
            **listing,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return int(row.id)
    finally:
        db.close()
```

- [ ] **Step 2: 跑测试确认失败（红）**

```bash
cd <WT>/backend && python3 -m pytest tests/api/test_sku_listing_copy.py -q
```

期望：`ImportError: cannot import name 'LISTING_COPY_FIELDS'`（红）。

- [ ] **Step 3: 加 schema**

在 `backend/app/schemas/sku_info.py` 顶部（`from pydantic import ...` 之后）加常量：

```python
#: 产品文案字段组（BLF-1080）。8 个业务字段——**不含** listing_copy_updated_{at,by}
#: 溯源列（由服务端写入，不接受客户端传值）。服务层 / 导出 / Agent schema 共用
#: 这唯一事实源，新增文案字段时只改这里。
LISTING_COPY_FIELDS: tuple[str, ...] = (
    "listing_title",
    "listing_bullet_1",
    "listing_bullet_2",
    "listing_bullet_3",
    "listing_bullet_4",
    "listing_bullet_5",
    "listing_description",
    "listing_selling_points",
)
```

`SkuRecordItem` 在 `product_image_uploaded_by` 之后、`marketplace_url` 之前加：

```python
    # 产品文案（BLF-1080）
    listing_title: str | None = None
    listing_bullet_1: str | None = None
    listing_bullet_2: str | None = None
    listing_bullet_3: str | None = None
    listing_bullet_4: str | None = None
    listing_bullet_5: str | None = None
    listing_description: str | None = None
    listing_selling_points: str | None = None
    listing_copy_updated_at: datetime | None = None
    listing_copy_updated_by: str | None = None
```

`SkuRecordCreate` 与 `SkuRecordUpdate` 各自 `sku_factory_info` 之后加 8 个可选字段
（**不含**溯源列）：

```python
    listing_title: str | None = Field(default=None, max_length=500)
    listing_bullet_1: str | None = None
    listing_bullet_2: str | None = None
    listing_bullet_3: str | None = None
    listing_bullet_4: str | None = None
    listing_bullet_5: str | None = None
    listing_description: str | None = None
    listing_selling_points: str | None = None
```

文件末尾（`SkuProductImageDeleteResponse` 之后）加批量端点 schema：

```python
class BatchUpdateListingCopyItem(BaseModel):
    """单行文案更新：id 必填，文案字段按需提供（只写显式提供项）。"""

    id: int = Field(..., description="SKU 记录 ID")
    listing_title: str | None = Field(default=None, max_length=500)
    listing_bullet_1: str | None = None
    listing_bullet_2: str | None = None
    listing_bullet_3: str | None = None
    listing_bullet_4: str | None = None
    listing_bullet_5: str | None = None
    listing_description: str | None = None
    listing_selling_points: str | None = None

    model_config = {"extra": "forbid"}


class BatchUpdateListingCopyRequest(BaseModel):
    """批量更新产品文案请求（BLF-1080）。

    语义对齐 ``BatchUpdateFactoryInfoRequest``：按 id 逐条更新，未知 / 缺失 id
    计入 skipped（不整批失败）。文案字段按 ``model_fields_set`` 判定——未提供
    的字段保持原值；显式传 ``null`` / 空串表示清空该字段。
    """

    items: list[BatchUpdateListingCopyItem] = Field(
        ..., min_length=1, max_length=500, description="文案更新项"
    )

    model_config = {"extra": "forbid"}


class BatchUpdateListingCopyResponse(BaseModel):
    """批量更新产品文案响应。"""

    updated: int = Field(..., description="更新记录数")
    skipped: int = Field(..., description="跳过记录数（id 缺失或不存在）")
    updated_ids: list[int] = Field(..., description="已更新的 SKU ID 列表")
```

- [ ] **Step 4: 补 `_serialize_sku_record`**

`backend/app/api/v1/endpoints/sku_info.py` 的 `_serialize_sku_record`，在
`product_image_uploaded_by` 之后加：

```python
        # 产品文案（BLF-1080）：8 字段 + 2 溯源列
        **{
            field: (getattr(row, field, None) or None)
            for field in LISTING_COPY_FIELDS
        },
        "listing_copy_updated_at": str(row.listing_copy_updated_at)
        if getattr(row, "listing_copy_updated_at", None)
        else None,
        "listing_copy_updated_by": getattr(row, "listing_copy_updated_by", None),
```

并在本文件 `from app.schemas.sku_info import (...)` 里加 `LISTING_COPY_FIELDS`。

> 注意 `or None`：空串归一成 `None`，避免「写空串 → 读出 `""`」的不一致。

- [ ] **Step 5: 跑测试确认通过（绿）**

```bash
cd <WT>/backend && python3 -m pytest tests/api/test_sku_listing_copy.py -q
```

---

### Task 3: 服务层批量写 + 内部批量端点

**Files:**

- Modify: `backend/app/services/data/sku_info_batch.py`（加 `batch_update_listing_copy`）
- Modify: `backend/app/api/v1/endpoints/sku_info.py`（加端点）
- Modify: `backend/app/services/infra/cache_write_endpoints.py`（登记白名单）
- Test: `backend/tests/api/test_sku_listing_copy.py`（扩写）

**Interfaces:**

- Consumes: `LISTING_COPY_FIELDS`（Task 2）、`get_sku_records_by_ids`（既有）
- Produces: `batch_update_listing_copy(db, updates: list[dict], operator: str | None = None) -> tuple[int, int, list[int]]` → `(updated, skipped, updated_ids)`；端点 `POST /sku-info/batch-update-listing-copy`。

- [ ] **Step 1: 写失败测试**

在 `backend/tests/api/test_sku_listing_copy.py` 追加：

```python
def test_batch_update_listing_copy_only_writes_provided_fields(client, admin_headers):
    """只提供 listing_title → bullets 保持原值（不清空）。"""
    record_id = _ensure_sku(listing_bullet_1="原始第 1 点", listing_bullet_2="原始第 2 点")

    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": [{"id": record_id, "listing_title": "新标题"}]},
        headers=admin_headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["updated"] == 1
    assert body["skipped"] == 0
    assert body["updated_ids"] == [record_id]

    db = SessionLocal()
    try:
        row = db.get(SkuRecord, record_id)
        assert row.listing_title == "新标题"
        assert row.listing_bullet_1 == "原始第 1 点"
        assert row.listing_bullet_2 == "原始第 2 点"
        assert row.listing_copy_updated_at is not None
        assert row.listing_copy_updated_by is not None
    finally:
        db.close()


def test_batch_update_listing_copy_explicit_null_clears(client, admin_headers):
    """显式传 null → 清空该字段。"""
    record_id = _ensure_sku(listing_title="待清空标题", listing_description="待清空描述")

    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": [{"id": record_id, "listing_title": None}]},
        headers=admin_headers,
    )

    assert response.status_code == 200, response.text
    db = SessionLocal()
    try:
        row = db.get(SkuRecord, record_id)
        assert row.listing_title is None
        assert row.listing_description == "待清空描述"
    finally:
        db.close()


def test_batch_update_listing_copy_unknown_id_skipped(client, admin_headers):
    """未知 id → skipped，不整批失败。"""
    record_id = _ensure_sku(sku="LISTING-SKU-SKIP")

    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={
            "items": [
                {"id": record_id, "listing_title": "有效"},
                {"id": 99_999_999, "listing_title": "不存在"},
            ]
        },
        headers=admin_headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["updated"] == 1
    assert body["skipped"] == 1
    assert body["updated_ids"] == [record_id]


def test_batch_update_listing_copy_empty_items_422(client, admin_headers):
    """空 items → 422（min_length=1）。"""
    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": []},
        headers=admin_headers,
    )
    assert response.status_code == 422


def test_batch_update_listing_copy_rejects_unknown_field(client, admin_headers):
    """extra=forbid：未知字段（如溯源列）→ 422。"""
    record_id = _ensure_sku(sku="LISTING-SKU-EXTRA")
    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": [{"id": record_id, "listing_copy_updated_by": "伪造"}]},
        headers=admin_headers,
    )
    assert response.status_code == 422


def test_list_endpoint_returns_listing_fields(client, admin_headers):
    """主列表返回文案字段（含溯源列），存量空值为 null。"""
    _ensure_sku(
        sku="LISTING-SKU-LIST",
        listing_title="列表标题",
        listing_bullet_1="第 1 点",
    )
    response = client.get(
        "/api/v1/sku-info",
        params={"project_name": "文案测试项目", "sku": "LISTING-SKU-LIST"},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 1
    item = items[0]
    assert item["listing_title"] == "列表标题"
    assert item["listing_bullet_1"] == "第 1 点"
    assert item["listing_bullet_2"] is None
    assert "listing_copy_updated_by" in item
```

- [ ] **Step 2: 跑测试确认失败（红）**

```bash
cd <WT>/backend && python3 -m pytest tests/api/test_sku_listing_copy.py -q
```

期望：批量端点 404（红）。

- [ ] **Step 3: 服务层实现**

`backend/app/services/data/sku_info_batch.py` 末尾追加：

```python
def batch_update_listing_copy(
    db: Session,
    updates: list[dict[str, Any]],
    operator: str | None = None,
) -> tuple[int, int, list[int]]:
    """批量更新 SKU 产品文案（BLF-1080，spec §3.2）。

    语义对齐 ``batch_update_factory_info``：

    * 未知 / 缺失 id → 计入 skipped（不整批失败）；
    * 文案字段按 ``updates`` 里**实际出现的 key** 判定（调用方用
      ``model_fields_set`` 构造）——未提供的字段保持原值，显式 ``None`` 清空；
    * 任一条有实际写入 → 刷新 ``listing_copy_updated_at`` /
      ``listing_copy_updated_by``。

    Returns:
        ``(updated_count, skipped_count, updated_ids)``
    """
    if not updates:
        return 0, 0, []

    ids = [u["id"] for u in updates if "id" in u]
    if not ids:
        return 0, 0, []

    records = get_sku_records_by_ids(db, ids)
    record_map = {r.id: r for r in records}

    updated_count = 0
    skipped_count = 0
    updated_ids: list[int] = []
    now = datetime.now(timezone.utc)

    for update in updates:
        record_id = update.get("id")
        record = record_map.get(record_id) if isinstance(record_id, int) else None
        if record is None:
            skipped_count += 1
            continue

        changed = False
        for field in LISTING_COPY_FIELDS:
            if field not in update:
                continue
            value = update[field]
            # 空串与 None 等价（均表示未填写 / 清空），避免 "" 与 NULL 双态
            normalized = value.strip() if isinstance(value, str) else value
            if isinstance(normalized, str) and normalized == "":
                normalized = None
            if getattr(record, field) != normalized:
                setattr(record, field, normalized)
                changed = True

        if not changed:
            skipped_count += 1
            continue

        record.listing_copy_updated_at = now
        record.listing_copy_updated_by = operator
        updated_count += 1
        updated_ids.append(int(record.id))

    db.flush()
    return updated_count, skipped_count, updated_ids
```

需要的新 import：文件头 `from app.schemas.sku_info import LISTING_COPY_FIELDS`
（`datetime` / `timezone` / `Any` / `select` 已有）。

- [ ] **Step 4: 端点实现**

`backend/app/api/v1/endpoints/sku_info.py` 在 `batch_update_factory_info_endpoint`
之后加：

```python
@router.post(
    "/sku-info/batch-update-listing-copy",
    response_model=BatchUpdateListingCopyResponse,
)
@invalidate_cache_on_commit_l1(domains=["sku_info"], project_id_from="global")
def batch_update_listing_copy_endpoint(
    payload: BatchUpdateListingCopyRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> BatchUpdateListingCopyResponse:
    """批量更新 SKU 产品文案（标题 / 5 点 / Description / 卖点）。

    只写显式提供的字段（未提供保持原值；显式 null / 空串清空）；
    未知 id 计入 skipped，不整批失败。
    """
    updates = [
        {
            "id": item.id,
            **{
                field: getattr(item, field)
                for field in LISTING_COPY_FIELDS
                if field in item.model_fields_set
            },
        }
        for item in payload.items
    ]

    updated, skipped, updated_ids = batch_update_listing_copy(
        db, updates, operator=operator
    )

    append_operation_audit_log(
        db,
        action="sku_info.batch_update_listing_copy",
        target_type="sku_info",
        operator=operator,
        after={
            "updated": updated,
            "skipped": skipped,
            "updated_ids": updated_ids,
        },
        request=request,
    )
    db.commit()

    return BatchUpdateListingCopyResponse(
        updated=updated,
        skipped=skipped,
        updated_ids=updated_ids,
    )
```

import 补：`from app.schemas.sku_info import (...)` 加
`BatchUpdateListingCopyRequest` / `BatchUpdateListingCopyResponse`；
`from app.services.data.sku_info_batch import (...)` 加 `batch_update_listing_copy`。

- [ ] **Step 5: 登记缓存白名单**

`backend/app/services/infra/cache_write_endpoints.py` 的 sku_info 段（`move_sku_record`
之后）加：

```python
    WriteEndpointSpec(
        domain="sku_info", layer="L1",
        module="app.api.v1.endpoints.sku_info",
        function="batch_update_listing_copy_endpoint", method="POST",
        path="/sku-info/batch-update-listing-copy",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="SKU 产品文案批量更新；L1 best_effort", issue_ref="BLF-1080",
    ),
```

跑守护确认不腐烂：

```bash
cd <WT>/backend && python3 scripts/check_cache_decorator_coverage.py
```

- [ ] **Step 6: 跑测试确认通过（绿）**

```bash
cd <WT>/backend && python3 -m pytest tests/api/test_sku_listing_copy.py -q
```

---

### Task 4: 导出 `export_type=listing` 分支

**Files:**

- Modify: `backend/app/api/v1/endpoints/sku_info.py`（`export_product_costs_csv`）
- Test: `backend/tests/api/test_sku_listing_copy.py`（扩写导出回归）

**Interfaces:**

- Consumes: `list_sku_records_all`（既有）、Task 1 的列
- Produces: `GET /sku-info/export?export_type=listing` → CSV（表头见 spec §3.3）；既有 `cost` / `dimension` 输出不变。

- [ ] **Step 1: 写失败测试（含既有两分支逐字节回归）**

追加：

```python
def _export_rows(client, headers, **params) -> list[str]:
    response = client.get("/api/v1/sku-info/export", params=params, headers=headers)
    assert response.status_code == 200, response.text
    text = response.content.decode("utf-8-sig")
    return [line for line in text.splitlines() if line.strip()]


def test_export_listing_headers_and_row(client, admin_headers):
    """export_type=listing → 文案表头 + 行内容。"""
    _ensure_sku(
        sku="LISTING-SKU-EXPORT",
        listing_title="导出标题",
        listing_bullet_1="要点一",
        listing_selling_points="卖点一；卖点二",
    )
    rows = _export_rows(
        client,
        admin_headers,
        project_name="文案测试项目",
        sku="LISTING-SKU-EXPORT",
        export_type="listing",
    )
    assert rows[0] == (
        "project_name,SKU,ASIN(可留空),FNSKU(可留空),品名(可留空),国家,"
        "标题,五点描述1,五点描述2,五点描述3,五点描述4,五点描述5,Description,卖点提炼"
    )
    assert "导出标题" in rows[1]
    assert "要点一" in rows[1]
    assert "卖点一；卖点二" in rows[1]


def test_export_cost_and_dimension_headers_unchanged(client, admin_headers):
    """既有 cost / dimension 两分支表头逐字节不变（回归锁）。"""
    _ensure_sku(sku="LISTING-SKU-EXPORT2")
    cost_rows = _export_rows(
        client, admin_headers, project_name="文案测试项目", export_type="cost"
    )
    assert cost_rows[0] == (
        "project_name,SKU,ASIN(可留空),FNSKU(可留空),品名(可留空),FOB单价(RMB),国家"
    )
    dim_rows = _export_rows(
        client, admin_headers, project_name="文案测试项目", export_type="dimension"
    )
    assert dim_rows[0].startswith(
        "project_name,SKU,ASIN(可留空),FNSKU(可留空),品名(可留空),国家,单品长(cm)"
    )
    assert dim_rows[0].endswith("装箱数量")
```

- [ ] **Step 2: 跑测试确认失败（红）**

```bash
cd <WT>/backend && python3 -m pytest tests/api/test_sku_listing_copy.py -q -k export
```

期望：listing 分支落到 cost 兜底（表头不符）→ 红；两分支回归应已绿。

- [ ] **Step 3: 实现导出分支**

`export_product_costs_csv` 现在用 `tab_segment = "尺寸管理" if normalized_export_type == "dimension" else "成本管理"` 与
`if normalized_export_type == "dimension": ... else: ...` 两分支。改为三分支：
把 `tab_segment` 计算改成映射，并在 `dimension` 分支后追加 `listing` 分支。

```python
    TAB_SEGMENTS = {
        "dimension": "尺寸管理",
        "listing": "产品文案",
    }
    tab_segment = TAB_SEGMENTS.get(normalized_export_type, "成本管理")
```

在 `if normalized_export_type == "dimension": ... filename = ...` 之后、
`else:`（成本分支）之前插入：

```python
    elif normalized_export_type == "listing":
        headers = [
            "project_name",
            "SKU",
            "ASIN(可留空)",
            "FNSKU(可留空)",
            "品名(可留空)",
            "国家",
            "标题",
            "五点描述1",
            "五点描述2",
            "五点描述3",
            "五点描述4",
            "五点描述5",
            "Description",
            "卖点提炼",
        ]
        csv_rows = [
            [
                row.project_name,
                row.sku,
                row.asin or "",
                row.fnsku or "",
                row.product_name or "",
                row.country,
                row.listing_title or "",
                row.listing_bullet_1 or "",
                row.listing_bullet_2 or "",
                row.listing_bullet_3 or "",
                row.listing_bullet_4 or "",
                row.listing_bullet_5 or "",
                row.listing_description or "",
                row.listing_selling_points or "",
            ]
            for row in rows
        ]
        filename = f"{safe_project_name}_{station_segment}-SKU信息-{tab_segment}批量修改模板-{timestamp}.csv"
```

- [ ] **Step 4: 跑测试确认通过（绿）**

```bash
cd <WT>/backend && python3 -m pytest tests/api/test_sku_listing_copy.py -q
```

---

### Task 5: 回归与契约

- [ ] **Step 1: 跑同域与相关域全量回归**

```bash
cd <WT>/backend && python3 -m pytest \
  tests/api/test_sku_listing_copy.py \
  tests/api/test_sku_product_image.py \
  tests/api/agent/test_sku_info.py \
  tests/api/agent/test_sku_info_native.py \
  tests/services/infra/test_cache_decorator_invariants.py \
  tests/test_check_alembic.py tests/test_cache_decorator_coverage.py -q
```

（`tests/test_cache_decorator_coverage.py` 若不存在则从命令中删掉。）

- [ ] **Step 2: 迁移图 + 缓存白名单双守护**

```bash
cd <WT>/backend && python3 scripts/check_alembic.py && python3 scripts/check_cache_decorator_coverage.py
```

- [ ] **Step 3: OpenAPI 契约重生成 + 前端类型同步**

```bash
cd <WT>/backend && python3 -m scripts.openapi_export --out ../frontend/types/api-generated/openapi.json
cd <WT>/frontend && node scripts/gen-api-types.mjs
```

`frontend/types/api-generated/` 是**契约文件**（git-tracked，前端构建靠它），
由后端 schema 驱动生成，后端 PR 可提交（否则 `pnpm build` 的
`gen:api-types:check` 会因漂移失败）。**不触碰任何前端业务代码。**

- [ ] **Step 4: 提交 + PR**

显式路径 `git add`，commit author 必须 `jr.way123@gmail.com`；PR title 带
`Closes BLF-1080`；PR body 按 `.github/pull_request_template.md` 写「测试声明」
（逐项数字），交棒 `[@代码质量工程师 Tia](mention://agent/d64098c0-685d-43d0-a6b7-a39881e6c135)`。

---

## Stage 3 任务（Agent API，S1 合入后执行）

### Task 6: Agent R1/R2 读侧补文案字段

**Files:**

- Modify: `backend/app/api/v1/endpoints/agent/sku_info.py`（`_serialize_sku_record`）
- Modify: `backend/app/schemas/agent_sku_info.py`
- Test: `backend/tests/api/agent/test_sku_listing_copy_agent.py`（新建）

要点：agent 侧 `_serialize_sku_record`（`agent/sku_info.py:216`）是**独立实现**，
需与内部同构补 10 个字段；`source_file` / `*_r2_key` 仍不外露（spec §4 公共约定）。
这一步让 R1/R2 **免费**获得文案读取能力（无需新端点）。

### Task 7: Agent 写侧（W1/W2 补字段 + W6 批量端点）

**Files:**

- Modify: `backend/app/schemas/agent_sku_info.py`
- Modify: `backend/app/api/v1/endpoints/agent/sku_info.py`
- Modify: `backend/app/services/infra/cache_write_endpoints.py`
- Modify: `backend/app/api/v1/endpoints/agent/__init__.py`（无需改——域复用）
- Test: `backend/tests/api/agent/test_sku_listing_copy_agent.py`

- **W1/W2**：`AgentSkuRecordUpsertRequest` / `AgentSkuRecordUpdateRequest` 加 8 个
  可选文案字段；W2 的 `_merge_update_payload` 的字段循环加 `LISTING_COPY_FIELDS`；
  W1 的 `SkuRecordCreate` 构造加文案（沿用 `model_fields_set` 语义）。
  同时 `update_sku_record_by_id` / `upsert_sku_record` 需支持文案字段 + 溯源列
  （服务层加 `if "listing_title" in payload.model_fields_set:` 形态的赋值块）。
- **W6 新端点**：`POST /agent/projects/{project_id}/sku-info/listing-copy/batch`
  - 请求：`{items: [{sku_record_id, listing_*...}], source}` + `Idempotency-Key`
  - confirm 两步流（`@require_confirmation(action="sku_info.listing_copy.batch", ...)`）+ 写桶限流
  - 只允许**本项目**的记录（跨项目 id → 404）；`source` 必填枚举（禁 manual）
  - 审计 `sku_info.listing_copy.batch`；`listing_copy_updated_by` = `agent_id`
  - 前端 `frontend/lib/agent-domains.ts` 的 `sku_info` 域 `routeCount` 7 → 8（**转交前端**）

---

## 自检清单（提交 PR 前）

- [ ] `python3 scripts/check_alembic.py` 通过（单 head `273`、命名合规）
- [ ] `python3 scripts/check_cache_decorator_coverage.py` 无腐烂
- [ ] `tests/api/test_sku_listing_copy.py` 全绿
- [ ] `tests/api/agent/test_sku_info*.py` 全绿（Agent 契约未破）
- [ ] `tests/api/test_sku_product_image.py` 全绿（同域回归）
- [ ] 成本 / 尺寸导出表头回归测试绿（逐字节不变）
- [ ] OpenAPI + `api.d.ts` 已重生成且已提交
- [ ] diff 无 TODO / FIXME / console.log / debugger
- [ ] commit author = `jr.way123@gmail.com`
- [ ] PR body 含「测试声明」（逐项数字）
