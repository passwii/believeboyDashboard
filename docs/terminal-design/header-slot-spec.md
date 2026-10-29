# 顶部插槽标准化规范（BLF-997）

> 状态：**规范定稿（2026-09-09），待按 §6 差距清单分批实施**
> 适用范围：`frontend/` 全站页面的 Top Header 中段插槽（HeaderSlot）与页面顶部区域
> 关联机制：BLF-826（插槽机制）/ BLF-874（Header 三区划分）/ BLF-887（高度上档 h-10）/ BLF-824（去重原则）/ BLF-931/933（移动端折叠条）/ BLF-962/963（月报试点）
> 本文是顶部插槽的**唯一规范来源**：新页面开工前先查本文，不再从各页拷贝实现。

---

## 1. 插槽机制现状（盘点基线）

### 1.1 Top Header 三区结构（`terminal-header.tsx`，固定 56px）

| 区块 | 内容 | 机制 |
|---|---|---|
| 左段 | SubNav 开关 + 面包屑（业务域 › 页面标题，`dashboard-route-meta.ts` 驱动） | 固定，`flex-1 min-w-0 overflow-x-auto` |
| 中段 | 页面操作 `HeaderSlotMount` + 常驻筛选 `PrimaryFilterSlotMount`（项目/日期）；两者与导航同处唯一 56px 主行。次级筛选仅在展开时进入第二行 | 常驻插槽 `hidden md:flex`；全局项目/日期在 `xl+` 复用同锚点 |
| 右段 | 次级筛选展开开关 / 全局刷新 / ⌘K 搜索 / 通知 / Inspector / 用户菜单 | 固定 |

### 1.2 基建组件与 hooks

| API | 文件 | 职责 |
|---|---|---|
| `useHeaderSlot(node)` | `components/terminal/terminal-header-slot.tsx` | 页面把控件 portal 进中段；unmount / 传 `null` 自动清除 |
| `useMobileFilterStrip(node)` | 同上 | `<md` 时把控件折叠条 portal 进正文顶部 `MobileStripMount`（BLF-933） |
| `useHeaderRefresh(handler, { loading })` | 同上 | 绑定右段全局刷新按钮；ref 桥接永远执行最新闭包；未注册页兜底 `router.refresh()`（BLF-881，10s 看门狗） |
| `HeaderFilterControls` | `components/terminal/header-filter-controls.tsx` | 插槽内容统一容器：≥md 单行平铺（`flex-nowrap overflow-hidden`），<md 折叠「筛选」Popover |
| `TERM_HEADER_TRIGGER` + `W_SM/MD/LG/XL` | `components/terminal/header-filter-suite.tsx` | h-10 触发器基类 + 四档固定宽度 |
| `HeaderSlotSelect` / `HeaderSlotDateRange` | 同上 | 插槽泛型原子控件（选项集合由页面传入） |
| `MobileFilterStrip` / `MobileFilterWide` | `components/terminal/mobile-filter-strip.tsx` | 移动端折叠条：摘要 + grid-cols-2 控件网格 |
| 全局四件套 + `useTerminalGlobalFilter` | `header-filter-suite.tsx` / `global-filter-context.tsx` | 项目/站点/日期全局态，URL（g* 键）+ localStorage 双持久化；**试点仅 2 路由**（daily-analysis、order-info），扩试点需单独决策 |

### 1.3 既有契约（沿用，不变）

- 刷新语义：有数据页注册 `useHeaderRefresh`（force 跳缓存强拉），写语义页保留完整刷新含义（如先存后刷），多 tab 页刷新 = 重拉当前激活 tab；纯表单/静态页不注册吃兜底。
- 注册后**删除页内重复刷新按钮**（全局唯一入口）。
- 页面标题由面包屑承载，页内不再渲染标题胶囊（BLF-824 去重原则）。

---

## 2. 全站顶部元素盘点（清单）

> 2026-09-09 全量 grep + 逐页阅读核实。`W_*` = 已用四档宽度常量；`ad-hoc` = 页内手写像素宽度。

### 2.1 已插槽化路由（22 条，`useHeaderSlot` 消费）

| # | 路由 | 插槽元素（现状） | 移动端 | 残留问题 |
|---|---|---|---|---|
| 1 | `/dashboard`（首页） | 项目 Select（手写 markup，`md:w-[180px]` ad-hoc）+ 数据区间徽标（7 天口径） | ✓ | 手写 Select 未用原子；ad-hoc 宽度 |
| 2 | `operations/daily-analysis` | xl+：SKU 搜索 combobox（W_LG）；md~xl：降级三件套（全局四件套只在 xl+ 渲染） | ✓ | 无（试点去重范本） |
| 3 | `operations/inventory-analysis` | 项目 Select（w-140 ad-hoc）+ CountrySelect（legacy console 组件，`md:h-9` 错档）+ 业务日期快照 Select（w-180）+ 业务日期徽标 | ✓ | legacy 组件 + ad-hoc 宽度 + h-9 |
| 4 | `operations/inventory-ledger` | 项目 W_MD + 月份 W_SM + SKU W_MD + 仓库 W_SM + 状态 W_SM | ✓ | 无 |
| 5 | `operations/inventory-replenishment` | 项目 W_MD + 关键词 Input(lg) W_LG + 站点 W_SM + 风险 W_MD | ✓ | SnapshotSelector 留正文（有意，含创建/编辑） |
| 6 | `operations/portfolio-overview` | PortfolioFilters 整组：项目多选 Command（w-72=288）+ CountrySelect（`md:h-9`）+ 日期范围 + **RefreshButton（插槽内！）** | ✓ | **插槽内刷新按钮与右段全局刷新双入口**；CountrySelect h-9 错档 |
| 7 | `operations/project-goals` | 项目 W_MD + 站点 W_SM + 年份 W_SM | ✓ | 无 |
| 8 | `operations/return-analysis` | 项目 W_MD + 站点 W_SM + 日期范围 W_XL（onApply→拉数） | ✓ | 无 |
| 9 | `operations/seasonal-replenishment` | 项目 W_MD + 站点 W_SM + 日期范围 W_XL + 关键词 Input(lg) W_LG + 「去年」Switch（h-10 容器） | ✓ | 无 |
| 10 | `operations/shipment-management` | 项目 W_MD + 状态 W_SM + 国家 W_SM + 货件编号搜索 Command（W_LG） | ✓ | 无 |
| 11 | `operations/sku-info` | 项目 W_MD + SKU Input W_MD + ASIN Input W_MD + 站点 W_SM + 状态 W_SM + 查询（PRIMARY）+ 重置（MUTED）—— 提交制 | ✓ | 7 控件超 1280px 预算（见 §4.3） |
| 12 | `operations/weekly-product-analysis` | 项目 W_MD + 站点 W_SM + 日期范围 W_XL | ✓ | 无 |
| 13 | `finance/commission-management` | 月份 MonthPicker（w-150）或 年份 Select（w-110）+ 站点 Select（w-120）+ 核算 Button（**h-7 错档**）+ 统计 mono 徽标条（xl+，按 tab 切换） | ✓ | 手写 Select、ad-hoc 宽度、h-7 按钮 |
| 14 | `finance/exchange-rate` | 货币（w-160）+ 年份（w-110）+ 月份（w-100）Select 手写 + 重置 Button（**h-7**） | ✓ | 同上 |
| 15 | `finance/platform-revenue` | 项目（w-160）+ 年份（w-110）+ 月份（w-100）+ 币种（w-130）+ 类型（w-120）手写 Select + 重置（**h-7**） | ✓ | 同上；6 控件 |
| 16 | `reports/monthly-report/display` | 店铺 W_MD + 国家 W_SM + 起月 MonthPicker W_SM + 止月 MonthPicker W_SM | ✓ | 无 |
| 17 | `reports/monthly-report/generate` | 项目 W_MD + 国家 W_SM + 账期月份 MonthNavigation W_MD | ✓ | 正文保留「控制台」卡（状态 tiles，有意）；本页无刷新语义不注册 |
| 18 | `reports/monthly-report/reconcile` | auto tab：项目 + 站点；manual tab：插槽传 `null` 自动清空 | ✓（auto） | 无（条件化插槽范本） |
| 19 | `reports/order-info` | 类型/状态/币种 MultiSelect×3（w-130/130/110）+ 订单号/SKU/ASIN Input×3（w-150/130/120）+ 清空筛选 | ✓ | **页内本地 `TERM_TRIGGER/TERM_INPUT` 是 h-9 旧档拷贝**（BLF-887 前残留），与全局 h-10 错档；7 控件 |
| 20 | `advertising/ad-analysis`（layout） | 项目 W_MD + 站点 W_SM + 日期范围 W_XL + 下钻 token（TermPill accent，条件渲染）+ 清空下钻 | **✗ 缺口** | 移动端筛选不可达（见 §2.5-G1） |
| 21 | `advertising/ad-data`（layout） | 项目 W_MD + 站点 W_SM + 日期范围 W_XL | **✗ 缺口** | 同上 |
| 22 | `finance/vat-invoice` | —（无筛选，仅 Tabs 正文） | — | 归入未接入表，无迁移需求 |

### 2.2 仅注册全局刷新路由（8 条，`useHeaderRefresh` 消费、无插槽）

| 路由 | 正文顶部现状 | 残留问题 |
|---|---|---|
| `operations/complaint-center` | PageHeader 胶囊（eyebrow+标题+描述）+ FilterToolbar（日期+刷新按钮）+ StatCardRow | **双刷新入口**（页内刷新按钮 + 已注册全局刷新）；PageHeader 与面包屑标题重复 |
| `operations/complaint-center/list` | 同上（筛选 Select + 刷新按钮） | 同上 |
| `operations/platform-inspection` | Tabs + 子组件按 refreshKey 加载 | 无 |
| `operations/store-navigation` | 统计磁贴 | 无 |
| `crm/dashboard` | KPI 磁贴 + 表格 | 无（CRM 豁免体系，见 §2.4） |
| `crm/audit` | 正文工具行（对象/操作 native select） | 无（正文工具行属 CRM 豁免） |
| `agent-center/overview` | PageHeader 胶囊（eyebrow+标题+描述） | PageHeader 与面包屑标题重复 |
| `agent-center/employees` | 同上 | 同上 |

### 2.3 未接入路由的顶部元素（正文承载）

| 路由 | 正文顶部元素 | 归类（§4.1） |
|---|---|---|
| `reports/pricing-calculation/new-product` | 「控制台」Card：国家（静态）+ 产品搜索 Input + 测算结果多选 Command picker + 导出；控件 **h-8 低于档** | F2/F5 混排 |
| `reports/pricing-calculation/shop-calculation` | 「控制台」Card：项目 Select（h-8）+ SKU 搜索（h-8）+ 导出 + PricingSnapshotSelector + 国家切换 | F1/F2/F5 混排 |
| `reports/product-analysis` | 「核算参数」TermPanel：项目/站点/日期范围 + 检查数据 + 执行核算 | F1+F3 工作流式 |
| `system/operator-management` | DataCard 头：MonthPicker（w-190）+ **页内 RefreshButton** | F1+F3 |
| `system/logs` | TermPanel：关键词/操作人 Input + 日志分类 Select + 查询/重置（提交制） | F2+F3 |
| `system/data-management` | 刷新状态 + 清理缓存（TermPanel actions，页内刷新未注册） | F5 写操作 |
| `ai/ad-analysis` | TermPanel 表单：项目/国家/日期 + 立即生成 | F1+F5 表单 |
| `ai/digital-employees` | 运行/异常计数徽标 + 全屏展示 + **页内刷新按钮**（未注册）+ 搜索/状态筛选（正文） | F4+F5 |
| `ai/insights` | Tab 切换（洞察记录/定时生成）+ 新建定时任务按钮 | H 视图 + F5 |
| `reports/auto-upload` | 双层 Tabs + 国家/报表类型在子 tab 内容内 | H 视图 |
| `system/project-info` / `system/alerts` / `system/account-management` / `system/changelog` / `profile` / `feature-updates` / `tools/*` | Tabs / 表单 / 内容页，无筛选维度 | H/F5/无需求 |

### 2.4 豁免路由（结构性或用户拍板，不迁插槽）

| 路由 | 豁免理由 |
|---|---|
| `crm/*`（customers/leads/sea/follow-ups/tasks/settings） | BLF-837 决策：筛选是**表格内建能力**（CrmTable 自带搜索 + filterFields 工具行），非页面级全局参数；ScopeToggle 是跨表数据范围切换，留正文工具行 |
| `operations/research-analysis` | 用户拍板豁免：表单式调研工作台（上传+核算流程），仅吃兜底刷新 |
| `reports/scheduled-reports` | 布局级双 View 常驻挂载（hidden 切换不卸载），两个 View 同时 portal 会互相覆盖——插槽锚点唯一所致；沿用正文工具行（h-9 正文档，合规） |
| `ai/chat` / `ai/customer-service` / `ai/believeboy-models` / `system/digital-display` / `ai/digital-employees/office` / `table-showcase` / `p/[id]` | 画布/对话/展示型页面，无筛选语义 |

### 2.5 盘点发现的存量偏差（drift 汇总）

- **G1 移动端缺口**：ad-analysis / ad-data 把 `isMobileView` 传给 `HeaderFilterControls`，但插槽挂载点本体 `hidden md:flex`——<md 时整段隐藏，筛选 Popover 永远不可达。两页需改走 `useMobileFilterStrip`。
- **G2 双刷新入口**：portfolio-overview（插槽内 RefreshButton + 全局刷新）、complaint-center ×2（页内刷新按钮 + 已注册全局刷新）。
- **G3 PageHeader 胶囊残留**：complaint-center ×2、agent-center ×2——标题与面包屑重复，违反 BLF-824。
- **G4 高度错档**：同排 h-7 按钮（commission 核算、platform-revenue/exchange-rate 重置）、h-9 触发器（order-info 本地旧常量、portfolio/inventory-analysis 的 CountrySelect `md:h-9`）混在 h-10 插槽行里。
- **G5 宽度双源**：6 页手写 `md:w-[100~190px]`（首页 180、inventory-analysis 140/160/180、commission 150/110/120、exchange-rate 160/110/100、platform-revenue 160/110/100/130/120、order-info 110~150），未走 `W_*` 四档常量。
- **G6 原语双轨**：一半页面用 `HeaderSlotSelect` 原子，另一半手写 `Select` + h-10 类名（首页、inventory-analysis、finance ×3、order-info MultiSelect）。
- **G7 legacy 组件**：`components/dashboard/console`（CountrySelect/RefreshButton/MonthNavigation）仍被插槽/正文混用（inventory-analysis、portfolio-filters、operator-management、generate）；该目录是插槽时代前的旧组件族，与 header-filter-suite 职责重叠。

---

## 3. 共性元素归纳

跨页出现频次（≥2 页才列入；数字为核实到的路由数）：

| 元素 | 频次 | 形态 | 归类 |
|---|---|---|---|
| 项目/店铺选择 | 20+ | 单选（个别多选） | F1 全局维度 |
| 站点/国家 | 16+ | 单选，页面原生选项集（US/DE/UK ± ALL） | F1 |
| 日期范围 | 10+ | DateRangePicker 带预设侧栏 | F1 |
| 月份 | 6 | MonthPicker / MonthNavigation（带前后切换） | F1（时间维度） |
| 年份 | 4 | Select | F1（时间维度） |
| 页面私有枚举（状态/风险/仓库/币种/类型/对象/日志分类） | 12+ | Select / MultiSelect / native select | F2 私有筛选 |
| 关键词输入（SKU/ASIN/订单号/货件/搜索） | 13（插槽 8 + 正文 5） | Input(lg) / Search combobox | F2 |
| 多选复合（订单 3×MultiSelect、portfolio 项目 Command 多选、测算结果 picker） | 3 | MultiSelect / Command | F2 |
| 提交按钮（查询/重置/清空/应用） | 6（插槽 4 + 正文 2） | h-10 PRIMARY/MUTED 按钮 | F3 提交动作 |
| 数据重算（核算/刷新重算） | 2 | 单击、直接跟随当前筛选 | F3（边界，见 §4.1 注） |
| 口径徽标（数据区间/业务日期/统计 mono 条/下钻 token/运行计数） | 5 | 非交互 mono 徽标 | F4 |
| 快照选择器（SnapshotSelector / PricingSnapshotSelector） | 3 | 含创建/编辑入口的重控件 | F5 重控件 |
| 写操作（生成/上传/创建/同步/导出/清理） | 15+ | 多步或含表单 | F5 |
| 视图切换 Tabs | 25+ | TabsList variant="term" | H 视图（正文） |
| 导出 Excel / 下载 | 34 | 卡头按钮 | F5（正文） |
| 刷新 | 全站 | 右段全局按钮 | J（唯一入口） |

**共性结论**：顶部元素天然收敛为「**选 → 输 → 提交 → 标 → 视图/写**」五段语法；插槽承载前三段 + 徽标，正文承载后两段。所有已迁移页面的实际排列顺序也已经是这个顺序（项目→站点→日期→私有枚举→关键词→提交→徽标），本文将其从事实约定升格为强制规范。

---

## 4. 插槽逻辑设计（分类规则）

### 4.1 元素分类法（五类 + 视图 + 刷新）

| 类 | 定义 | 入插槽？ | 判据 |
|---|---|---|---|
| **F1 全局维度筛选** | 项目/站点/日期（范围/月/年） | **是**（首段固定顺序） | 跨页面同构、决定数据口径 |
| **F2 页面私有筛选** | 私有枚举、关键词、多选 | **是**（F1 之后） | 只改查询不改数据；无表单 |
| **F3 提交动作** | 查询/重置/清空/应用；单击型数据重算 | **是**（跟随其筛选组，末段） | 提交制页（选择不自动查询）必须整体上移；即时制页（选择即查询）不上移按钮 |
| **F4 口径徽标** | 非交互信息（口径/统计/下钻 token） | **可**（末尾，≤1 组） | 只允许与当前筛选直接相关的 mono 徽标；宽度计入预算 |
| **F5 重控件 / 写操作** | 快照选择（含创建/编辑）、生成/上传/创建/导出/清理 | **否（留正文）** | 多步流程、含表单或对话框；快照选择器历史决策留正文（inventory-replenishment 先例） |
| **H 视图切换** | Tabs / ScopeToggle / 看板-列表切换 | **否（正文第一行）** | 视图是内容结构不是数据筛选 |
| **J 刷新** | 数据重拉 | **否（右段全局按钮唯一入口）** | 已注册页禁再放任何刷新按钮（插槽内/正文均禁） |

> F3 边界注：单击、无表单、直接跟随当前筛选值的「重算/核算」（如 commission 核算按当前月份 POST）归 F3 可入插槽；含任何弹窗/多步确认的（如快照创建）归 F5 留正文。

**统计磁贴（KPI tiles）永不入插槽**——信息密度高、非筛选语义，正文首行承载（return-analysis / daily-analysis 先例）。

### 4.2 排序规范（插槽内从左到右）

```
[F1 项目] → [F1 站点] → [F1 日期/月份/年份] → [F2 私有枚举…] → [F2 关键词…] → [F3 查询/重置] → [F4 徽标]
```

- 全站已验证的事实顺序，新页面照此排列，不发明新顺序。
- 语义分组间可插一根 `h-4 w-px bg-term-border` 分隔线（order-info 先例）；组内不加分隔。

### 4.3 数量预算与溢出策略（桌面端）

插槽挂载点 `shrink + overflow-hidden`，超宽时控件被裁切（控件均 shrink-0）。按右段 ≈240px、面包屑最小 ≈140px 估算可用宽度：

| 视口 | 主列宽 | 插槽可用 | 预算 |
|---|---|---|---|
| 1280×800 | 992 | ≈600px | **≤4 个标准控件**（如 项目150+站点130+日期240+关键词200=720 已超，需 3 个） |
| 1440 | 1152 | ≈760px | ≤5 |
| 1920+ | 1664+ | ≈1200px+ | ≤7（上限） |

**硬预算：任何视口下插槽控件 ≤7；1280 基线 ≤4。** 超出时按序降级：
1. 相邻私有枚举合并为一个 MultiSelect（order-info 先例：3 枚举 = 3 个 MultiSelect 已是极限形态）；
2. 低频私有筛选下移正文 FilterToolbar 工具行（h-9 正文档），插槽只留 F1+高频 F2（scheduled-reports 结构先例）；
3. 仍超 → F2 全部下移正文，插槽只留 F1（现状多数页面的形态）。

> 现存超预算页：sku-info（7）、order-info（7）、platform-revenue（6）——1280 下会被裁切，列入 §6 P1 收编。

### 4.4 与全局筛选四件套的去重规则（试点路由）

- 试点路由（daily-analysis、order-info）xl+ 由全局四件套承担项目/站点/日期，插槽**只渲染页面独有维度**，并按断点隐藏重复三件套（daily-analysis `LegacyFallbackFilters` 降级范本）。
- 非试点路由插槽常驻全维度；**扩试点需单独决策**（BLF-826 决策 1 沿用：不主动扩，规避 ALL 聚合位后端不支持的状态不一致）。
- 插槽内容与全局四件套**不得同视口重复渲染同一维度**。

### 4.5 结构性约束

- 插槽锚点是**唯一 DOM 节点**：布局级多视图常驻页（两 View 同时挂载）不可双 portal——要么条件化内容（reconcile 范本：`activeTab === 'auto' ? controls : null`），要么豁免走正文工具行（scheduled-reports 范本）。
- tab 级懒挂载页（切 tab 才挂载）不受此限，各 tab 组件各自 `useHeaderSlot` 即可（unmount 自动清除）。

---

## 5. 插槽规范与大小（尺寸规格）

### 5.1 高度：h-10 单一档

- 插槽内一切可交互控件（Select 触发器 / Input / 按钮 / Switch 容器 / MultiSelect / combobox）**统一 h-10**，与 `TERM_HEADER_TRIGGER` 对齐（BLF-887 上档）。
- 同排禁止 h-7 / h-8 / h-9（正文工具行 h-9 档、紧凑档 h-8 属正文规格，不得混入插槽行）。
- MonthNavigation 等复合控件内嵌小按钮可用 `[&>button]:h-8`（generate 先例），但容器整体 h-10。

### 5.2 宽度：四档常量，禁止页内像素

| 常量 | 值 | 用途映射 |
|---|---|---|
| `TERM_HEADER_W_SM` | 130px | 站点、月份、年份、短枚举（≤4 字）、单月 MonthPicker |
| `TERM_HEADER_W_MD` | 150px | 项目、中枚举、MonthNavigation、SKU/ASIN 单输入 |
| `TERM_HEADER_W_LG` | 200px | 关键词输入、搜索 combobox（货件号/SKU 下拉） |
| `TERM_HEADER_W_XL` | 240px | 日期范围 |

- 新宽度档位**先改常量再使用**，禁止组件内 `w-[XXXpx]` 字面量（master-prompt 硬约束第 10 条同源）。
- 多选 combobox 等固有大控件允许专用宽度类（portfolio w-72），但须在该页注释说明，不复制到别页。

### 5.3 控件原子白名单（只允许以下四种实现）

| 用途 | 原子 | 来源 |
|---|---|---|
| 下拉单选 | `HeaderSlotSelect` | header-filter-suite |
| 日期范围 | `HeaderSlotDateRange` | header-filter-suite |
| 关键词输入 | `Input size="lg"` + `widthClass` | ui/input（lg 档即 h-10 term 规格） |
| 提交按钮 | `TERM_HEADER_BUTTON_PRIMARY`（查询/应用/重算）/ `TERM_HEADER_BUTTON_MUTED`（重置/清空） | 现定义于 sku-info 页内，**P1 收编进 header-filter-suite** 后全站引用 |

禁止：页内手写 `Select`+h-10 类名、从 `components/dashboard/console` 引入 CountrySelect/RefreshButton 进插槽（G6/G7）。

### 5.4 视觉规格（随常量单源）

- 字体：触发器/按钮 `font-mono text-sm`（`TERM_HEADER_TRIGGER` 内置）；数值 `tabular-nums`。
- 圆角/阴影：`rounded-none`、零阴影。
- 边界：`border-term-border`，open 态 `border-term-border-strong`；弹层 `TERM_SELECT_CONTENT`。
- 间距：控件间 `gap-1.5`（`HeaderFilterControls` 内置）；插槽与右段之间 border-l。
- 图标：行内伴随图标 h-4（1b-2 M 档），strokeWidth 1.75。

### 5.5 移动端规格（强制）

- `<md` 一律 `useMobileFilterStrip(<MobileFilterStrip summary controls>)`，**禁止**依赖 `HeaderFilterControls isMobileView` Popover 路径（插槽挂载点本身 hidden，该分支在真机不可达——G1 教训）。
- 摘要格式：`标签 · 标签 · 标签`（当前值，非占位词）；宽控件（日期范围/月份导航/多选）包 `MobileFilterWide` 占整行。
- 桌面/移动共用同一受控状态与控件 JSX（portal 两个挂载点），禁止双套 state。

### 5.6 反模式清单（Review 检查项）

1. 插槽里出现刷新按钮（J 冲突）。
2. 插槽里出现快照选择器/生成/上传/导出（F5）。
3. 同排高度 ≠ h-10。
4. 页内像素宽度未走 `W_*`。
5. 手写 Select/legacy console 组件进插槽。
6. 页内渲染 PageHeader 标题胶囊（面包屑已承载）。
7. 试点路由 xl+ 双渲染同一筛选维度。
8. 移动端走 isMobileView Popover 而非 MobileFilterStrip。
9. 多视图常驻页双 portal 未条件化。
10. 统计磁贴塞进插槽。

---

## 6. 迁移差距清单（分批实施 backlog）

> 本 issue 交付规范本身；下表为后续子 issue 的拆分依据，优先级按用户感知排序。

### P1 存量偏差修复（不新增能力，纯收口）

| 项 | 内容 | 涉及 |
|---|---|---|
| P1-1 | portfolio-overview 移除插槽内 RefreshButton（全局刷新唯一入口） | portfolio-filters.tsx |
| P1-2 | complaint-center ×2：删页内刷新按钮 + 删 PageHeader 胶囊（标题归面包屑），日期/状态筛选上移插槽 | complaint-center 两 client |
| P1-3 | agent-center ×2：删 PageHeader 胶囊 | 两个 client |
| P1-4 | ad-analysis / ad-data 移动端补 `useMobileFilterStrip` | 两个 top-filters |
| P1-5 | order-info 本地 `TERM_TRIGGER/INPUT`（h-9 旧档）对齐 h-10（或全局化引用） | order-info page |
| P1-6 | 宽度收编 W 阶梯：首页 180→W_MD、inventory-analysis 140/160/180→W_*、finance ×3 全部 ad-hoc→W_*、order-info 110~150→W_* | 6 页 |
| P1-7 | 高度收编：commission 核算 h-7→h-10 按钮原子、platform-revenue/exchange-rate 重置 h-7→MUTED 原子、portfolio/inventory-analysis CountrySelect md:h-9→h-10 | 4 处 |
| P1-8 | `TERM_HEADER_BUTTON_*` 从 sku-info 上收到 header-filter-suite；inventory-analysis 换掉 legacy CountrySelect | header-filter-suite + 2 页 |

### P2 未接入页迁移（按业务价值排序）

| 批 | 页面 | 迁移内容 |
|---|---|---|
| P2-A | system/operator-management | MonthPicker 上移插槽（W_MD）+ 注册全局刷新、删页内 RefreshButton |
| P2-B | system/logs | 提交制整体上移（关键词/操作人 Input W_LG + 分类 W_SM + 查询/重置） |
| P2-C | reports/pricing-calculation/shop-calculation | 项目/国家/SKU 搜索上移插槽（h-8→h-10）；快照选择与导出留正文；删「控制台」卡壳 |
| P2-D | reports/pricing-calculation/new-product | 产品搜索 + 测算结果 picker 上移（若超预算则搜索上移、picker 留正文）；删「控制台」卡壳 |
| P2-E | reports/product-analysis | 核算参数三件套上移；「检查数据/执行核算」按 F3 边界评估（含多步校验倾向留正文卡头） |
| P2-F | ai/ad-analysis | 项目/国家/日期上移插槽；「立即生成」留正文（F5 表单提交） |
| P2-G | ai/digital-employees、system/data-management | 注册全局刷新、删页内刷新按钮（搜索/清理缓存留正文） |

### P3 观察类（暂不动）

- generate「控制台」卡（仅剩状态 tiles，无筛选重复）；
- vat-invoice / auto-upload / insights（Tabs + 写操作为主，无 F1/F2 需求）；
- CRM 全域、research-analysis、scheduled-reports（豁免，见 §2.4）。

### 新页面 / 迁移页统一验收清单

- [ ] F1/F2/F3/F4 才入插槽，F5/H/J 留正文或全局；
- [ ] 排序符合 §4.2；
- [ ] 全部 h-10、宽度走 `W_*`、原子白名单内；
- [ ] 1280 基线 ≤4 控件（或已按 §4.3 降级）；
- [ ] 移动端 `useMobileFilterStrip` + 摘要格式正确；
- [ ] 刷新已注册（有数据页）且页内无重复刷新按钮；
- [ ] 无 PageHeader 胶囊；试点路由无 xl+ 双渲染；
- [ ] `pnpm lint && pnpm build && pnpm test` 全绿；迁移页测试断言「旧控制台已移除 + 插槽节点非空」（既有模式沿用）。

---

## 7. 与既有文档的关系

- 尺寸阶梯总表仍以 `docs/terminal-design/master-prompt.md` §任务 1b 为准；本文只细化插槽行内的取值。
- 打磨单页 SOP（master-prompt §任务 2）第 1 步「检查页面级筛选条是否与 Top Header 重复」的执行标准即本文 §4/§5。
- 刷新语义契约原文见 `docs/superpowers/plans/2026-08-28-operations-header-migration.md` §1.4，本文 §1.3 为其摘要。
