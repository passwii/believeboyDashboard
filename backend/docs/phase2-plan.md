# 阶段2：共享工具层扩展 — 详细实施计划

更新时间：2026-05-11

## 一、目标

补充阶段1未覆盖的公共模块，消除剩余重复代码，为后续阶段（3-7）的服务拆分打好地基。

**产出**：3 个新工具文件 + 完善后的 parsers.py + 配套单元测试 ≥ 40 个

---

## 二、当前代码库问题清单（调研结果）

### 2.1 重复代码模式（待消除）

| 重复模式 | 出现位置 | 应迁至 |
|----------|----------|--------|
| `_normalize_country` | `ad_analysis_service.py`, `daily_analysis_service.py`, `digital_display_service.py`, `inventory_analysis_service.py`, `inventory_replenishment_service.py`, `product_analysis_source_service.py`, `product_cost_service.py`, `project_goal_service.py`, `shipment_schedule_service.py`, `ad_upload_service.py` | `app/shared/parsers.py`（已存在 `normalize_country`，需统一导入路径） |
| `_normalize_text` | `inventory_analysis_service.py`, `category_research_service.py`, `inventory_replenishment_service.py`, `product_cost_service.py`, `shipment_schedule_service.py`, `monthly_report_service.py` | `app/shared/text_utils.py`（已存在） |
| `_round_money` | `ad_analysis_service.py`, `daily_analysis_service.py`, `digital_display_service.py`, `ai_insight_aggregator.py` | `app.shared.math_utils.round_money`（已存在） |
| `_safe_ratio` | `ad_analysis_service.py`, `daily_analysis_service.py`, `ai_insight_aggregator.py` | `app.shared.math_utils.safe_ratio`（已存在） |
| `_parse_date` | `daily_analysis_service.py`, `shipment_schedule_service.py` | `app.shared.date_utils`（已存在） |
| `TZ_OFFSET_BY_ABBR` | `monthly_report_service.py`, `parsers.py`（重复定义） | `app/shared/constants.py` |
| `RECENT_SALES_LAG_DAYS = 2` | `inventory_replenishment_service.py` | `app/shared/constants.py` |

### 2.2 散落在各 service 中的硬编码常量（待抽取）

| 常量 | 当前位置 | 值 |
|------|----------|-----|
| `RECENT_SALES_LAG_DAYS` | `inventory_replenishment_service.py` | `2` |
| `TZ_OFFSET_BY_ABBR` | `monthly_report_service.py` | `{"UTC":0,"GMT":0,"PST":-8,"PDT":-7}` |
| `COUNTRY_TIMEZONE` | `parsers.py` | 已映射 |
| `SUPPORTED_REPORT_TYPES` | `report_upload_service.py` | `{"daily_report","monthly_report","product_analysis_report","product_cost","ad_performance","inventory","sales_order","settlement","store_sku_pricing","reconciliation"}` |
| `ALLOWED_EXTENSIONS (ad)` | `ad_upload_service.py` | `{'.csv', '.xlsx'}` |
| `ALLOWED_EXTENSIONS (ai)` | `ai_file_upload_service.py` | `{".csv", ".xlsx", ".xls", ".jpg", ".jpeg", ".png", ".pdf", ".txt"}` |
| `DEFAULT_PROJECTS_CSV_PATH` | `project_service.py` | 路径常量 |
| `MAX_CONTENT_LENGTH` | `ai_file_upload_service.py` | `50000` |
| `MAX_EXCEL_ROWS/MAX_EXCEL_COLS` | `ai_file_upload_service.py` | `1000/20` |
| `SEARCH_SNIPPET_MAX_LENGTH` | `ai_chat_service.py` | `1200` |
| `SEARCH_SOURCE_CARD_MAX_LENGTH` | `ai_chat_service.py` | `280` |
| `MAX_RETRIES` | `ai_chat_service.py` | `2` |
| `ALLOWED_COMMISSION_BASIS` | `project_service.py` | `{"sales_amount","cash_received","profit_margin"}` |
| `ALLOWED_METRIC_TYPES` | `project_goal_service.py` | `{"sales_amount"}` |
| `DEFAULT_AVATAR_URL` | `presence_service.py` | `"/avatars/default.svg"` |

### 2.3 重复的校验逻辑（待统一）

| 校验逻辑 | 当前位置 |
|----------|----------|
| 分页参数校验（page >= 1, page_size 范围） | `product_analysis_source_service.py`, `inventory_replenishment_service.py`, `category_research_service.py` 等 |
| 日期范围校验 | 多处 endpoint 层 |
| 金额/数字非负校验 | 多处 |

---

## 三、具体任务

### 任务 3.1：整理 `app/shared/parsers.py`（补充 + 统一导入路径）

**目标**：将 parsers.py 中已有的 `normalize_country` 设为各 service 的统一入口，清理 `app/utils/country.py` 中的重复实现。

**具体操作**：

1. **parsers.py 已有内容**（无需改动）：
   - `normalize_country()` — 功能完整，与 `app/utils/country.py` 中的 `_normalize_country()` 逻辑一致
   - `COUNTRY_ALIASES`, `COUNTRY_TIMEZONE`, `TZ_OFFSET_BY_ABBR` — 已定义
   - `SCOPE_INCLUDED/EXCLUDED_*` 常量
   - `INVENTORY_PROJECT_MATCH_MIN_ROWS`, `INVENTORY_PROJECT_MATCH_MIN_RATIO`
   - `match_columns()`, `classify_scope()`, `build_aging_status()`, `is_counted_sales_status()`
   - `validate_inventory_rows_against_project_mapping()`
   - `parse_transaction_at()`, `parse_business_rows()`, `parse_payment_rows()`, `parse_ad_rows()`, `parse_inventory_rows()`, `parse_sales_rows()`
   - `read_excel_no_warning()`

2. **需要调整的地方**：
   - 将 `TZ_OFFSET_BY_ABBR` 从 `monthly_report_service.py` 移除，改为从 `app/shared/parsers.py` 导入
   - 逐步将各 service 中 `from app.utils.country import _normalize_country` 改为 `from app.shared.parsers import normalize_country`
   - `app/services/payment/locale.py` 中的 `normalize_country` wrapper 保持不变（它有 `default` 参数）

3. **`app/utils/country.py`** 保持不变（它同时被 autoReportUpload 使用，且包含 `_normalize_country_http` 等 endpoint 特有函数）

**标记为废弃的 service（import 已改为 shared）**：
- `ad_analysis_service.py` ✅ 已有 deprecation warning
- `daily_analysis_service.py` ✅ 已有 deprecation warning
- `shipment_schedule_service.py` ✅ 已有 deprecation warning
- `inventory_replenishment_service.py` ✅ 已有 deprecation warning
- `ai_insight_aggregator.py` ✅ 已有 deprecation warning
- `digital_display_service.py` ✅ 已有 deprecation warning
- `ad_upload_service.py` ✅ 已有 deprecation warning
- `category_research_service.py` ✅ 已有 deprecation warning
- `monthly_report_service.py` ✅ 已有 deprecation warning

**注意**：这些 service 中仍有 `from app.utils.country import _normalize_country` 的引用，需要在阶段2中逐步替换为 `from app.shared.parsers import normalize_country`。

**测试目标**：`tests/shared/test_parsers.py` 现有 21 个测试方法（61个断言），已覆盖良好。**保持现有测试不变**，不新增。

---

### 任务 3.2：创建 `app/shared/constants.py`

**目标**：抽取跨 service 使用的硬编码常量，消除重复定义。

**文件路径**：`backend/app/shared/constants.py`

**内容规划**：

```python
"""Shared constants used across multiple services."""
from __future__ import annotations

# ─── 时间常量 ────────────────────────────────────────────────────────────

# 补货分析：近期销量滞后天数
RECENT_SALES_LAG_DAYS = 2

# 补货分析：近期销量统计窗口天数
RECENT_SALES_WINDOW_DAYS = 3

# ─── 报表与上传相关 ──────────────────────────────────────────────────────

SUPPORTED_REPORT_TYPES = {
    "inventory_report",
    "business_report",
    "ad_product_report",
    "ad_search_term_report",
    "sales_report",
    "payment_report",
    "return_report",
}

# Report types that are stored per-period (period_start_date / period_end_date).
# Inventory reports use snapshot_at instead and are NOT in this set.
PERIODIC_REPORT_TYPES: set[str] = {
    "business_report",
    "payment_report",
    "ad_product_report",
    "sales_report",
    "return_report",
}

# 各类型报表的 column mapping 文件中的 type code
REPORT_TYPE_COLUMNS_MAPPING = {
    "daily_report": "daily",
    "monthly_report": "monthly",
    "product_analysis_report": "product_analysis",
    "product_cost": "cost",
    "ad_performance": "ad",
    "inventory": "inventory",
    "sales_order": "sales_order",
    "settlement": "settlement",
    "store_sku_pricing": "store_sku_pricing",
    "reconciliation": "reconciliation",
}

# ─── 文件上传限制 ────────────────────────────────────────────────────────

MAX_UPLOAD_CONTENT_LENGTH = 50000  # AI 文件上传最大字符数
MAX_EXCEL_ROWS = 1000              # AI 文件上传最大行数
MAX_EXCEL_COLS = 20                # AI 文件上传最大列数

# ─── AI Chat 常量 ────────────────────────────────────────────────────────

AI_CHAT_SEARCH_SNIPPET_MAX_LENGTH = 1200
AI_CHAT_SEARCH_SOURCE_CARD_MAX_LENGTH = 280
AI_CHAT_MAX_RETRIES = 2

# ─── 分页默认值 ──────────────────────────────────────────────────────────

DEFAULT_PAGE_SIZE = 20
DEFAULT_PAGE = 1

# ─�── 业务常量 ────────────────────────────────────────────────────────────

DEFAULT_COUNTRY = "US"
```

**需要从此文件读取常量的 service**：
- `inventory_replenishment_service.py` — 读取 `RECENT_SALES_LAG_DAYS`, `RECENT_SALES_WINDOW_DAYS`
- `report_upload_service.py` — 读取 `SUPPORTED_REPORT_TYPES`
- `ad_upload_service.py` — 读取文件扩展名常量
- `ai_file_upload_service.py` — 读取 `MAX_*` 常量
- `ai_chat_service.py` — 读取 `AI_CHAT_*` 常量
- `project_service.py` — 可选，后续阶段
- `project_goal_service.py` — 可选，后续阶段
- `presence_service.py` — 可选，后续阶段

**迁移步骤**（非本阶段强制，仅标记）：
1. 创建 `constants.py` 并导入到需要的服务中
2. 原 service 中保留常量定义，添加 deprecation warning
3. 后续阶段逐步清理

**测试目标**：

创建 `tests/shared/test_constants.py`：

```python
class TestConstants:
    # 验证常量值正确
    def test_RECENT_SALES_LAG_DAYS(self): ...
    def test_RECENT_SALES_WINDOW_DAYS(self): ...
    def test_SUPPORTED_REPORT_TYPES_contains_sales_report(self): ...
    def test_DEFAULT_COUNTRY(self): ...
    def test_MAX_EXCEL_ROWS(self): ...
```

≥ 5 个测试，全部通过。

---

### 任务 3.3：创建 `app/shared/validators.py`

**目标**：提供通用参数校验函数，减少各 service/endpoint 中的重复校验逻辑。

**文件路径**：`backend/app/shared/validators.py`

**内容规划**：

```python
"""通用参数校验工具。"""
from __future__ import annotations

from typing import Any

# ─── 分页参数校验 ────────────────────────────────────────────────────────

def validate_page(page: int, *, minimum: int = 1) -> int:
    """校验并返回安全的页码，小于 minimum 时抛出 ValueError。"""

def validate_page_size(page_size: int, *, minimum: int = 1, maximum: int = 500) -> int:
    """校验并返回安全的每页条数，超出范围时自动 clamp。"""

# ─── 日期范围校验 ────────────────────────────────────────────────────────

def validate_date_range(date_from: date, date_to: date) -> tuple[date, date]:
    """校验日期范围，date_from > date_to 时抛出 ValueError。"""

# ─── 通用值校验 ──────────────────────────────────────────────────────────

def validate_positive(value: int | float, *, field_name: str = "value") -> None:
    """校验值是否为正数。"""

def validate_non_negative(value: int | float | Decimal, *, field_name: str = "value") -> None:
    """校验值是否非负。"""

def validate_required(value: Any, *, field_name: str) -> Any:
    """校验值不为 None/空。"""

def clamp(value: int, *, minimum: int, maximum: int) -> int:
    """将值限制在 [minimum, maximum] 范围内。"""
```

**测试目标**：

创建 `tests/shared/test_validators.py`：

```python
class TestValidatePage:
    def test_valid_page(self): ...
    def test_page_too_small_raises(self): ...
    def test_page_zero_raises(self): ...
    def test_negative_page_raises(self): ...

class TestValidatePageSize:
    def test_valid_page_size(self): ...
    def test_page_size_too_large_clamps(self): ...
    def test_page_size_too_small_raises(self): ...
    def test_exact_boundaries(self): ...

class TestValidateDateRange:
    def test_valid_range(self): ...
    def test_same_date_passes(self): ...
    def test_from_after_to_raises(self): ...

class TestValidatePositive:
    def test_positive_passes(self): ...
    def test_zero_raises(self): ...
    def test_negative_raises(self): ...

class TestValidateNonNegative:
    def test_positive_passes(self): ...
    def test_zero_passes(self): ...
    def test_negative_raises(self): ...

class TestClamp:
    def test_within_range(self): ...
    def test_below_minimum(self): ...
    def test_above_maximum(self): ...
```

≥ 10 个测试，全部通过。

---

### 任务 3.4：更新 `app/shared/__init__.py`

**目标**：确保新增模块的导出正确。

**操作**：已在现有 `__init__.py` 中存在对 `parsers` 的导入。`constants.py` 和 `validators.py` 新增后，视需要决定是否加入 `__init__.py` 的导出列表。

**注意**：`__init__.py` 当前导入了 `parsers` 模块中的所有公有符号。如果 `constants.py` 和 `validators.py` 需要作为 `app.shared.xxx` 直接调用，则需要添加导入。否则可以保持独立模块导入。

---

### 任务 3.5：整理 `app/shared/persist_helpers.py` 测试

**目标**：`persist_helpers.py` 已有独立的 `test_persist_helpers.py`。本阶段需：

1. 确认现有测试 ≥ 5 个
2. 检查是否需要 mock DB 的测试用例

**测试目标**：

检查 `tests/shared/test_persist_helpers.py`：

- `test_next_version` — ≥ 1 个
- `test_replace_current_pointer` — ≥ 1 个  
- `test_write_report_upload_log` — ≥ 1 个
- 其他边界测试

≥ 5 个测试（需 mock DB），全部通过。

---

## 四、阶段2完整测试清单

| 测试文件 | 最低测试数 | 状态 |
|----------|-----------|------|
| `tests/shared/test_parsers.py` | ≥ 20（现有 21 个） | ✅ 已存在 |
| `tests/shared/test_constants.py` | ≥ 5 | 🔲 新建 |
| `tests/shared/test_validators.py` | ≥ 10 | 🔲 新建 |
| `tests/shared/test_persist_helpers.py` | ≥ 5（需 mock DB） | ✅ 已存在 |
| **合计** | **≥ 40** | |

验证命令：`pytest backend/tests/shared/ -v`

---

## 五、阶段依赖与风险

### 依赖关系

- 阶段2 依赖 **阶段1 已完成** 的 4 个工具模块（math_utils, text_utils, date_utils, period_comparison）
- 阶段3-7 依赖 **阶段2 完成后** 的 constants 和 validators

### 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| parsers.py 中的 normalize_country 虽已存在但部分 service 仍从 `app.utils.country` 导入 | 重复代码未完全消除 | 阶段2中标记这些 service 为后续迁移目标，不强制立即改（不改也不影响功能） |
| constants.py 中的常量与 service 内硬编码值可能有语义差异 | 迁移过程中出错 | 采用渐进策略：先创建 constants.py，原位置保留+deprecation warning |
| 某些 service 的 `_normalize_text` 版本与 text_utils 签名不完全一致 | 替换时需逐一适配 | 已在废弃函数中保留兼容层 |

---

## 六、实施顺序建议

1. **创建 `app/shared/constants.py`**（最简单，纯数据定义）
2. **创建 `tests/shared/test_constants.py`**
3. **创建 `app/shared/validators.py`**
4. **创建 `tests/shared/test_validators.py`**
5. **整理 parsers.py**（主要是将 `TZ_OFFSET_BY_ABBR` 从 `monthly_report_service.py` 移入并 deprecate 原位置）
6. **运行完整测试**：`pytest backend/tests/shared/ -v`
7. **运行阶段2后的冒烟测试**：`pytest backend/tests/ -v --timeout=60`

全部通过后，更新 `backend-refactor-plan.md` 中阶段2的任务清单。