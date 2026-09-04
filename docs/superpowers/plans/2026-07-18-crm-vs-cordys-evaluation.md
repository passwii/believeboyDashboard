# CRM 方案评估：对照 CordysCRM 是否需要打磨方案本身

> 评估时间：2026-07-18
> 评估对象：`docs/CRM-MVP-PLAN.md` (v1.1) vs `openSourceProjects/CordysCRM`（1Panel-dev，v1.7+）
> 目的：判断我们推进到 Phase 1 完成时，方案本身是否需要修订

---

## 0. 一句话结论

**方案本身不需要大改，但有两处需要"显式打磨"后再推进：**

1. **MVP 与 CordysCRM 的"代差"要在计划里讲清楚**（避免 reviewer 拿全功能 CRM 比我们）——目前计划只写了"非目标"，没写"为什么我们的 MVP 比 CordysCRM 薄这么多"的锚点。
2. **Phase 2/3 的 3 个关键决策（详情 Drawer 是否带自定义字段骨架 / 商机是否仍砍 Kanban / 公海回收规则是否现在做）需要在开工前拍板**，因为 CordysCRM 证明了这 3 点是 CRM 体验的分水岭。

> 其余 D1–D22 决策依然成立，不需要推翻。我们的 Mock 先行 + 接口先行策略是对的——CordysCRM 是 Java 微服务 + Vue 全栈，我们 Next.js 单体前端 + Mock 后端，定位不同（我们是要"在 Dashboard 里嵌入一个能演示的销售闭环"，不是"再造一个开源 CRM"）。

---

## 1. CordysCRM 实际交付范围（已核对代码，非 README 宣传）

| 维度 | CordysCRM 实况 | 我们的 MVP 计划 |
|---|---|---|
| 技术栈 | Vue3 + Spring Boot 微服务 + NaiveUI | Next.js + React + shadcn + Mock API |
| 业务域 | **9 域全做**：客户/线索/商机/报价/产品/合同/订单/回款/发票/标讯 + 工作台 + AI 助手 | 仅：**客户（深）+ 线索（深）+ 商机（浅只读）+ 公海（浅）** |
| 自定义字段 | ✅ **核心抽象**（form-design 拖拽设计器 + formula 公式引擎，52 个 business 组件里有 8 个专门做这个）| ❌ D5 明确 MVP 不上，仅留 `FieldDefinition` 接口 |
| 商机 Kanban | ✅ `crm-stage-board` 拖拽换阶段（1093 行 opportunityTable.vue）| ❌ D8 砍，MVP 仅列表 |
| 详情形态 | 侧拉 Drawer（Tabs：基本信息/跟进/相关/日志）+ 上一条/下一条 | ✅ D9 同决策（Drawer）|
| 跟进 | 每个实体都有 FollowTimeline 多态 | ✅ 计划有 `crm-follow-timeline` |
| 公海/线索池 | 真实回收规则引擎（超时回收 + 领取冷却）| ⚠️ MVP 仅 `ownerId=null` 视图，无回收规则 |
| 审批流 | ✅ `@antv/x6` 流程图 + 审批面板 | ❌ 非目标 |
| BI | iframe 嵌 DataEase | ❌ 用本仓库已有 `components/ui/chart.tsx`（计划 D 已确认）|
| AI | ✅ `/agent` 独立页 + CRM Skills（OpenClaw/WorkBuddy）| ❌ 非目标（本仓库已有独立 ai-chat 模块）|
| 系统管理 | RBAC + 数据权限 + 操作日志 + 业务设置 | 仅 `roles` 过滤 + mine/all 两档 scope（D2/D11）|

**结论**：CordysCRM 是"生产级全功能 CRM"，我们是"Dashboard 内的销售闭环演示片段"。两者不在一个量级，**不应该直接对标功能广度**。

---

## 2. 我们的方案做对了什么（对照 CordysCRM 验证）

| 决策 | CordysCRM 印证 | 评价 |
|---|---|---|
| D9 侧拉 Drawer 详情 | CordysCRM 全量用 `crm-overview-drawer` 同范式 | ✅ 正确，UX 范式对齐 |
| D4 Mock 先行 + 接口契约 | CordysCRM 靠 `lib-shared` 解耦前后端；我们 `CrmClient` 接口同思路 | ✅ 正确 |
| D12 不引 React Query，自写 `useApi` | CordysCRM 用 Pinia + 自写；重型库非必需 | ✅ 正确 |
| D20 sidebar 集成主文件 | CordysCRM 也集中配路由菜单 | ✅ 正确 |
| 三层组件分层（pure/business/view）| CordysCRM 正是 `pure(34)/business(52)/views(~30)` | ✅ 我们 `ui/` + `crm/` + `app/dashboard/crm/` 同构 |
| View 薄壳原则 | CordysCRM customer.vue 仅 22 行 | ✅ 我们 `customers/page.tsx` 薄壳一致 |
| D5 写死字段、留 `FieldDefinition` | CordysCRM 证明自定义字段是"另一个量级的复杂度"（8 个组件 + 公式引擎）| ✅ **延迟正确**——MVP 阶段上自定义字段会爆炸 |

> **重点**：CordysCRM 用 8 个组件 + 公式引擎才撑起"自定义字段"，这反过来证明我们 D5/D6/D7 把自定义字段/公式/表单设计器推到 V2+ 是**明智的减法**，不是偷工。

---

## 3. 需要打磨的 3 处（开工 Phase 2 前必须拍板）

### 3.1 商机 Kanban（D8）是否真砍——建议维持砍，但计划要补一句

CordysCRM 商机体验的"灵魂"是 `crm-stage-board` 拖拽看板。我们 D8 砍了，Phase 3 只做"列表+详情只读"。

- **风险**：如果业务方预期"CRM 当然要有商机看板"，Phase 3 交差时会落差大。
- **建议**：维持 D8 砍（MVP 时间盒不够），但**在计划 §2.2 非目标里补一行**："商机 Kanban 看板是 CordysCRM 的核心体验，但属 V2；MVP 用列表 + 状态徽章替代，确保阶段流转可读"。
- **动作**：小改计划文案，不改代码。

### 3.2 公海"回收规则"是否在 MVP 做——建议 MVP 仍不做自动回收

CordysCRM 公海有"超时自动回收 + 领取冷却"。我们 MVP 仅 `ownerId=null` 视图 + 手动移入/领取。

- **风险**：无自动回收 = 公海会"只进不出"（除非手动），演示时能跑通领取闭环，但不符合真实 CRM 心智。
- **建议**：MVP 维持手动模式（D 已确认"自动回收规则 V2"），但**Phase 3 验收项里把"领取后能从公海消失、列表刷新"作为硬 DoD**，避免演示穿帮。
- **动作**：计划 §3 公海行补"（MVP 仅手动，无自动回收）"。

### 3.3 详情 Drawer 是否在 MVP 就埋 `FieldDefinition` 渲染骨架——**这是唯一值得认真考虑的升级**

CordysCRM 的 `crm-detail-card` 是"根据 schema 动态渲染字段"。我们计划 C4 `crm-detail-card` 写死字段渲染。

- **现状**：D5 说"写死字段，接口层留 `FieldDefinition` 抽象"。但 D5 的 `FieldDefinition` 目前只在类型层，没有渲染器。
- **选项 A（维持现状）**：Phase 2 直接写死 Customer 字段渲染 `crm-detail-card`，最快，但线索/商机/公海要各写一套。
- **选项 B（小步升级）**：Phase 2 抽一个 `renderField(fieldDef: FieldDefinition, value)` 渲染器 + 每实体一个 `FIELD_DEFS` 常量数组。多花 ~半天，但 Phase 3 线索/商机详情**直接复用同一个 Drawer + 换 FIELD_DEFS**，省下重复开发，且天然对齐 CordysCRM 的 schema 范式。
- **建议**：**选 B**。它不违背 D5（仍是"写死字段值"，只是把"字段清单"从散落 JSX 提为 `FieldDefinition[]` 数组），却是 CordysCRM 验证过的"一个 Drawer 服务多实体"的关键。ROI 极高。

> 若选 B，计划 §9 组件规格 C4 要补：`crm-detail-card` 接收 `fields: FieldDefinition[]`，内部 `fields.map(renderField)`。

---

## 4. 方案文档本身的 2 个待修项（非功能，纯文档健康）

| # | 问题 | 修法 |
|---|---|---|
| D-1 | `CRM-MVP-PLAN.md` 顶部仍写「🚧 启动前（Day 0 待开工）」，但实际已合并 PR #128 + #129，到 Phase 1 收尾 | 顶部改「🚧 Phase 1 完成，Phase 2 待开工」；补 §0 进度日志一行（PR #129 合并）|
| D-2 | 计划没锚定"我们 vs CordysCRM 的代差"，reviewer 易误判 | 在 §2.2 非目标段首加一句："本 MVP 定位为 Dashboard 内销售闭环演示片段，非对标 CordysCRM 全功能；自定义字段/公式/表单设计器/Kanban/合同/订单/AI 均按 D5–D8/D19 推 V2+，详见 `docs/cordys-crm-analysis.md`" |

---

## 5. 是否需要"继续打磨方案"——最终裁定

| 问题 | 答案 |
|---|---|
| 方案大方向错了吗？ | **否**。Mock 先行 + 接口契约 + 三层分层 + Drawer 范式，全部被 CordysCRM 印证。 |
| 决策 D1–D22 要推翻吗？ | **否**。仅 D8（Kanban）维持砍但补文案；D5 维持写死但建议 Phase 2 抽 `FIELD_DEFS` 渲染器（不违背 D5）。 |
| 功能范围要扩吗？ | **否**。10 工作日时间盒 + 砍范围策略正确，CordysCRM 证明全功能是一个团队级工作量。 |
| 方案文档要补吗？ | **是（小补）**。§3.2 公海补手动说明、§2.2 补代差锚点、顶部状态更新、§9 C4 补 FieldDefinition 渲染器（若选 B）。 |
| 现在该干嘛？ | **直接进 Phase 2**，落地详情 Drawer + 表单 + 跟进；开工前就 3.3 选 B 拍板即可。 |

---

## 6. 给下一步 agent 的 3 条硬指令

1. **不要因为 CordysCRM 功能多就扩 MVP 范围**——它的全功能恰恰证明"自定义字段+公式+表单设计器"是独立量级的工程，我们推 V2+ 是对的。
2. **Phase 2 抽 `FIELD_DEFS` + `renderField`**（选项 B），让线索/商机详情复用同一个 Drawer，这是对照 CordysCRM 后最值得吸收的"范式升级"，且不增加 MVP 风险。
3. **Phase 3 公海验收必须含"领取后列表刷新、公海项消失"**，否则手动模式演示会穿帮。

**版本**：v0.1 · 2026-07-18
**关联**：`docs/CRM-MVP-PLAN.md`、`docs/cordys-crm-analysis.md`、`openSourceProjects/CordysCRM`
