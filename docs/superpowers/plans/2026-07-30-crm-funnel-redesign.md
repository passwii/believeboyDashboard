# CRM 漏斗重新设计（设计定稿 · BLF-516）

**日期**：2026-07-31（讨论）→ 2026-08-08（定稿，BLF-516）
**来源**：与 Damon 的讨论，基于当前 CRM 看板（P6a 阶段）；BLF-516 拍板 5 项设计决策
**状态**：✅ 设计已定稿，待 BLF-517（漏斗指标 service）/ BLF-518（漏斗二层复盘面板）实现

---

## 背景

当前 CRM 看板的漏斗存在两个问题：
1. 前端从后端拿到 5 级状态快照（new / contacting / qualified / converted / discarded），前端用 `buildLeadFunnelStages` 转成 **4 级累计漏斗**（线索总量 → 跟进联系 → 验证 → 转化）展示
2. 累计漏斗在 4 级以内合理，但后端实际业务包含更多阶段（初次触达、二次触达、报价、拉扯跟进）全部压缩在 `new → contacting` 一级里，掉了细节；且没有"阶段卡住"和"停留时长"的信息，无法用于复盘

---

## 设计结论（两层漏斗）

### 第一层：看板漏斗（日常监控）

**4 个粗阶段**，用于日常 3 秒扫一眼：

```
线索 → 初次触达 → 推进/报价 → 成交
```

- 弃置 `discarded` 单独在页面右上角展示，不进漏斗主体
- 整体转化率显示在卡片标题区域（已有）
- 口径：**阶段漏斗（raw counts，不累计）** —— 4 级已经很粗，阶段级别能直接看到哪一级堆了人、哪一级掉得快（定稿决策 #4）

### 第二层：阶段详情（复盘诊断）

点进某个阶段，展开该阶段的明细面板，回答以下问题：

| 复盘问题 | 需要的数据 |
|----------|-----------|
| 此阶段多少条？当前在此阶段列表 | 该阶段末端所有 leads |
| 平均停留多少天？ | `entered_stage_at`（后端落字段，定稿决策 #5） |
| 最后一次动作是什么？到期没动？ | `CrmFollow` 最后一条记录 + time-to-next-stage |
| 从上一级流进来多少？卡住多少？流失多少？ | `CrmAuditLog` 状态变更记录（含 created_at） |

---

## 设计定稿（BLF-516 · 5 项拍板）

### 决策 #1 — 阶段命名：`线索 → 初次触达 → 推进/报价 → 成交`（采纳讨论方案）

- **采纳讨论产出的命名**，与现有状态枚举 1:1 映射，不动枚举：

  | 漏斗阶段 | CrmLead.status | 含义 |
  |---------|---------------|------|
  | 线索 | `new` | 刚进入系统，未触达 |
  | 初次触达 | `contacting` | 已建立第一次联系 |
  | 推进/报价 | `qualified` | 需求验证/报价/拉扯跟进 |
  | 成交 | `converted` | 转客户 |
  | （侧栏）弃置 | `discarded` | 不进主漏斗 |

- **不改状态枚举**（不加"二次触达 / 报价"等新 status）：P8 范围是看板深化，不是销售流程重构；枚举变更会波及权限、筛选、表单、任务、测试全链。细粒度阶段（二次触达/报价/拉扯跟进）留作未来销售流程建模，不在本期引入。
- 影响：`buildLeadFunnelStages` 从累计口径改为阶段 raw 口径（BLF-518 实现）。

### 决策 #2 — 阶段详情面板：右侧抽屉（Drawer）

- **采用右侧抽屉**，复用 CRM 已有 `crm-overview-drawer` 交互范式（列表详情已用抽屉，用户心智一致）。
- 对比：
  - 弹窗：阻断页面上下文，多阶段对比要反复开/关；不选。
  - 下方展开：把页面布局撑高、滚动抖动；表格宽度受限；同时只能看一级；不选。
  - 抽屉：不破坏布局、宽度足够容纳 lead 列表 + 指标；点另一档漏斗即切换抽屉内容（单实例，不叠加）；移动端全屏。✅
- 交互：点击漏斗某一档 → 抽屉打开展示该阶段明细；切档即换内容；关闭抽屉恢复漏斗全貌。

### 决策 #3 — 明细面板默认展示：滞留最久（卡住风险）Top，可切换「最近有动作」

- **默认「滞留最久」**：按 `now - entered_stage_at` 降序取前 N 条。复盘面板的目的是找风险线索，滞留最久 = 最该被捞起来跟进。
- 每条展示：名称/公司、停留天数、最后动作（最近 `CrmFollow` 时间 + 内容摘要）、下次跟进时间、逾期标记（`next_follow_at < now` 标红「已逾期」）。
- **提供分段切换「滞留最久 | 最近有动作」**：最近有动作按最后动作时间降序，默认停在滞留最久。
- 默认 Top 5，尾部「查看全部 →」跳线索列表（带该阶段筛选），完整列表不塞进抽屉。
- 顶部汇总该阶段：条数 / 平均停留天数 / 流入·卡住·流失计数。

### 决策 #4 — 第一层漏斗：阶段漏斗（raw counts，不累计）

- **拍板阶段漏斗**，放弃当前累计口径。理由：
  1. **1:1 归属，点击穿透干净**：每条线索只属于一个阶段，点某档 = 该阶段 lead 列表，无重复无歧义；累计口径下 contacting 的线索同时出现在"线索总量"和"跟进联系"两级，点哪级都歧义。
  2. **看"哪级堆人"直读**：raw 计数直接显示当前堆量，无需换算。
  3. **命名语义契合**：`线索/初次触达/推进报价/成交` 是阶段名，不是累计口径名。
- **技术要点（FunnelChart 兼容性，BLF-518 实现时处理）**：
  - `FunnelChart` 现以 `data[0].value` 为归一化 max（`funnel-chart.tsx:728`），raw 计数可能非单调（如 contacting > new），需改为 `max(所有档 value)` + 零值档给 min-width 下限（如 3%）渲染。
  - 该改动向后兼容：FunnelChart 当前仅在 CRM 看板页使用（grep 确认），现有调用数据单调递减，`max(all) = data[0]` 行为不变。
- 保留逐级转化率卡片（`leadFunnelStepRates` 已有）：此时转化率 = 后级 raw / 前级 raw，正是"掉得快"的直接指标。

### 决策 #5 — 后端落字段 `entered_stage_at`（status 变更时更新）

- **拍板后端落字段**，不做前端推算。理由：
  - 线索可能长期无跟进却早已处于当前状态 → 首条 follow 时间 ≠ 进入阶段时间，前端用 `CrmFollow.created_at` 推算不可靠；
  - 状态变更是 update 动作，不产生 follow 记录 → 根本没有对应 follow 可参考；
  - 停留时长均值/分布/滞留 Top 是 service 层聚合（BLF-517），不该逐条拉全量让前端算。
- **实现约定（BLF-517）**：
  - 迁移：`crm_leads` 加可空列 `entered_stage_at timestamptz`（默认 NULL）；
  - 写入点：所有改变 `CrmLead.status` 的路径统一赋值（`update_lead` 含 status patch、`convert_lead`），建议收敛到 lead_service 一个 `_apply_status_change` helper，避免散落；同一状态重复写入不更新；
  - 存量回填：迁移中对现有数据 `entered_stage_at = COALESCE(converted_at, updated_at)`（近似值，注释说明精度损失）；
  - **`last_action_at` 不落字段**：`CrmFollow.created_at` 已存在且有 `idx_cf_entity` 索引，服务端 `max(created_at)` 聚合一次到位；
  - **阶段流转计数不建新表**：`CrmAuditLog` 已记录每次 update 的 summary（含"状态: old→new"）+ created_at，BLF-517 解析审计得期间流入/卡住/流失；若 summary 文本解析脆弱，备选方案是审计加结构化 `status_change` 动作 + `from_status/to_status` 字段（不阻塞本期设计）。

---

## 数据基础（定稿后）

- 后端 `dashboard_service.py` 目前只返回 `lead_funnel: dict[str, int]`（各状态快照计数）
- 需要补的数据（按定稿决策 #5）：
  1. `CrmLead.entered_stage_at`（新列，status 变更时写入，迁移回填近似值）
  2. `CrmFollow` 已有记录，可直接读 last action（不落新字段）
  3. 阶段流转计数：按 `CrmAuditLog` 状态变更记录计算（不建新表）

---

## 当前相关代码

- 前端漏斗组件：`frontend/components/ui/funnel-chart.tsx`（归一化需改 max(所有档)，定稿 #4）
- 前端漏斗工具：`frontend/lib/crm/method/lead-funnel.ts` + `.test.ts`（累计口径 → 阶段口径，BLF-518）
- 前端页面改动：`frontend/app/dashboard/crm/dashboard/page.tsx` — 用了 `buildLeadFunnelStages`、`layers=3`、`grid`、`formatValue={compact}`
- 前端 mock 数据调整：`frontend/lib/crm/api/mock-data/_generator.ts` — 修正权重让快照本身是漏斗形
- 后端漏斗数据来源：`backend/app/services/crm/dashboard_service.py` — 5 级快照，`_LEAD_STATUS_ORDER`
- 后端 schema：`backend/app/schemas/crm.py` — `DashboardStats.lead_funnel: dict[str, int]`
- 线索状态模型：`backend/app/models/crm.py` `CrmLeadStatus`（new/contacting/qualified/converted/discarded）
- 审计日志：`backend/app/models/crm.py` `CrmAuditLog`（action + summary + created_at）

---

## 后续推进（BLF-517 / BLF-518）

1. **BLF-517 漏斗指标 service**：`entered_stage_at` 迁移 + 落字段写入点 + 按时间/角色/来源聚合 + 审计流转计数（按定稿 #5）
2. **BLF-518 漏斗二层复盘面板**：阶段漏斗（raw）+ FunnelChart 归一化兼容 + 右侧抽屉明细 + 滞留 Top / 最近有动作切换（按定稿 #1–#4）
