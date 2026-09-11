# Sidebar 合并：撤销「Agent 中心」，回归运营统一导航

**Goal:** 撤销 2026-09-05 引入的第 9 个顶级分组「Agent 中心」，把它与「运营」合并为一条统一业务导航——`数据流总览` 置顶、`Agent 接入管理` 置底、中段按业务类型排列；`报表自动化` 回归「报表中心」。URL 全部不动，只改分组归属与顺序。

**Architecture:** 纯配置改动，收敛在 `frontend/lib/sidebar-config.ts`（唯一数据权威）。terminal rail / subnav / 移动端抽屉 / ⌘K 命令面板 / 最近访问全部由该文件派生，**零组件改动、零路由改动、零后端改动**。

**Tech Stack:** Next.js 16 + Vitest。

---

## 一、决策记录（2026-09-11 用户拍板）

1. **撤销分家的根因**：Agent 与运营人员**同用一套前端**。2026-09-05 按「Agent 是否为页面主角」在 L1 rail 上分出两个顶级入口，结果是同一批页面被切成两组，使用者要在两组之间来回找。
2. **合并形态**：`operations`（运营）成为唯一业务入口，五项原「Agent 中心」条目全部并入：
   - `数据流总览` 置顶（全业务域产出 / 活动归集点，两类使用者共同的前门；且与 `Agent 员工` 同属 `agent-center` 页族，与总览构成「总览 → 员工」叙事）；
   - `Agent 员工` 紧随总览；
   - 中段 = 各类型业务页面；
   - `Agent 接入管理` 置底（凭据即员工身份，属体系运维，日常不用）。
3. **`报表自动化` 回归 `reports`**：与 2026-07 确立的「一切产出报表 / 核算单的入口统一归 `reports`」一致；上一版把它放进「Agent 中心」是当时按「Agent 写侧」划线的副产物。
4. **URL 一律不动**：单页权限、`dashboard-route-meta.ts`、收藏 / 外链、`lib/agent-domains.ts` 的 `dashboardPath` 全部不受影响；本次不引入 `/dashboard/agent-center/*` → `/dashboard/operations/*` 的迁移（见 §四）。

---

## 二、改动清单

### T1 `frontend/lib/sidebar-config.ts`

- 删除 `agent` 分组（原第 6 组）与 `IconMap.Bot`（及 `Bot` import，删后无引用）；
- `operations` 组：`数据流总览` + `Agent 员工` 插入组首，`客户消息`（保留 `matchPrefixes`）、`平台巡检` 插在中段，`Agent 接入管理` 追加组尾；
- `reports` 组：`报表自动化` 紧跟在 `定时报告` 之后（同属「自动化产出」语义）；
- 组头注释：把原「A/B 档归类门规」替换为本次的归位规则与理由，保留方案路径引用；
- 全局编号注释 9 组 → 8 组重排。

### T2 `frontend/lib/sidebar-config.test.ts`

守卫使用者可观察的导航契约，替代上一版的「Agent 中心」断言：

| 断言 | 守卫内容 |
|------|----------|
| 顶级分组 id 序列 | 恰为 `operations / reports / finance / advertising / ai / crm / tools / system`，且 `agent` 不存在 |
| 首尾 | `operations` 首项 = `/dashboard/agent-center/overview`；末项 = `/dashboard/system/agent-management` |
| 归属 | 五项 Agent 体系页面均在 `operations`，且 `/dashboard/system/agent-management` 不在 `system` |
| 中段不丢项 | 原 14 项运营页面一个不少 |
| `reports` | 含 `/dashboard/reports/auto-upload`，紧随 `scheduled-reports`，且不在 `operations` |
| 全局 URL 唯一 | 无重复 |
| `matchPrefixes` | 客诉中心 `/list` 子页、Agent 员工子页均命中 `operations` |

### T3 `frontend/components/terminal/terminal-rail.tsx`

注释同步：`9 大业务域图标` → `8 大业务域图标`（两处）。无逻辑改动。

### T4 本文档

`docs/superpowers/plans/2026-09-11-sidebar-merge-agent-operations/`，供后续回看归位规则。

---

## 三、验证

- `pnpm exec vitest run lib/sidebar-config.test.ts` → 8 passed；
- `pnpm test`（全量）、`pnpm lint`、`pnpm build`；
- 人工冒烟（部署后）：L1 rail 只剩 8 个图标；L2 subnav 首项「数据流总览」、末项「Agent 接入管理」；「报表自动化」出现在报表中心组；⌘K 搜「平台巡检」等条目的分组归属正确。

---

## 四、Review：本次不改、建议后续处理

按用户「还有什么地方可以调整」的要求给出，**均不在本次改动范围内**。

1. **`operations` 组 19 项无分组头**（最高优先）。合并后 L2 subnav 是一条 19 项的平铺长列表，比之前 6 + 14 两组更难扫读。建议给 subnav 引入分隔线 / 分段标题（如「总览 · 员工」「站点店铺」「销售退货」「商品库存」「履约」「系统运维」），把中段再做一次视觉分组。注意 `terminal-subnav.test.tsx` / `terminal-rail.test.tsx` 用自带 fixture，改动面可控。
2. **中段顺序仍是历史追加序**。当前为 站点导航 → 店铺导航 → 销售数据 → 退货分析 → 项目目标 → 调研分析 → 客户消息 → 平台巡检 → 库存分析 → 按周产品分析 → 组合分析 → SKU 信息 → 补货分析 → 库存分类账 → 季节性补货分析 → 发货管理。`库存分析` 与 `补货分析 / 库存分类账 / 季节性补货` 家族被商品分析块隔开。建议按类型重排为：站点店铺 → 销售退货 → 商品（SKU / 按周 / 组合）→ 库存（库存分析 / 补货 / 季节性补货 / 库存分类账）→ 履约（发货管理）→ 战略调研（项目目标 / 调研分析）→ 客户消息 / 平台巡检。
3. **命名碰撞（上一版遗留，仍未解）**：
   - `客户消息`（`/operations/complaint-center`）与 `客服交流`（`/ai/customer-service`）；
   - `Agent 员工`（`/agent-center/employees`）与 `数字员工`（`/ai/digital-employees`）+ `虚拟办公室`。
   合并后同类入口分散在「运营」与「AI 智能」两组，靠名字区分的成本更高。建议先明确「Agent 员工 = 接入过的 Agent 身份 / 数字员工 = 产品化拟人员工」的口径，再决定是否改名或迁移。
4. **`广告分析`（`/advertising/ad-analysis`）与 `AI 广告分析`（`/ai/ad-analysis`）双入口**：同一分析面的两种呈现，若已收敛为一条路径，sidebar 应二选一。
5. **URL 与分组名不符**：`operations` 组内含 `/dashboard/agent-center/*`、`/dashboard/system/agent-management`。若希望 URL 结构也体现「一个系统」，可把 `agent-center/*` 迁到 `/dashboard/operations/*` 并加 308 重定向——改动涉及路由、`dashboard-route-meta.ts`、`agent-domains.ts` 的 `dashboardPath`、crawl 测试与外部收藏，建议单独 issue 评估，不混在本次。
6. **页面注释里的「Agent 中心」字样**：`agent-overview-client.tsx`、`employees-client.tsx`、`use-agent-domain-summary.ts`、`use-agent-production.ts` 的文件头注释仍写「Agent 中心 · …」。这些是内部注释、对用户不可见（已确认页面无该文案），本次不追改；若 §5 决定迁 URL，可一并统一措辞。
7. **`sidebar-config.ts:52` 引用已不存在的 `pin-settings` 组件**：全仓已无该文件，注释是历史残留，易误导后续改动者以为存在固定（pin）机制。建议随下次改动清掉这一句。

---

## 五、风险与回滚

- 风险极低：单文件数据改动 + 一处注释；派生组件与移动端抽屉自动跟随；无 URL / 权限 / 后端变更。
- 无持久化 group id（已核：全仓无 `pin-settings` 组件，`localStorage` 只存 recents / 布局 / 全局筛选，均按 URL 或布尔值存，不存 group id），因此不存在「旧分组残留」脏数据。
- 回滚 = revert 单个 commit。
