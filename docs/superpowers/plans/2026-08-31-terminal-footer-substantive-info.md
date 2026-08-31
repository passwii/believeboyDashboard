# Terminal UI Footer 实质化改造 — 系统性规划（BLF-918）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Terminal Footer（36px 高度、多频道滚动 Ticker 架构）基础上系统性增加实质性信息频道，分 Stage 落地，每 Stage 独立可交付、可回滚。

**Architecture:** 保持「频道开关集中于 `TERMINAL_TICKER.channels` 常量 + 每频道独立 hook + 单频道失败只降级本频道」的既有三层架构（BLF-816 契约）。每个新频道 = 新增一个 `use-*.ts` hook（`frontend/lib/hooks/`）+ `terminal-footer.tsx` 加一个频道段 + `terminal-constants.ts` 加一个开关 + 单测。右侧固定区按「高频可点击状态徽标」方向增强（告警、报表上传）。数据源全部复用既有后端端点，**本规划零后端改动**（Stage 4 的 footer 专用聚合端点为可选的后续跟进项，需要后端 Damon 配合，不在本 plan 范围内）。

**Tech Stack:** Next.js 15 (App Router) + React 19 hooks + Vitest + Testing Library；后端 FastAPI（只读消费）。

## 现状盘点（2026-08-31，基于 origin/main d47389e2）

### Footer 当前结构（`frontend/components/terminal/terminal-footer.tsx`）

**Ticker 滚动频道（左段，超宽才滚动）：**

| 频道 | 开关键 | 数据源 | 轮询 |
|------|--------|--------|------|
| 汇率 | `fx` | `GET /api/exchange-rates?pageSize=500`（Next 代理）→ 全币种最新两条月度环比 | 5min |
| 全局快报 | `dailyBrief` | `GET /api/backend/api/v1/daily-analysis/all?project_ids=all&country=US&今天`（BLF-915 哨兵已合入 main d47389e2） | 5min |
| 数据更新时间 | `syncTime` | 复用汇率频道 `lastSuccessAt` | — |
| 更新日志 | `changelog` | `GET /api/changelog-latest`（本地快照） | 一次 |
| 库存预警 | `inventoryAlert` | `GET /api/backend/api/v1/inventory-replenishment-analysis?project_id&country&page_size=1` → `summary.out_of_stock_risk_count`，跟全局筛选 | 5min |

**右侧固定区：** 同步引擎状态点（`status: ok/loading/error`）· 未读通知数（>0 才显示）· BJ/PT 双时区时钟（lg 起显示）。

### 既有架构契约（必须遵守，不引入第二套约定）

1. **频道开关集中在 `TERMINAL_TICKER.channels`**（`terminal-constants.ts:64-75`）：新增/下线频道只改常量不动组件结构。
2. **单频道降级**：hook 失败置 `status: 'error'`、保留上次值或占位 `--`，绝不影响其他频道（`use-daily-brief.ts:80-84` 范式）。
3. **双拷贝无缝 marquee**：`tickerContent(0/1)` 双渲染，分隔符 `│` 规则见 `terminal-footer.tsx:199-207`（首拷贝首段不加，其余全加）。
4. **宽度探测**：`staticWhenContentFits: true` —— 内容欠宽静态展示，超宽按 `scrollSpeedPxPerSecond: 60` 换算时长。
5. **移动端 `<sm` 整个 footer 隐藏**；右侧固定区按 `md`/`lg` 分档显示。
6. **时钟 SSR 规避**：`now` 初始 `null`，挂载后再渲染（`terminal-footer.tsx:60-65`）。
7. **数值 span `font-mono tabular-nums`、中文标签不 mono**（BLF-832 A5）。
8. **测试模式**：hook 全 mock（`vi.hoisted` + `vi.mock`），纯函数 reducer 单测（`reduceDailyBrief` 范式，`use-daily-brief.test.ts`）。
9. **CodeGraph 契约（BEL-93）**：改公共 hook 前跑 `codegraph callers/impact`，PR 写明影响面。

### 用户诉求（BLF-918 issue 原文）

- footer 现状被肯定，**在此基础上**做实质化改造（不推翻重来）。
- 「把必要的信息增加显示，把很多实质性信息加入 footer 区域」。
- 「先产出完整规划，再按阶段分期落地」。
- 「系统性的、有意义的规划和信息增强，而非零散的局部改动」。

---

## 信息价值分层（规划骨架）

按「运营盯盘时看一眼 footer 就该知道什么」组织，四层递进：

- **L1 命中率最高的当日经营数字**（已在：GMV/订单/Pending/库存预警）→ 补环比参照与效率指标。
- **L2 数据可信度信号**（数据是否新鲜、是否完整）→ 报表上传完成度、数据新鲜度分国家展示。
- **L3 风险待办聚合**（需要人去看的点）→ 告警事件计数、（跟进）CRM 待办。
- **L4 环境与协作**（系统/团队在线状态）→ 在线协作人数。

每条信息都必须过「**为何值得常驻 footer**」准入测试：高频查看 + 无需交互即可理解 + 失败可静默降级。不满足的（如项目目标进度——需要先选项目的上下文、广告 ACOS——指标解释成本高）列入候选池不排 Stage。

---

## Stage 划分总览

| Stage | 主题 | 交付物 | 依赖 |
|-------|------|--------|------|
| 1 | 快报频道增强（环比参照 + 广告效率） | `useDailyBrief` 升级：对比昨天/上周同期，GMV/订单带涨跌箭头；新增广告花费/ACOS 数据 | 零后端改动 |
| 2 | 数据可信度频道（报表上传完成度 + 数据新鲜度） | 新频道「报表 N/M」+「数据至 MM-DD」；右侧固定区告警徽标 | 零后端改动 |
| 3 | 风险与协作频道（告警中心 + 在线人数） | 新频道「告警」+ 右侧「在线 N 人」；右侧告警可点击 | 零后端改动 |
| 4 | （跟进项，需后端配合）footer 专用聚合端点 | `GET /api/v1/footer/brief` 一次拉全部频道，减少 N 次轮询 | 后端 Damon |

Stage 1-3 每个都是独立 PR、独立验收、可单独回滚。Stage 4 是性能收敛项，在 Stage 1-3 频道数增多后做才有意义（当前 8 个频道 × 5min 轮询，负担可控）。

---

# Stage 1：快报频道增强（环比 + 广告效率）

## 目标

把「快报」频道从 3 个绝对值（GMV/订单/Pending）升级为带环比参照的经营快照，并补广告侧数字。解决「看到 GMV $12,345 但不知道好坏」的问题。

## 设计决策

- **环比基准 = 美西昨天 + 上周同日**（`start_date=end_date=目标日`，两次轻量请求）。对比口径与快报同端点同参数（country=US、project_ids=all），保证可比性。
- **广告数字用同一 `/daily-analysis/all` 响应**：`summary_rows` 里已含 `ad_spend` / `ad_orders`（`backend/app/services/daily/aggregation.py:108-109`），零额外请求。
- **呈现**：GMV / 订单带 `▲▼` 环比着色（复用 `changeColorClass`）；广告花费 + 广告订单数（后续 Stage 4 可加 ACOS = ad_spend/ordered_sales_amount）。
- **Pending 保留绝对值**（无环比意义）。

## Tasks

### Task 1.1：`useDailyBrief` 增加昨日/上周对比与广告字段

**Files:**
- Modify: `frontend/lib/hooks/use-daily-brief.ts`
- Test: `frontend/lib/hooks/use-daily-brief.test.ts`

**Interfaces:**
- Produces: `DailyBrief` 类型扩展为 `{ gmv, orders, pending, adSpend, adOrders, gmvWoW, ordersWoW }`（`*WoW` 为 `(vs昨日涨跌百分比|null)`，命名待定稿见步骤）；hook 返回不变 `{ brief, status }`。

- [ ] **Step 1: 写失败测试** —— 在 `use-daily-brief.test.ts` 增纯函数测试（对 `reduceDailyBrief` 扩展后的行为）：

```ts
it('归约含广告字段与环比：gmvWoW/ordersWoW 按昨日对比计算', () => {
  const today = reduceDailyBrief([{ sales_amount: 1200, order_qty: 10, pending_order_qty: 2, ad_spend: 80, ad_orders: 5 }])
  const yesterday = reduceDailyBrief([{ sales_amount: 1000, order_qty: 8, ad_spend: 60, ad_orders: 4 }])
  expect(today.gmvWoW).toBeCloseTo(20) // (1200-1000)/1000
  expect(today.ordersWoW).toBeCloseTo(25) // (10-8)/8
  expect(today.adSpend).toBe(80)
  expect(today.adOrders).toBe(5)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && pnpm test -- use-daily-brief`
Expected: FAIL（`gmvWoW` undefined / 字段缺失）

- [ ] **Step 3: 最小实现** —— `DailyBrief` 加字段、`reduceDailyBrief` 加 `ad_spend`/`ad_orders` 求和；hook `load` 内并发两次额外请求（昨天、上周同日，参数同今天只是日期不同），请求序号守卫沿用 `requestSeqRef`，三响应齐了再 setBrief；失败整频道降级不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && pnpm test -- use-daily-brief`
Expected: PASS

- [ ] **Step 5: Commit**（中文 Conventional Commits，`feat(终端): 快报频道补环比与广告字段`）

### Task 1.2：Footer 快报频道段升级渲染

**Files:**
- Modify: `frontend/components/terminal/terminal-footer.tsx:125-144`（快报频道 JSX）
- Test: `frontend/components/terminal/terminal-footer.test.tsx`

**Interfaces:**
- Consumes: Task 1.1 的 `DailyBrief` 新字段。

- [ ] **Step 1: 写失败测试** —— mock `briefMock` 返回带 `gmvWoW: 20, ordersWoW: -5, adSpend: 80, adOrders: 5`；断言出现 `▲20%`（text-term-pos）、`▼5%`（text-term-neg）、`广告 $80`、`广告单 5`（双拷贝 `getAllByText`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && pnpm test -- terminal-footer`
Expected: FAIL

- [ ] **Step 3: 实现** —— 快报段在 GMV/订单数值后追加环比 span（`changeColorClass` + `▲▼`/`—`，与汇率频道同款渲染范式 `terminal-footer.tsx:116-118`）；其后追加 `广告`/`广告单` 两对标签+数值。`briefReady` false 时全部 `--`。

- [ ] **Step 4: 跑测试确认通过**（Run: `cd frontend && pnpm test -- terminal-footer`，Expected: PASS）

- [ ] **Step 5: Commit**

### Task 1.3：Stage 1 收口验证

- [ ] `cd frontend && pnpm lint && pnpm build && pnpm test`（全绿）
- [ ] `codegraph impact useDailyBrief`（BEL-93；调用方仅 `terminal-footer`，预期影响面 = footer 渲染，无其他页面消费）
- [ ] PR：`feat(终端footer): 快报频道环比与广告效率（Closes BLF-918 Stage 1）` + 三件套评论

---

# Stage 2：数据可信度频道（报表上传 + 数据新鲜度）

## 目标

运营数字的前提是「数据本身到齐了」。本 Stage 把两条可信度信号搬进 footer：当日报表上传完成度（RPA 状态矩阵聚合）、关键报表最新数据日期。

## 设计决策

- **报表完成度**：`GET /api/backend/api/v1/rpa-reports/status?report_date=今天&country=US`（`backend/app/api/v1/endpoints/rpa_reports.py:13`，响应 `items[].statuses[]` 每 cell `{report_type, has_data, is_uploaded}`）。前端聚合为 `N/M`（M = 项目数×类型数，N = `is_uploaded` true 数）；**缺口 >0 时才显示**（全齐不占用滚动带宽——数据可信是默认态，异常才值得看）。
- **数据新鲜度**：`GET /api/backend/api/v1/daily-analysis/all?project_ids=all...` 响应已含 `available_dates`（`{sales_report: [最新日期], ...}`，`backend/app/services/daily/analysis.py:533-556`），**零额外请求**——由 `useDailyBrief`（Stage 1 改造后的 hook）顺带透出，footer 渲染「数据至 MM-DD」。
- **channel 开关**：`uploadStatus: true` / `dataFreshness: true` 进 `TERMINAL_TICKER.channels`。
- **失败降级**：整频道隐藏（与 changelog 范式一致）。

## Tasks

### Task 2.1：`useReportUploadStatus` hook

**Files:**
- Create: `frontend/lib/hooks/use-report-upload-status.ts`
- Test: `frontend/lib/hooks/use-report-upload-status.test.ts`

**Interfaces:**
- Produces: `useReportUploadStatus(): { uploaded: number | null, total: number | null, missing: number | null, status: 'loading'|'ok'|'error' }`；纯函数 `reduceUploadStatus(items: Array<{ statuses: Array<{ is_uploaded: boolean }> }>): { uploaded: number, total: number, missing: number }`。

- [ ] **Step 1: 写失败测试**（reducer 纯函数：空 items → total 0；三项目各 7 类型、部分 `is_uploaded: true` → 计数正确）
- [ ] **Step 2: 确认失败**（`pnpm test -- use-report-upload-status` FAIL）
- [ ] **Step 3: 实现** —— 复刻 `use-daily-brief.ts` 范式：`todayYMDinTimezone(US_TIMEZONE)`、fetch `/api/backend/api/v1/rpa-reports/status?report_date&country=US`、`requestSeqRef` 守卫、`TERMINAL_TICKER.pollIntervalMs` 轮询、catch 置 error。
- [ ] **Step 4: 确认通过**（PASS）
- [ ] **Step 5: Commit**

### Task 2.2：`TERMINAL_TICKER` 加频道开关 + Footer 渲染两频道

**Files:**
- Modify: `frontend/components/terminal/terminal-constants.ts`（channels 加 `uploadStatus: true`、`dataFreshness: true`）
- Modify: `frontend/components/terminal/terminal-footer.tsx`
- Test: `frontend/components/terminal/terminal-footer.test.tsx`

**Interfaces:**
- Consumes: Task 2.1 hook；`useDailyBrief` 透出的 `available_dates` 最新日期（Stage 1 Task 1.1 中若未透出，本任务补：`DailyBrief` 加 `latestSalesDate: string | null`）。

- [ ] **Step 1: 写失败测试**：
  - 上传缺口：`uploaded: 20, total: 21` → 出现 `报表 20/21`（text-term-warn 高亮）；全齐 `21/21` → 频道不渲染（`queryByText(/报表/)` null）。
  - 新鲜度：`latestSalesDate: '2026-08-30'` → 出现 `数据至 08-30`。
  - 开关关：`channels.uploadStatus = false` → 不渲染（契约断言，复刻 BLF-840 范式 `terminal-footer.test.tsx:200-213`）。
- [ ] **Step 2: 确认失败**（FAIL）
- [ ] **Step 3: 实现** —— channels 数组按既有模式加两段（`uploadStatus` 段：label「报表」+ `N/M` mono，missing>0 时 `text-term-warn`；`dataFreshness` 段：label「数据至」+ MM-DD）；`channels` useMemo 依赖数组补新值。
- [ ] **Step 4: 确认通过**（PASS）
- [ ] **Step 5: Commit**

### Task 2.3：Stage 2 收口验证

- [ ] `cd frontend && pnpm lint && pnpm build && pnpm test`
- [ ] `codegraph impact TerminalFooter`
- [ ] PR：`feat(终端footer): 报表上传完成度与数据新鲜度频道（Closes BLF-918 Stage 2）` + 三件套

---

# Stage 3：风险与协作频道（告警 + 在线人数）

## 目标

把「现在需要有人去看的事」聚到 footer：告警中心 active 事件计数（critical/warning 分级着色）+ 团队在线人数（presence）。

## 设计决策

- **告警**：`GET /api/backend/api/v1/alerts/stats`（无 project_id = 全局，响应 `{total_active, critical_count, warning_count, ...}`，`backend/app/api/v1/endpoints/alerts.py:200-231`）。渲染进 Ticker 频道：`total_active > 0` 时「告警 N」（critical>0 红 `text-term-neg`，仅 warning 黄 `text-term-warn`，0 则不渲染——正常态不占带宽）。
- **在线人数**：`GET /api/backend/api/v1/system-management/presence`（响应 `{server_time, items}`，`backend/app/api/v1/endpoints/presence.py:74-80`，`items.length` 即活跃用户数，90s 过期口径后端定）。渲染进**右侧固定区**（与时钟同区、`lg` 起显示）：`N 人在线`。
- **presence hook 仅挂在 footer**（不发 heartbeat——footer 是观察者不是上报者；heartbeat 属于页面级行为，不扩大 footer 职责）。
- **告警频道**开关 `alertEvents: true`；在线人数为右侧固定段，不走 channels 开关（与同步引擎状态同层级）。

## Tasks

### Task 3.1：`useAlertStats` + `usePresence` 两个 hook

**Files:**
- Create: `frontend/lib/hooks/use-alert-stats.ts`
- Create: `frontend/lib/hooks/use-presence-count.ts`
- Test: `frontend/lib/hooks/use-alert-stats.test.ts`（reducer：`critical 2 / warning 3` → `severity: 'critical'`；全 0 → `'none'`）

**Interfaces:**
- Produces: `useAlertStats(): { totalActive: number | null, criticalCount: number | null, warningCount: number | null, status }`；`usePresenceCount(): { online: number | null, status }`。

- [ ] **Step 1: 写失败测试**（alert stats reducer 纯函数）
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（两 hook 均复刻 `use-daily-brief` 范式；alerts 轮询 5min（告警变化低频）；presence 轮询 60s（在线状态分钟级时效）——轮询间隔分别独立常量，不挤占 `pollIntervalMs`）
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: Commit**

### Task 3.2：告警频道 + 右侧在线人数渲染

**Files:**
- Modify: `frontend/components/terminal/terminal-constants.ts`（channels 加 `alertEvents: true`）
- Modify: `frontend/components/terminal/terminal-footer.tsx`
- Test: `frontend/components/terminal/terminal-footer.test.tsx`

- [ ] **Step 1: 写失败测试**：
  - `totalActive: 5, criticalCount: 2` → `告警 5` 双拷贝 + text-term-neg；
  - `totalActive: 3, criticalCount: 0` → text-term-warn；
  - `totalActive: 0` → 频道不渲染；
  - `online: 4` → 右侧出现 `4 人在线`；
  - `channels.alertEvents = false` → 不渲染（契约断言）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现** —— 告警段进 channels；`usePresenceCount` 结果进右侧双时区时钟同区（`terminal-footer.tsx:300-304`），段间 `border-l` 分隔；`online == null` 时隐藏该 span。
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: Commit**

### Task 3.3：Stage 3 收口验证

- [ ] `cd frontend && pnpm lint && pnpm build && pnpm test`
- [ ] `codegraph impact TerminalFooter`
- [ ] PR：`feat(终端footer): 告警事件频道与在线人数（Closes BLF-918 Stage 3）` + 三件套

---

# Stage 4（跟进项）：footer 专用聚合端点 — 需后端配合，不在本 plan 实施

**为何需要**：Stage 1-3 落地后 footer 将有 8 个数据源（汇率、快报×3 请求、库存预警、报表状态、告警、presence），各自 5min/60s 轮询。终端多人同时在线时，同一批慢端点被重复打。

**方案（交后端 Damon）**：`GET /api/v1/footer/brief` 一次返回全部频道载荷（汇率可继续走既有端点、changelog 留本地），后端可对各子查询并发聚合 + 60s 缓存。前端改造点：各 hook 改从聚合端点取数（接口不变，只换数据来源），`TERMINAL_TICKER.pollIntervalMs` 统一为唯一轮询。

**触发条件**：Stage 1-3 全部合入、且观察到 footer 轮询成为可感知负载（或用户反馈慢）时启动。需要 issue 评论 @后端工程师 Damon 对齐契约。

---

# 候选池（已评估、暂不排期）

| 信息 | 结论 | 原因 |
|------|------|------|
| 项目目标进度 | 暂缓 | 依赖「当前项目」上下文；footer 是全局视角，放全局筛选选中项目会与「全部项目」快报口径打架 |
| 广告 ACOS | 并入 Stage 1 后续微调 | `ad_spend`/`ordered_sales_amount` 已在快报响应里，ACOS 是展示格式问题，不值得单独 Stage |
| 退货率 | 暂缓 | `return-analysis` 端点按 project 维度，无全局聚合；强行取单项目口径会误导 |
| 发货在途 | 暂缓 | `in_transit_qty` 在 detail_rows，无全局合计；意义对运营不如库存预警直接 |
| CRM 待办 | 暂缓 | `crm follow-ups` 有全局计数端点，但用户群（运营 vs 销售）与 footer 受众重叠度待验证 |
| 汇率异动阈值告警 | 暂缓 | 需要阈值配置 UI，属 alert-rules 体系而非 footer |
| 系统健康（DB/Redis） | 暂缓 | `/health` 需 API key（`require_api_key`），footer 前端无凭据；同步引擎状态点已覆盖「后端可达性」语义 |

---

# 全局约束（每任务隐含遵守）

- 分支：`agent/seth/<run-id>`；commit author `jr.way123@gmail.com / DamonRock`（BEL-153，Vercel 部署门禁）。
- 中文 Conventional Commits；PR 标题带 `Closes BLF-918`（Stage 1-3 各自 PR 用 `Refs BLF-918`，仅最后一个 Stage 的 PR 用 `Closes`——issue 由用户确认整体完成后关闭，或由最终 Stage PR 关闭）。
- 测试顺序：`pnpm lint` → `pnpm build` → `pnpm test`；每 Stage 全绿才提 PR。
- 公共 hook 改动前 `codegraph callers/impact`，PR 描述写明影响面结论（BEL-93）。
- 不改 `TERMINAL_FOOTER_HEIGHT`（36px，BLF-887 用户刚确认过高度）；新内容全部走 Ticker 滚动带宽或既有右侧区段，不撑高。
- 本 plan Stage 1-3 **零后端改动**；所有端点契约以 main 当前实现为准（`daily-analysis/all` 哨兵 = d47389e2 已合入）。

# Self-Review 记录

- 覆盖度：用户四个诉求点（增加显示 / 实质信息 / 先规划 / 分 stage）分别映射 → Stage 1-3 信息扩展、Stage 划分本身、本文档、每 Stage 独立交付。
- 占位符扫描：无 TBD/TODO；每任务有测试代码与验证命令。
- 类型一致性：`DailyBrief` 扩展字段在 Task 1.1 定义、1.2 消费；`reduceUploadStatus` 在 2.1 定义、2.2 消费。
- 已知风险：`/daily-analysis/all` 对比请求 ×3（今天+昨天+上周）可能触发后端负载——已通过 project_ids=all 哨兵 + 既有 Redis 缓存评估，若实测慢，Stage 4 聚合端点收敛。
