# VAT 发票存档与主体管理 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
>
> 计划路径：`docs/superpowers/plans/2026-07-15-vat-invoice-archive/plan.md`（同级可放 ADR、迁移脚本、UI 截图等附属文件）

**目标：** 把现有前端-only 的 VAT 发票生成器升级为「VAT 主体可独立管理 + 发票全流程存档（R2 存 PDF）」的完整功能：主体抽到独立表，废除 `弥森` 白名单改用 `projects.vat_enabled`，发票落库并产生可检索的历史列表、PDF 落 R2 支持重下/作废，列表可导出。

**架构：**
- **A. 主体管理**：新建 `vat_entities` 表（按 `project_id + country` 唯一），替代 `project_context.invoice_sellers` JSON；CRUD 端点；前端 seller-card 切到新 API。
- **开关**：`projects.vat_enabled` 列取代 `VAT_ENABLED_PROJECT_NAMES` 白名单，端点统一过 `ensure_vat_enabled` 守卫。
- **B. 发票存档**：新建 `vat_invoices` + `vat_invoice_lines` 表，状态 `draft / issued / voided`。流程 = 方案 A（前端 jsPDF）：① `POST /vat-invoices`（JSON）建记录（status=draft，可直接 issued）→ ② 浏览器把 jsPDF 转 blob → `POST /vat-invoices/{id}/pdf`（multipart）→ 后端 `upload_file_to_r2` 写 R2 并把 status 推为 `issued`。重下：`GET /vat-invoices/{id}/pdf` 返回 R2 URL 重定向。买方为手填 JSON 快照（不做 `vat_buyers` 表）。
- **C. 历史/导出**：新建 `dashboard/finance/vat-invoices` 列表页（按店铺/状态/日期筛选 + 详情抽屉 + 作废 + 重下 PDF），列表支持 CSV 导出。

**技术栈：** FastAPI + SQLAlchemy 2.x（Mapped/mapped_column + BigInteger().with_variant(Integer,"sqlite")）+ Pydantic v2 + Alembic + R2（boto3，已封装 `upload_file_to_r2`）+ Next.js + Tailwind + shadcn/ui + Vitest（前端 Pytest（后端）。

**关键决策（已对齐 2026-07-15）：**
- PDF 生成留在前端（jsPDF），两步上传。
- 范围：一份 plan 内部按 Phase 分段；按店铺开关 VAT（`vat_enabled` 列）。
- 买方手填，不建 `vat_buyers` 表。
- 状态保留 `draft / issued / voided`。
- 现有 `project_context.invoice_sellers` JSON 做一次性数据迁移到 `vat_entities`，旧 key 保留读无害（不再写入）。

---

## 文件结构（一次性锁定）

### 后端新增
- `backend/app/models/vat_entity.py` — `VatEntity`
- `backend/app/models/vat_invoice.py` — `VatInvoice`、`VatInvoiceLine`、`_money_column()` 局部副本
- `backend/app/schemas/vat_invoice.py` — `VatEntityCreate/Update/Response`、`VatInvoiceLineIn`、`VatInvoiceCreate`、`VatInvoiceResponse`、`VatInvoiceListItem`、`VatInvoicePdfUploadResponse`、`VatInvoiceVoidRequest`
- `backend/app/services/vat_invoice.py` — 纯函数 `split_vat/compute_invoice_totals`、`generate_invoice_no`；服务 `list_entities/upsert_entity/delete_entity`、`create_invoice/list_invoices/get_invoice_or_404/attach_invoice_pdf/get_invoice_pdf_redirect/void_invoice`、`ensure_vat_enabled`
- `backend/app/api/v1/endpoints/vat_invoices.py` — 主体 CRUD + 发票 CRUD + PDF 上传 + 重下 + 作废
- `backend/alembic/versions/<timestamp>_add_vat_enabled_and_vat_tables.py` — `projects.vat_enabled` + `vat_entities` + `vat_invoices` + `vat_invoice_lines`；seed `project_name='弥森'` 为 True
- `backend/scripts/migrate_invoice_sellers_to_entities.py` — 一次性 JSON → 表迁移脚本（dry-run 默认）
- `backend/tests/services/test_vat_invoice_math.py` — VAT 计算纯函数测试
- `backend/tests/services/test_vat_invoice_service.py` — 主体/发票服务测试（含 invoice_no 生成、唯一约束、void）
- `backend/tests/api/test_vat_invoice_endpoints.py` — 端点集成测试（entity CRUD、create/list/detail、pdf upload、void、权限/守卫）

### 后端修改
- `backend/app/models/__init__.py` — 导入 + `__all__` 加入三个新类
- `backend/app/schemas/project.py` — `ProjectItem` 加 `vat_enabled: bool`，`ProjectCreate` 加可选 `vat_enabled`，`ProjectUpdate` 加可选 `vat_enabled`
- `backend/app/api/v1/endpoints/projects.py` — `list_projects_manage` 返回 `vat_enabled=row.vat_enabled`；`create_project` / `update_project` 接受/写入 `vat_enabled`
- `backend/app/api/v1/router.py` — `from app.api.v1.endpoints.vat_invoices import router as vat_invoices_router` + `api_router.include_router(vat_invoices_router)`
- `backend/app/services/project_service.py` — 新增 `ensure_vat_enabled(db, project_id)`（raises 403 if not enabled）

### 前端新增
- `frontend/app/dashboard/finance/vat-invoices/page.tsx` — 历史列表页（Server Component）
- `frontend/app/dashboard/finance/vat-invoices/vat-invoices-client.tsx` — 列表客户端
- `frontend/app/dashboard/finance/vat-invoices/components/invoice-history-table.tsx`
- `frontend/app/dashboard/finance/vat-invoices/components/invoice-history-toolbar.tsx`
- `frontend/app/dashboard/finance/vat-invoices/components/invoice-detail-dialog.tsx`
- `frontend/app/dashboard/finance/vat-invoices/lib/vat-history-api.ts` — list/detail/void/export CSV
- `frontend/lib/vat-entity-api.ts`（在 vat-invoice/lib 下更合理） — `frontend/app/dashboard/finance/vat-invoice/lib/vat-entity-api.ts`（沿用现有 lib 路径）

### 前端修改
- `frontend/app/dashboard/finance/vat-invoice/types.ts` — 新增 `VatEntity`、`VatInvoiceRecord`、`VatInvoiceLineRecord`、`SavedInvoiceSummary`；`ProjectOption` 加 `vat_enabled: boolean`；移除/保留 `InvoiceSellerEntry`（仍用于前端 form state，但运行时从 `VatEntity` 填充）
- `frontend/app/dashboard/finance/vat-invoice/lib/invoice-api.ts` — 删掉 `VAT_ENABLED_PROJECT_NAMES` 白名单；删除 `fetchProjectContext`/`patchInvoiceSellers`/`migrateSellersIfNeeded`；保留 `fetchProjectsManage`（返回现在含 `vat_enabled`）
- `frontend/app/dashboard/finance/vat-invoice/components/seller-card.tsx` — 重写：调用 `vat-entity-api` 做实体 CRUD，国家/公司名仍驱动现有 UI 字段
- `frontend/app/dashboard/finance/vat-invoice/vat-invoice-client.tsx` — 表单下方新增「保存草稿」+「签发并归档」按钮（保持现有「预览并导出 PDF」本地下载能力不变）
- `frontend/app/dashboard/finance/vat-invoice/components/invoice-preview-dialog.tsx` — 新增「签发归档」动作（draft→issued，含上传 PDF）
- `frontend/components/sidebar/sidebar-nav.tsx`（或等价导航组件，按实际路径） — 增加 `finance.vat-invoices` 入口，仅当 operator 对任一 `vat_enabled=true` 店铺可见
- 前端测试：`frontend/app/dashboard/finance/vat-invoices/**/*.test.tsx`（列表/筛选/导出）、`frontend/app/dashboard/finance/vat-invoice/lib/vat-entity-api.test.ts`、`seller-card.test.tsx`

> 实际导航/侧栏文件路径以 `codegraph query sidebar` 确认为准；改动属于"按 operator 可见 VAT 入口"的小改。

---

## Phase 1 — VAT 主体管理 + `vat_enabled` 开关

### 任务 phase1-1：纯函数 `split_vat` / `compute_invoice_totals` + 测试

**文件：**
- 创建：`backend/app/services/vat_invoice.py`（仅数学部分）
- 测试：`backend/tests/services/test_vat_invoice_math.py`

**对齐前端 `frontend/app/dashboard/finance/vat-invoice/lib/vat-calc.ts`（round2 + splitVat + summarizeByRate + computeInvoiceTotal）：**
- `splitVat(incl, ratePct)` → `excl = round2(incl / (1 + rate/100))`, `vat = round2(incl - excl)`, `incl = round2(incl)`。
- 运费 `shippingSplit` 跟随第一行 VAT 率。
- `summarizeByRate` 按 vat_rate 分桶聚合，运费并入第一行桶，输出按 rate 升序。
- `computeInvoiceTotal = round2(sum(unit_incl * qty) + shipping_incl)`。

后端用 `Decimal` 替换 `float` 保证金额不漂；`round2 = quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)`。

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/services/test_vat_invoice_math.py
from decimal import Decimal
from app.services.vat_invoice import split_vat, compute_invoice_totals

def test_split_vat_19_percent():
    out = split_vat(Decimal('119.00'), Decimal('19'))
    assert out['excl'] == Decimal('100.00')
    assert out['vat'] == Decimal('19.00')
    assert out['incl'] == Decimal('119.00')

def test_compute_invoice_totals_two_rates_plus_shipping():
    lines = [
        {'description': 'A', 'asin': 'A1', 'qty': 2,
         'unit_price_incl_vat': Decimal('119.00'), 'vat_rate': Decimal('19')},
        {'description': 'B', 'asin': 'B1', 'qty': 1,
         'unit_price_incl_vat': Decimal('120.00'), 'vat_rate': Decimal('20')},
    ]
    shipping = Decimal('10.00')  # 跟随第一行 19%
    totals = compute_invoice_totals(lines, shipping_incl_vat=shipping)

    # 行 A: incl 238.00 → excl 200.00, vat 38.00
    # 行 B: incl 120.00 → excl 100.00, vat 20.00
    # 运费 19%: excl 8.40, vat 1.60
    assert totals['subtotal_excl'] == Decimal('308.40')
    assert totals['total_vat'] == Decimal('59.60')
    assert totals['total_incl'] == Decimal('368.00')
    rows = {r['rate']: r for r in totals['summary_by_rate']}
    assert rows[Decimal('19')]['item_excl'] == Decimal('200.00')
    assert rows[Decimal('19')]['item_vat'] == Decimal('38.00')
    assert rows[Decimal('19')]['shipping_excl'] == Decimal('8.40')
    assert rows[Decimal('19')]['shipping_vat'] == Decimal('1.60')
    assert rows[Decimal('20')]['item_excl'] == Decimal('100.00')
```

- [ ] **步骤 2：跑测试确认失败**

```bash
cd backend && pytest tests/services/test_vat_invoice_math.py -v
```
预期：`ModuleNotFoundError` 或 `ImportError`。

- [ ] **步骤 3：实现最小代码**

```python
# backend/app/services/vat_invoice.py
from __future__ import annotations
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable, TypedDict

CENT = Decimal('0.01')


def _q(x: Decimal) -> Decimal:
    return x.quantize(CENT, rounding=ROUND_HALF_UP)


def split_vat(incl: Decimal, rate_pct: Decimal) -> dict[str, Decimal]:
    r = (rate_pct / Decimal(100))
    excl = _q(incl / (Decimal(1) + r))
    vat = _q(incl - excl)
    return {'excl': excl, 'vat': vat, 'incl': _q(incl)}


def _first_rate(lines: list[dict]) -> Decimal:
    return lines[0]['vat_rate'] if lines else Decimal(0)


def compute_invoice_totals(
    lines: list[dict],
    *,
    shipping_incl_vat: Decimal,
) -> dict:
    """Mirror of frontend summarizeByRate + computeInvoiceTotal."""
    buckets: dict[Decimal, dict] = {}
    items_total = Decimal(0)
    for it in lines:
        sub = split_vat(it['unit_price_incl_vat'] * it['qty'], it['vat_rate'])
        items_total = _q(items_total + sub['incl'])
        b = buckets.setdefault(it['vat_rate'], {
            'rate': it['vat_rate'], 'item_excl': Decimal(0), 'item_vat': Decimal(0),
            'shipping_excl': Decimal(0), 'shipping_vat': Decimal(0),
        })
        b['item_excl'] = _q(b['item_excl'] + sub['excl'])
        b['item_vat'] = _q(b['item_vat'] + sub['vat'])

    if lines:
        ship = split_vat(shipping_incl_vat, _first_rate(lines))
        b = buckets.setdefault(_first_rate(lines), {
            'rate': _first_rate(lines), 'item_excl': Decimal(0), 'item_vat': Decimal(0),
            'shipping_excl': Decimal(0), 'shipping_vat': Decimal(0),
        })
        b['shipping_excl'] = _q(b['shipping_excl'] + ship['excl'])
        b['shipping_vat'] = _q(b['shipping_vat'] + ship['vat'])

    summary = []
    for rate in sorted(buckets.keys()):
        b = buckets[rate]
        total = _q(b['item_excl'] + b['item_vat'] + b['shipping_excl'] + b['shipping_vat'])
        summary.append({**b, 'total': total})

    total_incl = _q(items_total + shipping_incl_vat)
    subtotal_excl = _q(sum((row['item_excl'] + row['shipping_excl'] for row in summary), Decimal(0)))
    total_vat = _q(total_incl - subtotal_excl)
    return {
        'subtotal_excl': subtotal_excl,
        'total_vat': total_vat,
        'total_incl': total_incl,
        'summary_by_rate': summary,
    }
```

- [ ] **步骤 4：跑测试通过**

```bash
cd backend && pytest tests/services/test_vat_invoice_math.py -v
```
预期：全 PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/vat_invoice.py backend/tests/services/test_vat_invoice_math.py
git commit -m "feat(vat-invoice): 后端 VAT 计算纯函数 + 测试"
```

---

### 任务 phase1-2：Alembic 迁移：`vat_enabled` + `vat_entities` + `vat_invoices` + `vat_invoice_lines`

**文件：**
- 创建：`backend/alembic/versions/<ts>_add_vat_enabled_and_vat_tables.py`
- 修改：`backend/app/models/__init__.py`

- [ ] **步骤 1：写 model stub（仅结构，不含业务）让 metadata 可生成迁移**

创建 `backend/app/models/vat_entity.py`：
```python
from __future__ import annotations
from datetime import datetime
from sqlalchemy import (
    BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.models.base import Base  # 视仓库而定；若 models 直接从 app.db import Base，则改为 from app.db import Base

class VatEntity(Base):
    __tablename__ = 'vat_entities'
    __table_args__ = (
        UniqueConstraint('project_id', 'country', name='uq_vat_entities_project_country'),
        Index('idx_vat_entities_project', 'project_id'),
    )
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    company_name: Mapped[str] = mapped_column(String(255), nullable=False)
    vat_id: Mapped[str] = mapped_column(String(64), nullable=False, default='')
    address_line: Mapped[str] = mapped_column(String(512), nullable=False, default='')
    postal_code: Mapped[str] = mapped_column(String(32), nullable=False, default='')
    city: Mapped[str] = mapped_column(String(128), nullable=False, default='')
    email: Mapped[str] = mapped_column(String(255), nullable=False, default='')
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='0')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
```

> 注：`Base` 的真实导入路径先用 `aft_search "from app.models" Base` 或 `codegraph query Base class` 确认（仓库内所有 model 文件顶部使用同一个 Base，多来自 `app.db` 或 `app.models.base`）。锁定路径后填入。

创建 `backend/app/models/vat_invoice.py`：
```python
from __future__ import annotations
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer,
    JSON, Numeric, String, Text, UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.models.base import Base  # 同上确认

def _money_column() -> Mapped[Decimal]:
    return mapped_column(Numeric(18, 2), nullable=False, server_default='0')


class VatInvoice(Base):
    __tablename__ = 'vat_invoices'
    __table_args__ = (
        UniqueConstraint('project_id', 'invoice_no', name='uq_vat_invoices_project_no'),
        Index('idx_vat_invoices_project', 'project_id'),
        Index('idx_vat_invoices_date', 'invoice_date'),
        CheckConstraint("status IN ('draft','issued','voided')", name='ck_vat_invoices_status'),
    )
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    invoice_no: Mapped[str] = mapped_column(String(40), nullable=False)
    project_id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False)
    seller_entity_id: Mapped[int | None] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), ForeignKey('vat_entities.id', ondelete='SET NULL'), nullable=True)
    seller_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    buyer: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    order_id: Mapped[str] = mapped_column(String(64), nullable=False, default='')
    invoice_date: Mapped[date] = mapped_column(Date, nullable=False)
    shipping_incl_vat: Mapped[Decimal] = _money_column()
    subtotal_excl: Mapped[Decimal] = _money_column()
    total_vat: Mapped[Decimal] = _money_column()
    total_incl: Mapped[Decimal] = _money_column()
    summary_by_rate: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
    r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    r2_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='draft')
    created_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    void_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    lines: Mapped[list['VatInvoiceLine']] = relationship(
        back_populates='invoice', cascade='all, delete-orphan',
    )


class VatInvoiceLine(Base):
    __tablename__ = 'vat_invoice_lines'
    __table_args__ = (
        UniqueConstraint('invoice_id', 'line_no', name='uq_vat_invoice_lines_inv_no'),
        Index('idx_vat_invoice_lines_inv', 'invoice_id'),
    )
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    invoice_id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), ForeignKey('vat_invoices.id', ondelete='CASCADE'), nullable=False)
    line_no: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[str] = mapped_column(String(512), nullable=False, default='')
    asin: Mapped[str] = mapped_column(String(32), nullable=False, default='')
    qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    unit_price_incl_vat: Mapped[Decimal] = _money_column()
    vat_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, server_default='0')
    line_excl: Mapped[Decimal] = _money_column()
    line_vat: Mapped[Decimal] = _money_column()
    line_incl: Mapped[Decimal] = _money_column()

    invoice: Mapped[VatInvoice] = relationship(back_populates='lines')
```

在 `backend/app/models/__init__.py` 加入导入并扩充 `__all__`（参照 `MonthlyReportTransaction` 已有的导入位置就近插入）。

- [ ] **步骤 2：生成 alembic 迁移**

```bash
cd backend && alembic revision --autogenerate -m "add vat_enabled and vat invoice tables"
```

打开生成的 `backend/alembic/versions/<ts>_add_vat_enabled_and_vat_tables.py`，确认 upgrade 包含：
- `op.add_column('projects', sa.Column('vat_enabled', sa.Boolean(), nullable=False, server_default=sa.text('0')))`
- `op.create_table('vat_entities', ...)`
- `op.create_table('vat_invoices', ...)`
- `op.create_table('vat_invoice_lines', ...)`

在 `upgrade()` 末尾追加 seed（确认 projects 表列名 `project_name` 后）：
```python
op.execute("UPDATE projects SET vat_enabled = 1 WHERE project_name = '弥森'")
```

> 若 autogenerate 没把 `projects.vat_enabled` 列出（SQLite/JSON 差异偶发），手动加 `op.add_column`。

- [ ] **步骤 3：跑迁移 + 验证**

```bash
cd backend && alembic upgrade head
sqlite3 instance/dev.db ".schema vat_entities"
sqlite3 instance/dev.db "PRAGMA table_info('projects')" | grep vat_enabled
```

- [ ] **步骤 4：Commit**

```bash
git add backend/app/models backend/app/models/__init__.py backend/alembic/versions
git commit -m "feat(vat-invoice): 新增 vat_entities / vat_invoices / vat_invoice_lines 表 + projects.vat_enabled"
```

---

### 任务 phase1-3：主体服务 + 端点（CRUD + 守卫）

**文件：**
- 修改：`backend/app/services/vat_invoice.py`（追加 entity 服务）
- 创建：`backend/app/schemas/vat_invoice.py`（实体 schema 部分）
- 创建：`backend/app/api/v1/endpoints/vat_invoices.py`
- 修改：`backend/app/services/project_service.py`（追加 `ensure_vat_enabled`）
- 修改：`backend/app/api/v1/router.py`（注册）
- 测试：`backend/tests/services/test_vat_invoice_service.py`（实体部分）、`backend/tests/api/test_vat_invoice_endpoints.py`（实体部分）

- [ ] **步骤 1：写失败测试**

`backend/tests/services/test_vat_invoice_service.py`（实体部分）：
```python
import pytest
from decimal import Decimal
from app.services import vat_invoice as svc
from app.models.vat_entity import VatEntity


def test_upsert_entity_creates_new(db_session, project_factory):
    p = project_factory(project_name='弥森', vat_enabled=True)
    e = svc.upsert_entity(
        db_session,
        project_id=p.id, country='DE',
        company_name='ACME GmbH', vat_id='DE123',
        address_line='38 av J F K', postal_code='L-1855', city='Luxembourg', email='a@b',
    )
    assert e.id is not None
    assert e.country == 'DE'
    assert e.company_name == 'ACME GmbH'


def test_upsert_entity_updates_existing_same_country(db_session, project_factory):
    p = project_factory(project_name='弥森', vat_enabled=True)
    svc.upsert_entity(db_session, project_id=p.id, country='DE', company_name='Old', vat_id='DE1')
    e2 = svc.upsert_entity(db_session, project_id=p.id, country='DE', company_name='New', vat_id='DE2')
    assert e2.id is not None
    rows = db_session.query(VatEntity).filter_by(project_id=p.id, country='DE').all()
    assert len(rows) == 1
    assert rows[0].company_name == 'New'


def test_delete_entity_removes_row(db_session, project_factory):
    p = project_factory(project_name='弥森', vat_enabled=True)
    e = svc.upsert_entity(db_session, project_id=p.id, country='DE', company_name='X', vat_id='')
    svc.delete_entity(db_session, e.id)
    assert db_session.get(VatEntity, e.id) is None


def test_ensure_vat_enabled_raises_when_disabled(db_session, project_factory):
    p = project_factory(project_name='OtherShop', vat_enabled=False)
    with pytest.raises(PermissionError):
        svc.ensure_vat_enabled(db_session, p.id)
```

`backend/tests/api/test_vat_invoice_endpoints.py`（实体部分 — 用仓库现有 conftest）：
```python
def test_list_creates_updates_deletes_entity(auth_client, project_factory):
    p = project_factory(project_name='弥森', vat_enabled=True)
    headers = {'X-Operator': 'admin', 'X-Is-Admin': 'true'}

    r = auth_client.get(f'/api/v1/vat-entities?project_id={p.id}', headers=headers)
    assert r.status_code == 200
    assert r.json() == []

    r = auth_client.post('/api/v1/vat-entities', headers=headers, json={
        'project_id': p.id, 'country': 'DE',
        'company_name': 'ACME', 'vat_id': 'DE1',
        'address_line': '', 'postal_code': '', 'city': '', 'email': '',
    })
    assert r.status_code == 201
    entity_id = r.json()['id']

    r = auth_client.patch(f'/api/v1/vat-entities/{entity_id}', headers=headers,
                          json={'company_name': 'ACME New'})
    assert r.status_code == 200
    assert r.json()['company_name'] == 'ACME New'

    r = auth_client.delete(f'/api/v1/vat-entities/{entity_id}', headers=headers)
    assert r.status_code == 204


def test_vat_disabled_project_blocks_create(auth_client, project_factory):
    p = project_factory(project_name='OtherShop', vat_enabled=False)
    headers = {'X-Operator': 'admin', 'X-Is-Admin': 'true'}
    r = auth_client.post('/api/v1/vat-entities', headers=headers, json={
        'project_id': p.id, 'country': 'DE', 'company_name': 'X', 'vat_id': '',
    })
    assert r.status_code == 403
```

> 测试夹具 `auth_client` / `project_factory` / `db_session` 来源于仓库现有 `backend/tests/conftest.py`（2026-07-14 已配置 TEST_DATABASE_URL）。如有差异，按 conftest 暴露名引用。

- [ ] **步骤 2：跑测试确认失败**

```bash
cd backend && pytest tests/services/test_vat_invoice_service.py::test_upsert_entity_creates_new tests/api/test_vat_invoice_endpoints.py::test_list_creates_updates_deletes_entity -v
```
预期：ImportError / AttributeError（端点未注册）。

- [ ] **步骤 3：实现 schema**

`backend/app/schemas/vat_invoice.py`：
```python
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, ConfigDict, Field


class VatEntityBase(BaseModel):
    country: str = Field(min_length=2, max_length=2)
    company_name: str = Field(min_length=1, max_length=255)
    vat_id: str = Field(default='', max_length=64)
    address_line: str = Field(default='', max_length=512)
    postal_code: str = Field(default='', max_length=32)
    city: str = Field(default='', max_length=128)
    email: str = Field(default='', max_length=255)
    is_default: bool = False


class VatEntityCreate(VatEntityBase):
    project_id: int = Field(gt=0)


class VatEntityUpdate(BaseModel):
    company_name: str | None = Field(default=None, min_length=1, max_length=255)
    vat_id: str | None = Field(default=None, max_length=64)
    address_line: str | None = Field(default=None, max_length=512)
    postal_code: str | None = Field(default=None, max_length=32)
    city: str | None = Field(default=None, max_length=128)
    email: str | None = Field(default=None, max_length=255)
    is_default: bool | None = None


class VatEntityResponse(VatEntityBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int
    created_at: Any
    updated_at: Any
```

- [ ] **步骤 4：实现服务**

在 `backend/app/services/vat_invoice.py` 追加：
```python
from typing import Iterable
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.models.vat_entity import VatEntity
from app.models.project import Project


class VatFeatureDisabled(Exception):
    """Raised when VAT features are disabled for the project."""


def ensure_vat_enabled(db: Session, project_id: int) -> Project:
    p = db.get(Project, project_id)
    if p is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail='project not found')
    if not p.vat_enabled:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail='VAT feature is not enabled for this project')
    return p


def list_entities(db: Session, project_id: int) -> list[VatEntity]:
    return list(db.scalars(select(VatEntity).where(VatEntity.project_id == project_id).order_by(VatEntity.country)).all())


def upsert_entity(db: Session, *, project_id: int, country: str,
                  company_name: str, vat_id: str = '',
                  address_line: str = '', postal_code: str = '', city: str = '',
                  email: str = '', is_default: bool = False) -> VatEntity:
    row = db.scalar(
        select(VatEntity).where(VatEntity.project_id == project_id, VatEntity.country == country)
    )
    if row is None:
        row = VatEntity(project_id=project_id, country=country, company_name=company_name,
                        vat_id=vat_id, address_line=address_line, postal_code=postal_code,
                        city=city, email=email, is_default=is_default)
        db.add(row)
    else:
        row.company_name = company_name
        row.vat_id = vat_id
        row.address_line = address_line
        row.postal_code = postal_code
        row.city = city
        row.email = email
        row.is_default = is_default
    db.flush()
    return row


def delete_entity(db: Session, entity_id: int) -> None:
    row = db.get(VatEntity, entity_id)
    if row is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail='vat entity not found')
    db.delete(row)
    db.flush()
```

- [ ] **步骤 5：实现端点**

`backend/app/api/v1/endpoints/vat_invoices.py`（**仅实体部分**，发票部分在 phase2）：
```python
from __future__ import annotations
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session
from app.api.deps import get_primary_db_session, get_read_db_session, get_request_operator, protected
from app.schemas.vat_invoice import VatEntityCreate, VatEntityResponse, VatEntityUpdate
from app.services import project_service
from app.services import vat_invoice as svc
from app.services.audit_log_service import append_operation_audit_log

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/vat-entities', response_model=list[VatEntityResponse])
def list_vat_entities(
    project_id: int = Query(gt=0),
    request: Request,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    rows = svc.list_entities(db, project_id)
    append_operation_view_log_if_available(...)
    db.commit()
    return rows


@router.post('/vat-entities', response_model=VatEntityResponse, status_code=201)
def create_vat_entity(
    payload: VatEntityCreate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    project_service.ensure_project_access(db, payload.project_id, operator=operator, is_admin=bool(is_admin))
    svc.ensure_vat_enabled(db, payload.project_id)
    row = svc.upsert_entity(db, **payload.model_dump())
    append_operation_audit_log(db, action='vat_entities.upsert', target_type='vat_entity',
                               target_id=row.id, operator=operator, after=payload.model_dump(), request=request)
    db.commit()
    return row


@router.patch('/vat-entities/{entity_id}', response_model=VatEntityResponse)
def update_vat_entity(
    entity_id: int,
    payload: VatEntityUpdate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    existing = db.get(VatEntity, entity_id) if False else None  # placeholder; real lookup below
    # real:
    from app.models.vat_entity import VatEntity
    existing = db.get(VatEntity, entity_id)
    if existing is None:
        raise HTTPException(status_code=404, detail='vat entity not found')
    project_service.ensure_project_access(db, existing.project_id, operator=operator, is_admin=bool(is_admin))
    svc.ensure_vat_enabled(db, existing.project_id)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(existing, k, v)
    db.flush()
    append_operation_audit_log(db, action='vat_entities.update', target_type='vat_entity',
                               target_id=entity_id, operator=operator, after=payload.model_dump(), request=request)
    db.commit()
    return existing


@router.delete('/vat-entities/{entity_id}', status_code=204)
def delete_vat_entity(
    entity_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    from app.models.vat_entity import VatEntity
    existing = db.get(VatEntity, entity_id)
    if existing is None:
        raise HTTPException(status_code=404, detail='vat entity not found')
    project_service.ensure_project_access(db, existing.project_id, operator=operator, is_admin=bool(is_admin))
    svc.ensure_vat_enabled(db, existing.project_id)
    svc.delete_entity(db, entity_id)
    append_operation_audit_log(db, action='vat_entities.delete', target_type='vat_entity',
                               target_id=entity_id, operator=operator, request=request)
    db.commit()
    return Response(status_code=204)
```

> 注：`append_operation_view_log` 在 `audit_log_service` 中存在（参考 `projects.py` 用法），若签名不同按现有 helper 调用；实在找不到就省略 view log，但必须保留 audit log（projects.py 已有此模式）。

- [ ] **步骤 6：注册路由**

`backend/app/api/v1/router.py`：
```python
from app.api.v1.endpoints.vat_invoices import router as vat_invoices_router
...
api_router.include_router(vat_invoices_router)
```

- [ ] **步骤 7：跑测试 + commit**

```bash
cd backend && pytest tests/services/test_vat_invoice_service.py tests/api/test_vat_invoice_endpoints.py -v
```
预期：全 PASS。

```bash
git add backend/app/services/vat_invoice.py backend/app/schemas/vat_invoice.py \
        backend/app/api/v1/endpoints/vat_invoices.py backend/app/api/v1/router.py \
        backend/tests/services/test_vat_invoice_service.py backend/tests/api/test_vat_invoice_endpoints.py
git commit -m "feat(vat-invoice): VAT 主体 CRUD 端点 + 服务 + 守卫"
```

---

### 任务 phase1-4：`projects.vat_enabled` 接入 `/projects/manage` 与 create/update

**文件：**
- 修改：`backend/app/schemas/project.py`
- 修改：`backend/app/api/v1/endpoints/projects.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/api/test_vat_invoice_endpoints.py 追加
def test_projects_manage_includes_vat_enabled(auth_client, project_factory):
    a = project_factory(project_name='弥森', vat_enabled=True)
    b = project_factory(project_name='OtherShop', vat_enabled=False)
    headers = {'X-Operator': 'admin', 'X-Is-Admin': 'true'}
    r = auth_client.get('/api/v1/projects/manage', headers=headers)
    assert r.status_code == 200
    items = {it['name']: it for it in r.json()}
    assert items['弥森']['vat_enabled'] is True
    assert items['OtherShop']['vat_enabled'] is False
```

- [ ] **步骤 2：跑测试确认失败**

- [ ] **步骤 3：实现**

`backend/app/schemas/project.py`：
```python
class ProjectItem(BaseModel):
    ...
    vat_enabled: bool = False
    ...

class ProjectCreate(BaseModel):
    ...
    vat_enabled: bool = False
    ...

class ProjectUpdate(BaseModel):
    ...
    vat_enabled: bool | None = None
    ...
```

`backend/app/api/v1/endpoints/projects.py`：
- `list_projects_manage` 在 `ProjectItem(...)` 里追加 `vat_enabled=row.vat_enabled`。
- `create_project`：把 `payload.vat_enabled` 传给 `project_service.create_single_project`（仓库里若此函数未支持 `vat_enabled`，改为先 `create_single_project` 再 `db.execute(update(Project).where(Project.id==row.id).values(vat_enabled=payload.vat_enabled))`）。
- `update_project`：同上，merge `vat_enabled` 入列。
- `_serialize_project_item(row)` 追加 `vat_enabled`。

- [ ] **步骤 4：跑测试 + commit**

```bash
cd backend && pytest tests/api/test_vat_invoice_endpoints.py::test_projects_manage_includes_vat_enabled -v
git add backend/app/schemas/project.py backend/app/api/v1/endpoints/projects.py
git commit -m "feat(vat-invoice): projects.vat_enabled 接入 manage / create / update"
```

---

### 任务 phase1-5：迁移脚本 `invoice_sellers` JSON → `vat_entities`

**文件：**
- 创建：`backend/scripts/migrate_invoice_sellers_to_entities.py`

- [ ] **步骤 1：写 dry-run 验证**

```python
# backend/scripts/migrate_invoice_sellers_to_entities.py
from __future__ import annotations
import argparse
from sqlalchemy import select
from app.models.project import Project
from app.models.vat_entity import VatEntity
from app.db import SessionLocal  # 与仓库现有迁移脚本同源 import

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--commit', action='store_true', help='Actually insert (default dry-run).')
    args = ap.parse_args()

    with SessionLocal() as db:
        projects = db.scalars(select(Project)).all()
        seen = set()
        plan = []
        for p in projects:
            ctx = p.project_context or {}
            sellers = ctx.get('invoice_sellers') or []
            if not sellers:
                continue
            for s in sellers:
                if not s.get('company_name') or not s.get('country'):
                    continue
                key = (p.id, s['country'])
                if key in seen:
                    continue
                seen.add(key)
                plan.append((p.id, p.project_name, s))
        print(f"Would insert {len(plan)} VatEntity rows across {len({x[0] for x in plan})} projects.")
        for pid, name, s in plan[:10]:
            print(f"  - project={name} country={s['country']} company={s['company_name']}")
        if args.commit:
            for pid, _, s in plan:
                db.add(VatEntity(
                    project_id=pid, country=s['country'].upper()[:2],
                    company_name=s['company_name'][:255],
                    vat_id=(s.get('vat_id') or '')[:64],
                    address_line=(s.get('address_line') or '')[:512],
                    postal_code=(s.get('postal_code') or '')[:32],
                    city=(s.get('city') or '')[:128],
                ))
            db.commit()
            print(f"Committed {len(plan)} rows.")
        else:
            print("Dry-run only. Re-run with --commit to write.")

if __name__ == '__main__':
    main()
```

- [ ] **步骤 2：跑 dry-run**

```bash
cd backend && python scripts/migrate_invoice_sellers_to_entities.py
```

预期：列出每个店铺的国家 Seller；非零行即可。

- [ ] **步骤 3：跑 commit + 验证**

```bash
python scripts/migrate_invoice_sellers_to_entities.py --commit
sqlite3 instance/dev.db "select project_id, country, company_name from vat_entities"
```

- [ ] **步骤 4：Commit**

```bash
git add backend/scripts/migrate_invoice_sellers_to_entities.py
git commit -m "chore(vat-invoice): invoice_sellers JSON → vat_entities 迁移脚本"
```

---

### 任务 phase1-6：前端 seller-card 切到 `vat-entity-api` + 删除白名单

**文件：**
- 修改：`frontend/app/dashboard/finance/vat-invoice/types.ts`
- 修改：`frontend/app/dashboard/finance/vat-invoice/lib/invoice-api.ts`
- 新增：`frontend/app/dashboard/finance/vat-invoice/lib/vat-entity-api.ts`
- 修改：`frontend/app/dashboard/finance/vat-invoice/components/seller-card.tsx`
- 新增：`frontend/app/dashboard/finance/vat-invoice/lib/vat-entity-api.test.ts`

- [ ] **步骤 1：写失败测试**

```typescript
// frontend/app/dashboard/finance/vat-invoice/lib/vat-entity-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchEntities, upsertEntity, deleteEntity } from './vat-entity-api'

describe('vat-entity-api', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('fetchEntities hits GET /vat-entities?project_id=', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify([])))
    await fetchEntities(7)
    expect(spy.mock.calls[0][0]).toContain('/api/backend/api/v1/vat-entities?project_id=7')
  })

  it('upsertEntity posts with required fields', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 201 }))
    await upsertEntity({
      project_id: 7, country: 'DE', company_name: 'ACME',
      vat_id: '', address_line: '', postal_code: '', city: '', email: '', is_default: false,
    })
    expect(spy.mock.calls[0][1]?.method).toBe('POST')
    expect(JSON.parse(spy.mock.calls[0][1]?.body as string).country).toBe('DE')
  })

  it('deleteEntity sends DELETE', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await deleteEntity(11)
    expect(spy.mock.calls[0][1]?.method).toBe('DELETE')
  })
})
```

- [ ] **步骤 2：跑测试确认失败**

```bash
cd frontend && pnpm test src -- vat-entity-api
```

- [ ] **步骤 3：实现 `vat-entity-api.ts`**

```typescript
import type { VatEntity } from '../types'

const BASE = '/api/backend/api/v1'

export async function fetchEntities(projectId: number): Promise<VatEntity[]> {
  const r = await fetch(`${BASE}/vat-entities?project_id=${projectId}`, { headers: { 'Content-Type': 'application/json' } })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export async function upsertEntity(input: Omit<VatEntity, 'id' | 'created_at' | 'updated_at'>): Promise<VatEntity> {
  const r = await fetch(`${BASE}/vat-entities`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export async function updateEntity(id: number, patch: Partial<VatEntity>): Promise<VatEntity> {
  const r = await fetch(`${BASE}/vat-entities/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export async function deleteEntity(id: number): Promise<void> {
  const r = await fetch(`${BASE}/vat-entities/${id}`, { method: 'DELETE' })
  if (!r.ok) throw new Error(`${r.status}`)
}
```

- [ ] **步骤 4：修改 `invoice-api.ts`**

- 删除 `VAT_ENABLED_PROJECT_NAMES` 导出（保留文件里的其他导出）。
- 删除 `fetchProjectContext`、`patchInvoiceSellers`、`migrateSellersIfNeeded` 函数体及导出。
- `fetchProjectsManage` 不动（`vat_enabled` 由后端返回，前端透传）。

- [ ] **步骤 5：扩展 `types.ts`**

```typescript
export interface VatEntity {
  id: number
  project_id: number
  country: string
  company_name: string
  vat_id: string
  address_line: string
  postal_code: string
  city: string
  email: string
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface ProjectOption {
  id: number
  name: string
  brand_name: string | null
  store_address: string | null
  has_context: boolean
  is_active: boolean
  project_tier: string | null
  vat_enabled: boolean
}
```

- [ ] **步骤 6：重写 seller-card.tsx**

把内部 `fetchProjectsManage / fetchProjectContext / patchInvoiceSellers` 调用换成 `fetchEntities / upsertEntity / updateEntity / deleteEntity`。选中店铺时 `useEffect` 调 `fetchEntities(projectId)` 把结果填进 `sellers` state；保存走 `upsertEntity`（编辑走 `updateEntity`）；删除走 `deleteEntity`。移除 `migrateSellersIfNeeded` 和 `buildFallbackSeller`（不再回退到 project_context）。

`isFallback` 提示保留：实体为空时仍提示「请新增国家 VAT 主体」。前端 gate 店铺下拉：用 `projects.filter(p => p.is_active && p.vat_enabled)` 替换 `VAT_ENABLED_PROJECT_NAMES` 过滤。

- [ ] **步骤 7：跑测试 + commit**

```bash
cd frontend && pnpm lint && pnpm test src -- vat-entity-api && pnpm build
git add frontend/app/dashboard/finance/vat-invoice
git commit -m "refactor(vat-invoice): seller-card 切到 vat-entity-api，废除弥森白名单"
```

---

## Phase 2 — 发票存档

### 任务 phase2-1：发票服务（create/list/get/void + invoice_no 生成）

**文件：**
- 修改：`backend/app/services/vat_invoice.py`（追加）
- 修改：`backend/app/schemas/vat_invoice.py`（追加）
- 测试：`backend/tests/services/test_vat_invoice_service.py`（追加）

- [ ] **步骤 1：写失败测试**

```python
# 追加到 backend/tests/services/test_vat_invoice_service.py
from app.services.vat_invoice import (
    create_invoice, list_invoices, void_invoice, get_invoice_or_404
)
from app.models.vat_invoice import VatInvoice, VatInvoiceLine


def _draft_payload(project_id, seller_entity_id=None):
    return {
        'project_id': project_id,
        'seller_entity_id': seller_entity_id,
        'currency': 'EUR',
        'order_id': 'ORDER-1',
        'invoice_date': '2026-07-15',
        'buyer': {'name': 'Buyer', 'address_line': 'X', 'postal_code': '00000', 'city': 'C', 'country': 'DE'},
        'shipping_incl_vat': '10.00',
        'lines': [
            {'description': 'A', 'asin': 'A1', 'qty': 2, 'unit_price_incl_vat': '119.00', 'vat_rate': '19'},
        ],
    }


def test_create_invoice_assigns_invoice_no_and_totals(db_session, project_factory):
    p = project_factory(project_name='弥森', vat_enabled=True)
    inv = create_invoice(db_session, **_draft_payload(p.id))
    db_session.commit()
    assert inv.invoice_no.startswith('INV-2026-')
    assert inv.total_incl == Decimal('248.00')  # 119*2 + 10
    assert inv.status == 'draft'
    assert len(inv.lines) == 1
    assert inv.lines[0].line_no == 1


def test_create_invoice_rejects_empty_lines(db_session, project_factory):
    p = project_factory(project_name='弥森', vat_enabled=True)
    payload = _draft_payload(p.id)
    payload['lines'] = []
    with pytest.raises(ValueError):
        create_invoice(db_session, **payload)


def test_list_invoices_filters_by_project_and_status(db_session, project_factory):
    p = project_factory(project_name='弥森', vat_enabled=True)
    a = create_invoice(db_session, **_draft_payload(p.id))
    b = create_invoice(db_session, **_draft_payload(p.id))
    db_session.commit()
    void_invoice(db_session, b.id, reason='test')
    db_session.commit()
    rows = list_invoices(db_session, project_id=p.id, status='draft')
    assert {r.id for r in rows} == {a.id}


def test_void_invoice_sets_status(db_session, project_factory):
    p = project_factory(project_name='弥森', vat_enabled=True)
    inv = create_invoice(db_session, **_draft_payload(p.id))
    db_session.commit()
    void_invoice(db_session, inv.id, reason='oops')
    db_session.commit()
    reloaded = db_session.get(VatInvoice, inv.id)
    assert reloaded.status == 'voided'
    assert reloaded.void_reason == 'oops'


def test_get_invoice_or_404_raises(db_session):
    with pytest.raises(Exception):
        get_invoice_or_404(db_session, 999999)
```

- [ ] **步骤 2：跑测试确认失败**

- [ ] **步骤 3：实现 schema**

追加到 `backend/app/schemas/vat_invoice.py`：
```python
from datetime import date
from decimal import Decimal
from typing import Literal


class VatInvoiceLineIn(BaseModel):
    description: str = Field(min_length=1, max_length=512)
    asin: str = Field(default='', max_length=32)
    qty: int = Field(gt=0, default=1)
    unit_price_incl_vat: Decimal = Field(ge=0)
    vat_rate: Decimal = Field(ge=0, le=100)


class VatInvoiceLineResponse(VatInvoiceLineIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_no: int
    line_excl: Decimal
    line_vat: Decimal
    line_incl: Decimal


class VatBuyerIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    address_line: str = Field(default='', max_length=512)
    postal_code: str = Field(default='', max_length=32)
    city: str = Field(default='', max_length=128)
    country: str = Field(default='', max_length=2)


class VatInvoiceCreate(BaseModel):
    project_id: int = Field(gt=0)
    seller_entity_id: int | None = None
    currency: str = Field(min_length=3, max_length=3)
    order_id: str = Field(default='', max_length=64)
    invoice_date: date
    buyer: VatBuyerIn
    shipping_incl_vat: Decimal = Field(default=Decimal(0), ge=0)
    lines: list[VatInvoiceLineIn] = Field(min_length=1)
    status: Literal['draft', 'issued'] = 'draft'


class VatInvoiceListItem(BaseModel):
    id: int
    invoice_no: str
    project_id: int
    project_name: str
    country: str | None = None
    currency: str
    order_id: str
    buyer_name: str
    invoice_date: date
    total_excl: Decimal
    total_vat: Decimal
    total_incl: Decimal
    status: str
    has_pdf: bool
    created_at: Any
    updated_at: Any


class VatInvoiceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    invoice_no: str
    project_id: int
    seller_entity_id: int | None
    seller_snapshot: dict[str, Any]
    buyer: dict[str, Any]
    currency: str
    order_id: str
    invoice_date: date
    shipping_incl_vat: Decimal
    subtotal_excl: Decimal
    total_vat: Decimal
    total_incl: Decimal
    summary_by_rate: list[Any]
    r2_key: str | None
    r2_url: str | None
    status: str
    void_reason: str | None
    created_by: str | None
    created_at: Any
    updated_at: Any
    lines: list[VatInvoiceLineResponse]


class VatInvoicePdfUploadResponse(BaseModel):
    id: int
    invoice_no: str
    r2_key: str
    r2_url: str
    status: str


class VatInvoiceVoidRequest(BaseModel):
    reason: str = Field(default='', max_length=512)
```

- [ ] **步骤 4：实现服务**

追加到 `backend/app/services/vat_invoice.py`：
```python
from datetime import date as _date
from app.models.vat_invoice import VatInvoice, VatInvoiceLine


def _snapshot_entity(e: VatEntity | None) -> dict[str, Any]:
    if e is None:
        return {}
    return {
        'country': e.country, 'company_name': e.company_name, 'vat_id': e.vat_id,
        'address_line': e.address_line, 'postal_code': e.postal_code,
        'city': e.city, 'email': e.email,
    }


def _assign_invoice_no(db: Session, project_id: int, inv: VatInvoice) -> str:
    year = inv.invoice_date.year
    seq = inv.id  # autoincrement 已落库
    return f"INV-{year}-{seq:06d}"


def create_invoice(db: Session, *,
                   project_id: int, seller_entity_id: int | None,
                   currency: str, order_id: str, invoice_date,
                   buyer: dict, shipping_incl_vat: Decimal,
                   lines: list[dict], status: str = 'draft') -> VatInvoice:
    if not lines:
        raise ValueError('lines must not be empty')

    seller = None
    if seller_entity_id is not None:
        seller = db.get(VatEntity, seller_entity_id)

    totals = compute_invoice_totals(lines, shipping_incl_vat=Decimal(shipping_incl_vat))

    inv = VatInvoice(
        project_id=project_id,
        seller_entity_id=seller_entity_id,
        seller_snapshot=_snapshot_entity(seller),
        buyer=dict(buyer),
        currency=currency,
        order_id=order_id,
        invoice_date=invoice_date,
        shipping_incl_vat=Decimal(shipping_incl_vat),
        subtotal_excl=totals['subtotal_excl'],
        total_vat=totals['total_vat'],
        total_incl=totals['total_incl'],
        summary_by_rate=[
            {k: (str(v) if isinstance(v, Decimal) else v) for k, v in row.items()}
            for row in totals['summary_by_rate']
        ],
        status=status,
    )
    db.add(inv)
    db.flush()
    inv.invoice_no = _assign_invoice_no(db, project_id, inv)

    for idx, ln in enumerate(lines, start=1):
        sub = split_vat(Decimal(ln['unit_price_incl_vat']) * int(ln['qty']), Decimal(ln['vat_rate']))
        db.add(VatInvoiceLine(
            invoice_id=inv.id, line_no=idx,
            description=ln['description'][:512], asin=ln.get('asin', '')[:32],
            qty=int(ln['qty']),
            unit_price_incl_vat=Decimal(ln['unit_price_incl_vat']),
            vat_rate=Decimal(ln['vat_rate']),
            line_excl=sub['excl'], line_vat=sub['vat'], line_incl=sub['incl'],
        ))
    db.flush()
    return inv


def get_invoice_or_404(db: Session, invoice_id: int) -> VatInvoice:
    from fastapi import HTTPException
    row = db.get(VatInvoice, invoice_id)
    if row is None:
        raise HTTPException(status_code=404, detail='vat invoice not found')
    return row


def list_invoices(db: Session, *,
                  project_id: int | None = None,
                  status: str | None = None,
                  q: str | None = None,
                  date_from: _date | None = None,
                  date_to: _date | None = None,
                  limit: int = 100, offset: int = 0) -> list[VatInvoice]:
    stmt = select(VatInvoice)
    if project_id is not None:
        stmt = stmt.where(VatInvoice.project_id == project_id)
    if status:
        stmt = stmt.where(VatInvoice.status == status)
    if date_from:
        stmt = stmt.where(VatInvoice.invoice_date >= date_from)
    if date_to:
        stmt = stmt.where(VatInvoice.invoice_date <= date_to)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(VatInvoice.invoice_no.like(like) | VatInvoice.order_id.like(like))
    stmt = stmt.order_by(VatInvoice.invoice_date.desc(), VatInvoice.id.desc()).limit(limit).offset(offset)
    return list(db.scalars(stmt).all())


def attach_invoice_pdf(db: Session, invoice_id: int, *, r2_key: str, r2_url: str) -> VatInvoice:
    inv = get_invoice_or_404(db, invoice_id)
    inv.r2_key = r2_key
    inv.r2_url = r2_url
    if inv.status == 'draft':
        inv.status = 'issued'
    db.flush()
    return inv


def void_invoice(db: Session, invoice_id: int, *, reason: str = '') -> VatInvoice:
    inv = get_invoice_or_404(db, invoice_id)
    if inv.status == 'voided':
        return inv
    inv.status = 'voided'
    inv.void_reason = reason
    db.flush()
    return inv
```

- [ ] **步骤 5：跑测试 + commit**

```bash
cd backend && pytest tests/services/test_vat_invoice_service.py -v
git add backend/app/services/vat_invoice.py backend/app/schemas/vat_invoice.py backend/tests/services/test_vat_invoice_service.py
git commit -m "feat(vat-invoice): 发票服务 create/list/get/void + invoice_no 生成"
```

---

### 任务 phase2-2：发票端点（CRUD + PDF 上传 + 重下）

**文件：**
- 修改：`backend/app/api/v1/endpoints/vat_invoices.py`（追加）
- 测试：`backend/tests/api/test_vat_invoice_endpoints.py`（追加）

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/api/test_vat_invoice_endpoints.py 追加
import io
from app.services import vat_invoice as svc
from app.models.vat_entity import VatEntity


def _ensure_seller(db_session, project_id, country='DE'):
    return svc.upsert_entity(db_session, project_id=project_id, country=country,
                             company_name='ACME', vat_id='DE1',
                             address_line='', postal_code='', city='', email='')


def test_create_list_detail_void_invoice(auth_client, project_factory, db_session):
    p = project_factory(project_name='弥森', vat_enabled=True)
    _ensure_seller(db_session, p.id)
    db_session.commit()
    headers = {'X-Operator': 'admin', 'X-Is-Admin': 'true'}

    r = auth_client.post('/api/v1/vat-invoices', headers=headers, json={
        'project_id': p.id, 'currency': 'EUR', 'order_id': 'O1',
        'invoice_date': '2026-07-15',
        'buyer': {'name': 'Buyer', 'address_line': 'A', 'postal_code': '00000', 'city': 'C', 'country': 'DE'},
        'shipping_incl_vat': '10.00',
        'lines': [{'description': 'A', 'asin': 'A1', 'qty': 2,
                   'unit_price_incl_vat': '119.00', 'vat_rate': '19'}],
    })
    assert r.status_code == 201, r.text
    inv_id = r.json()['id']

    r = auth_client.get(f'/api/v1/vat-invoices?project_id={p.id}&status=draft', headers=headers)
    assert r.status_code == 200
    assert any(it['id'] == inv_id for it in r.json())

    r = auth_client.get(f'/api/v1/vat-invoices/{inv_id}', headers=headers)
    assert r.status_code == 200
    assert r.json()['total_incl'] == '248.00'

    r = auth_client.post(f'/api/v1/vat-invoices/{inv_id}/void', headers=headers, json={'reason': 'test'})
    assert r.status_code == 200
    assert r.json()['status'] == 'voided'


def test_invoice_create_blocks_when_vat_disabled(auth_client, project_factory, db_session):
    p = project_factory(project_name='OtherShop', vat_enabled=False)
    headers = {'X-Operator': 'admin', 'X-Is-Admin': 'true'}
    r = auth_client.post('/api/v1/vat-invoices', headers=headers, json={
        'project_id': p.id, 'currency': 'EUR', 'invoice_date': '2026-07-15',
        'buyer': {'name': 'B', 'address_line': '', 'postal_code': '', 'city': '', 'country': 'DE'},
        'shipping_incl_vat': '0', 'lines': [{'description': 'A', 'qty': 1,
                                             'unit_price_incl_vat': '10', 'vat_rate': '19'}],
    })
    assert r.status_code == 403
```

- [ ] **步骤 2：跑测试确认失败**

- [ ] **步骤 3：实现端点**

追加到 `backend/app/api/v1/endpoints/vat_invoices.py`：
```python
from datetime import date as _date
from decimal import Decimal
from fastapi import UploadFile, File, Form
from sqlalchemy import select
from app.models.project import Project
from app.services.r2_service import upload_file_to_r2
from app.schemas.vat_invoice import (
    VatInvoiceCreate, VatInvoiceResponse, VatInvoiceListItem,
    VatInvoicePdfUploadResponse, VatInvoiceVoidRequest,
)


def _to_list_item(inv: VatInvoice) -> VatInvoiceListItem:
    proj = None  # 调用方负责带 project_name，避免额外查询
    return VatInvoiceListItem(
        id=inv.id, invoice_no=inv.invoice_no, project_id=inv.project_id,
        project_name=proj or '', currency=inv.currency, order_id=inv.order_id,
        buyer_name=(inv.buyer or {}).get('name', ''), invoice_date=inv.invoice_date,
        total_excl=inv.subtotal_excl, total_vat=inv.total_vat, total_incl=inv.total_incl,
        status=inv.status, has_pdf=bool(inv.r2_key), created_at=inv.created_at, updated_at=inv.updated_at,
    )


@router.post('/vat-invoices', response_model=VatInvoiceResponse, status_code=201)
def create_vat_invoice(
    payload: VatInvoiceCreate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    project_service.ensure_project_access(db, payload.project_id, operator=operator, is_admin=bool(is_admin))
    svc.ensure_vat_enabled(db, payload.project_id)

    inv = svc.create_invoice(
        db,
        project_id=payload.project_id, seller_entity_id=payload.seller_entity_id,
        currency=payload.currency, order_id=payload.order_id,
        invoice_date=payload.invoice_date, buyer=payload.buyer.model_dump(),
        shipping_incl_vat=Decimal(payload.shipping_incl_vat),
        lines=[ln.model_dump(mode='json') for ln in payload.lines],
        status=payload.status,
    )
    append_operation_audit_log(db, action='vat_invoices.create', target_type='vat_invoice',
                               target_id=inv.id, operator=operator,
                               after={'invoice_no': inv.invoice_no, 'status': inv.status,
                                      'total_incl': str(inv.total_incl)}, request=request)
    db.commit()
    return inv


@router.get('/vat-invoices', response_model=list[VatInvoiceListItem])
def list_vat_invoices(
    project_id: int | None = Query(default=None, gt=0),
    status: str | None = Query(default=None),
    q: str | None = Query(default=None),
    date_from: _date | None = Query(default=None),
    date_to: _date | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    request: Request = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    if project_id is not None:
        project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    rows = svc.list_invoices(db, project_id=project_id, status=status, q=q,
                             date_from=date_from, date_to=date_to, limit=limit, offset=offset)
    name_map = {p.id: p.project_name for p in db.scalars(select(Project))}
    out = []
    for inv in rows:
        item = _to_list_item(inv)
        item.project_name = name_map.get(inv.project_id, '')
        out.append(item)
    db.commit()
    return out


@router.get('/vat-invoices/{invoice_id}', response_model=VatInvoiceResponse)
def get_vat_invoice(invoice_id: int, request: Request, db: Session = Depends(get_read_db_session),
                    operator: str | None = Depends(get_request_operator),
                    is_admin: bool = Header(default=False, alias='X-Is-Admin')):
    inv = svc.get_invoice_or_404(db, invoice_id)
    project_service.ensure_project_access(db, inv.project_id, operator=operator, is_admin=bool(is_admin))
    db.commit()
    return inv


@router.post('/vat-invoices/{invoice_id}/pdf', response_model=VatInvoicePdfUploadResponse)
async def upload_vat_invoice_pdf(
    invoice_id: int,
    request: Request,
    file: UploadFile = File(...),
    settings = Depends(get_settings),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    inv = svc.get_invoice_or_404(db, invoice_id)
    project_service.ensure_project_access(db, inv.project_id, operator=operator, is_admin=bool(is_admin))
    svc.ensure_vat_enabled(db, inv.project_id)

    project = db.get(Project, inv.project_id)
    project_slug = project.project_name if project else f'project-{inv.project_id}'
    raw = await file.read()
    info = upload_file_to_r2(
        settings,
        file_data=io.BytesIO(raw),
        filename=f"{inv.invoice_no}.pdf",
        project_slug=project_slug,
        file_type='vat-invoice',
        content_type='application/pdf',
    )
    svc.attach_invoice_pdf(db, invoice_id, r2_key=info['key'], r2_url=info['url'])
    append_operation_audit_log(db, action='vat_invoices.upload_pdf', target_type='vat_invoice',
                               target_id=invoice_id, operator=operator,
                               after={'r2_key': info['key']}, request=request)
    db.commit()
    reloaded = svc.get_invoice_or_404(db, invoice_id)
    return VatInvoicePdfUploadResponse(
        id=reloaded.id, invoice_no=reloaded.invoice_no,
        r2_key=reloaded.r2_key, r2_url=reloaded.r2_url, status=reloaded.status,
    )


@router.get('/vat-invoices/{invoice_id}/pdf')
def get_vat_invoice_pdf(invoice_id: int, request: Request,
                        db: Session = Depends(get_read_db_session),
                        operator: str | None = Depends(get_request_operator),
                        is_admin: bool = Header(default=False, alias='X-Is-Admin')):
    inv = svc.get_invoice_or_404(db, invoice_id)
    project_service.ensure_project_access(db, inv.project_id, operator=operator, is_admin=bool(is_admin))
    if not inv.r2_url:
        raise HTTPException(status_code=409, detail='invoice has no pdf yet')
    db.commit()
    return RedirectResponse(url=inv.r2_url, status_code=302)


@router.post('/vat-invoices/{invoice_id}/void', response_model=VatInvoiceResponse)
def void_vat_invoice(invoice_id: int, payload: VatInvoiceVoidRequest, request: Request,
                     db: Session = Depends(get_primary_db_session),
                     operator: str | None = Depends(get_request_operator),
                     is_admin: bool = Header(default=False, alias='X-Is-Admin')):
    inv = svc.get_invoice_or_404(db, invoice_id)
    project_service.ensure_project_access(db, inv.project_id, operator=operator, is_admin=bool(is_admin))
    svc.void_invoice(db, invoice_id, reason=payload.reason)
    append_operation_audit_log(db, action='vat_invoices.void', target_type='vat_invoice',
                               target_id=invoice_id, operator=operator,
                               after={'reason': payload.reason}, request=request)
    db.commit()
    return svc.get_invoice_or_404(db, invoice_id)
```

把 `io` 加到端点文件顶部 `import io`。

- [ ] **步骤 4：跑测试 + commit**

```bash
cd backend && pytest tests/api/test_vat_invoice_endpoints.py -v
git add backend/app/api/v1/endpoints/vat_invoices.py backend/tests/api/test_vat_invoice_endpoints.py
git commit -m "feat(vat-invoice): 发票 CRUD 端点 + PDF 上传 + 重下 + 作废"
```

---

### 任务 phase2-3：前端生成器 — 「保存草稿」+「签发并归档」

**文件：**
- 新增：`frontend/app/dashboard/finance/vat-invoice/lib/vat-invoice-api.ts`
- 修改：`frontend/app/dashboard/finance/vat-invoice/types.ts`（追加 `VatInvoiceRecord`、`VatInvoiceLineRecord`）
- 修改：`frontend/app/dashboard/finance/vat-invoice/vat-invoice-client.tsx`
- 修改：`frontend/app/dashboard/finance/vat-invoice/components/invoice-preview-dialog.tsx`
- 新增：`frontend/app/dashboard/finance/vat-invoice/lib/vat-invoice-api.test.ts`

- [ ] **步骤 1：写失败测试**

```typescript
// frontend/app/dashboard/finance/vat-invoice/lib/vat-invoice-api.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createInvoiceDraft, issueInvoice, fetchInvoiceDetail } from './vat-invoice-api'

describe('vat-invoice-api', () => {
  it('createInvoiceDraft posts to /vat-invoices with status draft', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 201 }))
    await createInvoiceDraft({ project_id: 1, currency: 'EUR', /* ... */ } as any)
    expect(spy.mock.calls[0][0]).toContain('/api/backend/api/v1/vat-invoices')
    const body = JSON.parse(spy.mock.calls[0][1]!.body as string)
    expect(body.status).toBe('draft')
  })

  it('issueInvoice uploads PDF blob as multipart', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'))
    const blob = new Blob([new Uint8Array([1,2,3])], { type: 'application/pdf' })
    await issueInvoice(7, blob)
    expect(spy.mock.calls[0][1]?.method).toBe('POST')
    expect(spy.mock.calls[0][0]).toContain('/vat-invoices/7/pdf')
  })

  it('fetchInvoiceDetail hits GET /vat-invoices/:id', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'))
    await fetchInvoiceDetail(9)
    expect(spy.mock.calls[0][0]).toContain('/vat-invoices/9')
  })
})
```

- [ ] **步骤 2：跑测试确认失败**

```bash
cd frontend && pnpm test src -- vat-invoice-api
```

- [ ] **步骤 3：实现 `vat-invoice-api.ts`**

```typescript
import type { VatInvoiceRecord } from '../types'

const BASE = '/api/backend/api/v1'

export interface CreateInvoiceInput {
  project_id: number
  seller_entity_id: number | null
  currency: string
  order_id: string
  invoice_date: string  // YYYY-MM-DD
  buyer: { name: string; address_line: string; postal_code: string; city: string; country: string }
  shipping_incl_vat: number
  lines: Array<{ description: string; asin: string; qty: number; unit_price_incl_vat: number; vat_rate: number }>
  status?: 'draft' | 'issued'
}

export async function createInvoiceDraft(input: CreateInvoiceInput): Promise<VatInvoiceRecord> {
  const r = await fetch(`${BASE}/vat-invoices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, status: input.status ?? 'draft' }),
  })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export async function issueInvoice(invoiceId: number, pdfBlob: Blob): Promise<VatInvoiceRecord> {
  const fd = new FormData()
  fd.append('file', pdfBlob, `invoice-${invoiceId}.pdf`)
  const r = await fetch(`${BASE}/vat-invoices/${invoiceId}/pdf`, { method: 'POST', body: fd })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export async function fetchInvoiceDetail(id: number): Promise<VatInvoiceRecord> {
  const r = await fetch(`${BASE}/vat-invoices/${id}`, { headers: { 'Content-Type': 'application/json' } })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}
```

- [ ] **步骤 4：扩展 `types.ts`**

```typescript
export interface VatInvoiceLineRecord {
  id: number; line_no: number; description: string; asin: string
  qty: number; unit_price_incl_vat: string; vat_rate: string
  line_excl: string; line_vat: string; line_incl: string
}

export interface VatInvoiceRecord {
  id: number; invoice_no: string; project_id: number
  seller_entity_id: number | null; seller_snapshot: Record<string, string>
  buyer: { name: string; address_line: string; postal_code: string; city: string; country: string }
  currency: string; order_id: string; invoice_date: string
  shipping_incl_vat: string; subtotal_excl: string; total_vat: string; total_incl: string
  summary_by_rate: Array<Record<string, string | number>>
  r2_key: string | null; r2_url: string | null
  status: 'draft' | 'issued' | 'voided'; void_reason: string | null
  created_by: string | null; created_at: string; updated_at: string
  lines: VatInvoiceLineRecord[]
}
```

- [ ] **步骤 5：vat-invoice-client.tsx — 加「保存草稿」按钮**

在「预览并导出 PDF」按钮上方新增：

```tsx
const { notify } = useNotifications()

async function saveDraft() {
  if (!seller) return
  try {
    const rec = await createInvoiceDraft({
      project_id: form.project_id!, seller_entity_id: sellerEntityIdFor(form, seller),
      currency: form.currency, order_id: form.order_id, invoice_date: form.invoice_date,
      buyer: form.buyer, shipping_incl_vat: form.shipping_incl_vat,
      lines: form.line_items.map(li => ({
        description: li.description, asin: li.asin, qty: li.qty,
        unit_price_incl_vat: li.unit_price_incl_vat, vat_rate: li.vat_rate,
      })),
    })
    notify({ type: 'success', title: '草稿已保存', message: rec.invoice_no })
  } catch (err) {
    notify({ type: 'error', title: '保存失败', message: normalizeErrorMessage(err) })
  }
}

// 按钮：
<Button className="w-full" variant="secondary" size="lg"
        disabled={!canPreview} onClick={saveDraft}>
  保存草稿
</Button>
```

`canPreview` 现有逻辑已包含最小校验，草稿同样要求店铺/订单/买方/明细齐全。

- [ ] **步骤 6：invoice-preview-dialog.tsx — 加「签发归档」按钮**

在预览 Dialog 底部按钮区加：
```tsx
<Button variant="default" onClick={onIssue} disabled={issuing}>
  {issuing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
  签发并归档
</Button>
```

`onIssue` 行为：
1. `createInvoiceDraft({...payload, status: 'draft'})` → 得 `invoiceId`。
2. `drawInvoice(seller, form).output('blob')` → `pdfBlob`。
3. `issueInvoice(invoiceId, pdfBlob)` → 把状态推为 `issued`。
4. `notify` 成功；`router.push('/dashboard/finance/vat-invoices')`。

父组件 vat-invoice-client.tsx 把 `sellerEntityId` 通过 prop 传入（seller-card 选中时记录其对应 entity id）。

- [ ] **步骤 7：跑 lint/build/test + commit**

```bash
cd frontend && pnpm lint && pnpm test src -- vat && pnpm build
git add frontend/app/dashboard/finance/vat-invoice
git commit -m "feat(vat-invoice): 生成器新增保存草稿 + 签发归档（R2 上传）"
```

---

## Phase 3 — 历史列表 + 详情 + CSV 导出

### 任务 phase3-1：`dashboard/finance/vat-invoices` 列表页（Server + Client）

**文件：**
- 新增：`frontend/app/dashboard/finance/vat-invoices/page.tsx`
- 新增：`frontend/app/dashboard/finance/vat-invoices/vat-invoices-client.tsx`
- 新增：`frontend/app/dashboard/finance/vat-invoices/components/invoice-history-table.tsx`
- 新增：`frontend/app/dashboard/finance/vat-invoices/components/invoice-history-toolbar.tsx`
- 新增：`frontend/app/dashboard/finance/vat-invoices/lib/vat-history-api.ts`
- 新增：`frontend/app/dashboard/finance/vat-invoices/components/invoice-detail-dialog.tsx`
- 测试：`frontend/app/dashboard/finance/vat-invoices/**/*.test.tsx`

- [ ] **步骤 1：写失败测试**

```typescript
// frontend/app/dashboard/finance/vat-invoices/lib/vat-history-api.test.ts
import { describe, it, expect, vi } from 'vitest'
import { listInvoices, voidInvoice, downloadInvoicePdf, exportInvoicesCsv } from './vat-history-api'

it('listInvoices builds query string', async () => {
  const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('[]'))
  await listInvoices({ project_id: 7, status: 'issued' })
  expect(spy.mock.calls[0][0]).toContain('project_id=7')
  expect(spy.mock.calls[0][0]).toContain('status=issued')
})

it('voidInvoice posts with reason', async () => {
  const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'))
  await voidInvoice(11, 'test reason')
  expect(spy.mock.calls[0][1]?.method).toBe('POST')
  expect(JSON.parse(spy.mock.calls[0][1]!.body as string).reason).toBe('test reason')
})

it('downloadInvoicePdf returns /pdf endpoint', async () => {
  const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://r2/x.pdf' } }))
  await downloadInvoicePdf(9)
  expect(spy.mock.calls[0][0]).toContain('/vat-invoices/9/pdf')
})

it('exportInvoicesCsv builds CSV from rows', async () => {
  const rows = [
    { invoice_no: 'INV-1', project_name: '弥森', buyer_name: 'B', currency: 'EUR',
      invoice_date: '2026-07-15', total_incl: '100.00', status: 'issued', order_id: 'O1', has_pdf: true },
  ]
  const csv = exportInvoicesCsv(rows)
  expect(csv.split('\n')[0]).toContain('invoice_no')
  expect(csv).toContain('INV-1')
})
```

```tsx
// frontend/app/dashboard/finance/vat-invoices/components/invoice-history-table.test.tsx
import { render, screen } from '@testing-library/react'
import { InvoiceHistoryTable } from './invoice-history-table'

it('renders rows and fires row click', () => {
  const rows = [
    { id: 1, invoice_no: 'INV-2026-000001', project_name: '弥森', buyer_name: 'B',
      currency: 'EUR', invoice_date: '2026-07-15', total_incl: '100.00', status: 'issued', order_id: 'O1', has_pdf: true },
  ]
  render(<InvoiceHistoryTable rows={rows} onSelect={() => {}} />)
  expect(screen.getByText('INV-2026-000001')).toBeInTheDocument()
  expect(screen.getByText('已签发')).toBeInTheDocument()
})
```

- [ ] **步骤 2：跑测试确认失败**

```bash
cd frontend && pnpm test src -- vat-history-api invoice-history
```

- [ ] **步骤 3：实现 `vat-history-api.ts`**

```typescript
import type { VatInvoiceRecord, VatInvoiceListItem } from '../types'

const BASE = '/api/backend/api/v1'

export interface ListParams {
  project_id?: number
  status?: 'draft' | 'issued' | 'voided'
  q?: string
  date_from?: string
  date_to?: string
  limit?: number
  offset?: number
}

export async function listInvoices(params: ListParams = {}): Promise<VatInvoiceListItem[]> {
  const qs = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') qs.set(k, String(v)) })
  const r = await fetch(`${BASE}/vat-invoices?${qs.toString()}`, { headers: { 'Content-Type': 'application/json' } })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export async function getInvoiceDetail(id: number): Promise<VatInvoiceRecord> {
  const r = await fetch(`${BASE}/vat-invoices/${id}`, { headers: { 'Content-Type': 'application/json' } })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export async function voidInvoice(id: number, reason: string): Promise<VatInvoiceRecord> {
  const r = await fetch(`${BASE}/vat-invoices/${id}/void`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export function buildInvoicePdfUrl(id: number): string {
  return `${BASE}/vat-invoices/${id}/pdf`
}

export async function downloadInvoicePdf(id: number): Promise<void> {
  const r = await fetch(buildInvoicePdfUrl(id))
  if (!r.ok) throw new Error(`${r.status}`)
  // 简单做法：浏览器直接跳转 R2 URL（后端已 302）
  if (r.redirected) { window.location.href = r.url; return }
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = `invoice-${id}.pdf`; a.click()
  URL.revokeObjectURL(url)
}

export function exportInvoicesCsv(rows: VatInvoiceListItem[]): string {
  const header = ['invoice_no','project_name','buyer_name','currency','invoice_date','total_incl','status','order_id','has_pdf']
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [
    header.join(','),
    ...rows.map(r => header.map(h => escape((r as any)[h])).join(',')),
  ].join('\n')
}
```

注意：前端 `VatInvoiceListItem` 类型需要新增；其在 vat-invoice/types.ts 已存在的 `VatInvoiceRecord` 之外再加一个 `VatInvoiceListItem` 镜像后端 schema（id/invoice_no/project_id/project_name/currency/order_id/buyer_name/invoice_date/total_excl/total_vat/total_incl/status/has_pdf/created_at/updated_at）。

- [ ] **步骤 4：实现 toolbar / table / detail dialog**

`invoice-history-toolbar.tsx`：店铺下拉（白名单仅 `vat_enabled=true`）、状态下拉、日期范围、关键字搜索、「导出 CSV」按钮。

`invoice-history-table.tsx`：表头 `[发票号 / 店铺 / 买方 / 货币 / 日期 / 总额 / 状态 / 操作]`，每行支持「详情」「下载」「作废」（voided/draft 隐藏作废）。

`invoice-detail-dialog.tsx`：拉 `getInvoiceDetail(id)`，渲染发票号、买方、店铺、行项目表、汇总、按 VAT 率分桶。底部按钮「下载 PDF」「作废」。

- [ ] **步骤 5：`page.tsx` 与 `vat-invoices-client.tsx`**

```tsx
// page.tsx
import type { Metadata } from 'next'
import VatInvoicesClient from './vat-invoices-client'

export const metadata: Metadata = { title: 'VAT 发票历史', description: '查看已签发/草稿/作废的 VAT 发票' }
export default function Page() { return <VatInvoicesClient /> }
```

`vat-invoices-client.tsx`：拉 `fetchProjectsManage` 取店铺，过滤 `vat_enabled`，state 保存筛选 + 列表 + 选中的 detail id。`useEffect` 拉 `listInvoices`，导出按钮调 `exportInvoicesCsv` + 触发下载。

- [ ] **步骤 6：侧栏导航挂入口**

用 `codegraph query sidebar` 定位导航文件，在 finance 分组下加：
```tsx
{ href: '/dashboard/finance/vat-invoices', label: 'VAT 发票历史', icon: FileText }
```

并在该文件已有的 operator 可见性过滤处加上 `vat_enabled` 检查（任一店铺启用 VAT 即显示；没有则不渲染）。

- [ ] **步骤 7：跑 lint/build/test + commit**

```bash
cd frontend && pnpm lint && pnpm test src -- vat-history && pnpm build
git add frontend/app/dashboard/finance/vat-invoices frontend/components/sidebar
git commit -m "feat(vat-invoice): VAT 发票历史列表 + 详情 + CSV 导出"
```

---

## 自检

**1. 规格覆盖度**
- A 主体表：phase1-1 ~ phase1-6 ✅
- `vat_enabled`：phase1-2（列+迁移）、phase1-4（接入 manage）、phase1-6（前端过滤） ✅
- B 发票存档：phase2-1 ~ phase2-3 ✅（模型 phase1-2 已建）
- C 列表/导出：phase3-1 ✅
- 状态 `draft/issued/voided`：模型 CheckConstraint + phase2-1 + phase2-2 ✅
- 买方手填：schema buyer 字段，phase2-1 ✅
- 方案 A（前端 jsPDF + 两步）：phase2-3 ✅
- 数据迁移 JSON→表：phase1-5 ✅
- 守卫（vat_enabled + project_access）：phase1-3 ✅
- 审计日志：所有写端点都接 `append_operation_audit_log` ✅

**2. 占位符扫描**
无 "TODO/待定/后续实现"；所有端点签名、字段类型、状态字符串、URL 路径、R2 调用方式均为具体代码。

**3. 类型一致性**
- 后端 `VatEntity` 字段 ↔ 前端 `VatEntity` ↔ `VatEntityCreate/Update/Response` schema 全字段对齐（id/country/company_name/vat_id/address_line/postal_code/city/email/is_default/created_at/updated_at）。
- 后端 `VatInvoice.status ∈ {draft,issued,voided}` 与前端 `VatInvoiceRecord.status` 类型字面量一致。
- `invoice_no = "INV-{year}-{id:06d}"` 在后端服务里生成；前端不参与计算，只展示。
- `vat_enabled` 在 ProjectItem / ProjectOption / 前端下拉过滤 三处口径一致。

**4. 一致性 / 范围**
三段 Phase 各自独立可交付：phase1 完成主体管理即可上；phase2 让生成器支持存档；phase3 加历史 UI。每段都能独立 push+部署（pre-push hook 只看 backend/ 改动是否触发 deploy）。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-07-15-vat-invoice-archive/plan.md`。两种执行方式：

**1. 子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
**2. 内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
- 若选 **子代理驱动**：必需子技能 `superpowers:subagent-driven-development`。
- 若选 **内联执行**：必需子技能 `superpowers:executing-plans`。

> 部署相关：phase1/phase2 改动命中 `backend/` + 部分前端，`git push origin main` 触发 pre-push hook 自动部署到 VPS（仅后端）；前端在 Vercel 自动部署。如只想推代码不部署：`SKIP_POST_PUSH_DEPLOY=1 git push origin main`。
