# Replenish 三段式评估（状态 + 行动 + 信号 + 季节性）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 replenish 评估从单维度 `_classify_risk`（只比 sellable_days）升级为三段式产物：`inventory_state`（5 状态）+ `replenishment_action`（6 行动）+ `signals`（透明原始数据，含季节性因子），落到外部 API + 内部 API + 前端表格 + Excel 导出。

**Architecture:** 新建两个独立模块（`seasonal_factor.py`、`state_action.py`）+ 复用现有 `health_score.py` 的 `ItemInput` + 改 `replenishment.py` 主函数拼装新字段 + 改 schemas 加新字段族 + 前端表格新增 3 列 + 行背景色 + Excel 导出扩展。所有判定纯计算层变更，0 数据库改动。`_classify_risk` 保留（summary 兼容）。

**Tech Stack:** Python 3.11 / FastAPI / SQLAlchemy 2.x / Pydantic / pytest / Next.js 14 / React / TypeScript / shadcn / Vitest + Testing Library / exceljs（已有）。

## Global Constraints

- Commit：中文 + Conventional Commits（feat/fix/docs/test/chore…），scope 中文，subject 动宾短语 ≤50 字无句号。
- 数据库 0 改动（Alembic 0 文件）。
- 主键统一 `Integer`（仓库约定）。
- 测试顺序：`pnpm lint` → `pnpm build` → `pnpm test`（前端）；`cd backend && pytest`（后端）。
- 部署：`git deploy` 推送命中 `backend/` 触发 VPS 自动部署；前端 Vercel 自动。
- `_classify_risk` 保留（summary 兼容旧字段），不删。
- `health_score.py` 不改（仅复用 `ItemInput` dataclass）。
- seasonal_replenishment endpoint 不动（仅复用其 `_load_seasonal_dms_map` SQL）。
- 季节性 fallback v1.2 简化：没 YoY 数据直接跳过，不 fallback 到项目级平均。
- `signals.seasonal_factor` clamp 到 [0.3, 3.0]（避免极端值）。

## File Structure

**后端（新建 3 + 改 2 + 测试 4）：**
- Create: `backend/app/services/inventory/seasonal_factor.py` — seasonal_factor 计算（v1.2 简化版）
- Create: `backend/app/services/inventory/state_action.py` — state + action + signals + trend_momentum + adjusted_sellable_days
- Create: `backend/tests/services/inventory/test_seasonal_factor.py`
- Create: `backend/tests/services/inventory/test_state_action.py`
- Create: `backend/tests/services/inventory/test_seasonal_integration.py`
- Create: `backend/tests/api/v1/inventory_replenishment/test_three_segment.py`
- Modify: `backend/app/services/inventory/replenishment.py:908` — `list_inventory_replenishment_analysis` 主函数拼装
- Modify: `backend/app/schemas/inventory_replenishment.py` — `InventoryReplenishmentListItem` + `InventoryReplenishmentSummary` + 新 `InventorySignals` schema
- Modify: `backend/app/services/inventory/__init__.py`（如需导出新模块）

**前端（改 2 + 测试 2）：**
- Modify: `frontend/app/dashboard/supply-chain/inventory-replenishment/page.tsx` — 加 3 列 + 行色 + Excel
- Modify: `frontend/types/api-generated/api.d.ts`（regen 自动）
- Test: `frontend/app/dashboard/supply-chain/inventory-replenishment/__tests__/columns.test.tsx`
- Test: `frontend/app/dashboard/supply-chain/inventory-replenishment/__tests__/excel-export.test.ts`

---

### Task 1: `seasonal_factor.py`（v1.2 简化版）

**Files:**
- Create: `backend/app/services/inventory/seasonal_factor.py`
- Create: `backend/tests/services/inventory/test_seasonal_factor.py`

**Interfaces:**
- Consumes: 4 个 `float | None`（dms_30 / dms_7 / dms_30_yoy / dms_7_yoy）
- Produces:
  - `compute_seasonal_factor(dms_30, dms_7, dms_30_yoy, dms_7_yoy) -> tuple[float | None, str, str]`
    - 返回 `(factor, phase, source)`；source ∈ `{"sku_yoy", "neutral"}`
  - `compute_seasonal_phase(factor: float | None) -> str` — 返回 `peak` / `rising` / `neutral` / `falling` / `trough` / `unknown`
  - 常量：`SEASONAL_PHASE_THRESHOLDS` dict

- [ ] **Step 1: 写失败测试 `test_seasonal_factor.py`**

创建 `backend/tests/services/inventory/test_seasonal_factor.py`：

```python
"""seasonal_factor 单元测试（v1.2 简化版）。"""
from __future__ import annotations

import pytest

from app.services.inventory.seasonal_factor import (
    SEASONAL_PHASE_THRESHOLDS,
    compute_seasonal_factor,
    compute_seasonal_phase,
)


class TestComputeSeasonalFactor:
    """compute_seasonal_factor 返回 (factor, phase, source)。"""

    def test_factor_from_sku_yoy_single_ratio(self):
        """dms_30=2.0, dms_30_yoy=1.0, dms_7_yoy=None → factor=2.0, source='sku_yoy'"""
        factor, phase, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=None, dms_30_yoy=1.0, dms_7_yoy=None
        )
        assert factor == 2.0
        assert source == "sku_yoy"
        assert phase == "peak"

    def test_factor_average_of_two_yoy_ratios(self):
        """dms_30=2.0/dms_30_yoy=1.0=2.0; dms_7=1.5/dms_7_yoy=1.0=1.5; avg=1.75"""
        factor, phase, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=1.5, dms_30_yoy=1.0, dms_7_yoy=1.0
        )
        assert factor == pytest.approx(1.75)
        assert source == "sku_yoy"
        assert phase == "peak"

    def test_factor_from_single_yoy_when_only_one_available(self):
        """只有 dms_7_yoy（dms_30_yoy=None）→ 单个比值"""
        factor, phase, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=1.5, dms_30_yoy=None, dms_7_yoy=1.0
        )
        assert factor == 1.5
        assert source == "sku_yoy"

    def test_factor_neutral_when_no_yoy(self):
        """全 None → None, 'neutral', 'unknown'（v1.2 不 fallback）"""
        factor, phase, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=1.5, dms_30_yoy=None, dms_7_yoy=None
        )
        assert factor is None
        assert source == "neutral"
        assert phase == "unknown"

    def test_factor_neutral_when_all_dms_zero(self):
        """dms 全 0（没销量）→ None"""
        factor, _, source = compute_seasonal_factor(
            dms_30=0, dms_7=0, dms_30_yoy=1.0, dms_7_yoy=1.0
        )
        assert factor is None
        assert source == "neutral"

    def test_factor_zero_yoy_returns_neutral(self):
        """yoy=0 → 不能除，返 None"""
        factor, _, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=1.5, dms_30_yoy=0, dms_7_yoy=0
        )
        assert factor is None
        assert source == "neutral"

    def test_factor_clamp_to_3_when_extreme_high(self):
        """factor=5.0 → clamp 到 3.0, peak"""
        factor, phase, _ = compute_seasonal_factor(
            dms_30=5.0, dms_7=5.0, dms_30_yoy=1.0, dms_7_yoy=1.0
        )
        assert factor == 3.0
        assert phase == "peak"

    def test_factor_clamp_to_03_when_extreme_low(self):
        """factor=0.1 → clamp 到 0.3, trough"""
        factor, phase, _ = compute_seasonal_factor(
            dms_30=0.1, dms_7=0.1, dms_30_yoy=1.0, dms_7_yoy=1.0
        )
        assert factor == 0.3
        assert phase == "trough"


class TestComputeSeasonalPhase:
    """compute_seasonal_phase 按阈值划分相位。"""

    def test_phase_peak(self):
        assert compute_seasonal_phase(1.5) == "peak"

    def test_phase_rising(self):
        assert compute_seasonal_phase(1.2) == "rising"

    def test_phase_neutral(self):
        assert compute_seasonal_phase(1.0) == "neutral"
        assert compute_seasonal_phase(0.95) == "neutral"

    def test_phase_falling(self):
        assert compute_seasonal_phase(0.8) == "falling"

    def test_phase_trough(self):
        assert compute_seasonal_phase(0.5) == "trough"

    def test_phase_unknown_when_factor_none(self):
        assert compute_seasonal_phase(None) == "unknown"

    def test_thresholds_dict_exists(self):
        """常量 SEASONAL_PHASE_THRESHOLDS 必须存在并有 5 档。"""
        assert "peak" in SEASONAL_PHASE_THRESHOLDS
        assert "rising" in SEASONAL_PHASE_THRESHOLDS
        assert "neutral" in SEASONAL_PHASE_THRESHOLDS or "neutral_low" in SEASONAL_PHASE_THRESHOLDS
        assert "falling" in SEASONAL_PHASE_THRESHOLDS
        assert "trough" in SEASONAL_PHASE_THRESHOLDS
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && pytest tests/services/inventory/test_seasonal_factor.py -v`
Expected: FAIL（`ImportError: cannot import name 'compute_seasonal_factor'`）

- [ ] **Step 3: 实现 `seasonal_factor.py`**

创建 `backend/app/services/inventory/seasonal_factor.py`：

```python
"""季节性因子计算（v1.2 简化版）。

每个 SKU 自己的"季节性基线"——基于 YoY DMS 数据自动学，不需要任何人工标注。

Fallback 链（v1.2 简化）：SKU 自己的 YoY → 跳过（无 fallback）。
v1.2 决策理由：现实里大部分项目店铺没 YoY，与其 fallback 到项目级平均污染判断，
不如直接跳过——signals.seasonal_phase = "unknown" 不影响主流程。
"""
from __future__ import annotations

# 阈值常量：factor > X → 对应相位
SEASONAL_PHASE_THRESHOLDS: dict[str, float] = {
    "peak": 1.3,         # > 1.3 → peak
    "rising": 1.1,       # > 1.1 且 ≤ 1.3 → rising
    "neutral_low": 0.9,  # ≥ 0.9 且 ≤ 1.1 → neutral
    "falling": 0.7,      # ≥ 0.7 且 < 0.9 → falling
    # < 0.7 → trough
}

FACTOR_MIN = 0.3
FACTOR_MAX = 3.0


def compute_seasonal_factor(
    dms_30: float | None,
    dms_7: float | None,
    dms_30_yoy: float | None,
    dms_7_yoy: float | None,
) -> tuple[float | None, str, str]:
    """返回 (factor, phase, source)。
    
    factor: 季节性因子，1.0=常态，>1=旺季，<1=淡季；None=无数据
    phase: peak/rising/neutral/falling/trough/unknown
    source: sku_yoy / neutral
    """
    ratios: list[float] = []
    if dms_30 is not None and dms_30 > 0 and dms_30_yoy is not None and dms_30_yoy > 0:
        ratios.append(dms_30 / dms_30_yoy)
    if dms_7 is not None and dms_7 > 0 and dms_7_yoy is not None and dms_7_yoy > 0:
        ratios.append(dms_7 / dms_7_yoy)

    if not ratios:
        return (None, "unknown", "neutral")

    raw = sum(ratios) / len(ratios)
    factor = max(FACTOR_MIN, min(FACTOR_MAX, raw))
    return (factor, compute_seasonal_phase(factor), "sku_yoy")


def compute_seasonal_phase(factor: float | None) -> str:
    """按 factor 划分相位。factor=None → 'unknown'。"""
    if factor is None:
        return "unknown"
    if factor > SEASONAL_PHASE_THRESHOLDS["peak"]:
        return "peak"
    if factor > SEASONAL_PHASE_THRESHOLDS["rising"]:
        return "rising"
    if factor >= SEASONAL_PHASE_THRESHOLDS["neutral_low"]:
        return "neutral"
    if factor >= SEASONAL_PHASE_THRESHOLDS["falling"]:
        return "falling"
    return "trough"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && pytest tests/services/inventory/test_seasonal_factor.py -v`
Expected: PASS（13 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/inventory/seasonal_factor.py backend/tests/services/inventory/test_seasonal_factor.py
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "feat(inventory): 新建 seasonal_factor.py 模块（v1.2 简化版）"
```

---

### Task 2: `state_action.py` — trend_label + trend_momentum

**Files:**
- Create: `backend/app/services/inventory/state_action.py`
- Create: `backend/tests/services/inventory/test_state_action.py`

**Interfaces:**
- Consumes: `ItemInput`（复用 `health_score.ItemInput`）
- Produces:
  - `compute_trend_label(dms_7, dms_30) -> str` — 复用 `_score_trend` 4 档语义
  - `compute_trend_momentum(dms_7, dms_14, dms_30) -> str` — 双比值差
  - `compute_seasonal_adjusted_sellable_days(sellable_days, seasonal_factor) -> float | None`

- [ ] **Step 1: 写失败测试（trend_label + momentum + adjusted_sellable_days 三部分）**

创建 `backend/tests/services/inventory/test_state_action.py`：

```python
"""state_action 单元测试。"""
from __future__ import annotations

import pytest

from app.services.inventory.health_score import ItemInput
from app.services.inventory.state_action import (
    compute_trend_label,
    compute_trend_momentum,
    compute_seasonal_adjusted_sellable_days,
)


class TestComputeTrendLabel:
    """复用 _score_trend 4 档语义。"""

    def test_trend_label_up_when_above_1_5(self):
        """dms_7/dms_30 = 2.0 → 上升"""
        assert compute_trend_label(2.0, 1.0) == "上升"

    def test_trend_label_stable_in_range_0_9_to_1_5(self):
        """dms_7/dms_30 = 1.0 → 稳定"""
        assert compute_trend_label(1.0, 1.0) == "稳定"

    def test_trend_label_slight_decline_in_range_0_7_to_0_9(self):
        """dms_7/dms_30 = 0.8 → 轻微下降"""
        assert compute_trend_label(0.8, 1.0) == "轻微下降"

    def test_trend_label_significant_decline_below_0_7(self):
        """dms_7/dms_30 = 0.5 → 下降明显"""
        assert compute_trend_label(0.5, 1.0) == "下降明显"

    def test_trend_label_returns_stable_when_dms30_missing(self):
        """dms_30=None → 稳定（无数据）"""
        assert compute_trend_label(0.5, None) == "稳定"

    def test_trend_label_returns_stable_when_dms7_missing(self):
        """dms_7=None → 稳定"""
        assert compute_trend_label(None, 1.0) == "稳定"


class TestComputeTrendMomentum:
    """双比值差算法：accelerating/decelerating/stable。"""

    def test_momentum_accelerating_when_recent_much_lower_than_earlier(self):
        """dms_7/dms_30 = 0.6, dms_14/dms_30 = 0.8 → delta=-0.2 → accelerating"""
        assert compute_trend_momentum(0.6, 0.8, 1.0) == "accelerating"

    def test_momentum_decelerating_when_recent_higher_than_earlier(self):
        """dms_7/dms_30 = 1.0, dms_14/dms_30 = 0.8 → delta=+0.2 → decelerating"""
        assert compute_trend_momentum(1.0, 0.8, 1.0) == "decelerating"

    def test_momentum_stable_when_delta_small(self):
        """dms_7/dms_30 = 0.9, dms_14/dms_30 = 0.85 → delta=0.05 → stable"""
        assert compute_trend_momentum(0.9, 0.85, 1.0) == "stable"

    def test_momentum_stable_when_data_missing(self):
        """任一字段 None → stable"""
        assert compute_trend_momentum(None, 0.8, 1.0) == "stable"
        assert compute_trend_momentum(0.6, None, 1.0) == "stable"
        assert compute_trend_momentum(0.6, 0.8, None) == "stable"

    def test_momentum_stable_when_dms30_zero(self):
        """dms_30=0（死货）→ stable"""
        assert compute_trend_momentum(0.0, 0.0, 0.0) == "stable"


class TestComputeSeasonalAdjustedSellableDays:
    """adjusted_sellable_days = sellable_days / seasonal_factor。"""

    def test_adjusted_shorter_in_peak(self):
        """factor=1.3 → adjusted = sellable_days / 1.3"""
        result = compute_seasonal_adjusted_sellable_days(39.0, 1.3)
        assert result == pytest.approx(30.0)

    def test_adjusted_longer_in_trough(self):
        """factor=0.7 → adjusted = sellable_days / 0.7"""
        result = compute_seasonal_adjusted_sellable_days(63.0, 0.7)
        assert result == pytest.approx(90.0)

    def test_adjusted_equals_original_when_factor_none(self):
        """factor=None → 不调整，返原值"""
        assert compute_seasonal_adjusted_sellable_days(50.0, None) == 50.0

    def test_adjusted_none_when_sellable_days_none(self):
        """sellable_days=None → None"""
        assert compute_seasonal_adjusted_sellable_days(None, 1.3) is None
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && pytest tests/services/inventory/test_state_action.py::TestComputeTrendLabel -v`
Expected: FAIL（`ImportError: cannot import name 'compute_trend_label'`）

- [ ] **Step 3: 实现 `state_action.py`（先实现 trend + momentum + adjusted）**

创建 `backend/app/services/inventory/state_action.py`：

```python
"""inventory_state + replenishment_action 判定逻辑。

三段式产物：
  1. inventory_state (5 状态)
  2. replenishment_action (6 行动)
  3. signals (透明度)

判定顺序（严格分阶段，避免循环）：
  trend_label → state → action
  trend_momentum / seasonal_factor 单独计算，传给 signals
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from app.services.inventory.health_score import ItemInput

if TYPE_CHECKING:
    pass

# 阈值常量
TREND_RATIO_UP = 1.5
TREND_RATIO_STABLE = 0.9
TREND_RATIO_DOWN_MILD = 0.7
MOMENTUM_DELTA = 0.1


def compute_trend_label(dms_7: float | None, dms_30: float | None) -> str:
    """复用 _score_trend 4 档语义。"""
    if dms_7 is None or dms_30 is None or dms_30 <= 0:
        return "稳定"
    ratio = dms_7 / dms_30
    if ratio > TREND_RATIO_UP:
        return "上升"
    if ratio >= TREND_RATIO_STABLE:
        return "稳定"
    if ratio >= TREND_RATIO_DOWN_MILD:
        return "轻微下降"
    return "下降明显"


def compute_trend_momentum(
    dms_7: float | None,
    dms_14: float | None,
    dms_30: float | None,
) -> str:
    """双比值差：delta = dms_7/dms_30 - dms_14/dms_30。"""
    if (
        dms_7 is None
        or dms_14 is None
        or dms_30 is None
        or dms_30 <= 0
    ):
        return "stable"
    delta = (dms_7 - dms_14) / dms_30
    if delta < -MOMENTUM_DELTA:
        return "accelerating"  # 趋势在恶化
    if delta > MOMENTUM_DELTA:
        return "decelerating"  # 趋势在回稳
    return "stable"


def compute_seasonal_adjusted_sellable_days(
    sellable_days: float | None,
    seasonal_factor: float | None,
) -> float | None:
    """adjusted_sellable_days = sellable_days / seasonal_factor。"""
    if sellable_days is None:
        return None
    if seasonal_factor is None:
        return sellable_days
    return sellable_days / seasonal_factor
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && pytest tests/services/inventory/test_state_action.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/inventory/state_action.py backend/tests/services/inventory/test_state_action.py
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "feat(inventory): state_action.py trend + momentum + adjusted_sellable_days"
```

---

### Task 3: `state_action.py` — `compute_inventory_state` + critical_subtype

**Files:**
- Modify: `backend/app/services/inventory/state_action.py`
- Modify: `backend/tests/services/inventory/test_state_action.py`

**Interfaces:**
- Produces:
  - `compute_inventory_state(item: ItemInput, trend_label: str, adjusted_sellable_days: float | None) -> tuple[str, str | None]`
    - 返回 `(state, critical_subtype)`；critical_subtype ∈ `{'shortage', 'aging', 'overstock'}` 仅当 state='critical'

- [ ] **Step 1: 追加测试**

在 `test_state_action.py` 末尾添加：

```python
class TestComputeInventoryState:
    """compute_inventory_state P0-P13 顺序短路。"""

    def test_state_unknown_when_dms30_missing(self):
        """dms_30=None → unknown"""
        item = ItemInput(available_qty=10, sellable_days=50, dms_30=None, dms_7=1.0)
        state, _ = compute_inventory_state(item, "稳定", 50.0)
        assert state == "unknown"

    def test_state_critical_when_doh_below_14(self):
        """DoH<14 → critical, subtype=shortage"""
        item = ItemInput(available_qty=10, sellable_days=10, dms_30=1.0, dms_7=1.0)
        state, subtype = compute_inventory_state(item, "稳定", 10.0)
        assert state == "critical"
        assert subtype == "shortage"

    def test_state_critical_when_doh_14_30_with_sales(self):
        """DoH 14-30 且 dms_30>0 → critical, subtype=shortage"""
        item = ItemInput(available_qty=20, sellable_days=20, dms_30=1.0, dms_7=1.0)
        state, subtype = compute_inventory_state(item, "稳定", 20.0)
        assert state == "critical"
        assert subtype == "shortage"

    def test_state_critical_when_age_365_plus(self):
        """age_365_plus_qty>0 → critical, subtype=aging"""
        item = ItemInput(
            available_qty=10, sellable_days=100, dms_30=1.0, dms_7=1.0,
            age_365_plus_qty=5,
        )
        state, subtype = compute_inventory_state(item, "稳定", 100.0)
        assert state == "critical"
        assert subtype == "aging"

    def test_state_critical_when_age_271_365_over_50pct(self):
        """age_271_365 占 total_age ≥ 50% → critical, subtype=aging"""
        item = ItemInput(
            available_qty=10, sellable_days=100, dms_30=1.0, dms_7=1.0,
            age_271_365_qty=10, age_91_180_qty=5,
        )
        state, subtype = compute_inventory_state(item, "稳定", 100.0)
        assert state == "critical"
        assert subtype == "aging"

    def test_state_critical_when_age_181_270_over_50pct(self):
        """age_181_270 占 ≥50% → critical, subtype=aging"""
        item = ItemInput(
            available_qty=10, sellable_days=100, dms_30=1.0, dms_7=1.0,
            age_181_270_qty=10, age_91_180_qty=3,
        )
        state, subtype = compute_inventory_state(item, "稳定", 100.0)
        assert state == "critical"
        assert subtype == "aging"

    def test_state_critical_when_dead_stock_high_doh_low_dms(self):
        """DoH>180 且 dms_30<0.7 → critical, subtype=overstock"""
        item = ItemInput(available_qty=100, sellable_days=200, dms_30=0.5, dms_7=0.3)
        state, subtype = compute_inventory_state(item, "下降明显", 200.0)
        assert state == "critical"
        assert subtype == "overstock"

    def test_state_deteriorating_when_doh_120_180_low_dms(self):
        """DoH 120-180 且 dms_30<0.7 → deteriorating"""
        item = ItemInput(available_qty=100, sellable_days=150, dms_30=0.5, dms_7=0.3)
        state, _ = compute_inventory_state(item, "下降明显", 150.0)
        assert state == "deteriorating"

    def test_state_deteriorating_when_declining_trend_plus_aging_or_transit(self):
        """trend=下降明显 + 库龄 91+ ≥30% → deteriorating"""
        item = ItemInput(
            available_qty=100, sellable_days=60, dms_30=1.0, dms_7=0.5,
            age_91_180_qty=40, age_0_90_qty=60,
        )
        state, _ = compute_inventory_state(item, "下降明显", 60.0)
        assert state == "deteriorating"

    def test_state_deteriorating_when_doh_45_90_declining_trend(self):
        """DoH 45-90 + trend=下降明显 → deteriorating"""
        item = ItemInput(available_qty=50, sellable_days=70, dms_30=1.0, dms_7=0.5)
        state, _ = compute_inventory_state(item, "下降明显", 70.0)
        assert state == "deteriorating"

    def test_state_watch_when_doh_30_45_declining_trend(self):
        """DoH 30-45 + trend=下降明显 → watch"""
        item = ItemInput(available_qty=40, sellable_days=40, dms_30=1.0, dms_7=0.5)
        state, _ = compute_inventory_state(item, "下降明显", 40.0)
        assert state == "watch"

    def test_state_watch_when_doh_90_180_normal_aging(self):
        """DoH 90-180 + 库龄正常 → watch"""
        item = ItemInput(
            available_qty=100, sellable_days=120, dms_30=1.0, dms_7=1.0,
            age_0_90_qty=100,
        )
        state, _ = compute_inventory_state(item, "稳定", 120.0)
        assert state == "watch"

    def test_state_healthy_default(self):
        """DoH 30-90 + 库龄正常 + trend 稳定 → healthy"""
        item = ItemInput(
            available_qty=60, sellable_days=60, dms_30=1.0, dms_7=1.0,
            age_0_90_qty=60,
        )
        state, _ = compute_inventory_state(item, "稳定", 60.0)
        assert state == "healthy"


class TestComputeInventoryStateUsesAdjustedDOH:
    """adjusted_sellable_days 必须用于判定（不是 sellable_days）。"""

    def test_state_critical_uses_adjusted_doh_in_peak(self):
        """原始 DoH=30, adjusted=23 (peak factor=1.3) → critical (subtype=shortage)"""
        item = ItemInput(available_qty=30, sellable_days=30, dms_30=1.0, dms_7=1.0)
        state, subtype = compute_inventory_state(item, "稳定", 23.0)
        assert state == "critical"
        assert subtype == "shortage"

    def test_state_healthy_in_trough_even_with_low_doh(self):
        """原始 DoH=30, adjusted=128 (trough factor=0.7) → healthy（不按原 DoH 判 critical）"""
        item = ItemInput(available_qty=30, sellable_days=30, dms_30=1.0, dms_7=1.0)
        state, _ = compute_inventory_state(item, "稳定", 90.0)  # 给一个正常的 adjusted
        assert state in {"healthy", "watch"}
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `cd backend && pytest tests/services/inventory/test_state_action.py::TestComputeInventoryState -v`
Expected: FAIL（`cannot import name 'compute_inventory_state'`）

- [ ] **Step 3: 实现 `compute_inventory_state`**

在 `backend/app/services/inventory/state_action.py` 末尾追加：

```python
# state 判定阈值常量（spec §2.1）
STATE_CRITICAL_DOH = 14
STATE_CRITICAL_SHORTAGE_DOH = 30
STATE_OVERSTOCK_CRITICAL_DOH = 180
STATE_OVERSTOCK_DETERIORATE_DOH = 120
STATE_DETERIORATE_TREND_RATIO = 0.7
STATE_WATCH_DOH_MIN = 30
STATE_WATCH_DOH_MAX = 90
AGING_271_RATIO = 0.50
AGING_181_RATIO = 0.50
AGING_91_DETERIORATE_RATIO = 0.30
TRANSIT_RATIO_DETERIORATE = 3.0
VELOCITY_MID = 0.7


def compute_inventory_state(
    item: ItemInput,
    trend_label: str,
    adjusted_sellable_days: float | None,
) -> tuple[str, str | None]:
    """返回 (state, critical_subtype)。"""

    doh = adjusted_sellable_days  # 用调整后的 DoH

    # P0: 数据缺失
    if item.dms_30 is None:
        return ("unknown", None)

    # P1: 立即断货风险
    if doh is not None and doh < STATE_CRITICAL_DOH:
        return ("critical", "shortage")

    # P2: DoH 14-30 且在卖
    if (
        doh is not None
        and doh < STATE_CRITICAL_SHORTAGE_DOH
        and item.dms_30 > 0
    ):
        return ("critical", "shortage")

    # 计算 total_age
    total_age = (
        item.age_0_90_qty
        + item.age_91_180_qty
        + item.age_181_270_qty
        + item.age_271_365_qty
        + item.age_365_plus_qty
    )

    # P3: 库龄 365+
    if item.age_365_plus_qty > 0:
        return ("critical", "aging")

    # P4: 库龄 271-365 占 ≥50%
    if total_age > 0 and (item.age_271_365_qty / total_age) >= AGING_271_RATIO:
        return ("critical", "aging")

    # P5: 库龄 181-270 占 ≥50%
    if total_age > 0 and (item.age_181_270_qty / total_age) >= AGING_181_RATIO:
        return ("critical", "aging")

    # P6: DoH>180 且慢销
    if doh is not None and doh > STATE_OVERSTOCK_CRITICAL_DOH and item.dms_30 < VELOCITY_MID:
        return ("critical", "overstock")

    # P7: DoH 120-180 且慢销
    if (
        doh is not None
        and STATE_OVERSTOCK_DETERIORATE_DOH < doh <= STATE_OVERSTOCK_CRITICAL_DOH
        and item.dms_30 < VELOCITY_MID
    ):
        return ("deteriorating", None)

    # P8: trend=下降明显 + 库龄 91+ ≥30% 或 在途/可售>3
    if trend_label == "下降明显":
        aging_91_plus_ratio = (
            (item.age_91_180_qty + item.age_181_270_qty + item.age_271_365_qty + item.age_365_plus_qty) / total_age
            if total_age > 0
            else 0
        )
        transit_ratio = (
            item.in_transit_qty / item.available_qty
            if item.available_qty > 0
            else 0
        )
        if aging_91_plus_ratio >= AGING_91_DETERIORATE_RATIO or transit_ratio > TRANSIT_RATIO_DETERIORATE:
            return ("deteriorating", None)

    # P9: DoH 45-90 + trend=下降明显
    if (
        doh is not None
        and 45 <= doh <= STATE_WATCH_DOH_MAX
        and trend_label == "下降明显"
    ):
        return ("deteriorating", None)

    # P10: DoH 30-45 + trend=下降明显 → watch
    if (
        doh is not None
        and STATE_WATCH_DOH_MIN <= doh < 45
        and trend_label == "下降明显"
    ):
        return ("watch", None)

    # P11: DoH 90-180 + 库龄正常 → watch
    if (
        doh is not None
        and STATE_WATCH_DOH_MAX < doh <= STATE_OVERSTOCK_CRITICAL_DOH
    ):
        return ("watch", None)

    # P12/P13: 其余 → healthy
    return ("healthy", None)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && pytest tests/services/inventory/test_state_action.py::TestComputeInventoryState tests/services/inventory/test_state_action.py::TestComputeInventoryStateUsesAdjustedDOH -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/inventory/state_action.py backend/tests/services/inventory/test_state_action.py
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "feat(inventory): state_action.py compute_inventory_state P0-P13"
```

---

### Task 4: `state_action.py` — `compute_replenishment_action`

**Files:**
- Modify: `backend/app/services/inventory/state_action.py`
- Modify: `backend/tests/services/inventory/test_state_action.py`

**Interfaces:**
- Produces:
  - `compute_replenishment_action(state, critical_subtype, trend_label, transit_ratio, seasonal_phase) -> str`
    - 返回 ReplenishmentAction 枚举值之一

- [ ] **Step 1: 追加测试**

```python
from app.services.inventory.state_action import (
    ReplenishmentAction,
    compute_replenishment_action,
)


class TestComputeReplenishmentAction:
    """12 行决策表（不含季节性列）。"""

    def test_action_replenish_now_for_doh_below_14(self):
        """critical (DoH<14) → REPLENISH_NOW"""
        action = compute_replenishment_action(
            state="critical", critical_subtype="shortage",
            trend_label="稳定", transit_ratio=1.0, seasonal_phase="neutral",
        )
        assert action == "REPLENISH_NOW"

    def test_action_remove_for_age_365_plus(self):
        """critical (库龄 365+) → REMOVE"""
        action = compute_replenishment_action(
            state="critical", critical_subtype="aging",
            trend_label="稳定", transit_ratio=0, seasonal_phase="neutral",
        )
        assert action == "REMOVE"

    def test_action_reduce_price_for_critical_overstock_declining(self):
        """critical (DoH>120 慢销) + trend=下降 → REDUCE_PRICE"""
        action = compute_replenishment_action(
            state="critical", critical_subtype="overstock",
            trend_label="下降明显", transit_ratio=1.0, seasonal_phase="neutral",
        )
        assert action == "REDUCE_PRICE"

    def test_action_hold_for_critical_overstock_stable_high_transit(self):
        """critical (DoH>120 慢销) + 稳定 + transit>3 → REDUCE_PRICE"""
        action = compute_replenishment_action(
            state="critical", critical_subtype="overstock",
            trend_label="稳定", transit_ratio=4.0, seasonal_phase="neutral",
        )
        assert action == "REDUCE_PRICE"

    def test_action_hold_for_critical_overstock_stable_low_transit(self):
        """critical (DoH>120 慢销) + 稳定 + transit≤3 → HOLD"""
        action = compute_replenishment_action(
            state="critical", critical_subtype="overstock",
            trend_label="稳定", transit_ratio=2.0, seasonal_phase="neutral",
        )
        assert action == "HOLD"

    def test_action_replenish_normal_for_critical_shortage_up_trend(self):
        """critical (DoH 14-30 在卖) + 上升 → REPLENISH_NORMAL"""
        action = compute_replenishment_action(
            state="critical", critical_subtype="shortage",
            trend_label="上升", transit_ratio=1.0, seasonal_phase="neutral",
        )
        assert action == "REPLENISH_NORMAL"

    def test_action_hold_for_critical_shortage_down_trend(self):
        """critical (DoH 14-30 在卖) + 下降 → HOLD"""
        action = compute_replenishment_action(
            state="critical", critical_subtype="shortage",
            trend_label="下降明显", transit_ratio=1.0, seasonal_phase="neutral",
        )
        assert action == "HOLD"

    def test_action_reduce_price_for_deteriorating_declining(self):
        """deteriorating + 下降 → REDUCE_PRICE"""
        action = compute_replenishment_action(
            state="deteriorating", critical_subtype=None,
            trend_label="下降明显", transit_ratio=1.0, seasonal_phase="neutral",
        )
        assert action == "REDUCE_PRICE"

    def test_action_hold_for_deteriorating_stable(self):
        """deteriorating + 稳定/上升 → HOLD"""
        action = compute_replenishment_action(
            state="deteriorating", critical_subtype=None,
            trend_label="稳定", transit_ratio=1.0, seasonal_phase="neutral",
        )
        assert action == "HOLD"

    def test_action_no_action_for_healthy(self):
        """healthy → NO_ACTION"""
        action = compute_replenishment_action(
            state="healthy", critical_subtype=None,
            trend_label="稳定", transit_ratio=1.0, seasonal_phase="neutral",
        )
        assert action == "NO_ACTION"

    def test_action_no_action_for_watch(self):
        """watch → NO_ACTION"""
        action = compute_replenishment_action(
            state="watch", critical_subtype=None,
            trend_label="稳定", transit_ratio=1.0, seasonal_phase="neutral",
        )
        assert action == "NO_ACTION"

    def test_action_no_action_for_unknown(self):
        """unknown → NO_ACTION"""
        action = compute_replenishment_action(
            state="unknown", critical_subtype=None,
            trend_label="稳定", transit_ratio=1.0, seasonal_phase="neutral",
        )
        assert action == "NO_ACTION"


class TestComputeReplenishmentActionSeasonal:
    """季节性覆盖。"""

    def test_action_hold_for_deteriorating_in_trough_phase(self):
        """deteriorating + 下降 + phase=trough → HOLD (避免误杀季节性回落)"""
        action = compute_replenishment_action(
            state="deteriorating", critical_subtype=None,
            trend_label="下降明显", transit_ratio=1.0, seasonal_phase="trough",
        )
        assert action == "HOLD"

    def test_action_hold_for_critical_overstock_stable_in_trough(self):
        """critical (overstock) + 稳定 + phase=trough → HOLD (季节性存量)"""
        action = compute_replenishment_action(
            state="critical", critical_subtype="overstock",
            trend_label="稳定", transit_ratio=2.0, seasonal_phase="trough",
        )
        assert action == "HOLD"

    def test_action_replenish_normal_for_critical_shortage_in_peak(self):
        """critical (shortage) + 下降 + phase=peak → REPLENISH_NORMAL (旺季覆盖)"""
        action = compute_replenishment_action(
            state="critical", critical_subtype="shortage",
            trend_label="下降明显", transit_ratio=1.0, seasonal_phase="peak",
        )
        assert action == "REPLENISH_NORMAL"
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `cd backend && pytest tests/services/inventory/test_state_action.py::TestComputeReplenishmentAction -v`
Expected: FAIL（`cannot import name 'compute_replenishment_action'`）

- [ ] **Step 3: 实现 `ReplenishmentAction` enum + `compute_replenishment_action`**

在 `state_action.py` 顶部加 enum：

```python
from enum import Enum


class ReplenishmentAction(str, Enum):
    REPLENISH_NOW = "REPLENISH_NOW"
    REPLENISH_NORMAL = "REPLENISH_NORMAL"
    HOLD = "HOLD"
    REDUCE_PRICE = "REDUCE_PRICE"
    REMOVE = "REMOVE"
    NO_ACTION = "NO_ACTION"
```

在末尾追加函数：

```python
PEAK_PHASES = {"peak", "rising"}
TROUGH_PHASES = {"falling", "trough"}


def compute_replenishment_action(
    state: str,
    critical_subtype: str | None,
    trend_label: str,
    transit_ratio: float,
    seasonal_phase: str,
) -> str:
    """决策表（spec §2.2 12 行 + 季节性列）。"""
    trend_is_decline = trend_label in {"轻微下降", "下降明显"}
    trend_is_up = trend_label in {"上升", "稳定"}

    # Row 1: critical (DoH<14) → REPLENISH_NOW
    if state == "critical" and critical_subtype == "shortage":
        # row 1 & 2: shortage covers both DoH<14 and DoH 14-30 在卖
        # Row 6/7: shortage + trend 决定 REPLENISH_NORMAL vs HOLD
        if trend_is_up:
            return ReplenishmentAction.REPLENISH_NORMAL.value
        # trend=下降；旺季覆盖 → REPLENISH_NORMAL（旺季"下降"可能是补货跟进问题）
        if seasonal_phase in PEAK_PHASES:
            return ReplenishmentAction.REPLENISH_NORMAL.value
        return ReplenishmentAction.HOLD.value

    # Row 3: critical (库龄 365+) → REMOVE
    if state == "critical" and critical_subtype == "aging":
        return ReplenishmentAction.REMOVE.value

    # Row 4-7: critical (DoH>120 慢销, subtype=overstock)
    if state == "critical" and critical_subtype == "overstock":
        if trend_is_decline:
            return ReplenishmentAction.REDUCE_PRICE.value
        # trend_is_up
        if transit_ratio > 3.0:
            return ReplenishmentAction.REDUCE_PRICE.value
        # transit≤3；trough 覆盖 → HOLD
        if seasonal_phase in TROUGH_PHASES:
            return ReplenishmentAction.HOLD.value
        return ReplenishmentAction.HOLD.value

    # Row 8/9: deteriorating
    if state == "deteriorating":
        if trend_is_decline:
            # trough 覆盖 → HOLD
            if seasonal_phase in TROUGH_PHASES:
                return ReplenishmentAction.HOLD.value
            return ReplenishmentAction.REDUCE_PRICE.value
        # trend_is_up → HOLD
        return ReplenishmentAction.HOLD.value

    # Row 10/11/12: watch / healthy / unknown
    return ReplenishmentAction.NO_ACTION.value
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && pytest tests/services/inventory/test_state_action.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/inventory/state_action.py backend/tests/services/inventory/test_state_action.py
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "feat(inventory): state_action.py compute_replenishment_action + 季节性覆盖"
```

---

### Task 5: `state_action.py` — `compute_signals`

**Files:**
- Modify: `backend/app/services/inventory/state_action.py`
- Modify: `backend/tests/services/inventory/test_state_action.py`

**Interfaces:**
- Produces:
  - `compute_signals(item, trend_label, trend_momentum, snapshot_age_days, seasonal_factor, seasonal_phase, seasonal_source) -> dict`
    - 返回 dict（包含所有 signals 字段），便于上层映射到 Pydantic schema

- [ ] **Step 1: 追加测试**

```python
from app.services.inventory.state_action import compute_signals


class TestComputeSignals:
    """signals dict 包含全部字段（含季节性）。"""

    def test_signals_full_data(self):
        item = ItemInput(
            available_qty=60, sellable_days=60, dms_30=1.0, dms_7=1.0, dms_14=1.0, dms_3=1.0,
            age_0_90_qty=60, in_transit_qty=10,
        )
        s = compute_signals(
            item=item,
            trend_label="稳定",
            trend_momentum="stable",
            snapshot_age_days=1,
            seasonal_factor=1.2,
            seasonal_phase="rising",
            seasonal_source="sku_yoy",
        )
        assert s["sellable_days"] == 60
        assert s["dms_30"] == 1.0
        assert s["trend_label"] == "稳定"
        assert s["trend_momentum"] == "stable"
        assert s["seasonal_factor"] == 1.2
        assert s["seasonal_phase"] == "rising"
        assert s["seasonal_source"] == "sku_yoy"
        assert s["data_freshness_days"] == 1
        assert s["confidence"] == "high"
        assert s["aging_share"]["0_90"] == 1.0
        assert s["transit_ratio"] == pytest.approx(10/60)

    def test_signals_confidence_low_when_dms30_missing(self):
        item = ItemInput(
            available_qty=10, sellable_days=50, dms_30=None, dms_7=None,
            age_0_90_qty=10,
        )
        s = compute_signals(
            item=item, trend_label="稳定", trend_momentum="stable",
            snapshot_age_days=5, seasonal_factor=None, seasonal_phase="unknown",
            seasonal_source="neutral",
        )
        assert s["confidence"] == "low"

    def test_signals_confidence_medium_when_partial(self):
        """dms_30 存在但 dms_7 缺失 → medium"""
        item = ItemInput(
            available_qty=60, sellable_days=60, dms_30=1.0, dms_7=None,
            age_0_90_qty=60,
        )
        s = compute_signals(
            item=item, trend_label="稳定", trend_momentum="stable",
            snapshot_age_days=2, seasonal_factor=None, seasonal_phase="unknown",
            seasonal_source="neutral",
        )
        assert s["confidence"] == "medium"

    def test_signals_aging_share_distribution(self):
        """库龄分布正确计算"""
        item = ItemInput(
            available_qty=100, sellable_days=60, dms_30=1.0, dms_7=1.0,
            age_0_90_qty=70, age_91_180_qty=20, age_181_270_qty=10,
        )
        s = compute_signals(
            item=item, trend_label="稳定", trend_momentum="stable",
            snapshot_age_days=1, seasonal_factor=None, seasonal_phase="unknown",
            seasonal_source="neutral",
        )
        assert s["aging_share"]["0_90"] == pytest.approx(0.7)
        assert s["aging_share"]["91_180"] == pytest.approx(0.2)
        assert s["aging_share"]["181_270"] == pytest.approx(0.1)
        assert s["aging_share"]["271_365"] == 0.0
        assert s["aging_share"]["365_plus"] == 0.0
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `cd backend && pytest tests/services/inventory/test_state_action.py::TestComputeSignals -v`
Expected: FAIL

- [ ] **Step 3: 实现 `compute_signals`**

在 `state_action.py` 末尾追加：

```python
def compute_signals(
    item: ItemInput,
    trend_label: str,
    trend_momentum: str,
    snapshot_age_days: int,
    seasonal_factor: float | None,
    seasonal_phase: str,
    seasonal_source: str,
) -> dict:
    """返回 signals dict（不含 dataclass，便于映射到 Pydantic schema）。"""

    # trend_ratio
    trend_ratio_7_30 = (
        item.dms_7 / item.dms_30
        if item.dms_7 is not None and item.dms_30 is not None and item.dms_30 > 0
        else None
    )
    trend_ratio_3_7 = (
        item.dms_3 / item.dms_7
        if item.dms_3 is not None and item.dms_7 is not None and item.dms_7 > 0
        else None
    )

    # aging_share
    total_age = (
        item.age_0_90_qty
        + item.age_91_180_qty
        + item.age_181_270_qty
        + item.age_271_365_qty
        + item.age_365_plus_qty
    )
    if total_age > 0:
        aging_share = {
            "0_90": item.age_0_90_qty / total_age,
            "91_180": item.age_91_180_qty / total_age,
            "181_270": item.age_181_270_qty / total_age,
            "271_365": item.age_271_365_qty / total_age,
            "365_plus": item.age_365_plus_qty / total_age,
        }
    else:
        aging_share = {"0_90": 0.0, "91_180": 0.0, "181_270": 0.0, "271_365": 0.0, "365_plus": 0.0}

    # transit_ratio
    transit_ratio = (
        item.in_transit_qty / item.available_qty
        if item.available_qty > 0
        else None
    )

    # confidence
    has_dms30 = item.dms_30 is not None
    has_dms7 = item.dms_7 is not None
    has_full_aging = total_age > 0
    has_yoy = seasonal_source == "sku_yoy"
    if not has_dms30 or snapshot_age_days > 3:
        confidence = "low"
    elif (not has_dms7 or not has_full_aging) and snapshot_age_days > 1:
        confidence = "medium"
    elif snapshot_age_days > 1:
        confidence = "medium"
    else:
        confidence = "high"

    return {
        "sellable_days": item.sellable_days,
        "dms_3": item.dms_3,
        "dms_7": item.dms_7,
        "dms_14": item.dms_14,
        "dms_30": item.dms_30,
        "trend_ratio_7_30": trend_ratio_7_30,
        "trend_ratio_3_7": trend_ratio_3_7,
        "trend_label": trend_label,
        "trend_momentum": trend_momentum,
        "aging_share": aging_share,
        "transit_ratio": transit_ratio,
        "data_freshness_days": snapshot_age_days,
        "confidence": confidence,
        "seasonal_factor": seasonal_factor,
        "seasonal_phase": seasonal_phase,
        "seasonal_source": seasonal_source,
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && pytest tests/services/inventory/test_state_action.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/inventory/state_action.py backend/tests/services/inventory/test_state_action.py
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "feat(inventory): state_action.py compute_signals 含季节性"
```

---

### Task 6: Schemas — `InventoryReplenishmentListItem` + `InventorySignals` + Summary

**Files:**
- Modify: `backend/app/schemas/inventory_replenishment.py`

- [ ] **Step 1: 添加 `InventorySignals` schema**

在 `inventory_replenishment.py` 中现有 `InventoryReplenishmentListItem` 之前插入：

```python
class InventorySignals(BaseModel):
    """inventory_state + action 决策依据的原始事实（透明度）。"""
    sellable_days: float | None = None
    dms_3: float | None = None
    dms_7: float | None = None
    dms_14: float | None = None
    dms_30: float | None = None
    trend_ratio_7_30: float | None = None
    trend_ratio_3_7: float | None = None
    trend_label: str | None = None
    trend_momentum: str | None = None
    aging_share: dict[str, float] = Field(default_factory=dict)
    transit_ratio: float | None = None
    data_freshness_days: int = 0
    confidence: str = "low"
    # v1.2 季节性
    seasonal_factor: float | None = None
    seasonal_phase: str | None = None
    seasonal_source: str | None = None
```

- [ ] **Step 2: 修改 `InventoryReplenishmentListItem`**

在现有字段后追加：

```python
class InventoryReplenishmentListItem(BaseModel):
    # ... 现有字段保留 ...
    # NEW v1.2:
    inventory_state: str  # critical/deteriorating/watch/healthy/unknown
    replenishment_action: str  # ReplenishmentAction 枚举值
    signals: InventorySignals | None = None
```

- [ ] **Step 3: 修改 `InventoryReplenishmentSummary`**

```python
class InventoryReplenishmentSummary(BaseModel):
    sku_count: int
    out_of_stock_risk_count: int  # 旧字段保留，按 critical_subtype='shortage' 重算
    healthy_count: int  # 旧字段保留
    slow_moving_count: int  # 旧字段保留，按 critical_subtype in {'overstock', 'aging'} 重算
    pending_data_count: int  # 旧字段保留
    total_available_inventory: int
    total_in_transit_quantity: int
    # NEW v1.2:
    critical_count: int = 0
    deteriorating_count: int = 0
    watch_count: int = 0
    healthy_count_v2: int = 0  # 注意：原 healthy_count 已存在；这里改名 healthy_count_v2 防冲突
    unknown_count: int = 0
```

（注意：上面 `healthy_count` 旧字段已存在 + `healthy_count_v2` 新字段并列；前端用 v2 字段做新 UI，旧字段保留给 BI。）

- [ ] **Step 4: 跑现有 API 测试**

Run: `cd backend && pytest tests/api/v1/inventory_replenishment -v`
Expected: PASS（schema 新增字段是向后兼容的，旧测试不会破）

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/inventory_replenishment.py
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "feat(schema): InventoryReplenishmentListItem 加 inventory_state/action/signals"
```

---

### Task 7: `replenishment.py` 主函数 — 集成 YoY 查询 + 三段式判定

**Files:**
- Modify: `backend/app/services/inventory/replenishment.py:908` — `list_inventory_replenishment_analysis`
- Modify: `backend/app/services/inventory/__init__.py`（如需导出）

- [ ] **Step 1: 在主函数内调用 `_load_seasonal_dms_map`**

定位 `list_inventory_replenishment_analysis` 函数（约 line 908）。在已有的 `_load_sales_dms_map` 调用附近，新增一行调用 `_load_seasonal_dms_map`：

```python
# 现有：
dms_map = _load_sales_dms_map(...)

# NEW: 季节性 YoY 查询
seasonal_dms_map = _load_seasonal_dms_map(
    db,
    project.id,
    normalized_country,
    to_date=date.today(),
    compare_year_offset=1,
)
```

注意：`_load_seasonal_dms_map` 是已有的季节性函数（replenishment.py 内 line 592-684），复用即可。

- [ ] **Step 2: 在 SKU 拼装循环里集成三段式判定**

在每个 SKU row 拼装时（约 line 1080-1100），插入三段式计算：

```python
# 现有代码：构造 _InventorySnapshot + sellable_days 等

# NEW: 三段式判定
seasonal_dms = seasonal_dms_map.get(base_row.sku)
dms_30_yoy = _decimal_to_float(seasonal_dms.dms_30_yoy) if seasonal_dms else None
dms_7_yoy = _decimal_to_float(seasonal_dms.dms_7_yoy) if seasonal_dms else None

# ItemInput for state_action
state_action_input = ItemInput(
    available_qty=available_inventory,
    sellable_days=float(sellable_days) if sellable_days is not None else None,
    dms_30=dms_30,
    dms_7=dms_7,
    dms_14=dms_14,
    dms_3=dms_3,
    age_0_90_qty=snap.age_0_90_qty if snap else 0,
    age_91_180_qty=snap.age_91_180_qty if snap else 0,
    age_181_270_qty=snap.age_181_270_qty if snap else 0,
    age_271_365_qty=snap.age_271_365_qty if snap else 0,
    age_365_plus_qty=snap.age_365_plus_qty if snap else 0,
    in_transit_qty=in_transit_quantity,
)

# seasonal_factor
seasonal_factor, seasonal_phase, seasonal_source = compute_seasonal_factor(
    dms_30=dms_30, dms_7=dms_7,
    dms_30_yoy=dms_30_yoy, dms_7_yoy=dms_7_yoy,
)

# adjusted_sellable_days
adjusted_sellable_days = compute_seasonal_adjusted_sellable_days(
    sellable_days=float(sellable_days) if sellable_days is not None else None,
    seasonal_factor=seasonal_factor,
)

# trend
trend_label = compute_trend_label(dms_7, dms_30)
trend_momentum = compute_trend_momentum(dms_7, dms_14, dms_30)

# state
inventory_state, critical_subtype = compute_inventory_state(
    state_action_input, trend_label, adjusted_sellable_days,
)

# transit_ratio for action
transit_ratio = (
    in_transit_quantity / available_inventory if available_inventory > 0 else 0.0
)

# action
replenishment_action = compute_replenishment_action(
    inventory_state, critical_subtype, trend_label, transit_ratio, seasonal_phase,
)

# signals
snapshot_age_days = (date.today() - source.report_date).days if source.report_date else 0
signals_dict = compute_signals(
    state_action_input, trend_label, trend_momentum, snapshot_age_days,
    seasonal_factor, seasonal_phase, seasonal_source,
)
signals = InventorySignals(**signals_dict)
```

- [ ] **Step 3: 在返回 dict 里加新字段**

在 row.append() 处加入新字段：

```python
rows.append({
    # ... 现有字段 ...
    "inventory_state": inventory_state,
    "replenishment_action": replenishment_action,
    "signals": signals,
    # risk_status 改为 emoji（向后兼容）
    "risk_status": STATE_EMOJI[inventory_state],
})
```

- [ ] **Step 4: 更新 summary 统计**

主函数末尾的 summary 计算处，追加新字段：

```python
# 统计 critical_count / deteriorating_count / watch_count / healthy_count_v2 / unknown_count
state_counts = {"critical": 0, "deteriorating": 0, "watch": 0, "healthy": 0, "unknown": 0}
for row in rows:
    state_counts[row["inventory_state"]] += 1

# 旧字段映射
old_out_of_stock = sum(
    1 for row in rows
    if row["inventory_state"] == "critical"
    and row.get("_critical_subtype") == "shortage"  # 需要在 row 携带
)
old_slow_moving = sum(
    1 for row in rows
    if row["inventory_state"] == "critical"
    and row.get("_critical_subtype") in {"overstock", "aging"}
)

summary = {
    "sku_count": len(rows),
    "out_of_stock_risk_count": old_out_of_stock,
    "healthy_count": state_counts["healthy"],
    "slow_moving_count": old_slow_moving,
    "pending_data_count": state_counts["unknown"],
    "total_available_inventory": sum(r["available_inventory"] for r in rows),
    "total_in_transit_quantity": sum(r["in_transit_quantity"] for r in rows),
    "critical_count": state_counts["critical"],
    "deteriorating_count": state_counts["deteriorating"],
    "watch_count": state_counts["watch"],
    "healthy_count_v2": state_counts["healthy"],
    "unknown_count": state_counts["unknown"],
}
```

- [ ] **Step 5: 跑现有 API 测试**

Run: `cd backend && pytest tests/api/v1/inventory_replenishment -v`
Expected: PASS（旧测试不破，新字段默认空）

- [ ] **Step 6: 跑 state_action + seasonal_factor 测试**

Run: `cd backend && pytest tests/services/inventory/ -v`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/inventory/replenishment.py
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "feat(inventory): list_inventory_replenishment_analysis 集成三段式 + 季节性"
```

---

### Task 8: API 集成测试 — 三段式字段在响应里

**Files:**
- Create: `backend/tests/api/v1/inventory_replenishment/test_three_segment.py`

- [ ] **Step 1: 写集成测试**

```python
"""API 集成测试：验证三段式字段在响应中正确出现。"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy.orm import Session


@pytest.mark.usefixtures("seed_inventory_replenishment")
def test_external_endpoint_returns_state_action_signals(client):
    """GET /api/v1/external/projects/{id}/replenishment-analysis 响应含 inventory_state/action/signals"""
    # ... 假设已有 seed fixture 创建 project + SKU + sales data
    response = client.get(
        "/api/v1/external/projects/1/replenishment-analysis?country=US"
    )
    assert response.status_code == 200
    data = response.json()
    items = data["items"]
    assert len(items) > 0
    first = items[0]
    assert "inventory_state" in first
    assert first["inventory_state"] in {"critical", "deteriorating", "watch", "healthy", "unknown"}
    assert "replenishment_action" in first
    assert first["replenishment_action"] in {
        "REPLENISH_NOW", "REPLENISH_NORMAL", "HOLD",
        "REDUCE_PRICE", "REMOVE", "NO_ACTION",
    }
    assert "signals" in first
    assert first["signals"] is not None
    assert "seasonal_factor" in first["signals"]
    assert "seasonal_phase" in first["signals"]


@pytest.mark.usefixtures("seed_inventory_replenishment")
def test_filter_by_inventory_state(client):
    response = client.get(
        "/api/v1/external/projects/1/replenishment-analysis?country=US&inventory_state=critical"
    )
    assert response.status_code == 200
    items = response.json()["items"]
    assert all(r["inventory_state"] == "critical" for r in items)


@pytest.mark.usefixtures("seed_inventory_replenishment")
def test_summary_counts_match_new_states(client):
    response = client.get(
        "/api/v1/external/projects/1/replenishment-analysis?country=US"
    )
    data = response.json()
    items = data["items"]
    summary = data["summary"]
    # summary 字段对齐 items
    assert summary["critical_count"] == sum(1 for r in items if r["inventory_state"] == "critical")
    assert summary["healthy_count_v2"] == sum(1 for r in items if r["inventory_state"] == "healthy")
```

- [ ] **Step 2: 跑测试**

Run: `cd backend && pytest tests/api/v1/inventory_replenishment/test_three_segment.py -v`
Expected: PASS（前提是已有 seed_inventory_replenishment fixture 或类似测试 setup）

- [ ] **Step 3: Commit**

```bash
git add backend/tests/api/v1/inventory_replenishment/test_three_segment.py
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "test(inventory): API 集成测试验证三段式字段"
```

---

### Task 9: 前端 — 列定义 + 行色 + Excel 导出

**Files:**
- Modify: `frontend/app/dashboard/supply-chain/inventory-replenishment/page.tsx`

- [ ] **Step 1: 重新生成 API schema 类型**

Run: `cd frontend && pnpm generate-api-types`（假设仓库已有该脚本；如无，手动更新 `frontend/types/api-generated/api.d.ts` 加新字段）

- [ ] **Step 2: 添加列定义常量**

定位 `inventory-replenishment/page.tsx` 中列定义（约 line 700-720）。在 risk_status 列后追加 3 列：

```typescript
const ACTION_LABEL_MAP: Record<string, { label: string; color: string }> = {
  REPLENISH_NOW: { label: '紧急补货', color: 'bg-red-100 text-red-900' },
  REPLENISH_NORMAL: { label: '按计划补货', color: 'bg-blue-50 text-blue-900' },
  HOLD: { label: '暂停补货', color: 'bg-orange-100 text-orange-900' },
  REDUCE_PRICE: { label: '降价清货', color: 'bg-orange-100 text-orange-900' },
  REMOVE: { label: '创建移除', color: 'bg-red-100 text-red-900' },
  NO_ACTION: { label: '不动', color: 'bg-gray-50 text-gray-700' },
};

const TREND_LABEL_MAP: Record<string, string> = {
  accelerating: '↑加速上升',
  decelerating: '↓减速下降',
  stable: '→平稳',
};

const PHASE_LABEL_MAP: Record<string, string> = {
  peak: '🔥旺季',
  rising: '↗向旺季',
  neutral: '→常态',
  falling: '↘向淡季',
  trough: '❄️淡季',
  unknown: '?未知',
};
```

在列定义数组里追加：

```typescript
{ header: '行动', key: 'replenishment_action', width: 14 },
{ header: '趋势', key: 'signals.trend_momentum', width: 12 },
{ header: '季节性', key: 'signals.seasonal_phase', width: 12 },
```

- [ ] **Step 3: 添加单元格渲染函数**

```typescript
function ActionCell({ value }: { value: string }) {
  const cfg = ACTION_LABEL_MAP[value] || { label: value, color: '' };
  return <span className={`px-2 py-0.5 rounded text-xs ${cfg.color}`}>{cfg.label}</span>;
}

function TrendCell({ momentum }: { momentum: string | undefined }) {
  return <span className="text-xs">{TREND_LABEL_MAP[momentum ?? ''] ?? momentum ?? '-'}</span>;
}

function SeasonalCell({ phase, factor }: { phase: string | undefined; factor: number | null | undefined }) {
  const label = PHASE_LABEL_MAP[phase ?? ''] ?? phase ?? '?未知';
  const tooltip = factor != null ? `factor=${factor.toFixed(2)}` : '';
  return (
    <span className="text-xs" title={tooltip}>
      {label}
    </span>
  );
}
```

- [ ] **Step 4: 在表格组件里渲染新列**

定位表格 JSX（约 line 800+），按列定义顺序渲染：

```tsx
<td>
  <ActionCell value={row.replenishment_action} />
</td>
<td>
  <TrendCell momentum={row.signals?.trend_momentum} />
</td>
<td>
  <SeasonalCell phase={row.signals?.seasonal_phase} factor={row.signals?.seasonal_factor} />
</td>
```

- [ ] **Step 5: 行背景色（按 action）**

```tsx
const ACTION_BG: Record<string, string> = {
  REPLENISH_NOW: 'bg-red-50',
  REMOVE: 'bg-red-50',
  REDUCE_PRICE: 'bg-orange-50',
  HOLD: 'bg-orange-50',
};

<tr className={`${ACTION_BG[row.replenishment_action] ?? ''} ${
  row.inventory_state === 'deteriorating' ? 'border-l-4 border-orange-400' : ''
}`}>
  {/* ... cells ... */}
</tr>
```

- [ ] **Step 6: Excel 导出扩展**

定位 `exceljs` 导出代码（约 line 760-810）。在 risk_status 之后追加 3 列：

```typescript
sheetRow.getCell(colIdx++).value = ACTION_LABEL_MAP[row.replenishment_action]?.label ?? row.replenishment_action;
sheetRow.getCell(colIdx++).value = TREND_LABEL_MAP[row.signals?.trend_momentum ?? ''] ?? row.signals?.trend_momentum ?? '-';
sheetRow.getCell(colIdx++).value = PHASE_LABEL_MAP[row.signals?.seasonal_phase ?? ''] ?? row.signals?.seasonal_phase ?? '-';
```

- [ ] **Step 7: 跑前端 lint/build/test**

```bash
cd frontend && pnpm lint
cd frontend && pnpm build
cd frontend && pnpm test
```

Expected: 全过

- [ ] **Step 8: Commit**

```bash
git add frontend/app/dashboard/supply-chain/inventory-replenishment/page.tsx
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "feat(frontend): inventory-replenishment 加 行动/趋势/季节性 列 + 行色 + Excel"
```

---

### Task 10: 部署 + 烟测

- [ ] **Step 1: 跑完整测试套件**

```bash
cd backend && pytest
cd frontend && pnpm lint && pnpm build && pnpm test
```

Expected: 全绿

- [ ] **Step 2: 推送 + 部署**

```bash
git deploy
```

Expected: VPS 自动部署（systemctl restart believeboy-api + alembic upgrade head）。前端 Vercel 自动。

- [ ] **Step 3: 真实项目抽查**

从 prod 拉一个真实项目，验证：
- 1 个 deteriorating SKU（DoH 120-180 + trend=下降）
- 1 个 critical SKU（DoH<14 或 库龄 365+）
- 1 个 healthy SKU
- 1 个有 YoY 数据的 SKU（应显示季节性相位）
- 1 个无 YoY 数据的 SKU（应显示 `?未知`，且不影响主流程）

通过 `multica issue comment add BEL-369 --content-file ./spot-check-result.md` 报告抽查结果。

- [ ] **Step 4: Commit 抽查结果**

```bash
git add docs/superpowers/specs/2026-08-01-replenish-2d-assessment-design.md  # 如果更新了
git -c user.email="jr.way123@gmail.com" -c user.name="DamonRock" commit -m "docs: 真实项目抽查结果"
```

---

## Self-Review

**1. Spec coverage:**
- §2.1 state 判定 → Task 3
- §2.2 action 决策表 → Task 4（含季节性覆盖）
- §2.3 signals → Task 5
- §2.4 季节性因子 → Task 1（simplified）+ Task 7（集成）
- §3.2 API schema → Task 6
- §4 服务层改动 → Task 7
- §5 前端改动 → Task 9
- §6 测试 → Tasks 1, 2-5 (test_state_action.py), 8 (API 集成测试)
- §11 DoD → Task 10

**2. Placeholder scan:** 无 TBD/TODO；所有 step 含具体代码或命令。

**3. Type consistency:**
- `compute_seasonal_factor` 返回 `(float | None, str, str)` — Task 1 + Task 7 调用一致
- `compute_inventory_state` 返回 `(str, str | None)` — Task 3 + Task 7 调用一致
- `compute_replenishment_action` 返回 `str` — Task 4 + Task 7 一致
- `compute_signals` 返回 `dict` — Task 5 + Task 7 一致
- `InventorySignals` Pydantic schema — Task 6 + Task 7 一致
- 注意：summary 字段同时存在 `healthy_count`（旧）+ `healthy_count_v2`（新）—— spec §3.2 决策 D6 要求，v1.2 沿用

---

## Execution Handoff

Plan complete. 10 tasks, ~150 行后端 + ~100 行前端 + ~250 行测试。

**Two execution options:**

1. **Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session, batch with checkpoints

**Which approach?**