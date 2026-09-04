# DE / UK 月报 VAT 口径适配 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 DE（VAT 19%）和 UK（VAT 20%）站点的 Amazon 月报使用 tax-inclusive 口径：收入合计 = sales + sales tax，报表显式增加 VAT 列，回款公式改为 `income + expense - vat`，US 项目保持原状零变更。

**架构：**
- 后端 PT3/PT4 模型各加 1-2 列；抽出 `_compute_vat_metrics(classified, country)` 共享给新上传 (`tasks/scripts/monthly_report.py`) 和重算 (`payment/financial.py:compute_metrics`) 两条路径
- alembic 迁移加 3 列（server_default='0'，存量数据零影响）
- 报表核算 Excel 双栏明细在 Total_Income 之前插入 2 行；财务序列 trend 加 `vat_total` 点
- 前端 TypeScript 类型同步加字段，UI 多展示 1 行 + 1 条趋势线，**前端不重算公式**

**技术栈：** FastAPI + SQLAlchemy + alembic + Pydantic v2 / Next.js 14 + React 18 + TanStack Table v8 + Recharts

---

## 文件结构

### 后端（修改）

| 文件 | 职责 |
|---|---|
| `backend/app/models/monthly_report.py` | PT3 加 `income_vat_total`、`income_sales_with_tax`；PT4 加 `expense_vat_total` |
| `backend/alembic/versions/20260611_160_add_de_uk_vat_total.py` | 新建迁移：PT3 +2 列、PT4 +1 列，server_default='0' |
| `backend/app/services/payment/financial.py` | 新增 `_compute_vat_metrics()` 共享函数；`compute_metrics()` 接入，pt3 / pt4 payload 加新字段，回款公式用新口径 |
| `backend/app/tasks/scripts/monthly_report.py` | `run()` 接入同一 VAT 函数（与 compute_metrics 保持一致） |
| `backend/app/services/report/pt3.py` | `_build_accounting_rows` 双栏明细插入 2 行；`_normalize_pt3_payload` 透传 |
| `backend/app/services/report/pt4.py` | `_normalize_pt4_payload` 已透传 dict，**无需改**（自动接受新字段） |
| `backend/app/services/report/export.py` | 核算明细 Excel 导出插入 2 行 |
| `backend/app/schemas/monthly_report.py` | `MonthlyFinancialSeriesRow` / `MonthlyFinancialTrendPoint` / `MonthlyFinancialAccountingLine` 加字段 |

### 前端（修改）

| 文件 | 职责 |
|---|---|
| `frontend/app/dashboard/data-analysis/financial-data/financial-data-client.tsx` | 财务序列 chart 多 1 条 VAT 趋势线；核算明细 tab 双栏多 2 行；FinancialExportDetailRow 类型加 3 字段；buildFinancialExportTotals 累加 3 字段 |
| `frontend/app/dashboard/data-analysis/financial-data/page.tsx` | 服务端初始化数据透传新字段 |
| `frontend/app/dashboard/data-reporting/monthly-report/page.tsx` | 若展示 amazon_pay_back，**确认用后端算好的值**（不重算） |

### 后端（无修改，仅确认行为）

- `backend/app/services/report/monthly.py:rebuild_pt3_pt4_for_report` — 通过 `_load_transaction_raw_rows` 读 `raw_row["product sales tax"]`（**CSV 解析时已持久化**），调 `compute_metrics`（**已更新**）→ 自动支持重算
- `backend/app/services/payment/classifier.py:classify_rows` — 不动，分类规则不变
- `backend/app/utils/payment_locale.py:detect_payment_report_structure` — `product sales tax` 列已在 `PAYMENT_REPORT_COLUMN_ALIASES`

---

## 任务清单

### 任务 1：编写 alembic 迁移（PT3 +2 列、PT4 +1 列）

**文件：**
- 创建：`backend/alembic/versions/20260611_160_add_de_uk_vat_total.py`
- 参考：`backend/alembic/versions/20260610_159_add_sku_record_product_image.py`（最新迁移，格式模板）

- [ ] **步骤 1：编写迁移文件**

```python
"""add DE/UK VAT total columns to monthly report PT3/PT4

Revision ID: 20260611_160
Revises: 20260610_159
Create Date: 2026-06-11 17:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '20260611_160'
down_revision: Union[str, None] = '20260610_159'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'monthly_report_pt3_calculation',
        sa.Column('income_vat_total', sa.Numeric(18, 2), nullable=False, server_default='0'),
    )
    op.add_column(
        'monthly_report_pt3_calculation',
        sa.Column('income_sales_with_tax', sa.Numeric(18, 2), nullable=False, server_default='0'),
    )
    op.add_column(
        'monthly_report_pt4_calculation',
        sa.Column('expense_vat_total', sa.Numeric(18, 2), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('monthly_report_pt4_calculation', 'expense_vat_total')
    op.drop_column('monthly_report_pt3_calculation', 'income_sales_with_tax')
    op.drop_column('monthly_report_pt3_calculation', 'income_vat_total')
```

- [ ] **步骤 2：本地升级验证**

运行：`cd backend && /Users/damon/miniconda3/bin/python3 -m alembic upgrade head`
预期：成功，3 列添加。

- [ ] **步骤 3：Commit**

```bash
git add backend/alembic/versions/20260611_160_add_de_uk_vat_total.py
git commit -m "feat(migration): PT3/PT4 加 DE/UK VAT 列

- PT3: income_vat_total、income_sales_with_tax
- PT4: expense_vat_total
- server_default='0'，存量数据零影响"
```

---

### 任务 2：在 SQLAlchemy 模型中声明新字段

**文件：**
- 修改：`backend/app/models/monthly_report.py:168-238`（PT3 类）
- 修改：`backend/app/models/monthly_report.py:241-286`（PT4 类）

- [ ] **步骤 1：PT3 类加 2 个新字段**

定位：`MonthlyReportPT3Calculation` 类中 `income_total: Mapped[Decimal] = _money_column()`（约第 202 行）之后插入：

```python
    income_vat_total: Mapped[Decimal] = _money_column()
    income_sales_with_tax: Mapped[Decimal] = _money_column()
```

定位：`expense_total: Mapped[Decimal] = _money_column()`（约第 224 行）保持不变。

- [ ] **步骤 2：PT4 类加 1 个新字段**

定位：`MonthlyReportPT4Calculation` 类中 `expense_total: Mapped[Decimal] = _money_column()`（约第 272 行）之后插入：

```python
    expense_vat_total: Mapped[Decimal] = _money_column()
```

- [ ] **步骤 3：验证模型 import 成功**

运行：`cd backend && /Users/damon/miniconda3/bin/python3 -c "from app.models.monthly_report import MonthlyReportPT3Calculation, MonthlyReportPT4Calculation; print('OK')"`
预期：打印 `OK`

- [ ] **步骤 4：Commit**

```bash
git add backend/app/models/monthly_report.py
git commit -m "feat(model): PT3/PT4 加 VAT 字段声明"
```

---

### 任务 3：实现 `_compute_vat_metrics` 共享函数

**文件：**
- 修改：`backend/app/services/payment/financial.py:46-46`（在 `compute_metrics` 之前）

- [ ] **步骤 1：编写 `_compute_vat_metrics` 函数**

在 `compute_metrics` 之前（`_safe_div_percent_decimal` 函数后，约第 43 行）插入：

```python
# VAT 国家集合：DE（19%）、UK（20%）。US 报表 product_sales_tax 通常为 0，
# 自动兼容；新口径行为完全一致（income_vat_total=0 → gross ≡ net）。
VAT_INCLUSIVE_COUNTRIES: frozenset[str] = frozenset({"DE", "UK"})


def _compute_vat_metrics(
    classified: dict[str, list[dict[str, object]]],
    country: str,
) -> dict[str, Decimal]:
    """Compute VAT (sales tax) metrics for tax-inclusive countries (DE/UK).

    Args:
        classified: Dict of classified rows from classify_rows().
        country: Normalized country code (US/DE/UK).

    Returns:
        Dict with keys:
        - income_vat_total: sum of product_sales_tax across all Order+Refund rows
        - income_sales_with_tax: sum of (product_sales + product_sales_tax)
        - expense_vat_total: mirror of income_vat_total (used by PT4 回款公式)
    """
    normalized = (country or "").strip().upper()
    if normalized not in VAT_INCLUSIVE_COUNTRIES:
        return {
            "income_vat_total": Decimal("0"),
            "income_sales_with_tax": Decimal("0"),
            "expense_vat_total": Decimal("0"),
        }

    # 跨所有 Order/Refund 行计算。注意 fba_refund / fbm_refund 的 product_sales 是负数
    # （退款为负），所以 sales_with_tax 也自然为负（消费者退的钱含税）。
    all_sales_rows = classified["order"] + classified["refund"]
    income_vat_total = _round2(
        sum((_to_decimal(row.get("product sales tax")) for row in all_sales_rows), Decimal("0"))
    )
    income_sales_with_tax = _round2(
        sum(
            (
                _to_decimal(row.get("product sales"))
                + _to_decimal(row.get("product sales tax"))
                for row in all_sales_rows
            ),
            Decimal("0"),
        )
    )
    return {
        "income_vat_total": income_vat_total,
        "income_sales_with_tax": income_sales_with_tax,
        "expense_vat_total": income_vat_total,
    }
```

- [ ] **步骤 2：单元测试 — US 国家返回零**

在 `backend/tests/test_payment_financial.py`（如不存在则创建）添加：

```python
"""Unit tests for _compute_vat_metrics (US country returns zero)."""
from decimal import Decimal

from app.services.payment.financial import _compute_vat_metrics


def test_vat_metrics_us_returns_zero():
    """US 报表：product_sales_tax 通常为 0，新口径与原版完全一致。"""
    result = _compute_vat_metrics(
        classified={"order": [{"product sales": "10", "product sales tax": "0"}]},
        country="US",
    )
    assert result["income_vat_total"] == Decimal("0")
    assert result["income_sales_with_tax"] == Decimal("0")
    assert result["expense_vat_total"] == Decimal("0")


def test_vat_metrics_us_lowercase_country_normalized():
    """country 大小写不敏感：'us'、'US' 同义。"""
    result = _compute_vat_metrics(
        classified={"order": [], "refund": []},
        country="us",
    )
    assert result["income_vat_total"] == Decimal("0")
```

- [ ] **步骤 3：DE 国家的 VAT 计算**

在同文件追加：

```python
def test_vat_metrics_de_orders_only():
    """DE 纯订单：income_vat_total = sum(product_sales_tax)。"""
    result = _compute_vat_metrics(
        classified={
            "order": [
                {"product sales": "15.82", "product sales tax": "3.17"},
                {"product sales": "20.99", "product sales tax": "0"},  # 0% tax 情形
            ],
            "refund": [],
        },
        country="DE",
    )
    assert result["income_vat_total"] == Decimal("3.17")
    # 含税 = 15.82 + 3.17 + 20.99 + 0 = 39.98
    assert result["income_sales_with_tax"] == Decimal("39.98")
    assert result["expense_vat_total"] == Decimal("3.17")


def test_vat_metrics_uk_refund_negative_tax():
    """UK 退款：product_sales 为负、product_sales_tax 也为负。"""
    result = _compute_vat_metrics(
        classified={
            "order": [],
            "refund": [
                {"product sales": "-17.49", "product sales tax": "-3.50"},
            ],
        },
        country="UK",
    )
    # VAT = -3.50
    assert result["income_vat_total"] == Decimal("-3.50")
    # 含税 = -17.49 + -3.50 = -20.99
    assert result["income_sales_with_tax"] == Decimal("-20.99")


def test_vat_metrics_mixed_order_and_refund():
    """Order 与 Refund 同时存在时求和（退款为负，自然抵消）。"""
    result = _compute_vat_metrics(
        classified={
            "order": [{"product sales": "100", "product sales tax": "20"}],
            "refund": [{"product sales": "-20", "product sales tax": "-4"}],
        },
        country="UK",
    )
    # VAT = 20 + (-4) = 16
    assert result["income_vat_total"] == Decimal("16")
    # 含税 = (100+20) + (-20-4) = 96
    assert result["income_sales_with_tax"] == Decimal("96")
```

- [ ] **步骤 4：跑测试验证通过**

运行：`cd backend && pytest tests/test_payment_financial.py -v`
预期：4 个 test 全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/payment/financial.py backend/tests/test_payment_financial.py
git commit -m "feat(payment): 新增 _compute_vat_metrics 共享 VAT 计算

- US 返回零（行为完全兼容）
- DE/UK 走 tax-inclusive 口径
- 退款为负自然求和"
```

---

### 任务 4：让 `compute_metrics` 调用 VAT 函数

**文件：**
- 修改：`backend/app/services/payment/financial.py:106-220`（PT3 计算）
- 修改：`backend/app/services/payment/financial.py:242-281`（PT4 计算 + 回款公式）

- [ ] **步骤 1：PT3 计算接入 VAT**

定位：`compute_metrics` 函数体，约第 105 行 `income_total = _round2(...)` 之后、`seller_fulfilled_selling_fees = ...`（第 122 行）之前，**插入 VAT 计算与 income_total 调整**：

```python
    # ── VAT 适配（DE/UK tax-inclusive 口径）──
    # country 暂从 classified 字典中读取（由外部传入），所以这里需要
    # 把 country 参数加入 compute_metrics 签名，见步骤 2。
```

**实操**：直接把 `compute_metrics` 签名改为接受 `country` 参数，并在内部调用：

定位：函数签名 `def compute_metrics(classified)`（第 46 行）改为：

```python
def compute_metrics(
    classified: dict[str, list[dict[str, object]]],
    country: str = "US",
) -> dict[str, Any]:
```

定位：`income_total = _round2(...)`（约第 106 行）之后**新增**：

```python
    # VAT 适配：DE/UK 在收入合计上加 VAT（gross 化）
    vat_metrics = _compute_vat_metrics(classified, country)
    income_vat_total = vat_metrics["income_vat_total"]
    income_sales_with_tax = vat_metrics["income_sales_with_tax"]
    expense_vat_total = vat_metrics["expense_vat_total"]
    if income_vat_total != Decimal("0"):
        income_total = _round2(income_total + income_vat_total)
```

定位：`pt3_payload` 字典中 `"income_total": income_total`（约第 195 行）之后**新增**：

```python
        "income_vat_total": income_vat_total,
        "income_sales_with_tax": income_sales_with_tax,
```

- [ ] **步骤 2：PT4 计算接入 VAT（回款新公式）**

定位：`amazon_pay_back = _round2(pt4_income_total + pt4_expense_total)`（约第 281 行）改为：

```python
    # DE/UK 回款公式：收入 + 支出 - VAT（VAT 为正数）
    # US：expense_vat_total = 0 → 与原公式完全一致
    amazon_pay_back = _round2(
        pt4_income_total + pt4_expense_total - expense_vat_total
    )
```

定位：`pt4_payload` 字典中 `"expense_total": pt4_expense_total`（约第 295 行）之后**新增**：

```python
        "expense_vat_total": expense_vat_total,
```

- [ ] **步骤 3：补单元测试 — 端到端 compute_metrics**

在 `backend/tests/test_payment_financial.py` 追加：

```python
def test_compute_metrics_us_unchanged():
    """US 报表：income_total 与 amazon_pay_back 公式不变。"""
    from app.services.payment.classifier import classify_rows

    rows = [
        {"type": "Order", "fulfillment": "Amazon", "product sales": "100",
         "product sales tax": "0", "selling fees": "-15", "fba fees": "-5",
         "shipping credits": "0", "promotional rebates": "0",
         "gift wrap credits": "0", "other": "0", "total": "80",
         "description": ""},
    ]
    classified = classify_rows(rows)
    result = compute_metrics(classified, country="US")

    pt4 = result["pt4"]
    # US：income_total 不含 VAT
    assert pt4["income_total"] == Decimal("100")
    assert pt4["expense_vat_total"] == Decimal("0")
    # 回款 = 100 + (-15) + (-5) = 80
    assert pt4["amazon_pay_back"] == Decimal("80")


def test_compute_metrics_de_with_vat():
    """DE 报表：income_total 含 VAT，回款公式走新口径。"""
    from app.services.payment.classifier import classify_rows

    rows = [
        {"type": "Order", "fulfillment": "Amazon",
         "product sales": "100", "product sales tax": "19",  # 19% VAT
         "selling fees": "-15", "fba fees": "-5",
         "shipping credits": "0", "promotional rebates": "0",
         "gift wrap credits": "0", "other": "0", "total": "99",
         "description": ""},
    ]
    classified = classify_rows(rows)
    result = compute_metrics(classified, country="DE")

    pt4 = result["pt4"]
    # DE：income_total = 100 + 19 = 119（gross）
    assert pt4["income_total"] == Decimal("119")
    assert pt4["expense_vat_total"] == Decimal("19")
    # 回款 = 119 + (-15) + (-5) - 19 = 80（与 US 数值一致，gross 化但回款金额不变）
    assert pt4["amazon_pay_back"] == Decimal("80")

    pt3 = result["pt3"]
    assert pt3["income_vat_total"] == Decimal("19")
    assert pt3["income_sales_with_tax"] == Decimal("119")
```

- [ ] **步骤 4：跑测试验证**

运行：`cd backend && pytest tests/test_payment_financial.py -v`
预期：所有 test PASS（包括 4 个 task 3 的 + 2 个新加的）

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/payment/financial.py backend/tests/test_payment_financial.py
git commit -m "feat(payment): compute_metrics 接入 VAT 适配

- US 行为完全不变（VAT=0）
- DE/UK income_total 加 VAT，amazon_pay_back 走新公式
- 共享 _compute_vat_metrics 避免代码重复"
```

---

### 任务 5：让 `tasks/scripts/monthly_report.py:run()` 调用同一 VAT 函数

**文件：**
- 修改：`backend/app/tasks/scripts/monthly_report.py:147-546`（run 函数体）

- [ ] **步骤 1：在 run 函数中导入 VAT 函数**

定位：函数顶部 imports 区（`from app.services.payment...` 之前）追加：

```python
from app.services.payment.financial import (
    _compute_vat_metrics,
    compute_metrics as payment_compute_metrics,  # noqa: F401
)
```

> 注：本任务实际**不需要** import `compute_metrics`（脚本里有自己的内联实现），只导入 `_compute_vat_metrics` 即可。修正：

```python
from app.services.payment.financial import _compute_vat_metrics
```

- [ ] **步骤 2：在 income_total 计算后接入 VAT 调整**

定位：`income_total = _round2(...)` 之后（约第 216 行）、`seller_fulfilled_selling_fees` 之前，**新增**：

```python
    # VAT 适配（DE/UK）：tax-inclusive 口径
    vat_metrics = _compute_vat_metrics(
        {"order": order, "refund": refund}, country
    )
    income_vat_total = vat_metrics["income_vat_total"]
    income_sales_with_tax = vat_metrics["income_sales_with_tax"]
    expense_vat_total = vat_metrics["expense_vat_total"]
    if income_vat_total != Decimal("0"):
        income_total = _round2(income_total + income_vat_total)
```

- [ ] **步骤 3：pt3_payload 加 2 字段**

定位：`pt3_payload = { ... "income_total": income_total, ... }` 之后**新增**：

```python
        "income_vat_total": income_vat_total,
        "income_sales_with_tax": income_sales_with_tax,
```

- [ ] **步骤 4：pt4 amazon_pay_back 改用新公式 + expense_vat_total 字段**

定位：`amazon_pay_back = _round2(pt4_income_total + pt4_expense_total)` 改为：

```python
    amazon_pay_back = _round2(
        pt4_income_total + pt4_expense_total - expense_vat_total
    )
```

定位：`pt4_payload = { ... "amazon_pay_back": amazon_pay_back }` 之后**新增**：

```python
        "expense_vat_total": expense_vat_total,
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/tasks/scripts/monthly_report.py
git commit -m "feat(tasks): monthly_report.run() 接入 VAT 适配

- 与 compute_metrics 共享同一 VAT 函数
- US 行为完全不变"
```

---

### 任务 6：pt3.py 双栏明细插入 2 行

**文件：**
- 修改：`backend/app/services/report/pt3.py:34-269`（`_build_accounting_rows` 函数体）

- [ ] **步骤 1：在 income_lines 末尾 Total_Income 之前插入 2 行**

定位：`income_lines` 列表最后一个元素是 `("Total_Income", ...)`（约第 135 行）。在该行**之前**插入：

```python
        (
            "Product sales tax (gross)",
            "销售税（gross）",
            _pt3_float(pt3, "income_vat_total"),
            "所有订单/退款-产品销售税",
        ),
        (
            "Sales tax / VAT (Sales Tax)",
            "VAT (销售税)",
            _pt3_float(pt3, "income_vat_total"),  # 与上行同值，UI 上两行分别展示
            "所有订单/退款-产品销售税",
        ),
```

> **注**：两行金额相同。设计原因：第一行用于"含税销售额"语义、第二行用于"独立 VAT 列"语义（用户原话："额外增加一列 VAT Tax"）。两者并存避免漏展示。US 报表中 `income_vat_total = 0`，两行都显示 0。

- [ ] **步骤 2：确认 `_normalize_pt3_payload` 透传新字段**

定位：`_normalize_pt3_payload` 函数（第 469 行）— 已用 `for key, value in pt3.items()` 通用处理，**自动接受新字段**，无需改。

- [ ] **步骤 3：Commit**

```bash
git add backend/app/services/report/pt3.py
git commit -m "feat(pt3): 双栏核算明细插入 VAT 行

- Product sales tax (gross) / 销售税（gross）
- Sales tax / VAT (Sales Tax) / VAT (销售税)
- US VAT=0 时两行都显示 0"
```

---

### 任务 7：pt4.py 透传新字段（无需改）

**文件：**
- 修改：无

- [ ] **步骤 1：确认 _normalize_pt4_payload 已透传**

定位：`backend/app/services/report/pt4.py:329-338`：

```python
def _normalize_pt4_payload(pt4: dict[str, Any]) -> dict[str, Any]:
    return {key: _round2(_to_decimal(value)) for key, value in pt4.items()}
```

**已用 dict.items() 通用处理，自动接受 `expense_vat_total` 字段，**无需改动**。

- [ ] **步骤 2：标记确认**

无需 commit。注释：步骤 1 已确认。

---

### 任务 8：export.py 核算明细 Excel 导出

**文件：**
- 修改：`backend/app/services/report/export.py:44-?`（`export_financial_accounting_detail_workbook` 函数体）

- [ ] **步骤 1：定位双栏明细写入部分**

运行 `grep -n "Total_Income\|income_total\|income_lines\|expense_lines" backend/app/services/report/export.py` 找出 income/expense 循环写入的位置。

- [ ] **步骤 2：在 income 行循环中插入 2 行**

参考 `pt3.py:_build_accounting_rows`（任务 6），在写入 `Total_Income` 之前同样追加 2 行（金额来自 `pt3.income_vat_total`）。

> **实操提示**：先 Read 文件第 30-150 行定位循环结构，然后在合适位置插入 2 个 `ws_accounting.append([...])` 调用，每行 5 个元素对应 income_en / income_zh / amount / source / 空字符串 / expense 4 列。

- [ ] **步骤 3：Commit**

```bash
git add backend/app/services/report/export.py
git commit -m "feat(export): 核算明细 Excel 加 VAT 行"
```

---

### 任务 9：Pydantic schema 加字段

**文件：**
- 修改：`backend/app/schemas/monthly_report.py:77-104`（`MonthlyFinancialSeriesRow` + `MonthlyFinancialTrendPoint`）

- [ ] **步骤 1：MonthlyFinancialSeriesRow 加 3 字段**

定位：`MonthlyFinancialSeriesRow` 类（约第 77 行），在 `has_source_report: bool` 之后**新增**：

```python
    income_vat_total: float = 0.0
    income_sales_with_tax: float = 0.0
    expense_vat_total: float = 0.0
```

- [ ] **步骤 2：MonthlyFinancialTrendPoint 加 1 字段**

定位：`MonthlyFinancialTrendPoint` 类（约第 98 行），在 `has_source_report: bool` 之后**新增**：

```python
    vat_total: float = 0.0
```

- [ ] **步骤 3：验证 schema 加载**

运行：`cd backend && /Users/damon/miniconda3/bin/python3 -c "from app.schemas.monthly_report import MonthlyFinancialSeriesRow, MonthlyFinancialTrendPoint; print('OK')"`
预期：打印 `OK`

- [ ] **步骤 4：Commit**

```bash
git add backend/app/schemas/monthly_report.py
git commit -m "feat(schemas): financial series/trend 加 VAT 字段"
```

---

### 任务 10：前端 TypeScript 类型同步

**文件：**
- 修改：`frontend/app/dashboard/data-analysis/financial-data/financial-data-client.tsx:364-484`（`FinancialExportDetailRow` / `FinancialExportTotals` / `buildFinancialExportTotals`）

- [ ] **步骤 1：FinancialExportDetailRow 加 3 字段**

定位：第 364 行 `type FinancialExportDetailRow = { ... }` 字典中，**找到合适位置**（如 `expenseOtherFees` 之后）追加：

```tsx
  vatTotal: number
  incomeSalesWithTax: number
  expenseVatTotal: number
```

- [ ] **步骤 2：FinancialExportTotals 加 3 字段**

定位：第 400 行 `type FinancialExportTotals = { ... }` 字典中，**找到合适位置**追加：

```tsx
  vatTotal: number
  incomeSalesWithTax: number
  expenseVatTotal: number
```

- [ ] **步骤 3：buildFinancialExportTotals 累加新字段**

定位：第 427 行 `function buildFinancialExportTotals(rows: ...)` 函数 reduce 体中，**找到 incomeTotal 累加的位置附近**追加：

```tsx
      vatTotal: acc.vatTotal + row.vatTotal,
      incomeSalesWithTax: acc.incomeSalesWithTax + row.incomeSalesWithTax,
      expenseVatTotal: acc.expenseVatTotal + row.expenseVatTotal,
```

定位：reduce 初始值字典（第 465 行附近 `{ incomeSales: 0, ... }`）追加：

```tsx
      vatTotal: 0,
      incomeSalesWithTax: 0,
      expenseVatTotal: 0,
```

- [ ] **步骤 4：财务序列 / 明细 tab UI 加展示**

定位：搜 `income_sales` / `income_total` / `incomeRefund` / `amazonPayBack` 在 JSX 中用到的位置（chart 图表、table 单元格），按以下规则加展示：

- **chart**（财务序列 trend 图）：在现有 income_total / expense_total / amazon_pay_back 折线外，**多 1 条"VAT"趋势线**（颜色用 `var(--chart-5)` 之类未占用色）
- **table 明细**（核算明细 tab 双栏）：在 `Total_Income` 之前**插入 2 行**，金额显示 `income_vat_total`（与任务 6 后端 PT3 双栏一致）
- **EXPORT_DETAIL_COLUMNS**（财务序列导出列）：**新增列** `'VAT (Sales Tax)'` 用 `vatTotal` 字段，format 用 `'currency_usd'`

> **前端原则**：所有金额读后端字段，**不重算公式**。

- [ ] **步骤 5：Commit**

```bash
git add frontend/app/dashboard/data-analysis/financial-data/financial-data-client.tsx
git commit -m "feat(frontend): 财务数据页加 VAT 字段展示

- Type 加 vatTotal / incomeSalesWithTax / expenseVatTotal
- chart 多 1 条 VAT 趋势线
- 核算明细双栏多 2 行
- EXPORT_DETAIL_COLUMNS 加 VAT 列"
```

---

### 任务 11：服务端 page.tsx 透传新字段

**文件：**
- 修改：`frontend/app/dashboard/data-analysis/financial-data/page.tsx`

- [ ] **步骤 1：定位 initialData 序列化位置**

运行 `grep -n "MonthlyFinancialSeriesResponse\|FinancialSeriesResponse\|initialData\|serializable" frontend/app/dashboard/data-analysis/financial-data/page.tsx` 找数据传输点。

- [ ] **步骤 2：确认新字段自动随 Pydantic 序列化**

Pydantic v2 默认序列化所有字段，**前端无需手动映射**。如果 page.tsx 用 `model_dump()` / `.dict()`，**新字段自动包含**。

- [ ] **步骤 3：标记确认（无需代码改动）**

无需 commit。

---

### 任务 12：跑全量后端测试

- [ ] **步骤 1：跑 pytest**

运行：`cd backend && pytest -q`
预期：所有测试 PASS（新增 6 个 VAT 相关 test，旧的全部不破）

- [ ] **步骤 2：跑 alembic 升降级测试**

运行：
```bash
cd backend && /Users/damon/miniconda3/bin/python3 -m alembic upgrade head
/Users/damon/miniconda3/bin/python3 -m alembic downgrade -1
/Users/damon/miniconda3/bin/python3 -m alembic upgrade head
```
预期：3 次都成功

---

### 任务 13：前端 lint + build

- [ ] **步骤 1：lint**

运行：`cd frontend && pnpm lint`
预期：无 error / warning

- [ ] **步骤 2：build**

运行：`cd frontend && pnpm build`
预期：构建成功

---

### 任务 14：业务测试（提交给用户执行）

> AI 提交以下清单给用户手动验证：

| 场景 | 操作 | 期望 |
|---|---|---|
| US 1 月报表重算 | 财务页选 US 项目、1 月、点"重算"按钮 | income_total / amazon_pay_back 与重算前完全一致 |
| DE 1 月报表重算 | 选 DE 项目、1 月、点"重算" | 收入合计 + VAT 合计 = 含税总额；amazon_pay_back 数值不变（gross 化前后期望值 ≈ 净回款） |
| UK 5 月报表上传 | 选 UK 项目、5 月、上传你提供的 2026MayMonthlyTransaction.csv | 报表展示 "Sales tax (gross)" 行，金额 ≈ 已知 5 月 VAT |
| 财务序列 trend | 财务页查看 DE 项目趋势线 | 多一条 "VAT" 折线，与 income/expense/amazon_pay_back 并列 |
| Excel 导出 | 核算明细 tab 点"导出" | 报表核算 sheet 多 2 行，金额与 UI 一致 |
| VAT 数值核对 | 选 UK 5 月、查看 PT3 数据 | income_vat_total ≈ 已知 5 月所有 "product sales tax" 列加和（应 ≈ 41.81 GBP） |

---

## 自检

**1. 规格覆盖度：**
- [x] PT3/PT4 模型字段 → 任务 2
- [x] alembic 迁移 → 任务 1
- [x] `_compute_vat_metrics` 共享函数 → 任务 3
- [x] `compute_metrics` 接入 → 任务 4
- [x] `tasks/scripts/monthly_report.py:run()` 接入 → 任务 5
- [x] pt3.py 双栏明细 → 任务 6
- [x] pt4.py 透传（无需改）→ 任务 7
- [x] export.py Excel 导出 → 任务 8
- [x] Pydantic schema → 任务 9
- [x] 前端类型 + UI → 任务 10
- [x] 前端 page.tsx 透传 → 任务 11
- [x] 后端测试 → 任务 12
- [x] 前端 lint + build → 任务 13
- [x] 业务测试 → 任务 14

**2. 占位符扫描：** 无 "TODO" / "待定" / "补充细节" 等模糊词

**3. 类型一致性：**
- `income_vat_total` / `income_sales_with_tax` / `expense_vat_total` — 任务 2、3、4、5、6、8、9、10 一致
- `vatTotal` / `incomeSalesWithTax` / `expenseVatTotal` (前端 camelCase) — 任务 10 一致
- `MonthlyFinancialSeriesRow` / `MonthlyFinancialTrendPoint` / `FinancialExportDetailRow` / `FinancialExportTotals` — 任务 9、10 一致

**已修复**：
- 任务 5 步骤 1 原本让 import `compute_metrics as payment_compute_metrics`，实际不需要，已修正只 import `_compute_vat_metrics`
- 任务 6 步骤 1 解释清楚两行金额相同（设计意图）

---

## 计划已完成并保存到 `docs/superpowers/plans/2026-06-11-de-uk-vat-monthly-report-plan.md`。

**两种执行方式：**

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

**选哪种方式？**
