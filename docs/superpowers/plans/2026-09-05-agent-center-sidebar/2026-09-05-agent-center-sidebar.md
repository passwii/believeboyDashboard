# Agent 中心 — Sidebar 独立分类（Phase 1）

**Goal:** 新增第 9 个 sidebar 顶级分组「Agent 中心」，归集 Agent 员工产品线的运维工具与 A 档产出页面；URL 全部不动，只改分组归属。为后续 Agent 数据流总览页预留归集点。

**Architecture:** 纯配置改动，全部收敛在 `frontend/lib/sidebar-config.ts`（唯一数据权威，pin-settings / search-command / terminal rail / subnav 全部自动派生）。**零组件改动、零路由改动、零后端改动。**

**Tech Stack:** Next.js 15 + Vitest（纯数据模块测试，不依赖 jsdom）。

## 背景与决策记录（2026-09-05 讨论）

1. **愿景前提**：数字员工实做尚少，原设想即 Agent 员工。因此「Agent 中心」直接作为 Agent 员工产品线的家（员工 → 产出 → 接入三段叙事），与「AI 智能」组（纯 AI 能力：chat / 洞察 / 模型选型 / AI 广告分析）不冲突。
2. **归类门规（核心决策）**：按「Agent 是否为页面主角」划线，不按「背后有无 agent 端点」——后者不可执行（`AGENT_DOMAINS` 已 16 域，几乎覆盖全业务面）。
   - **A 档（迁入）**：Agent 是数据主要生产者，或页面本身是 Agent 体系运维工具。
   - **B 档（暂不迁）**：域工作台，agent 只是也能读写（SKU 信息 / 发货管理 / 库存分类账 / 销售数据 / 补货分析 / 各测算）。留在业务分组，待数据流总览页上线后按实际使用数据再评估。
3. **迁移方式**：只挪 sidebar 分组归属，**URL 保持原路径**——单页权限、`dashboard-route-meta.ts`、已有收藏 / 外链全部不受影响；高频用户可用 pin 固定入口，日常路径不变。
4. **命名**：Phase 1 不改名。`客诉中心` 与 AI 组 `客服交流` 的命名碰撞、是否更名「客服中心」，另行讨论后单独处理。

## Phase 1 范围（本 plan）

### A 档迁入清单（4 项）

| 页面 | URL（不变） | 原分组 | 迁入理由 |
|------|------------|--------|---------|
| 客诉中心 | `/dashboard/operations/complaint-center` | 运营 | Agent 每日巡检客诉写入（`complaint_center` 域，BLF-981），人只消费 |
| 平台巡检 | `/dashboard/operations/platform-inspection` | 运营 | Agent 写侧（模板 / 提交报告 / 截图上传），人看产出 |
| 报表自动化 | `/dashboard/reports/auto-upload` | 报表中心 | Agent / RPA 报表上传数据流（`report_upload` + `report_upload_status` 域） |
| Agent 接入管理 | `/dashboard/system/agent-management` | 系统管理 | Agent 体系运维工具（凭据即员工身份、用量、技能指南） |

### 任务清单

- [ ] **T1** `frontend/lib/sidebar-config.ts`：
  - 新增顶级分组 `{ id: 'agent', label: 'Agent 中心', icon: Bot }`，插在 `ai` 组之后、`crm` 组之前（第 9 组，编号注释 1-9 重排）；
  - 四项按上表迁入，title / url / icon 逐字保留（客诉中心补 `matchPrefixes: ['/dashboard/operations/complaint-center']`，修复 `/list` 子页不高亮分组的既有问题）；
  - 原 `operations` / `reports` / `system` 三组移除对应行，更新各组头注释；
  - 在新组注释中写死 A/B 档门规，防止后续按「有无 agent 端点」误搬 B 档。
- [ ] **T2** 新增 `frontend/lib/sidebar-config.test.ts`（首个真引 `SIDEBAR_TOP_GROUPS` 的守卫测试）：
  - `agent` 组存在、label 正确、位于 `ai` 与 `crm` 之间；
  - 四项 URL 在 `agent` 组内且不在原组内；
  - 全局 URL 无重复（回归守卫）；
  - `findGroupByPathname('/dashboard/operations/complaint-center/list') === 'agent'`。
- [ ] **T3** 验证：lint → vitest（`sidebar-config.test`）→ build（环境受限时降级策略见下）。

### 明确不做（Phase 1 边界）

- 不改任何页面组件 / 路由 / 权限 / `dashboard-route-meta.ts`；
- 不迁 B 档页面；
- 不做数据流总览页（Phase 2，基于 `report_upload_status` 矩阵 + `agent_api_audit` 扩展为全 16 域 Agent 活动矩阵，独立 plan）；
- 不处理 `客诉中心` / `客服交流` 命名合并。

## 验证

- `pnpm lint` / `pnpm test`（`lib/sidebar-config.test.ts`）/ `pnpm build` 全绿；
- 人工冒烟：rail 上出现「Agent 中心」组且位于 AI 智能之后；客诉中心 `/list` 子页时分组高亮正确；pin / 命令面板搜「客诉中心」「Agent」结果指向新分组。

## 环境备注（本机）

本 Windows 检出无 node / pnpm，仅 bun 1.4.2。验证用 `bun install` + `bun run` / `bunx` 执行（bun 运行脚本时以自身替代 node shim）；`sidebar-config.test.ts` 为纯数据模块测试不依赖 jsdom，bun 下可跑。若 `next build` 在 bun 运行时下因非本次改动原因失败，以 lint + vitest 结果为准并在交付说明中注明，build 留给 CI / 用户本机复验。装依赖产生的 `bun.lock*` 验证后清理，不进 commit。

## 风险与回滚

- 风险极低：数据单源改动，派生组件自动跟随；terminal rail/header/subnav 测试自带 fixture（只引类型），不受影响。
- 回滚 = revert 单个 commit；用户无感知迁移（URL 未动）。

## 后续（不在本 plan）

1. **Phase 2 数据流总览页**：全 16 域 Agent 活动矩阵（最近写入 / 写入量 / 健康度），作为未来所有 Agent 上传数据流的归集点；需后端聚合端点配合（@后端工程师 Damon）。
2. **B 档复评**：总览页上线一个迭代后，按访问路径数据决定 SKU / 发货 / 台账等是否迁移。
3. **数字员工迁移**：`digital-employees` / `office` 实做成熟后从 AI 组迁入 Agent 中心「员工」段。
4. **命名清理**：`客诉中心` vs `客服交流` 二选一或明确分工。
