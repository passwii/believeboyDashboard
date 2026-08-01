# Replenish 二维评估（三段式：状态 + 行动 + 信号）设计文档

> v1.2 · 2026-08-01 · BEL-369
> 状态：方案 A（用户拍板）+ 季节性因子（v1.2 简化版），待实施
> 后续里程碑：C（预测式评估）独立 spec

## 0. v1.0 → v1.1 → v1.2 变更记录

**v1.1 → v1.2（本次）：季节性 fallback 简化**
- v1.1 设计三层 fallback：SKU YoY → 项目级平均 → neutral
- v1.2 简化两层：**SKU YoY → 跳过**（大部分项目店铺没 YoY 数据，与其用项目平均污染判断，不如直接忽略季节性）
- 移除：`project_seasonal_avg` 中位数计算 + 24h 缓存逻辑、_compute_project_seasonal_avg 函数、test_seasonal_factor.py 中所有 project_avg 相关 case
- 影响面：从 v1.1 的 ~230 行后端减到 ~150 行后端；测试从 ~400 行减到 ~250 行

**v1.0 → v1.1（已 commit `9bb1dd37`）**
- 新增"季节性因子（seasonal_factor）"——基于 YoY DMS 数据**自动**计算每个 SKU 当前的旺季/淡季相位，**无需人工配置月度销售趋势**。
- 范围调整：seasonal_replenishment 仍**不在本次改造内**（不动 seasonal endpoint），但**复用其已有的 YoY DMS 数据**给本 spec 用。

## 1. 概述

把现有 replenish 评估体系从"单维度卖断货日期（`_classify_risk`）"升级到"**三段式：状态 + 行动 + 信号**"——三个独立产物各司其职，互不混在一个标签里。

### 1.1 核心变更

| 现有 | 升级后 |
|---|---|
| `risk_status` = 单字符串（"长期断货"/"短期断货"/"健康库存"/"滞销"...8 个值） | `inventory_state`（5 个互斥状态）+ `replenishment_action`（6 个互斥行动）+ `signals`（透明原始数据，含季节性因子） |
| 判定只用 `risk_anchor_date - today`（单维度） | state 综合 DOH + dms_30 + 库龄 + **季节性因子**；action 在 state 之上叠加 trend + 在途 + **季节性相位** |
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
- ❌ **不**改 seasonal_replenishment endpoint / 季节性补货页面——A4 决策不判 risk；本次升级**不动 seasonal** 的 endpoint 和页面
- ✅ **但** seasonal_replenishment 已有的 YoY DMS 数据 (`dms_30_yoy` / `dms_7_yoy` / ...) **可复用**——本次新建 `seasonal_factor.py` 直接消费这些字段，**不需要新增数据源**。
- ❌ **不**改前端 inventory-analysis 页面——它不是这次 review 的目标
- ❌ **不**改现有 5 轴评分代码（`health_score.py`）——只复用，不重构
- ✅ **改** `InventoryReplenishmentListItem` schema（加 3 个新字段族 + 季节性 3 个字段）
- ✅ **改** `list_inventory_replenishment_analysis` 服务函数（接入三段式 + 季节性）
- ✅ **改** 前端 `inventory-replenishment/page.tsx`（新列 + 颜色映射 + 季节性提示）

## 2. 详细设计

### 2.1 产物 1：`inventory_state`（5 个互斥状态）

**判定逻辑**（按顺序短路）。表中 `sellable_days` 字样均为 **seasonal-adjusted sellable_days**（见 §2.4）——即 `sellable_days / seasonal_factor`。原始 sellable_days 保留在 `signals.sellable_days` 供对照。

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

**判定顺序关键**：先算 `trend_label`（`_score_trend`）和 `seasonal_factor`（§2.4），再算 `inventory_state`（用 trend_label + 季节性调整后的 DoH + 库龄），最后算 `replenishment_action`（用 state + trend_label + transit_ratio + seasonal_phase）。三者**严格分阶段**，不存在"用 action 反过来影响 state"的循环。

`trend_label` 复用现有 `_score_trend` 的 4 档语义：`上升 (>=1.5)` / `稳定 (0.9-1.5)` / `轻微下降 (0.7-0.9)` / `下降明显 (<0.7)`。`replenishment_action` 决策表里 `trend_label` 取这 4 个值的简化二分：**上升 | 稳定/上升 | 下降**（"上升"与"稳定"归一类——都属于"该补的判断不变"；"轻微下降"+"下降明显"归"下降"类——都属于"该降价的判断不变"，二者力度不同由 signals.trend_momentum 区分）。

`seasonal_phase` 在决策表里取 5 档语义：`peak` / `rising` / `neutral` / `falling` / `trough` / `unknown`。**重要**：`rising`/`peak` 强化补货；`falling`/`trough` 抑制补货（避免在淡季初误判为恶化）。

**decision table 命中规则**（行匹配：第一行命中即返回；表按优先级排序）：

| # | state | trend_label | 在途/可售 | seasonal_phase | action |
|---|---|---|---|---|---|
| 1 | `critical` (DoH<14) | 任意 | 任意 | peak/rising | `REPLENISH_NOW` + 旺季标记 |
| 2 | `critical` (DoH<14) | 任意 | 任意 | 其它 | `REPLENISH_NOW` |
| 3 | `critical` (库龄 365+) | 任意 | 任意 | 任意 | `REMOVE` |
| 4 | `critical` (DoH>120 慢销) | 下降 | 任意 | 任意 | `REDUCE_PRICE` |
| 5 | `critical` (DoH>120 慢销) | 稳定/上升 | > 3 | 任意 | `REDUCE_PRICE` |
| 6 | `critical` (DoH>120 慢销) | 稳定/上升 | ≤ 3 | falling/trough | `HOLD` （可能是淡季引发的存量上升） |
| 7 | `critical` (DoH>120 慢销) | 稳定/上升 | ≤ 3 | 其它 | `HOLD` |
| 8 | `critical` (DoH 14-30 在卖) | 上升 | 任意 | peak/rising | `REPLENISH_NORMAL` + 旺季加注 |
| 9 | `critical` (DoH 14-30 在卖) | 上升 | 任意 | 其它 | `REPLENISH_NORMAL` |
| 10 | `critical` (DoH 14-30 在卖) | 下降 | 任意 | peak/rising | `REPLENISH_NORMAL` （旺季"下降"可能是补货跟进问题，不是需求弱化） |
| 11 | `critical` (DoH 14-30 在卖) | 下降 | 任意 | 其它 | `HOLD` |
| 12 | `deteriorating` | 下降 | 任意 | falling/trough | `HOLD` （可能是淡季引发的趋势下降，不是真恶化） |
| 13 | `deteriorating` | 下降 | 任意 | 其它 | `REDUCE_PRICE` |
| 14 | `deteriorating` | 稳定/上升 | 任意 | 任意 | `HOLD` |
| 15 | `watch` | 任意 | 任意 | 任意 | `NO_ACTION` |
| 16 | `healthy` | 任意 | 任意 | 任意 | `NO_ACTION` |
| 17 | `unknown` | 任意 | 任意 | 任意 | `NO_ACTION` |

> **critical 行细分**：critical 由多种条件触发（P1 断货 / P2 14-30 在卖 / P3-P5 库龄 / P6 死货），不同 critical 触发不同 action。表里用 `state + (DoH/库龄细化) + trend_label + 在途 + seasonal_phase` 区分。代码层用 `compute_critical_subtype()` 辅助函数返回 `'shortage' | 'aging' | 'overstock'` 三个子类型，再查表——避免决策表行过多。
> **季节性覆盖说明**：
> - `peak/rising` 场景下 `critical (DoH<14)` → 补货量上浮 30%（旺季断货损失远大于补货成本），标记 `_urgent: True` 进 signals。
> - `falling/trough` 场景下 `deteriorating + 下降` → 不去 REDUCE_PRICE，避免误杀（可能是季节性回落而非真恶化）。

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
    trend_label: str | None          # "上升" | "稳定" | "轻微下降" | "下降明显"
    trend_momentum: str | None       # "accelerating" | "decelerating" | "stable"
    aging_share: dict[str, float]    # {"0_90": 0.7, "91_180": 0.2, ...}
    transit_ratio: float | None      # 在途/可售
    data_freshness_days: int         # 快照距今天数
    confidence: str                  # "high" | "medium" | "low"
    # NEW v1.1: 季节性因子（见 §2.4）
    seasonal_factor: float | None    # YoY 比值；1.0=常态，>1=旺季，<1=淡季
    seasonal_phase: str | None       # "peak" | "rising" | "neutral" | "falling" | "trough" | "unknown"
    seasonal_source: str | None      # "sku_yoy" | "project_avg" | "neutral"
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

### 2.4 季节性因子（v1.1 新增）——全自动，无人工配置

**核心问题**：Amazon 销售有季节性（Prime Day / 圣诞 / 夏季户外 / 节庆礼品等）。同一个 DoH=30 在 7 月（旺季）比在 2 月（淡季）危险得多——因为旺季 dms 会更高，库存消耗更快。

**但用户明确说不想手动指定月度销售趋势**——所以必须是**系统化自动**检测。

**v1.2 简化原则**：
- 现实里**大部分项目店铺没 YoY 数据**（新店铺 / 数据历史太短 / 跨境初期）——v1.1 设计的"项目级平均 fallback"在这种情况下被频繁触发，但项目平均会把老店铺 + 新店铺混在一起污染判断
- **v1.2 简化**：没 SKU YoY 就**直接忽略季节性**（不做 fallback），signals.seasonal_phase = "unknown"
- 每个 SKU 自己的"季节性基线"——基于 YoY 数据自动学，不需要任何人工标注
- 不要 fallback 到项目级平均——避免污染；要么 SKU 自己有数据，要么不调整

#### 2.4.1 seasonal_factor 算法（v1.2 两层）

```python
def compute_seasonal_factor(
    dms_30: float | None,
    dms_7: float | None,
    dms_30_yoy: float | None,
    dms_7_yoy: float | None,
) -> tuple[float | None, str]:
    """返回 (seasonal_factor, source)。
    source ∈ {"sku_yoy", "neutral"}。
    """

    # 路线 1: SKU 自己的 YoY 比值
    ratios = []
    if dms_30 and dms_30_yoy and dms_30_yoy > 0:
        ratios.append(dms_30 / dms_30_yoy)
    if dms_7 and dms_7_yoy and dms_7_yoy > 0:
        ratios.append(dms_7 / dms_7_yoy)

    if ratios:
        factor = sum(ratios) / len(ratios)
        # clamp 避免极端值
        factor = max(0.3, min(3.0, factor))
        return (factor, "sku_yoy")

    # 路线 2: 没 YoY 数据 → 跳过季节性调整（v1.2 决策）
    return (None, "neutral")
```

**为什么取 dms_30_yoy 和 dms_7_yoy 两个**：30D 是稳定基线，7D 是近期抖动——两个综合可以过滤单窗口噪声。如果只有一个窗口有值，用单个。

**v1.2 移除 v1.1 的项目级平均**：理由
- 大部分项目没 YoY，项目级平均会被频繁触发
- 项目平均污染严重——老店铺旺季信号会误推到新店铺上
- 不做 fallback 更简单：要么有数据就用，要么不用
- 运营看到的"季节性"是 SKU 自己真正的相位，不被项目平均干扰

#### 2.4.2 seasonal_phase 划分

```python
SEASONAL_PHASE_THRESHOLDS = {
    "peak":    1.3,   # factor > 1.3 → 旺季（同期销量比去年高 30%+）
    "rising":  1.1,   # 1.1 < factor ≤ 1.3 → 向旺季走
    "neutral": 0.9,   # 0.9 ≤ factor ≤ 1.1 → 常态
    "falling": 0.7,   # 0.7 ≤ factor < 0.9 → 向淡季走
    "trough":  None,  # factor < 0.7 → 淡季
}
# factor=None → "unknown"
```

#### 2.4.3 如何应用到判定

**state 判定**：用 **seasonal-adjusted sellable_days**（以下简写 `adjusted_sellable_days`）替代原始 `sellable_days`：

```python
adjusted_sellable_days = sellable_days / seasonal_factor  # factor=1.3 → 缩水 23%
# factor=None → adjusted = sellable_days（原值）
```

判定表 §2.1 中所有 `sellable_days` 字样替换为 `adjusted_sellable_days`。原始 `sellable_days` 仍保留在 `signals` 里供运营对照。

**action 判定**：用 `seasonal_phase` 作为辅助信号加进决策表（详见 §2.2）——旺季断货比淡季更急，淡季的"销量下降"不一定是真恶化（可能是季节性回落）。

**未调整状态判定**（seasonal_phase = "unknown" 时）：
- state 判定走原 sellable_days，不被季节性影响
- action 决策表查 "其它" 行（peak/rising 之外的行）
- signals.seasonal_phase = "unknown"、seasonal_factor = None、seasonal_source = "neutral"

#### 2.4.4 为什么不需要人配置月度趋势

- YoY 数据已经在 seasonal_replenishment 端点算过（`dms_30_yoy` 等），**直接复用**，不增加新计算
- 没有"月度销售趋势表""淡旺季日历表"任何人工输入——**纯数据驱动**
- 没 YoY 数据的项目（多数）直接跳过季节性——不影响主流程
- 没有"月度销售趋势表""淡旺季日历表"任何人工输入——**纯数据驱动**

#### 2.4.5 边界 case 与处理

| 情况 | factor | phase | confidence | 状态判定调整 |
|---|---|---|---|---|
| SKU 有 dms_30_yoy 和 dms_7_yoy | `avg(2 个比值)` | 按阈值定 | high | 走 adjusted_sellable_days |
| 只有 dms_30_yoy（无 dms_7_yoy）| 单个比值 | 按阈值定 | medium | 走 adjusted_sellable_days |
| 只有 dms_7_yoy（无 dms_30_yoy）| 单个比值 | 按阈值定 | medium | 走 adjusted_sellable_days |
| 新 SKU（< 12 月历史）| None | "unknown" | low | **不调整**（v1.2 简化）|
| 新项目（无任何 SKU 有 YoY）| None | "unknown" | low | **不调整**（v1.2 简化）|
| dms_30_yoy=0（去年此时也不卖）| None → neutral | "unknown" | low | 不调整 |
| factor > 3（极旺）| clamp 到 3.0 | "peak" | high | 走 adjusted_sellable_days |
| factor < 0.3（极淡）| clamp 到 0.3 | "trough" | high | 走 adjusted_sellable_days |
| factor=0 或负 | 视为异常 → None | "unknown" | low | 不调整 |

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

def compute_seasonal_adjusted_sellable_days(
    sellable_days: float | None,
    seasonal_factor: float | None,
) -> float | None:
    """sellable_days / seasonal_factor；factor=None 返原值。"""
    ...

def compute_inventory_state(item: ItemInput, trend_label: str, adjusted_sellable_days: float | None) -> tuple[str, str | None]:
    """返回 (state, critical_subtype_or_None)。critical_subtype 仅当 state=='critical' 时返回 'shortage'|'aging'|'overstock'，其他返回 None。"""
    ...

def compute_replenishment_action(
    state: str, critical_subtype: str | None, trend_label: str, transit_ratio: float,
    seasonal_phase: str | None,
) -> str:
    """返回 ReplenishmentAction 枚举值。"""
    ...

def compute_signals(item: ItemInput, trend_label: str, trend_momentum: str,
                    snapshot_age_days: int, seasonal_factor: float | None,
                    seasonal_phase: str | None, seasonal_source: str | None) -> InventorySignals:
    """返回 InventorySignals dataclass / schema。"""
    ...

def compute_trend_momentum(dms_7, dms_14, dms_30) -> str:
    """双比值差算法：accelerating / decelerating / stable。"""
    ...
```

**主函数改动**：在每个 SKU row 拼装时（line ~1100），按顺序调用：
1. `seasonal_factor.compute_seasonal_factor()` （§4.4）→ seasonal_factor + source
2. `state_action.compute_seasonal_adjusted_sellable_days()` → adjusted_sellable_days
3. `state_action.compute_trend_label()` + `compute_inventory_state()` → state + critical_subtype
4. `state_action.compute_replenishment_action()` → action
5. `state_action.compute_signals()` → InventorySignals

**SQL 改动**：replenishment.py 主函数多查 1 个 `_load_seasonal_dms_map`（复用 seasonal_replenishment 已有的 SQL，见 §4.4）。

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

输入：ItemInput（与 health_score.ItemInput 复用）+ trend_label + transit_ratio + seasonal_phase
输出：(inventory_state, replenishment_action, signals_dict)
"""
```

**好处**：
- 与 health_score.py 解耦——health_score 是 5 轴评分，state_action 是判定层
- 后续 C（预测式）方案可复用 `inventory_state` 函数
- 测试独立——state_action_test.py 单独维护 case

### 4.4 新建模块 `backend/app/services/inventory/seasonal_factor.py`（v1.1 新增）

独立的季节性因子计算模块。**复用** seasonal_replenishment 已有的 `_load_seasonal_dms_map` SQL（不重写），再加项目级平均缓存。

```python
# backend/app/services/inventory/seasonal_factor.py
"""
季节性因子计算。系统化、不需人工配置。
v1.2 简化：只支持 SKU 自己的 YoY 路线，没数据则跳过。

输入：dms_30 / dms_7 / dms_30_yoy / dms_7_yoy (单 SKU)
输出：(seasonal_factor, seasonal_phase, source)
source ∈ {"sku_yoy", "neutral"}

依赖：
- _load_seasonal_dms_map 已有（replenishment.py 内，复用）
"""

SEASONAL_PHASE_THRESHOLDS = {
    "peak": 1.3,
    "rising": 1.1,
    "neutral_low": 0.9,
    "falling": 0.7,
}

def compute_seasonal_factor(
    dms_30, dms_7, dms_30_yoy, dms_7_yoy,
) -> tuple[float | None, str, str]:
    """返回 (factor, phase, source)。
    v1.2 简化：仅 SKU YoY 路线，没数据返 (None, 'unknown', 'neutral')。
    """
    ...
```

**简化优势（v1.2）**：
- 不需要额外的 SQL 查询（项目级平均需要查所有 SKU）
- 不需要缓存层（24h 缓存逻辑 + 失效）
- 没有项目级污染问题（老店铺 + 新店铺混在一起）
- 代码量减少 ~30%，测试减少 ~40%

## 5. 前端改动

### 5.1 `frontend/app/dashboard/supply-chain/inventory-replenishment/page.tsx`

**改动 1：列定义**
- 保留"风险状态"列（key=`risk_status`），语义不变（显示 emoji）
- **新增**"行动"列（key=`replenishment_action`）：显示 `REPLENISH_NOW` / `REDUCE_PRICE` / `HOLD` 等，带颜色映射
- **新增**"趋势"列（key=`signals.trend_momentum`）：显示 `↑加速上升` / `↑稳定` / `↓加速下降` / `↓减速下降` / `→平稳`
- **新增**"季节性"列（key=`signals.seasonal_phase`）：显示 `🔥旺季` / `↗向旺季` / `→常态` / `↘向淡季` / `❄️淡季` / `?未知`——附加 hover tooltip 显示 `seasonal_factor` 数值
- 表格默认列宽调整：风险状态 -2，行动 +10，趋势 +10，季节性 +10

**改动 2：行背景色（按 action 主导，state 辅助）**
- `REPLENISH_NOW` / `REMOVE`: 红底
- `REDUCE_PRICE`: 橙底
- `HOLD`: 橙底（"暂停"也是要关注的）
- `REPLENISH_NORMAL`: 默认白底
- `NO_ACTION`: 默认白底
- 额外装饰（与背景色可叠加）：`inventory_state == deteriorating` 的行加左侧边框轮廓（橙色）

**改动 3：Excel 导出**
- 增加 3 列：`行动`、`趋势`、`季节性`（factor + phase）
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

**新增** `backend/tests/services/inventory/test_seasonal_factor.py`（v1.2 简化版）：

- `test_factor_from_sku_yoy` —— dms_30=2.0, dms_30_yoy=1.0 → factor=2.0, source='sku_yoy'
- `test_factor_average_of_two_yoy_ratios` —— 30D 和 7D 比值取平均
- `test_factor_from_single_yoy` —— 只有 dms_30_yoy（无 dms_7_yoy）→ 单个比值
- `test_factor_neutral_when_no_yoy` —— SKU 没 yoy → None, source='neutral'（**v1.2 不 fallback 到项目**）
- `test_factor_zero_yoy_returns_neutral` —— yoy=0 → None, source='neutral'
- `test_phase_peak` —— factor > 1.3 → 'peak'
- `test_phase_rising` —— 1.1 < factor ≤ 1.3 → 'rising'
- `test_phase_neutral` —— 0.9 ≤ factor ≤ 1.1 → 'neutral'
- `test_phase_falling` —— 0.7 ≤ factor < 0.9 → 'falling'
- `test_phase_trough` —— factor < 0.7 → 'trough'
- `test_factor_clamp_to_3_when_extreme` —— factor=5.0 → clamp 到 3.0
- `test_factor_clamp_to_03_when_extreme_low` —— factor=0.1 → clamp 到 0.3
- `test_phase_unknown_when_factor_is_none` —— factor=None → phase='unknown'
- `test_action_hold_for_deteriorating_in_trough_phase` —— 季节性下行场景
- `test_action_replenish_normal_for_critical_in_peak_phase` —— 旺季补货加注

**保留**既有 `test_health_score.py` 14 个测试（不动）。

**新增** `backend/tests/services/inventory/test_seasonal_integration.py`（v1.1）：

- `test_state_uses_adjusted_sellable_days_in_peak` —— 旺季 DoH 30 划归 critical (因 30 / 1.3 ≈ 23)
- `test_state_uses_adjusted_sellable_days_in_trough` —— 淡季 DoH 90 仍为 healthy (因 90 / 0.7 ≈ 128)
- `test_action_phase_affects_decision` —— 同 state 不同 phase 不同 action

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

## 8. 影响面汇总（v1.2 简化后）

| 范围 | 改动文件 | 改动量 |
|---|---|---|
| 后端服务 | `state_action.py`（新建）+ `seasonal_factor.py`（新建，更小）+ `replenishment.py`（增函数 + 多查一次 YoY SQL） | ~150 行新增（比 v1.1 少 80 行） |
| 后端 schema | `inventory_replenishment.py`（加字段含 seasonal 3 个） | ~40 行 |
| 后端 API | `replenishment_analysis.py`（无改动，schema 自动） + `inventory_replenishment.py` 内部端点 | 0 行（schema 透传） |
| 后端测试 | `test_state_action.py`（新建）+ `test_seasonal_factor.py`（新建，更小）+ `test_seasonal_integration.py`（新建）+ `test_three_segment.py`（新建） | ~250 行新增（比 v1.1 少 150 行） |
| 前端页面 | `inventory-replenishment/page.tsx`（加 3 列含季节性 + 行色 + Excel） | ~100 行 |
| 前端 schema 类型 | `api-generated/api.d.ts`（regen） | 自动 |
| 数据库 | 无 | 0 |
| 现有单测 | `test_health_score.py`（保留不动） | 0 |
| 库存分析页面 | 不动 | 0 |
| Seasonal replenishment endpoint/页面 | 不动（仅复用其 YoY SQL 数据） | 0 |

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
| D12 (v1.1) | 季节性因子用 YoY 自动算，**不**人工配置月度趋势 | YoY 数据已在 seasonal_replenishment 端点算过，直接复用 |
| D13 (v1.1) | seasonal_factor 范围 [0.3, 3.0] clamp | 极端值避免 state 判定跳变 |
| D14 (v1.1) | state 判定用 adjusted_sellable_days（除以 seasonal_factor） | 旺季 DoH 30 与淡季 DoH 30 不等价；季节性调整让阈值自适应 |
| D15 (v1.1) | action 表增加 seasonal_phase 列 | 旺季断货升级、淡季趋势下降 HOLD（避免误杀） |
| D16 (v1.1) | seasonal_endpoint 本身**不动** | A4 决策不判 risk；本次只是复用其数据 |
| D17 (v1.2) | **没 YoY 数据直接跳过季节性，不 fallback 到项目级平均** | 现实里大部分项目店铺没 YoY，项目级平均会被频繁触发、且老店铺+新店铺混在一起污染判断（用户拍板） |

## 10. 后续（不本 spec 范围）

- **思路 C：预测式评估**（BEL-369 milestone 2）——独立 spec。复用本 spec 的 `inventory_state` 函数算每日 projected_state，输出轨迹。
- **思路 B：Profitability-Weighted**——独立 spec。需先验证 product_costs / listing 生命周期数据完整度。
- **现有 5 轴评分移除**（V3）——如果三段式运行稳定且 `health_score` 5 轴评分确认无消费者，可移除 `health_score.py` 节省维护成本。

## 11. 验收标准（Definition of Done）

- [ ] `test_state_action.py` 15 个测试全绿
- [ ] `test_seasonal_factor.py` 13 个测试全绿（v1.2 简化版）
- [ ] `test_seasonal_integration.py` 3 个测试全绿（v1.2）
- [ ] `test_three_segment.py` 4 个测试全绿
- [ ] `test_health_score.py` 既有 14 个测试保留全绿
- [ ] 外部 API `/api/v1/external/projects/{id}/replenishment-analysis` 响应包含 `inventory_state` / `replenishment_action` / `signals` 3 个新字段族（signals 含 `seasonal_factor` / `seasonal_phase` / `seasonal_source`）
- [ ] 内部 API `/api/v1/inventory-replenishment` 同上
- [ ] summary `critical_count` / `deteriorating_count` / `watch_count` / `healthy_count` / `unknown_count` 数字正确（手动抽查 5 个项目）
- [ ] 前端 `inventory-replenishment` 页面新增"行动"列 + "趋势"列 + "季节性"列，行色按 action 渲染
- [ ] Excel 导出新增 3 列（行动 / 趋势 / 季节性）
- [ ] pnpm lint / pnpm build / pnpm test 全过
- [ ] 部署后真实项目抽查：1 个 deteriorating SKU、1 个 critical SKU、1 个 healthy SKU、1 个有 YoY 数据的 SKU（旺季）、1 个无 YoY 数据 SKU（确认 seasonal_phase=unknown 不影响主流程）验证显示正确
- [ ] `git deploy` 推送命中 `backend/` 触发 VPS 自动部署（前端 Vercel 自动）