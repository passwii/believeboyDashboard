# Agent API · Replenishment Analysis（补货分析）API 设计规范（v0.3 已拍板并实施）

> **状态**：**已拍板并实施**（2026-08-07）——用户「好的，全部按照你的推荐来」：D1–D10 全部按推荐拍板，随 BLF-502 直接实施（对齐 BLF-470 先例），实施记录见 §12。v0.2 为重设计版（从 Agent 任务模型出发，不锚 external；分析模型审计 G1–G8）。
> **配套文档**：[`docs/agent-api-design.md`](../../agent-api-design.md)（Agent API 全局设计稿 v0.7）、[`docs/superpowers/specs/2026-08-07-agent-return-analysis-api.md`](./2026-08-07-agent-return-analysis-api.md)（退货分析域 spec 定稿，路由风格模板）、[`docs/superpowers/specs/2026-08-01-replenish-2d-assessment-design.md`](./2026-08-01-replenish-2d-assessment-design.md)（三段式体系设计稿 v1.2，BEL-369）、[`backend/docs/external-api.md`](../../backend/docs/external-api.md)（external 读契约 §6——**本版不再以它为设计锚点**，仅作既有资产记录）。
> **范围**：在 `/api/v1/agent/projects/{id}/replenishment-analysis*` 开放**补货分析域**的完整读面 + 设置读写。
> **前提**：`require_project_scope` / `require_business_scope` 已就绪；BLF-491 调研结论（三段式为现行行为、镜像缺独立域）为本版基线。代码核实基于 main @ cf99d794。

---

## 0. 结论摘要

### 0.1 重设计动因（用户反馈，2026-08-07）

v0.1 采用「原生替换镜像」——本质是 **external §6 契约 + 三段式增强**，仍然锚定 external。用户明确指出两点：

1. **应重新设计，而不是用 external 的来修改**——API 面要从「Agent 到底要做什么任务」出发，而不是「external 有什么参数」。
2. **之前的设计可能并不全面**——需要审计「所有应该考虑的点」是否被覆盖，含底层三段式分析模型（BEL-369）本身。

本版回应这两点：§1 做**分析模型审计**（模型缺什么、API 如何补），§2 从 **Agent 任务模型**重构 API 家族（不锚 external），§3 给出完整路由表（v1 6 条 + v1.1 预留 2 条）。

### 0.2 设计结论（重设计版）

- **分析模型补强（v1 前置，service 小改）**：①`decision_path`（为什么是这个状态/行动——当前 `signals` 只有原始事实，没有「哪条规则命中」；`critical_subtype` 已在行内算出但被 schema 丢弃）②`data_freshness_days` 真实值（当前恒 0）③`REPLENISH_NOW` 判定修复（决策表第 1/2 行未落地）④summary 增加 `action_distribution` 分布。
- **路由面（v1 6 条，Agent 任务 → 端点一一映射）**：R1 决策清单（**默认轻量响应 + `?detail=full` 全量**——LLM token 优化）/ R2 单 SKU 深挖（含 decision_path 解释）/ R3 项目总览（state×action 分布矩阵）/ R4 覆盖度与新鲜度 / R5 设置列表（审计）/ R6 设置写（confirm 流）。
- **v1.1 预留**：R7 快照对比 trend（state/action 转移矩阵——service `report_date` 已支持回溯，可行性高）/ R8 预测 projection（BEL-369 §10 思路C，独立 spec）。
- **契约原则**：`{ok, data}` 壳、域 code `replenishment_analysis` 挂 `require_business_scope`、**零新错误码、零 DB 迁移**、读不落审计、写（R6）confirm + agent 审计归因。
- **与 v0.1 的差异**：v0.1 = external 契约 + 3 段式过滤（3 读 + 1 可选写）；v0.2 = Agent 任务模型驱动（6 读/写面 + 分析模型补强 + 响应瘦身/解释性/分布增强 + v1.1 路线图）。

---

## 1. 分析模型审计：BEL-369 三段式还缺什么（代码核实）

> 回应「之前的设计可能不全面」。以下缺口全部为**代码核实**（main @ cf99d794），不是推测。每项给「现状 → API 设计对策」。（决策路径/快照对比/预测属于模型层，汇总/分布/覆盖属于 API 表达层。）

| # | 缺口 | 代码现状 | API 设计对策 |
|---|---|---|---|
| G1 | **决策路径不可解释**：Agent 能拿到 `signals`（原始事实）与最终 `inventory_state` / `replenishment_action`，但**不知道哪条规则命中**——无法向用户解释「为什么判它 critical / 为什么建议 HOLD 而不是 REDUCE_PRICE」 | `compute_inventory_state` 按 P0→P13 顺序短路（`state_action.py:115`）；`compute_replenishment_action` 决策表分支（`:230`）；`critical_subtype`（shortage/aging/overstock）已算出且进了行 dict（`replenishment.py:1176` 的 `_critical_subtype`）但**被 schema 静默丢弃** | **v1：`decision_path` 字段**（state_rule / critical_subtype / action_rule / seasonal_override），service 小改把规则码带出（影响面：2 个 compute 函数各有 1 个 prod 调用方，见 §8.1） |
| G2 | **REPLENISH_NOW 未产出**：枚举存在，但 `critical+shortage` 分支只返回 REPLENISH_NORMAL 或 HOLD——决策表第 1/2 行（DoH<14 → REPLENISH_NOW）**未落地** | `compute_replenishment_action`（`state_action.py:250-256`）：trend 上升/旺季 → REPLENISH_NORMAL，否则 HOLD；测试 `test_action_replenish_now_for_doh_below_14`（`test_state_action.py:277`）锁定为 REPLENISH_NORMAL | **D4 待拍板**：修复判定（紧急补货是 Agent 最高价值动作，过滤才有意义）或仅标注预留枚举；修复会连带改锁 REPLENISH_NORMAL 的测试 |
| G3 | **无快照对比 / 趋势**：当前是「时点视图」，Agent 无法回答「比上一份库存快照是变好还是变坏」 | service `today = report_date or date.today()`（`replenishment.py:933`），库存/在途/DMS 窗口全部锚定 report_date——**双快照重算可行**；`list_snapshot_options`（`:863`）给出快照日期列表 | **v1.1：R7 trend 端点**（state/action 转移矩阵 + 逐 SKU 变化），两快照各调一次 service 对比，无需新表 |
| G4 | **`data_freshness_days` 恒 0**：新鲜度信号是占位 | `snapshot_age_days = 0  # TODO`（`replenishment.py:1110`） | **v1：修复**——从 `list_snapshot_options` 取最新 report_date 计算真实值；R4 coverage 同步提供 |
| G5 | **分布只有扁平计数**：summary 只有 5 个 state 计数，无 state×action 交叉、无 action 分布 | `replenishment.py:1180-1223`（summary dict） | **v1：R1 summary 加 `action_distribution`；R3 加 state×action 交叉矩阵**（行内两字段已齐，纯 Python 聚合，零成本） |
| G6 | **单国家粒度**：整个分析按 country 算，Agent 问「项目整体」需自己跨国家拼 | service 逐 country；无项目级聚合函数 | **v1.1 候选**：project 级聚合端点（逐国计算后合并，成本需评估）——v1 用 R3 按国家粒度 + 文档指引 Agent 多次调用 |
| G7 | **unknown 占比不可见**：数据缺失导致的 unknown SKU 数量只在过滤后 summary 里，Agent 无法判断「多少 SKU 因缺数据无法判定」 | summary.unknown_count 为过滤后口径 | **v1：R4 coverage 提供 `unknown_rate`**（无过滤基线上报，薄查询或复用分析缓存） |
| G8 | **设置不可审计**：Agent 无法回答「哪些 SKU 配了补货周期、配的是什么」 | 设置内嵌在分析行（production_lead_days 等），无独立列表；内部只有 PUT upsert，无 GET | **v1：R5 设置列表**（薄查询 `inventory_replenishment_settings`） |

> **结论**：三段式**判定骨架是对的**（5 state + 6 action + signals 的组合是现行最优），缺的是①解释性（G1）、②时间维度（G3）、③完备性（G2/G4）、④表达层（G5-G8）。本版 API 设计把前四项列为模型补强、后四项列为表达层增强，全部落在同一域内。

---

## 2. Agent 任务模型 → API 家族（重设计核心）

> 设计方法：先枚举 Agent 在该域的**真实任务**，再为每个任务设计端点。**不参照 external 参数表**；external §6 契约只在「既有消费者兼容」时被记录（§8.3）。

### 2.1 Agent 任务清单

| 任务 | Agent 的提问 | 关键设计考量 |
|---|---|---|
| T1 决策清单 | 「今天有哪些 SKU 要处理？按紧急度排序」 | 过滤（state/action 多值）+ 排序 + **响应瘦身**（LLM 上下文预算） |
| T2 单 SKU 深挖 | 「SKU X 什么情况？为什么这么判？」 | 完整行 + **决策路径解释** + 设置 + 时间轴 |
| T3 项目总览 | 「这个项目补货总体什么情况？」 | **分布矩阵**（state×action）+ 关键指标，无 items |
| T4 数据可信度 | 「这份分析数据可靠吗？覆盖到哪天？」 | 快照新鲜度 / 销售跨度 / 设置覆盖 / unknown 占比 |
| T5 配置审计与闭环 | 「哪些 SKU 配了补货周期？给 X 调整参数」 | 设置读（列表）+ 设置写（confirm 流） |
| T6 趋势对比（v1.1） | 「比上一份快照是变好还是变坏？」 | 双快照 state/action 转移矩阵 |
| T7 预测（v1.1） | 「不补货会怎样？」 | projected_state 轨迹（BEL-369 §10 思路C） |

### 2.2 家族 → 端点映射

| 家族 | 端点 | 对应任务 | confirm | 限流 | 审计 |
|---|---|---|---|---|---|
| **F1 决策清单** | `GET /replenishment-analysis` | T1 | ❌ | 读 | 不落 |
| **F2 单 SKU 深挖** | `GET /replenishment-analysis/skus/{sku}` | T2 | ❌ | 读 | 不落 |
| **F3 项目总览** | `GET /replenishment-analysis/summary` | T3 | ❌ | 读 | 不落 |
| **F4 覆盖度** | `GET /replenishment-analysis/coverage` | T4 | ❌ | 读 | 不落 |
| **F5 设置读写** | `GET /replenishment-analysis/settings`、`PUT /replenishment-analysis/settings/{sku}` | T5 | 写 ⚠️ | 读/写 | 写落 |
| **F6 趋势对比**（v1.1） | `GET /replenishment-analysis/trend` | T6 | ❌ | 读 | 不落 |
| **F7 预测**（v1.1） | `GET /replenishment-analysis/projection` | T7 | ❌ | 读 | 不落 |

**分类理由**：

1. **T1/T2 分离**是 Agent-first 的核心：清单要轻（默认不带 signals/decision_path），深挖要全。external 只有一个「全量重响应」端点，Agent 拉 200 个 SKU × 15+ signals 字段会吃掉大量上下文——`?detail=` 是 external 永远不会有、但 Agent 一定要有的设计点（D2）。
2. **T3 独立于 T1**：总览是「无 items 的聚合」语义，与清单（过滤后行集）是两种任务。独立端点让 Agent 用一次调用完成项目级概括，不必拉全量再数。
3. **T5 是本域唯一写目标**（设置 upsert 是真实内部写操作）——写走 confirm 流 + agent 审计归因（对齐 shipments PATCH 先例）；读侧 R5 补上「设置审计」能力（G8）。
4. **T6/T7 归 v1.1**：需要分析模型层先行（G3 双快照对比可行但属新增能力；T7 是独立 spec 的未来路线）。列入路线图保证「所有应考虑的点」被显式记录，不因 v1 裁剪而丢失。

---

## 3. 完整路由表（v1 6 条 + v1.1 预留 2 条）

> 统一挂 `/api/v1/agent/projects/{project_id}`（router prefix）；命名空间级鉴权（Bearer + X-Agent-Id + 读限流）由 `agent_router` 承担。全部路由挂 `Depends(require_project_scope)`；域级 `require_business_scope("replenishment_analysis")` 在 `agent/__init__.py` 装配时挂载（D3）。

| # | Method | Path | 复用 service | confirm | 限流 | 审计 |
|---|---|---|---|---|---|---|
| R1 | GET | `/replenishment-analysis` | `list_inventory_replenishment_analysis` + 内部 5min 缓存 | ❌ | 读 | 不落 |
| R2 | GET | `/replenishment-analysis/skus/{sku}` | 同 service（精确 SKU） | ❌ | 读 | 不落 |
| R3 | GET | `/replenishment-analysis/summary` | 同 service（聚合，无 items） | ❌ | 读 | 不落 |
| R4 | GET | `/replenishment-analysis/coverage` | `list_snapshot_options` + 设置/基表计数 + 销售跨度 | ❌ | 读 | 不落 |
| R5 | GET | `/replenishment-analysis/settings` | `inventory_replenishment_settings` 薄查询 | ❌ | 读 | 不落 |
| R6 | PUT | `/replenishment-analysis/settings/{sku}` | `upsert_inventory_replenishment_setting` | ⚠️ 是 | 写 | 落 |
| R7 | GET | `/replenishment-analysis/trend`（**v1.1**） | 双快照调 service 对比 | ❌ | 读 | 不落 |
| R8 | GET | `/replenishment-analysis/projection`（**v1.1**） | BEL-369 §10 思路C（未开工） | ❌ | 读 | 不落 |

### R1 决策清单（T1）

```
GET /api/v1/agent/projects/{pid}/replenishment-analysis
    ?country=US[&keyword=SKU-][&inventory_state=critical,deteriorating]
    [&replenishment_action=REPLENISH_NOW,REPLENISH_NORMAL,REDUCE_PRICE,REMOVE]
    [&risk_status=断货风险][&in_transit_only=false][&report_date=2026-08-01]
    [&order_by=sellable_days][&order_dir=asc][&detail=summary|full]
    [&page=1][&page_size=50]
```

- **过滤（Agent-first 白名单）**：
  - `inventory_state`：逗号分隔多值 ∈ `critical,deteriorating,watch,healthy,unknown`（非法值 → 400 `VALIDATION_FAILED`）
  - `replenishment_action`：逗号分隔多值 ∈ 6 枚举（同上校验；命中当前不产出的值如 REPLENISH_NOW → 空结果 200，不报错——D4 修复后自然有值）
  - `keyword`：SKU/ASIN 子串（大小写不敏感）；`in_transit_only`；`report_date`（历史快照，取该日或之前最近一版）
  - `risk_status`：老 4 类（**兼容既有消费者**，新消费者优先用 `inventory_state`/`replenishment_action`；§8.3 记录 deprecated 方向）
- **排序**：`order_by` 白名单 `sku / available_inventory / in_transit_quantity / weighted_dms / sellable_days / estimated_replenishment_quantity / risk_status / inventory_state / replenishment_action` + `order_dir ∈ asc|desc`；默认维持基表 `sort_order` 顺序（服务层 Python 侧排序，小改）
- **响应瘦身（D2）**：`detail=summary`（**默认**）→ items 只带核心决策字段（sku/asin/product_name/available_inventory/in_transit_quantity/weighted_dms/sellable_days/estimated_replenishment_quantity/inventory_state/replenishment_action/risk_status/replenishment_order_date）；`detail=full` → 完整行 + `signals` + `decision_path` + 时间轴。summary 增加 `action_distribution`（G5）
- **缓存（D10）**：默认路径复用内部 `get/set_inventory_replenishment_cache`（5min，key 与内部端点一致 → 与 UI 共享）；`report_date`/三段式过滤/排序/detail 走扩展 key 或独立 key（方案见 D10）

### R2 单 SKU 深挖（T2）

```
GET /api/v1/agent/projects/{pid}/replenishment-analysis/skus/{sku}?country=US[&report_date=2026-08-01]
```

- 响应 `data` = 完整 `InventoryReplenishmentListItem` 同构行 + `signals` + **`decision_path`**（G1 解释性）。
- 无该 SKU → **200 + `data: null`**（D5：查询结果为空 ≠ 资源不存在，对齐 return-analysis D6）。

### R3 项目总览（T3）

```
GET /api/v1/agent/projects/{pid}/replenishment-analysis/summary?country=US[&report_date=2026-08-01]
```

- 响应 `data`（草案，G5）：

```json
{
  "project_id": 1,
  "country": "US",
  "as_of_date": "2026-08-07",
  "summary": {
    "sku_count": 120, "critical_count": 3, "deteriorating_count": 2,
    "watch_count": 8, "healthy_count_v2": 100, "unknown_count": 7,
    "total_available_inventory": 18240, "total_in_transit_quantity": 3120
  },
  "state_distribution": { "critical": 3, "deteriorating": 2, "watch": 8, "healthy": 100, "unknown": 7 },
  "action_distribution": { "REPLENISH_NOW": 0, "REPLENISH_NORMAL": 2, "HOLD": 5, "REDUCE_PRICE": 1, "REMOVE": 1, "NO_ACTION": 111 },
  "state_action_matrix": {
    "critical": { "REPLENISH_NORMAL": 2, "HOLD": 1 },
    "deteriorating": { "REDUCE_PRICE": 1, "HOLD": 1 },
    "watch": { "NO_ACTION": 8 },
    "healthy": { "NO_ACTION": 100 },
    "unknown": { "NO_ACTION": 7 }
  }
}
```

- 与 R1 同计算源（同一 service 调用 + 聚合），**无 items**——轻量总览；与 R1 共享 5min 缓存。

### R4 数据覆盖度 / 新鲜度（T4）

```
GET /api/v1/agent/projects/{pid}/replenishment-analysis/coverage?country=US
```

- 响应 `data`（草案；G4/G7）：

```json
{
  "project_id": 1,
  "country": "US",
  "as_of_date": "2026-08-07",
  "inventory_snapshot": {
    "report_date": "2026-08-01",
    "freshness_days": 6,
    "is_current": true,
    "available_options_count": 12
  },
  "sales_data": { "max_sales_date": "2026-08-06", "window_days": 30 },
  "base_skus": { "total_count": 120, "configured_count": 45 },
  "unknown_rate": 0.058
}
```

- `inventory_snapshot`：`list_snapshot_options` 最新 report_date + is_current + 历史快照数；`freshness_days = as_of_date - report_date`——即 `signals.data_freshness_days` 的真实值来源（G4 修复）。
- `sales_data.max_sales_date`：`analysis_sales_order_rows` MAX(purchase_date_pt)（薄查询）。
- `base_skus`：基表 SKU 总数 vs 有自定义设置数（配置覆盖度：设置缺失越多，默认周期兜底越多，建议越需人工复核）。
- `unknown_rate`：无过滤基线中 state=unknown 的占比（G7；实现走轻量计数或复用最近一次 R1 缓存）。

### R5 设置列表（T5 读侧）

```
GET /api/v1/agent/projects/{pid}/replenishment-analysis/settings?country=US[&sku=]
```

- 响应 `data` = `{ "items": [ InventoryReplenishmentSettingItem ... ] }`（`schemas/inventory_replenishment.py:110`：project/sku/country/asin/production_lead_days/shipping_days/safety_factor）。
- 薄查询 `inventory_replenishment_settings`（无内部 GET 先例，属新增小查询）；`?sku=` 精确/子串过滤可选。

### R6 设置写（T5 写侧；confirm 流）

```
# 第一次调用（预览，server 不落库）
PUT /api/v1/agent/projects/{pid}/replenishment-analysis/settings/{sku}?country=US
Authorization: Bearer <key_secret>
X-Agent-Id: <agent_id>
Idempotency-Key: <uuid>
Content-Type: application/json

{ "asin": "B0XXXX", "production_lead_days": 35, "shipping_days": 40, "safety_factor": 0.2 }
```

- 预览响应（HTTP 200）：`{ ok: false, requires_confirmation: true, confirm_token, preview: { action: "replenishment_settings.upsert", summary: { sku, old: {...}, new: {...} } }, expires_in_sec: 300, ... }`。
- 重放：同一 `Idempotency-Key` + `X-Confirm-Token`，body hash 一致 → 落库 + 审计（`operator=NULL` + `agent_id`，action `inventory_replenishment_settings.upsert`）。
- body = `InventoryReplenishmentSettingUpdate`（asin ≤64 / production_lead_days≥0 / shipping_days≥0 / safety_factor≥0）。

### R7 快照对比 / R8 预测（v1.1 预留，本节只记设计意图）

- **R7 trend（T6）**：`?compare_from=2026-07-01&compare_to=2026-08-01`（或默认「最新 vs 上一份」）→ 逐 SKU `{ sku, state_from→state_to, action_from→action_to, change: improved|worsened|stable }` + 项目级 state 转移矩阵。可行性已核实：service `report_date` 同时锚定库存/在途/DMS（G3）。
- **R8 projection（T7）**：BEL-369 §10「思路C 预测式评估」——projected_state 轨迹（不补货的 DoH 演化）。独立 spec 前置，v1.1 立项。

---

## 4. 请求 / 响应 schema 草案（新增字段）

### 4.1 `decision_path`（G1；R1 detail=full / R2 返回）

```json
"decision_path": {
  "state_rule": "P1",                 // P0-P13 命中的 state 规则
  "critical_subtype": "shortage",     // critical 时：shortage|aging|overstock
  "action_rule": "shortage-up",       // 决策表分支标识（实现时给分支命名）
  "seasonal_override": false,         // 季节性是否覆盖了动作判定
  "seasonal_phase_used": "neutral"    // 判定用到的 seasonal_phase
}
```

- 服务层改动：`compute_inventory_state` 返回 `(state, critical_subtype, state_rule)`；`compute_replenishment_action` 返回 `(action, action_rule, seasonal_override)`（或端点层由已输入参数推导）。**影响面已核实**：两个函数各 1 个 prod 调用方（`replenishment.py:1093/1102`）+ `test_state_action.py` 断言适配（§8.1）。

### 4.2 R1 `detail` 语义

| detail | items 行字段 | 适用 |
|---|---|---|
| `summary`（默认） | sku/asin/product_name/available_inventory/in_transit_quantity/weighted_dms/sellable_days/estimated_replenishment_quantity/inventory_state/replenishment_action/risk_status/replenishment_order_date | T1 清单、上下文预算受限的 Agent |
| `full` | 完整 `InventoryReplenishmentListItem` + signals + decision_path + 时间轴 | T2 深挖、需要解释的 Agent |

### 4.3 响应壳 / 错误码

- 全部复用既有壳与错误码（见 §5）；R6 走 confirm 预览壳（`agent-api-design.md` §3.1）。

---

## 5. 错误码注册（`app/api/agent/errors.py`）

**v1 建议零新增错误码**——全部复用既有：

| 场景 | code | HTTP |
|---|---|---|
| 项目不存在 | `RESOURCE_NOT_FOUND` | 404 |
| 非法 country / report_date / inventory_state / replenishment_action / order_by / detail / 分页参数 | `VALIDATION_FAILED`（白名单校验失败同码） | 400 |
| 越权项目 / 越权域 | `AGENT_PROJECT_OUT_OF_SCOPE` / `AGENT_BUSINESS_OUT_OF_SCOPE` | 403 |
| 鉴权失败 / 限流 | `AGENT_AUTH_FAILED` / `AGENT_RATE_LIMIT_EXCEEDED` | 401 / 429 |
| R6 confirm 校验失败 | `CONFIRM_TOKEN_INVALID` / `CONFIRM_TOKEN_EXPIRED` / `IDEMPOTENCY_KEY_CONFLICT`（已注册） | 400 / 409 |

> R2 空 SKU 默认 200 + `data:null`；`replenishment_action` 命中未产出枚举（REPLENISH_NOW）→ 空 items 200——均不新增错误码（D4/D5）。

---

## 6. 权限矩阵

| 能力 | 人类用户（内部端点） | Agent（`/agent/*`） | 备注 |
|---|---|---|---|
| 决策清单（三段式过滤/排序） | ✅ `GET /api/v1/inventory-replenishment-analysis`（无过滤/排序） | ✅ R1（多值过滤 + 排序 + detail 瘦身） | Agent 能力超集（G 表达层） |
| 单 SKU 深挖 + 解释 | ⚠️ 仅 `?keyword=` 子串 | ✅ R2（精确行 + decision_path） | G1 |
| 项目总览（分布矩阵） | ❌ 无 | ✅ R3（**新增**） | G5 |
| 数据覆盖度/新鲜度 | ⚠️ `GET /api/v1/inventory-snapshot-options`（仅日期） | ✅ R4（**新增**，快照+销售+配置+unknown） | G4/G7 |
| 设置审计 | ❌ 无独立 GET | ✅ R5（**新增**） | G8 |
| 设置写 | ✅ `PUT /api/v1/inventory-replenishment-settings/{pid}/{sku}` | ✅ R6（confirm + agent 审计归因） | D5 |
| 快照对比/预测 | ❌ 无 | R7/R8（v1.1 预留） | G3 / 思路C |
| 修改分析结果本身 | ❌ 无内部操作（实时计算） | ❌ 不开放 | 无物化表，无可写目标 |
| 在途货件明细 | ✅ `GET /api/v1/inventory-replenishment-shipments` | ❌ 归 shipments 域 | BLF-476 单域约束；在途量已在 R1/R2 行 |

---

## 7. 测试清单（供执行子 issue）

| 文件 | 覆盖 |
|---|---|
| `backend/tests/api/agent/test_replenishment_read.py` | R1（三段式过滤白名单/非法值 400/排序/分页/`?report_date=` 回溯/**detail 两档字段集**/空结果 200）；R2（有数据行/无数据 `data:null`/decision_path 存在） |
| `backend/tests/api/agent/test_replenishment_summary.py` | R3（state/action 分布 + state×action 矩阵 + as_of_date） |
| `backend/tests/api/agent/test_replenishment_coverage.py` | R4（快照 report_date/freshness_days/无快照 null/销售跨度/设置计数/unknown_rate） |
| `backend/tests/api/agent/test_replenishment_settings.py` | R5 列表（country/sku 过滤）；R6 confirm 预览→重放→body hash 不匹配→token 过期→审计 operator=NULL+agent_id |
| `backend/tests/services/inventory/test_state_action.py` | 适配 compute 函数签名变化（state_rule/action_rule）；**D4 修复 REPLENISH_NOW 后更新 `test_action_replenish_now_for_doh_below_14`** |
| `backend/tests/services/inventory/test_inventory_replenishment.py` | service 过滤/排序/data_freshness 真实值/decision_path 入行 |
| `backend/tests/api/agent/test_business_scope.py`（已有） | `replenishment_analysis` 放行 / 不含 403 |
| `backend/tests/api/agent/test_project_scope.py`（已有） | 挂载后回归 |
| `backend/tests/api/agent/test_external_mirror.py`（已有） | replenishment-analysis 已从 mirror 排除（镜像路由数减 1） |

运行顺序（AGENTS.md 约定）：`cd backend && pytest -q tests/api/agent` → 全量无新增失败。

---

## 8. 与既有资产 / 契约 / 前端的协同

### 8.1 服务层补强清单（v1 前置，全部小改）

| # | 改动 | 位置 | 影响面 |
|---|---|---|---|
| S1 | `compute_inventory_state` 返回 `(state, critical_subtype, state_rule)` | `state_action.py:115` | 1 prod 调用方（`replenishment.py:1093`）+ `test_state_action.py` state 测试 |
| S2 | `compute_replenishment_action` 返回 `(action, action_rule, seasonal_override)` | `state_action.py:230` | 1 prod 调用方（`replenishment.py:1102`）+ `test_state_action.py` action 测试（D4 含 REPLENISH_NOW 修复） |
| S3 | row 增加 `decision_path`（`critical_subtype` 从 `_critical_subtype` 转正） | `replenishment.py:1176` 附近 | schema `InventoryReplenishmentListItem` 加可选字段 |
| S4 | `snapshot_age_days` 真实值（从 `list_snapshot_options` 最新 report_date 计算） | `replenishment.py:1110` | `data_freshness_days` 不再是 0 |
| S5 | service 增加 `inventory_state`/`replenishment_action` 过滤 + `order_by`/`order_dir`（Python 侧） | `list_inventory_replenishment_analysis` | 内部端点可同步透传（D10 方案 A） |
| S6 | summary 增加 `action_distribution` + `state_action_matrix` | `replenishment.py:1180` 附近 | 内部端点 response 兼容（新字段可选） |
| S7 | 设置列表薄查询（R5） | `replenishment.py` 或端点模块内 | 无内部先例，新增 |
| S8 | 销售跨度薄查询（R4） | 端点模块内 | `analysis_sales_order_rows` MAX 查询 |

### 8.2 路由装配 / 镜像 / openapi

1. **镜像排除（D1）**：`external_mirror.py` `_EXCLUDED_EXTERNAL_PATHS` 增加 `/external/projects/{project_id}/replenishment-analysis`（对齐 new-product-calculations / return-analysis precedent）。
2. **`agent/__init__.py`**：include `replenishment_analysis_router` + `require_business_scope("replenishment_analysis")`（**必须插在兜底路由之前**，文件内已有注释警告）。
3. **openapi 再生成**：`scripts/openapi_export.py` + `frontend/types/api-generated/` 同步（BLF-465 流程）。
4. **external-api.md §6**：标记 deprecated（原契约仍可用于理解既有消费者行为，但不再作为 Agent 设计依据）。

### 8.3 既有消费者兼容

- R1 保持 `country/keyword/risk_status/in_transit_only/report_date/page/page_size` 参数可用（`risk_status` 标注 deprecated 方向），存量镜像消费者换路后参数不破坏；`detail=full` 提供与镜像等价的完整行。
- 响应壳不变（`{ok, data}`）；`data.items` 结构在 `detail=full` 下与镜像一致 + 新字段（signals 已有）。

### 8.4 前端四件套（BLF-474/490 模式）

- `frontend/lib/agent-domains.ts`：`{ code: 'replenishment_analysis', label: '补货分析', description: '补货决策清单/单 SKU 深挖/项目总览/覆盖度/设置（三段式体系）', status: 'live'（实施后）, routeCount: 6, capabilities: { read: true, write: true } }`。
- `frontend/app/dashboard/system/agent-management/agent-usage-guide.tsx`：新增 `buildReplenishmentAnalysisGuide()`——示例 curl（R1 带 `inventory_state=critical` / `replenishment_action=REDUCE_PRICE` 过滤与 `detail=summary`、R2 深挖、R3 总览、R4 覆盖度、R6 设置写 confirm 两段式）；标注：`REPLENISH_NOW` 枚举预留（D4 前）、`risk_status` 兼容旧字段、`detail` 两档语义。

---

## 9. 决策记录（D1–D10 待拍板）

| # | 决策点 | 选项 | 推荐 | 拍板 | 实施影响 |
|---|---|---|---|---|---|
| **D1** | **镜像去留**：R1 与镜像路径冲突 | A=原生迁移（mirror 排除 1 路径）；B=保留镜像仅新增 R2-R6 | **A（原生迁移）** | ✅ | mirror 排除；原生模块；openapi 再生成 |
| **D2** | **响应瘦身**：R1 是否默认 `detail=summary`（轻量行）而非全量 | 默认 summary + `?detail=full`（LLM token 优化）；或默认 full（兼容全量） | **默认 summary + detail=full** | ✅ | schema 两档字段集；guide 标注 |
| **D3** | **decision_path**：是否 v1 加入解释性字段（G1） | 加（service 小改 S1/S2/S3）/ 不加（仅 signals） | **加** | ✅ | 2 个 compute 函数签名 + 测试适配 |
| **D4** | **REPLENISH_NOW 判定修复**：决策表第 1/2 行是否落地（G2） | 修复（连带改 `test_action_replenish_now_for_doh_below_14`）/ 仅标注预留枚举 | **修复** | ✅ | `compute_replenishment_action` 逻辑 + 测试；R1 过滤从此可命中 REPLENISH_NOW |
| **D5** | **设置写**：R6 是否开放 | 开放（confirm 流）/ 全读 | **开放** | ✅ | 路由 +1；confirm + 写限流 + 审计 |
| **D6** | **R3 独立总览 + 分布矩阵** | 独立（无 items 轻量 + state×action 矩阵）/ 并入 R1 summary | **独立** | ✅ | 路由 +1；S6 聚合 |
| **D7** | **R4 覆盖度 + data_freshness 修复** | 新增 R4；S4 修 TODO | **新增 + 修复** | ✅ | 薄查询 S8；`data_freshness_days` 真实值 |
| **D8** | **R7 快照对比 trend** | v1.1 预留 / 纳入 v1 | **v1.1** | ✅ | 路线图；可行性格外标注（G3） |
| **D9** | **R8 预测 projection** | v1.1 预留（BEL-369 §10 思路C）/ 不纳入 | **v1.1 独立 spec** | ✅ | 路线图 |
| **D10** | **缓存策略**：R1 新参数（过滤/排序/detail/report_date）的缓存 key | A=扩展内部缓存 key + 内部端点透传（S5 双侧受益）；B=agent 侧独立 key | **A（评估兼容）** | ✅ | 缓存 key 扩展；内部端点签名变化需回归 |

---

## 10. 执行前置（已全部完成 2026-08-07）

- [x] D1–D10 拍板（用户「好的，全部按照你的推荐来」= 推荐组合全量通过）
- [x] 实施（随 BLF-502 直接实施，对齐 BLF-470 先例）：`endpoints/agent/replenishment_analysis.py` + mirror 排除 + `__init__.py` 挂载 + 服务层补强 S1–S8 + R6 confirm + openapi/api.d.ts 再生成 + 测试（见 §12）
- [x] 仓库 main 已含：`require_project_scope` / `require_business_scope` / `_EXCLUDED_EXTERNAL_PATHS` precedent；本 spec 引用的复用函数均为真实存在的符号（CodeGraph 已核实）

---

## 12. 实施记录（BLF-502 落地）

**2026-08-07**（设计拍板同日随 BLF-502 实施，未另开执行子 issue）：

| 文件 | 变更 |
|---|---|
| `backend/app/services/inventory/state_action.py` | S1：`compute_inventory_state` 返回 `(state, critical_subtype, state_rule)`（P0–P13）；S2：`compute_replenishment_action` 返回 `(action, action_rule, seasonal_override)` + `adjusted_sellable_days` 参数 + **D4 REPLENISH_NOW 修复**（DoH<14 → 紧急补货） |
| `backend/app/services/inventory/replenishment.py` | S3-S8：`decision_path` 入行、`data_freshness_days` 真实值（`_compute_snapshot_age_days`）、三段式过滤 + `order_by` 排序（`_sort_rows`）、summary 分布（state/action/交叉矩阵）、设置列表/基表计数/销售跨度查询；**顺带修复 BEL-369 遗留 YoY 窗口无上界 bug**（`_load_seasonal_dms_map` 去年同期 CASE 补 `<= until`，当年数据不再泄漏进 YoY 汇总） |
| `backend/app/schemas/inventory_replenishment.py` | 新增 `InventoryDecisionPath`；item 加 `decision_path`；summary 加 `state_distribution` / `action_distribution` / `state_action_matrix` |
| `backend/app/services/infra/inventory_cache.py` | D10：`get/set_inventory_replenishment_cache` key 扩展（过滤/排序/detail/report_date），内部端点默认 `detail=full` 与 agent `detail=full` 共享 |
| `backend/app/api/v1/endpoints/agent/replenishment_analysis.py` | **新增**：R1 决策清单（detail 两档）/ R2 skus/{sku} / R3 summary / R4 coverage / R5 settings / R6 settings/{sku} confirm |
| `backend/app/api/v1/endpoints/agent/external_mirror.py` | `_EXCLUDED_EXTERNAL_PATHS` 增加 replenishment-analysis（D1） |
| `backend/app/api/v1/endpoints/agent/__init__.py` | include `replenishment_analysis_router` + `require_business_scope("replenishment_analysis")`（D3） |
| `backend/tests/api/agent/` | 新增 `test_replenishment_read.py`（R1/R2/读不落审计）、`test_replenishment_summary.py`（R3/R4）、`test_replenishment_settings.py`（R5/R6 confirm）；conftest 新增 `seed_sales_order_rows` / `seed_replenishment_sku` / `seed_replenishment_setting`；适配 `test_external_mirror.py`（镜像排除） |
| `backend/tests/api/conftest.py` | 新增 autouse `_cleanup_agent_audit_tables`（agent_api_audit_log + operation_audit_logs 全局清理——access/operation logs 测试做全局计数断言，防跨会话残留污染） |
| `backend/tests/services/inventory/` | 适配 `test_state_action.py`（3 元组 + REPLENISH_NOW）、`test_three_segment_integration.py`（3 元组 + REPLENISH_NOW）、`test_inventory_replenishment.py`（快照新鲜度 mock） |
| `frontend/types/api-generated/` | openapi 再生成（6 原生路由入列，镜像 operation 移除） |
| `frontend/lib/agent-domains.ts` | 新增 `replenishment_analysis`（live，routeCount 6，读+写） |
| `frontend/app/dashboard/system/agent-management/agent-usage-guide.tsx` | 新增 `buildReplenishmentAnalysisGuide()`（6 条路由 + 三段式过滤 + confirm 两段式示例） |
| `frontend/lib/agent-domains.test.ts` / `agent-usage-guide.test.ts` | 新增域注册 + guide 断言 |

测试验收：`backend` tests/api/agent 全绿 + tests/api 659 passed（13 failed 均为 main 既有：page_render 10 + profile_endpoints 3）+ tests/services/inventory 505 passed（2 failed 均为 main 既有）；frontend vitest 36 相关用例全绿 + lint 0 error。

---

## 修订记录

- **v0.3（2026-08-07）**：**已拍板并实施**——用户「好的，全部按照你的推荐来」：§9 D1–D10 全部标拍板；§10 执行前置勾选；新增 §12 实施记录（服务层 S1-S8 + 6 路由 + mirror 排除 + business_scope + 测试 + openapi/api.d.ts + 前端 agent-domains/usage-guide）；**顺带修复 BEL-369 遗留 YoY 窗口无上界 bug**（当年数据泄漏进去年同期汇总）。
- **v0.2（2026-08-07）**：**重设计**（BLF-502，按用户反馈「重新设计，而不是用 external 的来修改；之前的设计可能不全面」）——①新增 §1 分析模型审计（G1-G8：决策路径不可解释 / REPLENISH_NOW 未产出 / 无快照对比 / data_freshness_days=0 / 分布只有扁平计数 / 单国家粒度 / unknown 不可见 / 设置不可审计）；②§2 改为 Agent 任务模型驱动（T1-T7 → F1-F7 家族），不再以 external §6 契约为锚；③路由面 v1 从 4 条扩到 6 条（+R3 summary 分布矩阵 / +R5 设置列表），v1.1 预留 R7 trend / R8 projection；④新增 `decision_path` 解释性字段与 `detail` 响应瘦身两档；⑤D1-D7 → D1-D10（新增 D2 瘦身 / D3 decision_path / D4 REPLENISH_NOW 修复）；⑥服务层补强清单 S1-S8（含影响面核实）。
- **v0.1（2026-08-07）**：初版（external 契约 + 三段式增强，3 读 + 1 可选写，D1-D7）。
