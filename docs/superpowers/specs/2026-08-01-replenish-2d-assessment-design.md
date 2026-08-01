# Replenish 二维评估（三段式：状态 + 行动 + 信号）设计文档

> v1 · 2026-08-01 · BEL-369
> 状态：方案 A（用户拍板），待实施
> 后续里程碑：C（预测式评估）独立 spec

## 1. 概述

把现有 replenish 评估体系从"单维度卖断货日期（`_classify_risk`）"升级到"**三段式：状态 + 行动 + 信号**"——三个独立产物各司其职，互不混在一个标签里。

### 1.1 核心变更

| 现有 | 升级后 |
|---|---|
| `risk_status` = 单字符串（"长期断货"/"短期断货"/"健康库存"/"滞销"...8 个值） | `inventory_state`（5 个互斥状态）+ `replenishment_action`（6 个互斥行动）+ `signals`（透明原始数据） |
| 判定只用 `risk_anchor_date - today`（单维度） | state 综合 DOH + dms_30 + 库龄；action 在 state 之上叠加 trend + 在途；signals 给运营完整证据 |
| `health_score.py` 5 轴 + 两层判定（已存在但未对外） | 复用 5 轴作为内部评分；对外只暴露三段式产物；内部评分仅用于 confidence / reason 排序 |

### 1.2 三个产物的边界

```
                   ┌──────────────────┐
                   │   5-axis assess  │  (内部，existing health_score.py)
                   └────────┬─────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
  inventory_state    replenishment_action      signals
  (判断维度)         (动作维度)                (透明度)
   5 状态             6 行动                    原始事实
   给前端标签         给运营/agent 决策         给排错/解释
```

- `inventory_state` 和 `replenishment_action` **解耦**——同一 state 可能推荐不同 action
- `signals` 不进判定，只进响应体供前端/外部 agent 消费

### 1.3 不在范围

- ❌ **不**改 `inventory_analysis_service.py`（inventory-analysis 页面）——它走 `recommended_action` 翻译不走 risk_status
- ❌ **不**改 seasonal_replenishment——按 A4 决策不判 risk；本次升级不动 seasonal
- ❌ **不**改前端 inventory-analysis 页面——它不是这次 review 的目标
- ❌ **不**改现有 5 轴评分代码（`health_score.py`）——只复用，不重构
- ✅ **改** `InventoryReplenishmentListItem` schema（加 3 个新字段族）
- ✅ **改** `list_inventory_replenishment_analysis` 服务函数（接入三段式）
- ✅ **改** 前端 `inventory-replenishment/page.tsx`（新列 + 颜色映射）

## 2. 详细设计

### 2.1 产物 1：`inventory_state`（5 个互斥状态）

**判定逻辑**（按顺序短路）：

| 优先级 | 条件 | state |
|---|---|---|
| P0 | `dms_30 is None` 或 (`available_qty = 0` 且 `dms_30 = 0` 且 `age_*` 全 0) | `unknown` ⚪ |
| P1 | `sellable_days < 14` | `critical` 🔴 |
| P2 | `14 ≤ sellable_days < 30 且 dms_30 > 0` | `critical` 🔴 |
| P3 | `age_365_plus_qty > 0` | `critical` 🔴 |
| P4 | `age_271_365_qty / total_age ≥ 0.50` | `critical` 🔴 |
| P5 | `age_181_270_qty / total_age ≥ 0.50` | `critical` 🔴 |
| P6 | `sellable_days > 180 且 dms_30 < 0.7` | `critical` 🔴 |
| P7 | `120 < sellable_days ≤ 180 且 dms_30 < 0.7` | `deteriorating` 🟠 |
| P8 | `trend_label == "下降明显" 且 (库龄 91+ 占 ≥30% 或 在途/可售 > 3)` | `deteriorating` 🟠 |
| P9 | `45 ≤ sellable_days ≤ 90 且 trend_label == "下降明显"` | `deteriorating` 🟠 |
| P10 | `30 ≤ sellable_days < 45 且 trend_label == "下降明显"` | `watch` 🟡 |
| P11 | `90 < sellable_days ≤ 180 且库龄正常` | `watch` 🟡 |
| P12 | `30 ≤ sellable_days ≤ 90 且库龄正常`（无 trend 恶化） | `healthy` 🟢 |
| P13 | 其余（doh 在 30-120 之间无恶化信号） | `healthy` 🟢 |

> **判定顺序关键**：P0→P13 顺序短路，**P1/P2 先于 P3/P4**——意思：即便库存老（库龄 365+），如果 DoH<30 且在卖，仍优先按"断货侧"判定为 critical（运营该补货，不是该清货）。P3/P4 是"没有断货压力"的兜底。
> P10（P10 单独成行）的原因是：DoH 30-45 是健康下沿，本身已属边缘；如果 trend 又在掉，归 `watch` 比 `healthy` 更安全——避免遗漏"刚好活着但在变差"的 SKU。

**threshold 常量**（集中在新建 `state_action.py`，不分散）：
```python
STATE_CRITICAL_DOH = 14               # < 14 立即 critical（断货风险）
STATE_CRITICAL_SHORTAGE_DOH = 30      # 14-30 但 dms_30>0 也是 critical（短路库龄判定）
STATE_OVERSTOCK_CRITICAL_DOH = 180
STATE_OVERSTOCK_DETERIORATE_DOH = 120
STATE_DETERIORATE_TREND_RATIO = 0.7   # dms_7/dms_30 < 0.7 才算"下降明显"
STATE_WATCH_DOH_MIN = 30
STATE_WATCH_DOH_MAX = 90              # 90 < x ≤ 180 也归 watch（除非有 critical 信号）
```

**保留现有 emoji**（向后兼容——前端 risk_status 列可继续显示 🔴🟠🟡🟢⚪）：
```python
STATE_EMOJI = {
    "critical":     "🔴",
    "deteriorating":"🟠",
    "watch":        "🟡",
    "healthy":      "🟢",
    "unknown":      "⚪",
}
```

### 2.2 产物 2：`replenishment_action`（6 个互斥行动）

**判定顺序关键**：先算 `trend_label`（`_score_trend`），再算 `inventory_state`（用 trend_label + DoH + 库龄），最后算 `replenishment_action`（用 state + trend_label + transit_ratio）。三者**严格分阶段**，不存在"用 action 反过来影响 state"的循环。

`trend_label` 复用现有 `_score_trend` 的 4 档语义：`上升 (>=1.5)` / `稳定 (0.9-1.5)` / `轻微下降 (0.7-0.9)` / `下降明显 (<0.7)`。`replenishment_action` 决策表里 `trend_label` 取这 4 个值的简化二分：**上升 | 稳定/上升 | 下降**（"上升"与"稳定"归一类——都属于"该补的判断不变"；"轻微下降"+"下降明显"归"下降"类——都属于"该降价的判断不变"，二者力度不同由 signals.trend_momentum 区分）。

**decision table 命中规则**（行匹配：第一行命中即返回；表按优先级排序）：

| # | state | trend_label | 在途/可售 | action |
|---|---|---|---|---|
| 1 | `critical` (DoH<14) | 任意 | 任意 | `REPLENISH_NOW` |
| 2 | `critical` (库龄 365+) | 任意 | 任意 | `REMOVE` |
| 3 | `critical` (DoH>120 慢销) | 下降 | 任意 | `REDUCE_PRICE` |
| 4 | `critical` (DoH>120 慢销) | 稳定/上升 | > 3 | `REDUCE_PRICE` |
| 5 | `critical` (DoH>120 慢销) | 稳定/上升 | ≤ 3 | `HOLD` |
| 6 | `critical` (DoH 14-30 在卖) | 上升 | 任意 | `REPLENISH_NORMAL` |
| 7 | `critical` (DoH 14-30 在卖) | 下降 | 任意 | `HOLD` |
| 8 | `deteriorating` | 下降 | 任意 | `REDUCE_PRICE` |
| 9 | `deteriorating` | 稳定/上升 | 任意 | `HOLD` |
| 10 | `watch` | 任意 | 任意 | `NO_ACTION` |
| 11 | `healthy` | 任意 | 任意 | `NO_ACTION` |
| 12 | `unknown` | 任意 | 任意 | `NO_ACTION` |

> **critical 行细分**：critical 由多种条件触发（P1 断货 / P2 14-30 在卖 / P3-P5 库龄 / P6 死货），不同 critical 触发不同 action。表里用 `state + (DoH/库龄细化) + trend_label + 在途` 区分。代码层用 `compute_critical_subtype()` 辅助函数返回 `'shortage' | 'aging' | 'overstock'` 三个子类型，再查表——避免决策表行过多。

**action 枚举**：
```python
class ReplenishmentAction(str, Enum):
    REPLENISH_NOW = "REPLENISH_NOW"      # 紧急补货（DoH<14）
    REPLENISH_NORMAL = "REPLENISH_NORMAL" # 按计划补货
    HOLD = "HOLD"                         # 暂停补货，观察
    REDUCE_PRICE = "REDUCE_PRICE"        # 降价清货
    REMOVE = "REMOVE"                    # 创建移除订单
    NO_ACTION = "NO_ACTION"              # 不动
```

**为什么不要 `REPLENISH_HALF`**（用户问）：YAGNI。当前 6 个行动已覆盖运营实际触发的所有操作；"补一半货"等于"REPLENISH_NORMAL 但 estimated_replenishment_quantity 减半"——这是 quantity 层面的调整，不是 action 层面的扩展。**V2 视情况再加**。

### 2.3 产物 3：`signals`（原始事实，供前端/agent 消费）

不进判定，作为响应体里的独立字段：

```python
class InventorySignals(BaseModel):
    sellable_days: float | None
    dms_3: float | None
    dms_7: float | None
    dms_14: float | None
    dms_30: float | None
    trend_ratio_7_30: float | None   # dms_7 / dms_30
    trend_ratio_3_7: float | None    # 短期抖动
    trend_label: str | None          # "上升" | "稳定" | "下降明显"
    trend_momentum: str | None       # "accelerating" | "decelerating" | "stable"
    aging_share: dict[str, float]    # {"0_90": 0.7, "91_180": 0.2, ...}
    transit_ratio: float | None      # 在途/可售
    data_freshness_days: int         # 快照距今天数
    confidence: str                  # "high" | "medium" | "low"
```

**`trend_momentum` 算法**（用户问题 3 拍板：用双比值差）：
```python
momentum = "stable"
if dms_7 and dms_14 and dms_30 and dms_30 > 0:
    recent = dms_7 / dms_30      # 周环比
    earlier = dms_14 / dms_30    # 月环比
    delta = recent - earlier
    if delta < -0.1: momentum = "accelerating"     # 趋势在恶化（短期比长期还差）
    elif delta > 0.1: momentum = "decelerating"   # 趋势在回稳
    # 否则 stable
```

**`confidence` 算法**：
- `high`: dms_30 存在 + 库龄分档齐全 + 快照 ≤ 1 天
- `medium`: dms_30 存在但库龄缺失一项 / 快照 2-3 天
- `low`: dms_30 缺失 / 快照 > 3 天 / 大量数据缺失

## 3. 数据库与 Schema

### 3.1 不改数据库

本次升级纯计算层变更，不涉及任何表结构改动。

### 3.2 API Schema 变更（`InventoryReplenishmentListItem`）

**保留**字段（向后兼容，前端不破）：
- `risk_status`: 改为 `STATE_EMOJI[state]`，字符串内容不变（"🔴"/"🟠"/"🟡"/"🟢"/"⚪"）

**新增**字段族：

```python
class InventoryReplenishmentListItem(BaseModel):
    # ... 现有字段保留 ...
    risk_status: str  # 改为 emoji（state → emoji 映射），内容兼容

    # NEW: 判断维度
    inventory_state: str  # "critical" | "deteriorating" | "watch" | "healthy" | "unknown"

    # NEW: 动作维度
    replenishment_action: str  # ReplenishmentAction 枚举值

    # NEW: 透明度
    signals: InventorySignals | None  # 嵌套对象，None 表示完全无数据
```

**summary 影响**：`InventoryReplenishmentSummary` 增加按 state 分布的字段：

```python
class InventoryReplenishmentSummary(BaseModel):
    sku_count: int
    # ... 现有字段保留（向后兼容，旧的 risk 计数用新 state 重算） ...
    critical_count: int      # 新
    deteriorating_count: int # 新
    watch_count: int         # 新
    healthy_count: int       # 新
    unknown_count: int       # 新

    # 旧字段映射（保留，向后兼容）：
    # out_of_stock_risk_count = critical_count
    # healthy_count = healthy_count
    # slow_moving_count = critical_count (库龄 365+)  -- 旧的逻辑
```

**summary 字段映射策略**：保留旧的 `out_of_stock_risk_count` / `healthy_count` / `slow_moving_count` / `pending_data_count` 4 个字段，但值按新 state 重算：

- `out_of_stock_risk_count` = critical_count 中 `critical_subtype == 'shortage'` 的 SKU 数（保持"未补货会断"的语义）
- `healthy_count` = healthy_count
- `slow_moving_count` = critical_count 中 `critical_subtype == 'overstock'` 或 `critical_subtype == 'aging'` 的 SKU 数（保持"老化清货"语义）
- `pending_data_count` = unknown_count

这样外部 BI / dashboard 不会破。

## 4. 服务层改动

### 4.1 `list_inventory_replenishment_analysis`（`backend/app/services/inventory/replenishment.py:908`）

**新增内层函数**（全部放新建模块 `state_action.py`，replenishment.py 只负责调用）：

```python
# backend/app/services/inventory/state_action.py

def compute_trend_label(dms_7, dms_30) -> str:
    """复用 health_score._score_trend 语义，返回 上升/稳定/轻微下降/下降明显 之一。"""
    ...

def compute_inventory_state(item: ItemInput, trend_label: str) -> tuple[str, str | None]:
    """返回 (state, critical_subtype_or_None)。critical_subtype 仅当 state=='critical' 时返回 'shortage'|'aging'|'overstock'，其他返回 None。"""
    ...

def compute_replenishment_action(
    state: str, critical_subtype: str | None, trend_label: str, transit_ratio: float
) -> str:
    """返回 ReplenishmentAction 枚举值。"""
    ...

def compute_signals(item: ItemInput, trend_label: str, trend_momentum: str,
                    snapshot_age_days: int) -> InventorySignals:
    """返回 InventorySignals dataclass / schema。"""
    ...

def compute_trend_momentum(dms_7, dms_14, dms_30) -> str:
    """双比值差算法：accelerating / decelerating / stable。"""
    ...
```

**主函数改动**：在每个 SKU row 拼装时（line ~1100），调用上面 3 个函数，把结果塞进 `InventoryReplenishmentListItem`。

**`_classify_risk` 不删除**：保留供 summary 统计的旧字段映射使用（兼容）。

### 4.2 内部 `health_score.py`（不改）

`assess()` 函数维持现状——内部评分继续算（0-100 + breakdown）但不进响应体，只用于：
- `_build_signals` 时计算 confidence（基于 breakdown 各项是否齐全）
- 测试覆盖（既有 14 个 health_score 测试保留）

**不暴露 health_score 到 API**——用户没要求看 0-100 数字，YAGNI。

### 4.3 新建模块 `backend/app/services/inventory/state_action.py`

把三段式判定逻辑独立成模块，便于测试和未来切换算法：

```python
# backend/app/services/inventory/state_action.py
"""
inventory_state + replenishment_action 判定逻辑。

输入：ItemInput（与 health_score.ItemInput 复用）+ trend_label + transit_ratio
输出：(inventory_state, replenishment_action, signals_dict)
"""
```

**好处**：
- 与 health_score.py 解耦——health_score 是 5 轴评分，state_action 是判定层
- 后续 C（预测式）方案可复用 `inventory_state` 函数
- 测试独立——state_action_test.py 单独维护 case

## 5. 前端改动

### 5.1 `frontend/app/dashboard/supply-chain/inventory-replenishment/page.tsx`

**改动 1：列定义**
- 保留"风险状态"列（key=`risk_status`），语义不变（显示 emoji）
- **新增**"行动"列（key=`replenishment_action`）：显示 `REPLENISH_NOW` / `REDUCE_PRICE` / `HOLD` 等，带颜色映射
- **新增**"趋势"列（key=`signals.trend_momentum`）：显示 `↑加速上升` / `↑稳定` / `↓加速下降` / `↓减速下降` / `→平稳`
- 表格默认列宽调整：风险状态 -2，行动 +10，趋势 +10

**改动 2：行背景色（按 action 主导，state 辅助）**
- `REPLENISH_NOW` / `REMOVE`: 红底
- `REDUCE_PRICE`: 橙底
- `HOLD`: 橙底（"暂停"也是要关注的）
- `REPLENISH_NORMAL`: 默认白底
- `NO_ACTION`: 默认白底
- 额外装饰（与背景色可叠加）：`inventory_state == deteriorating` 的行加左侧边框轮廓（橙色）

**改动 3：Excel 导出**
- 增加 2 列：`行动`、`趋势`
- summary 行的 critical_count / deteriorating_count 单独统计

### 5.2 不改

- `inventory-analysis` 页面（`frontend/app/dashboard/operations/inventory-analysis/page.tsx`）
- `inventory-ledger` 页面
- `seasonal-replenishment` 页面
- `weekly-product-analysis` 等其它供应链页面

## 6. 测试策略

### 6.1 单元测试

**新增** `backend/tests/services/inventory/test_state_action.py`：

- `test_state_critical_doh_below_14` —— 各种 critical 触发
- `test_state_deteriorating_doh_in_120_180` —— 即将严重滞销
- `test_state_deteriorating_with_declining_trend` —— trend + 库龄组合
- `test_state_watch_doh_in_30_45_with_declining_trend` —— DoH 边缘 + trend 下降归 watch（不是 healthy）
- `test_state_healthy_default`
- `test_state_unknown_dms_30_missing`
- `test_action_replenish_now_for_doh_below_14`
- `test_action_remove_for_aging_365_plus`
- `test_action_reduce_price_for_deteriorating_with_declining_trend`
- `test_action_hold_for_deteriorating_with_stable_trend`
- `test_action_no_action_for_healthy_watch_unknown`
- `test_signals_trend_momentum_accelerating` —— 双比值差 < -0.1
- `test_signals_trend_momentum_decelerating` —— 双比值差 > 0.1
- `test_signals_confidence_high` —— 数据齐全 + 快照新
- `test_signals_confidence_low` —— dms_30 缺失

**保留**既有 `test_health_score.py` 14 个测试（不动）。

### 6.2 API 集成测试

**新增** `backend/tests/api/v1/inventory_replenishment/test_three_segment.py`：

- `test_external_endpoint_returns_state_action_signals` —— 验证响应 schema 含 3 个新字段族
- `test_filter_by_inventory_state_critical` —— `?inventory_state=critical` 只返回 critical 的 SKU
- `test_filter_by_replenishment_action_replenish_now` —— `?action=REPLENISH_NOW` 只返回紧急补货的 SKU
- `test_summary_counts_match_new_states` —— summary 计数正确

### 6.3 前端测试

- 表格列定义测试（vitest 单元）
- 行背景色渲染测试（testing-library）
- Excel 导出多 sheet 测试（已有 vitest 模式）

### 6.4 烟测

- `pnpm lint`、`pnpm build`、`pnpm test`（前端）
- `cd backend && pytest`（后端）
- 部署后从 prod 拉一个真实 SKU，看新字段是否合理

## 7. 迁移与回退

### 7.1 数据库迁移

无（纯计算层变更）。

### 7.2 部署步骤

1. **后端**：改 `replenishment.py` / `state_action.py` / `inventory_replenishment.py`（schemas） / `replenishment_analysis.py`（外 API） → 单测全绿 → `pytest tests/api` → `git deploy` 推送
2. **前端**：改 `inventory-replenishment/page.tsx` → `pnpm test` → `pnpm build` → 推 main（Vercel 自动部署）
3. **顺序**：先后端再前端。后端先支持新字段但前端未消费前，对用户无感；前端部署后即时显示新列。

### 7.3 回退方案

- **回退条件**：新字段上线后某项目 critical_count 突变 > 50% 或前端报错率上升
- **回退操作**：
  - 后端：用 feature flag 控制是否返回 `inventory_state` 字段（`?legacy_risk=true` 走旧 `_classify_risk`）
  - 前端：移除"行动"/"趋势"列，回退到只显示 `risk_status` emoji
- **回退时间**：1 个工作日内完成（不涉及数据库）

## 8. 影响面汇总

| 范围 | 改动文件 | 改动量 |
|---|---|---|
| 后端服务 | `state_action.py`（新建）+ `replenishment.py`（增函数） | ~150 行新增 |
| 后端 schema | `inventory_replenishment.py`（加字段） | ~30 行 |
| 后端 API | `replenishment_analysis.py`（无改动，schema 自动） + `inventory_replenishment.py` 内部端点 | 0 行（schema 透传） |
| 后端测试 | `test_state_action.py`（新建）+ `test_three_segment.py`（新建） | ~250 行新增 |
| 前端页面 | `inventory-replenishment/page.tsx`（加 2 列 + 行色 + Excel） | ~80 行 |
| 前端 schema 类型 | `api-generated/api.d.ts`（regen） | 自动 |
| 数据库 | 无 | 0 |
| 现有单测 | `test_health_score.py`（保留不动） | 0 |
| 库存分析页面 | 不动 | 0 |
| Seasonal replenishment | 不动 | 0 |

## 9. 关键决策记录

| # | 决策 | 理由 |
|---|---|------|
| D1 | 三段式产物而非统一字段 | state/action/signals 各有消费者，分开比混在一起清晰 |
| D2 | `inventory_state` 5 个值含 deteriorating | 用户核心诉求——捕获"现在正常但在变差" |
| D3 | action 解耦 state | 同一 state 不同 trend 推荐不同 action（避免映射表冗长） |
| D4 | signals 永远进响应体（不空缺） | 即便数据全缺也返回 `confidence: low` + 全部 None，外部 agent 能消费 |
| D5 | 复用 health_score.py 的 ItemInput | 不重复定义 dataclass |
| D6 | summary 字段新旧兼容 | 旧 BI / dashboard 不破 |
| D7 | 不改 health_score.py | 5 轴评分内部继续算但不进 API；YAGNI |
| D8 | 不动 seasonal | A4 决策不判 risk；保持不变 |
| D9 | trend_momentum 用双比值差 | 比 dms_3/dms_7 噪声小，比单比值稳定 |
| D10 | 不加 REPLENISH_HALF | YAGNI；half-quantity 是 quantity 调整不是 action 扩展 |
| D11 | 前端加 Excel 列扩展 | 已有 vitest 模式，无需新基建 |

## 10. 后续（不本 spec 范围）

- **思路 C：预测式评估**（BEL-369 milestone 2）——独立 spec。复用本 spec 的 `inventory_state` 函数算每日 projected_state，输出轨迹。
- **思路 B：Profitability-Weighted**——独立 spec。需先验证 product_costs / listing 生命周期数据完整度。
- **现有 5 轴评分移除**（V3）——如果三段式运行稳定且 `health_score` 5 轴评分确认无消费者，可移除 `health_score.py` 节省维护成本。

## 11. 验收标准（Definition of Done）

- [ ] `test_state_action.py` 13 个测试全绿
- [ ] `test_three_segment.py` 4 个测试全绿
- [ ] `test_health_score.py` 既有 14 个测试保留全绿
- [ ] 外部 API `/api/v1/external/projects/{id}/replenishment-analysis` 响应包含 `inventory_state` / `replenishment_action` / `signals` 3 个新字段族
- [ ] 内部 API `/api/v1/inventory-replenishment` 同上
- [ ] summary `critical_count` / `deteriorating_count` / `watch_count` / `healthy_count` / `unknown_count` 数字正确（手动抽查 5 个项目）
- [ ] 前端 `inventory-replenishment` 页面新增"行动"列 + "趋势"列，行色按 action 渲染
- [ ] Excel 导出新增 2 列
- [ ] pnpm lint / pnpm build / pnpm test 全过
- [ ] 部署后真实项目抽查：1 个 deteriorating SKU、1 个 critical SKU、1 个 healthy SKU 验证显示正确
- [ ] `git deploy` 推送命中 `backend/` 触发 VPS 自动部署（前端 Vercel 自动）