# CRM 漏斗重新设计（讨论产出 · 待推进）

**日期**：2026-07-31
**来源**：与 Damon 的讨论，基于当前 CRM 看板（P6a 阶段）
**状态**：讨论已完成，待 CRM Agent 推进实现

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
- 累计还是阶段？—— **建议阶段漏斗（raw counts，不累计）**，因为 4 级已经很粗，阶段级别能直接看到哪一级堆了人、哪一级掉得快

### 第二层：阶段详情（复盘诊断）

点进某个阶段，展开该阶段的明细面板，回答以下问题：

| 复盘问题 | 需要的数据 |
|----------|-----------|
| 此阶段多少条？当前在此阶段列表 | 该阶段末端所有 leads |
| 平均停留多少天？ | 进入该阶段的时间戳 |
| 最后一次动作是什么？到期没动？ | `CrmFollow` 最后一条记录 + time-to-next-stage |
| 从上一级流进来多少？卡住多少？流失多少？ | 阶段间流转计数 |

### 数据基础

- 后端 `dashboard_service.py` 目前只返回 `lead_funnel: dict[str, int]`（各状态快照计数）
- **不需要改漏斗层级名**——后端只负责给数据
- **需要补的数据**（后端已有或需加）：
  1. `CrmLead` 上的 `last_action_at` / `entered_stage_at`（时间戳）
  2. `CrmFollow` 已有记录，可直接读 last action
  3. 阶段流转计数：按 `status` 变更历史计算（已有 audit log 基础）

---

## 待决策

1. **4 个粗阶段命名**：`线索 → 初次触达 → 推进/报价 → 成交` — 这个分法是否贴合业务？如果需要调整，告诉我
2. **阶段详情面板放哪里**：弹窗？右侧抽屉？下方展开？
3. **阶段 detail 面板里默认展示什么**：卡住在前三名的 leads？还是最近有动作的 leads？
4. **第一层用阶段漏斗还是累计漏斗**：讨论后我倾向于阶段，但你可以再选
5. **是否改后端数据模型**：`entered_stage_at` 这类时间戳是前端自己算（基于 `CrmFollow.created_at`），还是后端要落字段？

---

## 当前相关代码

- 前端漏斗组件：`frontend/components/ui/funnel-chart.tsx`（未改）
- 前端漏斗工具（新建，未 commit）：`frontend/lib/crm/method/lead-funnel.ts` + `.test.ts`
- 前端页面改动（未 commit）：`frontend/app/dashboard/crm/dashboard/page.tsx` — 用了 `buildLeadFunnelStages`、`layers=3`、`grid`、`formatValue={compact}`
- 前端 mock 数据调整（未 commit）：`frontend/lib/crm/api/mock-data/_generator.ts` — 修正权重让快照本身是漏斗形
- 后端漏斗数据来源：`backend/app/services/crm/dashboard_service.py` — 5 级快照，`_LEAD_STATUS_ORDER`
- 后端 schema：`backend/app/schemas/crm.py` line 368 — `lead_funnel: dict[str, int]`
- P6a Task 3 计划：`docs/superpowers/plans/2026-07-30-funnel-chart-visual-issue.md`（已部署，等待决策 X/Y/Z/F）
- P6a Task 4 计划：`docs/superpowers/plans/2026-07-29-crm-p6a-task4-plan-vs-schema-conflict.md`（等用户拍板 A/B）

---

## 推进建议

1. 先确认第一层 4 阶段命名和阶段 vs 累计的选择
2. 确认第二层 detail 面板的交互形式和数据来源
3. 再决定是否要改后端或前端
