# Operations 全域 Header 化改造方案（蓝本：daily-analysis）

> 状态：**实施完成（2026-08-28），待用户业务验收**
> 蓝本：`frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx`
> 日期：2026-08-28
>
> ## 执行记录
>
> | 阶段 | commit | 内容 |
> |---|---|---|
> | Phase 0 | `716f5c10` | HeaderFilterControls 收口为共享组件（替换 7 处拷贝）+ HeaderSlotSelect/HeaderSlotDateRange 原子控件 |
> | Phase 1 | `4fbea9c7` | return-analysis 精细化（控制台上移、7 格磁贴条、导出移位、零圆角） |
> | Phase 2 Batch A | `fa9ab936` | weekly-product-analysis / project-goals / seasonal-replenishment / inventory-ledger（4 subagent 并行） |
> | Phase 2 Batch B | `9d763265` | inventory-replenishment（双模式写语义）/ shipment-management（多 tab 分派）/ sku-info（提交制） |
> | Phase 2 Batch C | `8fac7c6b` | platform-inspection / store-navigation 注册全局刷新；site-navigation / research-analysis 豁免 |
>
> 验证：`pnpm lint`（0 errors）+ `pnpm test`（181 文件 / 1103 用例全过）+ `pnpm build` 通过。
> 分支：`feat/operations-header-migration`。

---

## 0. 背景与现状盘点

### 0.1 蓝本架构（已落地，直接复用）

TerminalHeader（`frontend/components/terminal/terminal-header.tsx`，固定 48px）**分三块**：

| 区块 | 内容 | 机制 |
|---|---|---|
| 左段 | SubNav 开关 + 面包屑（域 › 页面标题） | 固定 |
| 中段 | **HeaderSlot 插槽**（页面 portal 进来的筛选控件）+ 全局筛选四件套（仅试点路由、xl+） | `HeaderSlotMount`（`hidden md:flex`） |
| 右段 | **全局刷新按钮**、⌘K 搜索、通知、Inspector、用户菜单 | 固定 |

核心机制（`frontend/components/terminal/terminal-header-slot.tsx`）：

- `useHeaderSlot(node)`：页面把筛选控件 `createPortal` 进 header 中段；unmount 自动清除。
- `useHeaderRefresh(handler, { loading })`：页面注册全局刷新回调并上报 loading；ref 桥接保证执行最新闭包。
- **BLF-881 兜底**：页面未注册时，刷新按钮走 `router.refresh()`（重取当前路由 server 数据，10s 看门狗防卡死）。

### 0.2 刷新按钮现状与真实差距（用户诉求 #1）

用户诉求：**有数据的页面刷新 = pull 数据/计算刷新（跳缓存）；没数据的页面 = 简单刷新**。

- 机制本身已存在（BLF-881），语义约定与诉求完全一致。
- **真实差距**：`router.refresh()` 只重取 Server Component 数据；operations 各页的数据是 client 端 `useEffect` 拉取的，**未注册页点刷新实际上什么都不发生**。
- ∴ 本次改造的刷新工作 = 让每个有数据的 operations 页面注册 `useHeaderRefresh`（force 跳缓存重拉）；无数据页保持兜底。

### 0.3 operations 页面现状（调研结论）

| 页面 | 数据/缓存 | 现有控制台 | 迁移分批 |
|---|---|---|---|
| daily-analysis | ✅ 2min 缓存，支持 force | 已 header 化（蓝本） | — |
| inventory-analysis | ✅ 2min 缓存，支持 force | 已 header 化 | — |
| portfolio-overview | ✅ 已 header 化 | 已 header 化 | — |
| **return-analysis** | ✅ 2min 缓存，`loadData(force)` | 旧控制台卡（筛选+导出+刷新+7格统计） | **Phase 1 精细化** |
| weekly-product-analysis | ✅ 自建缓存 3/5min，支持 force | 旧控制台 + PageHeader 胶囊 | Batch A |
| project-goals | ✅ 2min 缓存，`loadData(true)` | TermPanel 控制台（项目/站点/年份+刷新） | Batch A |
| seasonal-replenishment | ✅ 2min 缓存，forceNextLoadRef | 控制台（5控件+刷新重算） | Batch A |
| inventory-ledger | 无缓存（6端点 allSettled） | TermPanel（项目/月份+刷新）+ FilterToolbar（4维派生筛选） | Batch A |
| inventory-replenishment | ✅ 2min 缓存，reloadAnalysis force | 控制台（4控件+SnapshotSelector+刷新重算=refreshWithSave） | Batch B |
| shipment-management | 无缓存（8 loader，tab 懒加载） | 控制台混排筛选+写操作 | Batch B |
| sku-info | 无缓存，**提交制查询** | 筛选控制台（5字段+查询/重置） | Batch B |
| platform-inspection | 子组件分散加载（refreshKey） | 无筛选、无刷新按钮 | Batch C |
| store-navigation | fetchManagedProjectsCached | 无筛选、无刷新 | Batch C |
| site-navigation | **静态 server component** | 无 | 豁免（兜底刷新天然适配） |
| research-analysis | 按需按钮加载，重算=POST | 表单式工作台 | **豁免（用户已拍板）** |

### 0.4 已确认的设计决策（用户拍板）

1. **仅插槽化迁移**：不扩展 `GLOBAL_FILTER_PILOT_PREFIXES` 试点。各页把自己的控件 portal 进中段插槽，选项集合保持页面原生（规避 ALL 站点/全部项目后端不支持的状态不一致）。扩展试点留作后续可选项。
2. **sku-info 保持提交制**：5 字段 + 查询/重置按钮整体移进 header 插槽（term 规格），语义不变。
3. **research-analysis 豁免**：保留正文工作台，仅吃 BLF-881 兜底刷新。

---

## 1. Phase 0 — 共享基建收口（我本人执行，前置）

> 目的：`HeaderFilterControls` 目前被复制粘贴在 **7 个文件**里（daily-analysis / inventory-analysis / portfolio-overview / ad-data/top-filters / finance×3）。批量铺开前先收口为单一共享组件，避免 subagent 各自再抄一份走样。

### 1.1 新建 `frontend/components/terminal/header-filter-controls.tsx`

- 以 daily-analysis 版为基准（最完整）：
  - `<md`：折叠为「筛选」Popover（term 规格 trigger + `border-term-border bg-term-panel` 弹层）；
  - `≥md`：`flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden` 平铺。
- 导出 `HeaderFilterControls({ isMobileView, controls })`。
- 新建配套测试 `header-filter-controls.test.tsx`（两形态渲染断言）。

### 1.2 替换 7 处拷贝为共享 import

- `operations/daily-analysis`、`operations/inventory-analysis`、`operations/portfolio-overview`
- `components/dashboard/ad-data/top-filters.tsx`
- `finance/commission-management`、`finance/platform-revenue`、`finance/exchange-rate`
- 纯引用替换 + 删除本地拷贝，行为零变化；跑各页既有测试确认。

### 1.3 新增插槽控件原子（降低 subagent 走样）

在 `frontend/components/terminal/header-filter-suite.tsx` 追加**页面插槽用**泛型控件（复用既有 `TERM_HEADER_TRIGGER` / `TERM_HEADER_W_*` / `TERM_SELECT_CONTENT` 常量）：

```tsx
/** 页面插槽泛型下拉（term 规格；选项集合由页面传入，不做全局假设） */
export function HeaderSlotSelect({ value, options, onChange, widthClass, placeholder, disabled, title })
/** 页面插槽日期范围（term 规格；timezone/onApply 透传） */
export function HeaderSlotDateRange({ value, onChange, onApply, timezone, widthClass })
```

- 不改动 `HeaderProjectSelect/HeaderCountrySelect/HeaderDateRangePicker`（全局四件套专用，试点逻辑不动）。

### 1.4 刷新语义契约（写入共享文档注释，供所有批次引用）

```
页面有数据   → useHeaderRefresh(强制重拉)：fetchOpsJsonCached force:true /
              自建缓存 force / 无缓存页直接重拉；必须 { loading } 上报；
              handler 用 ref 桥接（loadDataRef.current）防过期闭包。
页面有写语义 → 刷新回调保留页面原刷新按钮的完整语义（如 refreshWithSave 先存后刷）。
页面多 tab  → 刷新 = 重拉「当前激活 tab」的数据集。
页面纯表单/静态 → 不注册，吃 BLF-881 router.refresh() 兜底。
注册后      → 删除页内重复的刷新按钮（全局唯一入口）。
```

---

## 2. Phase 1 — return-analysis 精细化（我本人执行，核心交付）

文件：`frontend/app/dashboard/operations/return-analysis/return-analysis-client.tsx`（1416 行）

### 2.1 删除与上移

| 现状 | 去向 |
|---|---|
| Section 1「控制台」卡片标题行（退货分析 控制台） | 删除——标题由 header 面包屑承载（`dashboard-route-meta.ts` 已有「退货分析」） |
| FilterToolbar：项目 Select / CountrySelect / DateRangePicker | portal 进 header 中段：`HeaderSlotSelect`（项目，W_MD）+ `HeaderSlotSelect`（站点，W_SM，**仅 US/DE/UK**，保持页面原生选项集）+ `HeaderSlotDateRange`（W_XL，timezone 跟随站点，onApply→loadData） |
| 控制台 RefreshButton（`loadData(true)`） | 删除 → `useHeaderRefresh(() => loadDataRef.current(true), { loading })` |
| Tab 卡头部 ghost「刷新」按钮（`loadData()`） | 删除（全局刷新唯一入口） |
| 控制台内「导出 Excel」按钮 | 移入 `DataTableCardHeader`，与 Tabs 同行（蓝本 daily-analysis 布局：标题左、导出+Tabs 右） |
| 控制台内 7 格 Summary Stats | 移出为正文第一行 **term 磁贴条**（参照 inventory-analysis `SummaryTile`：`border-term-border bg-term-panel`、mono 大写 label、tabular-nums 数值；整体退货率保留红/黄/绿语义色） |

### 2.2 页面骨架（改造后）

```tsx
<div className="flex min-w-0 flex-col gap-3">
  {headerSlotPortal}                    // 筛选控件已上移
  <SummaryTile 磁贴条（7 格，data 存在时渲染）/>
  <Tabs …>                              // 7 tab 保持 BLF-883 term 激活样式
    <DataTableCard（rounded-none + term 边界，对齐 BLF-872 零圆角方向）>
      <DataTableCardHeader: 标题 + 导出按钮 + TabsList/>
      …表格/图表内容不动…
```

### 2.3 保留不动

- `useSmoothRefresh` + `RefreshProgressBar`（首载 skeleton / 刷新保持内容）逻辑。
- Excel 导出（5 sheet）、全部 tab 内容、图表配置。
- URL 参数（project/country/tab，`useUrlParam`）与 `useAutoSelectFirstProject`。

### 2.4 终端化细节

- 卡片 `rounded-xl` → `rounded-none` + `border-term-border`（与 BLF-872 数据展示类收口一致）。
- tab 内容区表格已是 `Table` 基座，仅补 term 边界/零圆角，不动列结构。

### 2.5 新增测试 `return-analysis-client.test.tsx`

参照 `inventory-analysis-client.test.tsx` 的 mock 模式（`useHeaderSlot: (node) => null`、`useHeaderRefresh: () => ({ setLoading: vi.fn() })`），至少覆盖：

1. 渲染不崩溃（mock fetch/session/notifications）；
2. 头部刷新回调触发 `loadData(force=true)`（fetchOpsJsonCached 收到 `force: true`）；
3. 控制台卡片已移除（断言无「控制台」文案）、导出按钮位于 tab 卡头。

---

## 3. Phase 2 — operations 全域铺开（subagent 并行，我做集成）

> 每个 subagent 任务包 = 本节对应页 spec + 蓝本文件清单（daily-analysis / inventory-analysis 作参照）+ Phase 0 共享件 + 测试与验证命令。**护栏**：只动该页目录与必要测试；不改 `terminal-header*.tsx` / `global-filter-context.tsx`；不加新依赖；不动 `backend/`。

### Batch A —— 直接套模板（4 个 subagent 并行）

**A1 weekly-product-analysis**（2684 行）
- 上移：项目(店铺)/站点/日期 3 控件 → header 插槽（term 规格）。
- 刷新：`useHeaderRefresh` = 重拉**当前激活 tab** 数据集（汇总→`loadWeeklyData({force:true})`；明细→`loadWeeklyDetails({force:true})`），`{ loading }` 取当前 tab 的 loading。
- 删除：控制台卡片、PageHeader 胶囊、控制台 RefreshButton；明细 tab 内局部刷新按钮保留与否随 tab 内既有布局（若与全局入口重复则删）。
- 保留：StatCard 网格、导出、列显隐、LoadingScrim、sticky 表。

**A2 project-goals**（1006 行）
- 上移：项目/站点/年份 3 select → header 插槽。
- 刷新：`useHeaderRefresh(() => loadDataRef.current(true), { loading })`。
- 删除：TermPanel 控制台壳与「刷新」TERM_BUTTON。
- 保留：三环进度、4 统计块、2 tabs、目标 CRUD 弹窗（写后 clearOpsClientCaches+force 逻辑不动）。

**A3 seasonal-replenishment**（1132 行）
- 上移：项目/站点/日期范围/关键词输入/「去年」同比 Switch 5 控件 → header 插槽（Switch 与关键词输入做 term 规格适配，h-9 高度对齐；日期旁天数提示文本随控件进插槽或收敛为 tooltip）。
- 刷新：`useHeaderRefresh` = 原「刷新重算」语义（`forceNextLoadRef.current = true` + 触发重载），`{ loading }` 上报。
- 删除：「季节性补货控制台」卡片壳与刷新重算按钮。
- 保留：权重 Badge、5 格统计条、导出、同比列、口径说明。

**A4 inventory-ledger**（440 行）
- 上移：项目 + 月份 2 控件 + FilterToolbar 4 维派生筛选（SKU/仓库/状态/事件类型）+「清除筛选(N)」→ header 插槽（派生选项随数据更新，portal 天然实时）。
- 刷新：`useHeaderRefresh(() => loadDataRef.current())`（无缓存，直接全量重拉 6 端点），`{ loading }` 上报。
- 删除：TermPanel 控制台壳与「刷新」按钮。
- 保留：总览图表区（lazy）、3 tabs、错误横幅+重试。

### Batch B —— 带语义决策（3 个 subagent 并行，Batch A 集成后启动）

**B1 inventory-replenishment**（1999 行）
- 上移：项目/关键词/站点/风险状态 4 控件 → header 插槽。
- **SnapshotSelector 留正文**（含创建/编辑入口，偏重）。
- 刷新语义（关键）：
  - 非快照模式：`useHeaderRefresh` = `refreshWithSave`（先持久化未保存行编辑再 force 重载）——**完整保留写语义**；
  - 快照模式（原按钮隐藏）：注册 handler 降级为不带 save 的 force 重载，避免快照态误触发保存。
- 保留：CockpitOverview 指挥带、3 tabs、导出、快照 CRUD、发货 Sheet、口径说明。

**B2 shipment-management**（4556 行）
- 上移：项目/状态/国家 3 select + 货件编号可搜索 combobox → header 插槽（combobox 用 term trigger + Command 弹层，参照 SkuSearchField 形态）。
- **写操作留正文**：新建批次/下载模板/批量导入 csv 归入正文 ActionsBar。
- 刷新语义：重拉**当前激活 tab** 数据集（list→`loadList(1)` 保持当前筛选；cost→成本汇总 loader；fba→box 明细 loader）；无缓存可跳，直接重拉。
- 保留：4 动效 tabs、每 tab 导出、CRUD 弹窗、行编辑器、标签下载、lightbox、分页；cost tab 的 DateRangePicker 与 fba tab 自有筛选随各自 tab 留正文。

**B3 sku-info**（2247 行，提交制——用户已拍板）
- 上移：项目名/国家/状态 3 select + SKU/ASIN 2 input + **查询/重置 2 个 term 按钮** → header 插槽；`<md` 折进「筛选」Popover。
- 语义不变：选择/填写不自动查询；点「查询」执行 `loadData`（含「至少填一项」校验，提示走 notify）。
- 刷新：`useHeaderRefresh` = 若当前查询有效则重跑当前查询；无有效查询则 no-op（可 notify 提示「请先填写查询条件」）。
- 保留：5 tabs、ActionsBar（模板下载/批量导入/同步头程运费）、分页、批量 Sheet、标签、lightbox。

### Batch C —— 最小适配（1 个 subagent 或我顺手完成）

- **platform-inspection**：`useHeaderRefresh` = bump `refreshKey` + 重取 currentPeriod；无控件上移。
- **store-navigation**：`useHeaderRefresh` = `fetchStores`（force 跳缓存重拉）；无控件上移。
- **site-navigation**：**零改动**（静态 server component，`router.refresh()` 兜底恰好是正确语义）。
- **research-analysis**：**零改动**（用户拍板豁免；兜底刷新无副作用）。

---

## 4. 测试与验证

### 每页完成标准（subagent 与本人统一执行）

1. `cd frontend && pnpm lint`（biome）
2. `pnpm vitest run <该页测试文件>`
3. 新增/更新页面级测试：断言插槽注册、刷新回调 force 语义、旧控制台移除。

### 集成后全量（我执行）

```bash
cd frontend
pnpm lint && pnpm build && pnpm test
```

- `pnpm build` 特别关注：各页 `force-dynamic` / Suspense 边界无回归（静态预渲染报 Missing Suspense 即回归信号）。
- 全过之后交用户手动业务验收清单：逐页检查 ① header 三块布局与控件齐全 ② 全局刷新按钮在有数据页强刷跳缓存/无数据页兜底刷新 ③ `<md` 筛选 Popover 可用 ④ 导出/写操作未受影响。

---

## 5. 风险与已知限制

| 风险 | 应对 |
|---|---|
| `<md` 视口 HeaderSlotMount 本身 `hidden`，移动端筛选不可见 | 蓝本既有行为，本次保持一致（`HeaderFilterControls` 的 Popover 分支在 md+ 窄屏仍生效）；移动端完整方案另立事项 |
| 大页面（shipment 4556 行 / weekly 2684 行）subagent 改动面大 | spec 精确到「删什么/移什么/留什么」；集成时我逐页 diff review |
| inventory-replenishment 刷新写语义（refreshWithSave）误降级 | spec 明确双模式语义；测试覆盖快照/非快照两分支 |
| 7 处 HeaderFilterControls 拷贝替换波及 finance/ad 域 | Phase 0 纯引用替换、行为零变化，跑全域既有测试 |
| 并行 subagent 撞同一共享文件 | Phase 0 先合入；Batch 内各页只动自己目录；共享件改动只允许走我 |

---

## 6. 执行顺序总览

```
Phase 0  共享基建收口（我）                    —— 前置，1 个 commit
Phase 1  return-analysis 精细化（我）          —— 核心交付，1 个 commit
Phase 2  Batch A ×4 subagent 并行 → 我集成     —— 4 页
         Batch B ×3 subagent 并行 → 我集成     —— 3 页
         Batch C 最小适配（我/1 subagent）     —— 2 页改动 + 2 页豁免
Phase 3  全量 lint/build/test + 业务验收清单交用户
```

提交规范：中文 Conventional Commits（如 `feat(前端): 退货分析页 header 化——控制台上移 Top Header 插槽`），author email `jr.way123@gmail.com`（Vercel 校验要求）。

> 备注：本 plan 已按仓库约定归档至 `docs/superpowers/plans/2026-08-28-operations-header-migration.md`（原稿位于 `~/.opencode/plan/operations-header-migration.md`）。
