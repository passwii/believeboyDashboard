# 手机端响应式设计打磨规则

> 本文档记录定时报告页面手机端适配过程中总结的成功案例与设计规则，供后续页面打磨参考。

---

## 前置条件：页面优化检查清单

> 每次开始一个新的页面优化前，必须先完成以下检查，形成**问题分析报告**，再进入实施阶段。

### 检查清单（每次必做）

#### 1. 收集页面结构信息
- [ ] 读取页面完整代码，了解组件层级
- [ ] 识别所有 `Card` / `DataCard` / `DataTableCard` 容器
- [ ] 识别所有 `Grid` / `flex` 布局区域
- [ ] 识别所有 `Table` 表格（尤其是 ≥5 列的多列表格）
- [ ] 识别所有 `Dialog` / `Popover` 弹窗
- [ ] 识别所有 `Pagination` 分页组件
- [ ] 识别所有表单输入区域（`Input` / `Select` / `Tabs`）
- [ ] 识别所有 `Button` 交互元素

#### 2. 分析问题（输出问题分析报告）

| 区域 | 问题类型 | 具体描述 |
|------|----------|----------|
| 工具栏/筛选项 | 换行混乱 / 溢出 | 描述具体问题 |
| 表格 | 水平溢出 / 列过多 | 描述列数和溢出情况 |
| 图表区域 | 留白过多 | 描述左右/上下留白 |
| 卡片/KPI | 挤成一团 / 被压缩 | 描述卡片被压缩情况 |
| Dialog/Popover | 宽度不适配 | 描述宽度问题 |
| 表单 | 字段换行混乱 | 描述字段布局问题 |
| Pagination | 按钮溢出 | 描述分页按钮问题 |
| 触控目标 | 太小难点击 | 描述触摸问题 |

#### 3. 匹配规则并制定方案

根据"规则清单"匹配适用规则，制定具体实施计划：

| 问题 | 适用规则 | 实施方案 |
|------|----------|----------|
| 表格溢出 | 规则1 | 桌面表格 → 手机卡片列表 |
| 筛选项换行 | 规则2 / 规则9 | 2列网格 / 去除标签 |
| 图表留白 | 规则（图表优化） | 隐藏Y轴 + 负margin |
| 指标卡压缩 | 规则7 | 水平滑动 |
| Dialog适配 | 规则3 | 响应式 DialogContent |
| 触控目标 | 规则5 | 最小 44×44px |
| 空状态 | 规则6 | 居中带图标 |
| 筛选项标签 | 规则8 / 规则9 | 内联标签 / 去除标签 |

#### 4. 实施三步骤
1. **评判当前极端适配的页面存在哪些问题**（详细说明）
2. **说明如何调整优化，并给出对应的方法**（匹配规则）
3. **实施和 build 补充**（编码实现 + 验证）

---

## 核心原则

1. **数据优先**：手机端显示的核心是数据本身，而非表格容器
2. **渐进式隐藏**：PC 端显示的信息在手机端通过卡片堆叠展示，关键信息不丢失
3. **触摸友好**：按钮、输入框足够大，间距充足，避免误触
4. **遵循项目设计系统**：复用 `dashboard-surface`、`dashboard-panel`、`dashboard-toolbar` 等组件类

---

## 组件排列总则（BLF-610）

> 全项目手机端适配的排列基线，逐页打磨时逐条对照。

1. **卡片/KPI 默认一行两个**：网格基础列数 `grid-cols-2`，随断点递增（`sm:grid-cols-3` / `md:grid-cols-4` / `lg:grid-cols-5…`）；数量多（≥6）时改用规则 7 水平滑动。**禁止**裸 `grid-cols-3/4/5`（无断点前缀）直接上手机。
2. **宽组件一行一个**：表格、图表、趋势图、地图、大型卡片等宽度需求大的组件始终独占整行（`grid-cols-1` / `col-span-full`），不与别的组件并排挤压。
3. **宽组件的判定**：内容含多列数据、横轴时间序列、或最小可用宽度 > 视口一半的组件，一律按宽组件处理。
4. **表单一列起步**：表单字段手机端单列（`grid-cols-1`），`md:grid-cols-2` 起双列；宽字段（地址、备注、SKU 搜索）`col-span-full`。
5. **标题行纵向堆叠**：页面/区块标题行手机端 `flex-col items-start gap-3`，`sm:flex-row sm:items-center sm:justify-between`；操作按钮手机端 `w-full sm:w-auto`。
6. **裸 `grid-cols-N` 排查命令**（子任务必跑）：

   ```bash
   # 在 frontend/ 下执行：列出无断点前缀的固定网格（逐个评估是否违反总则 1/2）
   grep -rnE '(^|[^:a-z0-9-])grid-cols-[0-9]' app components --include='*.tsx' | grep -vE '(sm|md|lg|xl|2xl):grid-cols'
   ```

---

## 规则清单

### 规则 1：表格 → 卡片列表（Table → Card List，仅限例外场景）

> ⚠️ **BLF-610 起范围收窄**：多列表格的默认手机端方案改为**规则 10（横滑保持列宽）**。
> 卡片列表只保留给例外表格：列数极多（≈15+）且行数据可独立展示、或已在 BLF-503 时期完成卡片化并验收通过的存量页面（不推倒重来）。

**问题**：多列表格（≥5 列）在手机端水平溢出，体验差。

**解决方案**：在小屏幕（`<768px`）使用卡片列表替代表格行。

**实现模式**：

```tsx
// 隐藏桌面表格，显示手机卡片
<div className="hidden md:block">
  {/* Desktop: 桌面端表格 */}
  <Table>...</Table>
</div>

<div className="md:hidden space-y-3">
  {items.map(item => (
    <div className="dashboard-surface p-4">
      {/* 手机端：卡片堆叠 */}
      <div className="flex justify-between items-start mb-2">
        <span className="font-medium">{item.title}</span>
        <StatusBadge />
      </div>
      <div className="text-sm text-muted-foreground space-y-1">
        <div>标签: {item.value}</div>
        <div>日期: {item.date}</div>
      </div>
      <div className="flex gap-2 mt-3">
        <Button size="sm" variant="outline">操作</Button>
      </div>
    </div>
  ))}
</div>
```

**适用场景**：表格列数 ≥5，且每行数据可独立展示。

---

### 规则 2：工具栏 → 折叠筛选项（Toolbar Collapsing）

**问题**：筛选项过多（≥4 个）时在手机端换行混乱。

**解决方案**：手机端将筛选项折叠为 2 列网格，主要按钮靠右。

**实现模式**：

```tsx
<div className="flex gap-3 flex-wrap">
  {/* Desktop: 横向排列 */}
  <Select>...</Select>
  <Select>...</Select>
  <Input className="w-[200px]" />
  <div className="ml-auto">
    <Button>主要操作</Button>
  </div>
</div>

// 改为响应式：
<div className="grid grid-cols-2 md:flex md:flex-row gap-2 md:gap-3">
  {/* 手机: 2 列网格，最多 4 项；平板+: 横向 */}
  <Select className="col-span-1">...</Select>
  <Select className="col-span-1">...</Select>
  <Input className="col-span-2 md:col-span-1 md:w-[200px]" placeholder="搜索..." />
  <div className="col-span-2 md:col-span-1 flex justify-end">
    <Button size="sm" className="w-full md:w-auto">操作</Button>
  </div>
</div>
```

**间距规则**：
- 手机：`gap-2`，组件 `h-9` 或 `h-8`
- 平板+：`gap-3`，组件 `h-9`
- 按钮在手机端可占满整行 (`w-full`)

---

### 规则 3：Dialog 表单适配

**问题**：`DialogContent className="max-w-2xl"` 在小屏上留白过多或内容拥挤。

**解决方案**：调整 Dialog 最大宽度，表单字段在手机上堆叠。

**实现模式**：

```tsx
// DialogContent 响应式宽度
<DialogContent className="max-w-2xl max-w-[calc(100%-2rem)] sm:max-w-[540px]">

// 表单字段响应式网格
<div className="grid gap-4 md:grid-cols-2">
  <div className="md:col-span-1">
    <label>...</label>
    <Input />
  </div>
  {/* 某些字段在手机端可占整行 */}
  <div className="col-span-2 md:col-span-1">
    <label>...</label>
    <Input />
  </div>
</div>
```

**Dialog 宽度规则**：
- 手机：`max-w-[calc(100%-2rem)]`（左右各 1rem 边距）
- 大手机/平板：`max-w-[540px]`
- 桌面：`max-w-2xl`

**表单网格规则**：
- 手机：单列全宽 (`col-span-2`)
- 平板+：双列 (`md:grid-cols-2`)

---

### 规则 4：统计数字 → 紧凑网格（KPI Grid）

**问题**：5+ 个统计数字在小屏上挤成一团。

**解决方案**：使用响应式网格，数字足够大，标签足够小。

**实现模式**：

```tsx
// 手机: 2 列或 3 列网格
<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
  {stats.map(s => (
    <div className="dashboard-surface p-3 text-center">
      <div className="text-xs text-muted-foreground mb-1">{s.label}</div>
      <div className={cn("text-xl font-semibold", s.colorClass)}>{s.value}</div>
    </div>
  ))}
</div>
```

**数字大小规则**：
- 手机：`text-xl`（KPI 数字）
- 桌面：`text-2xl`
- 标签始终 `text-xs`

---

### 规则 5：触摸目标尺寸

**问题**：小按钮在手机上难以点击。

**解决方案**：所有交互元素确保最小触摸面积为 44×44px。

**实现规则**：
- 按钮：`size="sm"` 或 `size="icon"` 在手机端额外增加 `min-h-[44px] min-w-[44px]`
- 图标按钮始终使用 `size="icon"` + `h-10 w-10`
- 列表项触摸区域：`py-3 px-4`

---

### 规则 6：空状态

**问题**：手机上空白区域需要明确告知用户。

**解决方案**：居中显示带图标的空状态说明。

**实现模式**：

```tsx
<div className="flex flex-col items-center justify-center py-12 text-center">
  <FileText className="h-10 w-10 text-muted-foreground/50 mb-3" />
  <p className="text-sm text-muted-foreground">暂无数据</p>
  <Button size="sm" className="mt-4">添加</Button>
</div>
```

---

### 规则 7：指标卡 → 水平滑动（Horizontal Scroll）

**问题**：大量指标卡（≥6 个）在手机端用左右箭头翻页时，两侧箭头占据固定空间，中间卡片被严重压缩，触控体验差。

**解决方案**：手机端改用 `overflow-x-auto` + `snap-x snap-mandatory` 实现真正的水平滑动，平板/桌面保持网格布局 + 箭头翻页。

**实现模式**：

```tsx
// 桌面端：左右箭头 + 自适应网格
<div className='hidden sm:flex items-center gap-2'>
  <button>←</button>
  <div className='flex-1 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6'>
    {cards}
  </div>
  <button>→</button>
</div>

// 手机端：水平滑动 + 指示点
<div className='sm:hidden'>
  <div
    className='flex gap-2 overflow-x-auto snap-x snap-mandatory pb-2 -mx-1 px-1'
    style={{ WebkitOverflowScrolling: 'touch' }}
  >
    {cards.map(card => (
      <button
        key={card.key}
        className='flex-none snap-start w-[calc(50%-0.25rem)]'
      >
        {card.content}
      </button>
    ))}
  </div>
  {/* 指示点：活跃页面对应点高亮 */}
  <div className='flex justify-center gap-1.5 mt-1'>
    {groups.map((_, i) => (
      <button
        key={i}
        className={cn(
          'h-1.5 rounded-full transition-all',
          isActiveGroup(i) ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/30'
        )}
      />
    ))}
  </div>
</div>
```

**关键 CSS**：
- `overflow-x-auto`：允许水平滚动
- `snap-x snap-mandatory`：吸附到最近的卡片
- `snap-start`：对齐到容器起点
- `w-[calc(50%-0.25rem)]`：每屏显示 2 张卡片（配合 gap-2）
- `scrollbar-hide`：隐藏滚动条（配合 `::-webkit-scrollbar { display: none }`）

**适用场景**：指标卡数量 ≥4，且需要快速浏览对比的场景（如 Dashboard KPI 卡片、数据分析指标卡）

---

### 规则 8：筛选项标签对齐

**问题**：使用 `FilterField` 组件包裹筛选项时，手机端每个筛选项独立一行导致标签和控件间距不一致、视觉不整齐。

**解决方案**：手机端直接内联布局标签，不使用 `FilterField`，保持标签 `text-[0.65rem]`、`gap-1.5` 与控件紧密贴合。

**实现模式**：

```tsx
// 桌面端：使用 FilterField 横向排列
<div className='hidden md:flex items-center gap-4'>
  <FilterField label="项目">
    <Select>...</Select>
  </FilterField>
  <FilterField label="国家站点">
    <Select>...</Select>
  </FilterField>
</div>

// 手机端：内联标签 + 2 列网格
<div className='md:hidden px-4 py-3'>
  <div className='grid grid-cols-2 gap-2'>
    {/* 项目 */}
    <div className='space-y-1.5'>
      <div className='text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground'>项目</div>
      <Select>...</Select>
    </div>
    {/* 国家站点 */}
    <div className='space-y-1.5'>
      <div className='text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground'>国家</div>
      <CountrySelect />
    </div>
  </div>
  {/* 其他全宽项 */}
  <div className='space-y-1.5 mt-3'>
    <div className='text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground'>SKU</div>
    <SearchableSkuField className='w-full' />
  </div>
</div>
```

**标签样式规则**：
- 桌面端：`text-[0.72rem]`、`tracking-[0.18em]`
- 手机端：`text-[0.65rem]`、`tracking-[0.16em]`（更紧凑）
- 标签与控件间距：`space-y-1.5`（约 6px）

---

### 规则 9：控制台筛选项 → 去除小标题标签

**问题**：每个筛选项带有小标题标签（如"项目"、"国家站点"、"日期范围"），导致：
1. 手机端 2 列网格时，每个单元格的标签 + 控件高度不一致，对齐不整齐
2. 左右留白多，利用率低
3. 桌面端显得拥挤

**解决方案**：统一去除所有控制台筛选项的标题标签，控件直接横向排列。桌面端紧凑对齐，手机端 2 列网格紧贴无缝隙。

**实现模式**：

```tsx
// ✅ 正确：无标签，横向排列
<div className='dashboard-toolbar hidden md:flex items-center gap-3 px-4 py-4'>
  <Select placeholder='选择项目'>...</Select>
  <Select placeholder='国家站点'>...</Select>
  <DateRangePicker />
  <Button>刷新</Button>
</div>

// ✅ 手机端：2 列网格无标签
<div className='dashboard-toolbar md:hidden px-4 py-3'>
  <div className='grid grid-cols-2 gap-2'>
    <Select placeholder='项目'>...</Select>
    <Select placeholder='国家'>...</Select>
  </div>
  <div className='mt-2'>
    <DateRangePicker className='w-full' />
  </div>
  <div className='flex gap-2 mt-2'>
    <Button className='flex-1'>刷新</Button>
    <Button className='flex-1'>近7天</Button>
  </div>
</div>

// ❌ 错误：有标签导致对齐问题
<div className='space-y-1.5'>
  <div className='text-xs text-muted-foreground'>项目</div>
  <Select>...</Select>
</div>
```

**适用场景**：所有控制台工具栏、筛选区域、数据分析页面的筛选项

**注意**：如果某筛选项需要特别说明（如“周一限制 ≥ 16:00”），可以在控件内通过 tooltip 或 placeholder 提示，而不是单独标签

---

### 规则 10：表格横滑保持列宽，不折行（BLF-610，多列表格默认方案）

**问题**：手机端表格列宽被压缩，单元格文字折行；而所有表格容器本身已集成左右滑动（Table 原语 wrapper `overflow-x-auto` / `DataTableFrame` 滚动体），折行是无意义的显示损失。

**解决方案**：表格保持**与桌面端相同的宽度需求**（列的固有宽度），视口不足时由容器横向滚动承接。全局兜底已落地（`globals.css` `<768px`）：

```css
.dashboard-surface table,
.dashboard-panel table,
[class*="overflow-auto"] table,
[class*="overflow-x-auto"] table {
  min-width: max-content;  /* 取代旧 min-width: 600px */
}
```

**页面级调优手段**（子任务逐表过）：

| 场景 | 手段 |
|------|------|
| 长文本列（备注/地址/URL）不想被 max-content 撑得过宽 | 单元格加 `max-w-[16rem] whitespace-normal`，约束 max-content 贡献且保留换行 |
| 某列需要保底宽度（如 SKU/日期） | 表头/单元格加 `min-w-[Npx]` 或 `whitespace-nowrap` |
| 固定列宽表格（`tableLayout="fixed"` + `ColGroup`） | 列宽之和即横滑宽度，与桌面一致，无需额外处理 |
| 原生 `<table>`（未走 Table 原语） | 确保包一层 `overflow-x-auto` 容器并位于 `dashboard-surface` 内，才能吃到全局兜底 |
| 个别表格确实想压缩折行 | table 上加 `[min-width:0!]` 退出兜底（需在设计上说明理由） |

**验收**：手机端表格不出现单元格折行（除非该列显式 `max-w` 换行）；横滑顺畅；sticky 首列/表头在滑动时保持固定。

**适用场景**：除规则 1 例外之外的所有数据表格

---

## 定时报告页面适配记录

### 订阅管理 Tab

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| 表格（8列） | 水平溢出 | 桌面显示表格，手机切换为卡片列表 |
| 工具栏（6项） | 换行混乱 | 2列网格，按钮全宽 |
| 新增订阅 Dialog | 宽度不适配 | 响应式 DialogContent + 单列表单 |
| 编辑订阅 Dialog | 同上 | 同上 |

### 调度记录 Tab

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| 表格（10列） | 水平溢出 | 桌面显示表格，手机切换为卡片列表 |
| 工具栏（5项） | 换行混乱 | 2列网格 |
| 统计数字（5个） | 挤成一团 | `grid-cols-2 sm:grid-cols-3 md:grid-cols-5` |
| 重发状态显示 | 行内进度条 | 保持现状（已足够紧凑） |
| 截图预览 | 小图难点击 | 点击后全屏预览（已有 PortraitScreenshotDialog） |
| AI 文案弹窗 | 内容宽度 | DialogContent 响应式调整 |

### 每日分析页面

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| 控制台工具栏 | 桌面横向 → 手机换行混乱 | 桌面端横向排列；手机端 2 列网格 |
| 项目/国家站点 | 并列显示但对齐差 | 去除小标题标签，2 列网格紧贴 |
| SKU + 日期范围 | 各占一行利用不充分 | SKU 与日期范围并列一行（2 列网格） |
| 操作按钮 | 双按钮堆叠 | 双按钮横排 `flex-1` 各占一半 |
| 图表区域 | 手机端左右留白大 | 缩减 margin（right/left），减小 barSize/strokeWidth |

---

### 图表区域手机端优化

**问题**：图表在手机端左右留白大，有效数据区域被压缩。

**解决方案**：
1. **隐藏 Y 轴**：手机端不渲染 `<YAxis>`，消除左侧标签区域的留白
2. **负 margin 补偿**：`margin={{ left: -12 }}` 把图表区域往左推，贴边填充
3. **缩短日期格式**：`05月28日` → `05/28`，减少 X 轴文字占用
4. **缩减刻度/线条**：`fontSize: 10`、`strokeWidth: 2`、`radius: [4,4,0,0]`
5. **容器 padding 缩减**：手机端 `px-1 pt-2 pb-0` 替代 `p-4`
6. **使用 `useMobile` hook**（SSR 安全的 `useSyncExternalStore`）判断视口宽度

```tsx
// 手机端：隐藏 Y 轴 + 负 margin 贴边
{!isMobile && (
  <YAxis tickMargin={16} tick={{ fontSize: 12, fill: '#71717a' }} />
)}
<BarChart
  margin={isMobile
    ? { top: 12, right: 4, left: -12, bottom: 8 }
    : { top: 20, right: 8, left: 0, bottom: 12 }
  }
/>

// 手机端日期格式缩短
tickFormatter={(value) => {
  const [, month, day] = String(value).split('-')
  return isMobile ? `${month}/${day}` : `${month}月${day}日`
}}
```

**关键 CSS**：
- `left: -12`（负 margin 向左推进图表区域）
- 手机端容器：`px-1 pt-2 pb-0`（极小 padding，最大化图表宽度）
- `useMobile` hook 用 `useSyncExternalStore` 实现 SSR 安全

**注意**：桌面端可保持原有 margin 值，仅在手机端收缩

| 指标卡（11个） | 手机端左右箭头占位导致卡片被压缩 | 桌面端箭头+网格；手机端水平滑动 `overflow-x-auto` + `snap-x`，每屏 2 张 |
| Tab 切换 + 导出 | 导出按钮宽度不适配 | 桌面端 `w-auto`；手机端 `w-full` |
| 图表区域 | — | 保持现状（`h-[360px]` 足够高） |

---

### 新品定价测算页面

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| 主布局 Grid | 手机端单列未声明 | 添加 `grid-cols-1` 显式声明 |
| Tab 切换（4项） | 手机端 4 列太挤 | 手机端 `grid-cols-2`，平板+ `grid-cols-4` |
| 长/宽/高/重量 | 手机端 4 列溢出 | 手机端 `grid-cols-2`，平板+ `grid-cols-4` |
| 控制台筛选项 | 桌面端 flex 横向 → 手机换行混乱 | 手机端 2 列网格；平板+ 横向排列 |
| 测算结果 Popover | 按钮文字"下拉选择测算结果"过长 | 手机端简化为"下拉选择"，按钮 w-full |
| 清空选择按钮 | 手机端与其他筛选项同处一行不整齐 | 独立一行，按钮 h-9 |

**关键改动**：
- 控制台筛选项手机端 2 列网格 (`grid-cols-1 sm:grid-cols-[140px_1fr_auto] md:flex`)
- `sm:grid-cols-2` 让尺寸行（长宽高重）在手机端变成 2×2 网格
- Tabs 手机端 2 列，平板+ 4 列横向

---

### 店铺 SKU 测算页面

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| 主布局 Grid | 手机端未声明列数 | 添加 `grid-cols-1` 显式声明 |
| 控制台筛选项 | 项目/SKU/导出带标签，手机换行混乱 | 手机端隐藏标签（`hidden sm:block`），2 列网格 `gap-3` |
| 站点切换器 | 宽度 `sm:w-48` 固定 | 手机端 `w-full`，平板+ `sm:w-48` |
| 空状态 | 固定高度 `h-48` 在手机端利用不充分 | 改为 `py-8`，自适应高度 |
| 错误状态 | `m-4` 在手机端 margin 过大 | 改为无固定 margin，p-4 改为 `px-4` |

**关键改动**：
- 筛选项手机端 `hidden sm:block` 隐藏标签，`grid-cols-1 sm:grid-cols-2`
- 站点切换器手机端 `w-full`，平板+ `sm:w-48`
- 空状态容器：`py-8` 替代固定 `h-48`

---

### 库存分析页面

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| 主控制台 | DataCard + FilterField 结构复杂，手机端布局错乱 | 重构为 `dashboard-surface` 直接承载筛选项 + 统计条，移除 DataCard 包裹 |
| 筛选项 | FilterField 包裹导致换行混乱 | 去除 FilterField，手机 2 列网格 `grid-cols-2`，平板+ 横向 `md:flex` |
| 筛选项标签 | 桌面端显示标签，手机端多余 | `hidden md:block` 手机隐藏，桌面 `text-[0.72rem]` |
| 统计条 | DataTableCardStatBar 手机端 4 项溢出 | 手工实现 stats，手机 `flex-col divide-y` 纵向，桌面 `sm:flex-row sm:divide-x` 横向 |
| 导出按钮 | 宽度不适配 | 手机 `w-full`，平板+ `sm:w-auto` |

**关键重构**：
- 移除 `DataCard` / `DataCardHeader` / `DataCardContent` 包裹，直接使用 `dashboard-surface`
- 移除 `FilterField` 组件，筛选项直接用 `div.space-y-1.5` + `Select` / `CountrySelect`
- 统计条手工实现：手机 `grid grid-cols-2 gap-2` 2×2 网格，桌面 `sm:flex-row` 横向
- 业务日期显示手机端 `hidden sm:inline` 隐藏标签文字

**高度陷阱（SelectTrigger 的 min-h-touch）**：
- `SelectTrigger` 组件内部有 `min-h-touch`（44px），即使传入 `h-9`（36px）也会被覆盖
- 非 Select 的自定义显示元素（如业务日期框）必须同步使用 `min-h-[44px]` 才能与 Select 保持一致
- 圆角样式必须与 SelectTrigger 一致（`rounded-lg` 而非 `rounded-md`）
- 边框样式必须与 SelectTrigger 一致（`border-border/70` 或 `border-input`）

```tsx
// ❌ 错误：高度不一致
<div className="h-9 w-full border border-border/70 rounded-md">...</div>

// ✅ 正确：与 SelectTrigger 一致
<div className="h-9 min-h-[44px] w-full border border-border/70 rounded-lg">...</div>
```

---

### 补货分析页面

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| 控制台整体 | DataCard + FilterField 结构，手机端布局错乱 | 重构为 `dashboard-surface` 直接承载，去除 DataCard / DataCardHeader / DataCardContent / FilterField |
| 筛选项（4项） | FilterField 包裹导致标签冗余、换行混乱 | 去除 FilterField，手机 `grid-cols-2` 2×2 网格，桌面 `lg:flex` 横向排列 |
| 统计条（7项） | DataTableCardStatBar 7 列横排手机端严重挤压 | 手机 `grid-cols-2` 2×2 网格带 border，桌面 `lg:flex` + `divide-x` 横排 |
| 标题行 | 仅桌面横向排列 | 手机 `flex-col` 堆叠，桌面 `sm:flex-row` 横向 |
| 表格（22列） | `min-w-[2050px]` 完全无法在手机端使用 | 桌面保留完整表格（`hidden md:block`）；手机卡片列表（`md:hidden`）|
| 手机卡片列表 | 22 列数据需要精简展示 | 核心信息：SKU + 国家 + 风险状态 + 4 核心数据 + 日期 + 可编辑字段 + 操作按钮 |
| 可编辑字段 | 生产交货/运输时间/加权系数需要在手机端保留编辑能力 | 3 列网格 `grid-cols-3`，Input 缩小为 `h-8 text-xs` |
| 导出按钮 | 导出 Excel 按钮宽度不适配 | 手机 `w-full`，桌面 `sm:w-auto`，移到 Tabs 头部 |
| Tabs + 导出 | 导出按钮原在 DataTableCardHeader 内 | 移到 Tabs 行，手机端 `flex-col` 堆叠 |

**关键重构**：
- 移除 `DataCard` / `DataCardHeader` / `DataCardContent` / `DataTableCardStatBar` / `FilterField` 导入
- 控制台三层结构：标题行 → 筛选项 → 统计条，各自独立 border-t 分隔
- 统计条手机端：`grid grid-cols-2 gap-2`，每项带 `rounded-lg border border-border/70`
- 统计条桌面端：`lg:flex lg:divide-x lg:divide-border/60`，去除圆角和边框
- 手机卡片列表：每个 SKU 卡片包含完整编辑功能（保存按钮 + 查看发货按钮）
- 操作按钮：`h-9 min-h-[44px]` 确保触摸友好（`flex-1` 等分宽度）

---

### 调研分析页面

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| MetricGridCard | DataCard + DataCardHeader + DataCardContent 嵌套 | 重构为 `div.dashboard-surface` + 内联 header/content，`grid-cols-2 lg:grid-cols-3` |
| InsightChartCard | 同上 | 重构为 `div.dashboard-surface`，标题行内联 |
| ContextSummaryStrip | `grid-cols-3` 手机端布局不均 | 改为 `grid-cols-2` |
| 调研工作台 | DataCard 包裹，grid `md:grid-cols-2` | 重构为 `dashboard-surface`，`grid-cols-2 lg:grid-cols-5`，SelectTrigger 添加样式 |
| 核心过程 | DataCard 包裹 | 重构为 `dashboard-surface`，`grid-cols-2 lg:grid-cols-4` |
| 分析工作台 | DataCard 包裹，SelectTrigger 无样式 | 重构为 `dashboard-surface`，添加 SelectTrigger 样式 `h-9 w-full rounded-lg` |
| 骨架屏 | `md:grid-cols-2 lg:grid-cols-4` | 改为 `grid-cols-2 lg:grid-cols-4` |

**关键改动**：
- MetricGridCard / InsightChartCard 组件重构为内联实现，去除 DataCard 嵌套
- SelectTrigger 添加统一样式：`h-9 w-full rounded-lg border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]`
- ContextSummaryStrip：`md:grid-cols-3` → `grid-cols-2`（手机端先适配）
- 各 section 的 grid 从 `md:` 改为直接在 `lg:` 断点生效，手机端用更紧凑的布局

---

### 目标管理页面

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| 控制台 Hero | Card + CardHeader 结构，手机端堆叠不紧凑 | 重构为 `dashboard-surface` 直接承载 |
| 标题行 | `CardTitle text-2xl md:text-[2rem]` | 改为 `h2 text-2xl lg:text-[2rem]` |
| 描述行 | `CardDescription` | 改为 `p` 元素 |
| 筛选项（3项+刷新） | 固定宽度 `w-56`/`w-36`/`w-28`，无包裹 | 改为 `grid-cols-2 sm:grid-cols-3 lg:flex` 响应式布局，SelectTrigger `w-full` |
| 刷新按钮 | 固定宽度 | 手机 `w-full`，桌面 `lg:w-auto` |
| 本月进度 StatCard | `grid-cols-2 gap-4` 间距大 | 改为 `grid-cols-2 gap-2 sm:grid-cols-4` |
| 骨架屏 | 固定 `h-36`/`h-64` | 改为 `h-28 rounded-xl sm:h-36` / `h-48 sm:h-64` |
| 空状态 | 无包裹 | 添加 `dashboard-surface` 包裹 |

**关键改动**：
- 控制台 Hero：`Card` → `div.dashboard-surface`，`CardHeader` → `div.px-4.py-4`
- 标题：使用原生 `h2` + `CardTitle` 类名，去除 `Card` 组件
- 筛选项：`grid grid-cols-2 sm:grid-cols-3 lg:flex lg:flex-row lg:gap-3`
- StatCard 区域：`gap-2` 手机端更紧凑
- 空状态/骨架屏：添加响应式高度

---

### 退货分析页面

| 元素 | 问题 | 适配方案 |
|------|------|----------|
| 控制台 | DataCard + FilterField 结构，标签冗余 | 重构为 `dashboard-surface`，去除 DataCard / DataCardHeader / DataCardContent / FilterField |
| 筛选项（3项） | 项目/国家/日期范围 + 操作按钮 | 手机 `grid-cols-2`，日期范围 `col-span-2`；桌面 `lg:flex` 横向 |
| 日期范围 | `w-[240px]` 固定宽度 | 改为 `w-full` 配合 grid |
| 操作按钮 | 与筛选项同处一行 | 移至标题行 action 区域，手机 `w-full sm:w-auto` |
| 统计卡（7项） | 嵌套 DataCard 过重 | 精简为 `dashboard-surface` 内 `grid-cols-2` 带 border 的统计单元格 |
| 排行表（7列） | 偏挤 | 保持现状，7 列在手机端勉强可用 |
| 趋势图表 | 留白大 | 缩减 margin，减小 barSize / fontSize / radius，容器 `p-1 sm:p-4` |
| 饼图 | 外半径大 | `outerRadius` 缩小，容器高度 `h-[240px] sm:h-[300px]` |
| 星期分布 | `grid-cols-7` 手机端太挤 | 改为 `grid-cols-4 sm:grid-cols-7` |
| Tab 内容区 | 无 padding | 各 Tab 添加 `p-4` padding |

**关键改动**：
- 控制台三层结构：标题行（含操作按钮）→ 筛选项 → 统计条
- 统计卡改为 `rounded-lg border border-border/70 py-2.5 px-2` 内联样式，去除嵌套 DataCard
- 图表优化：margin `top: 12, right: 4, left: -12, bottom: 8`，barSize 16/10，fontSize 10
- 标题 `text-base font-semibold`（统一为 `text-base`，去除 `text-lg`/`text-2xl`）

---

### Terminal 移动端筛选折叠条（BLF-933 / BLF-930 / BLF-931）

> Terminal 终端页面的移动端筛选适配方案：把散落在 header 中段插槽的筛选项，在手机端**下迁为正文顶部的可折叠筛选条**，折叠态只占一行、展示当前筛选摘要，展开态用 2 列网格承载控件。桌面端行为完全不变（零回归）。

#### 新组件

| 组件 | 位置 | 职责 |
|------|------|------|
| `MobileFilterStrip` | `frontend/components/terminal/mobile-filter-strip.tsx` | 可折叠筛选条主体：折叠态=筛选图标+摘要+展开按钮；展开态=`grid-cols-2` 网格渲染 `controls` |
| `MobileFilterWide` | 同上 | 宽筛选项容器（`col-span-2` 占整行），用于日期范围 / SKU 搜索等宽控件 |
| `MobileStripMount` | `frontend/components/terminal/terminal-header-slot.tsx` | 正文顶部挂载点（`md:hidden`，仅 <768px 可见，`sticky top-0`） |
| `useMobileFilterStrip` | 同上 | 页面侧 hook：`isMobile` 时把折叠条 portal 进正文顶部挂载点；桌面端返回 null |

#### 设计决策

1. **折叠优先**：默认折叠，只显示当前筛选摘要（如「玥涵 · US · 06/01~09/01」），不遮挡正文数据区；点开才露出控件，收起即还原。
2. **2 列网格 + 宽控件整行**：短控件（项目/站点 Select）各占 1/2，宽控件（日期范围/SKU 搜索）用 `MobileFilterWide` 占整行——对应规则 2/9 的 2 列网格基线。
3. **下迁不复制**：复用页面上已有的筛选控件（同一份 state / 回调闭包），通过 portal 从 header 中段插槽（桌面）下迁到正文顶部（手机），避免双份控件导致状态分叉。
4. **桌面零回归**：桌面端 `useHeaderSlot` 行为完全不变；`useMobileFilterStrip` 在非 `isMobile` 时返回 null，不渲染任何内容。
5. **Terminal 终端风格**：与终端视觉一致——1px border / 零圆角 / `term-*` 色组 / mono 数值，融入现有终端页面。
6. **触控友好**：折叠条按钮 `min-h-[44px]`，满足规则 5 最小触摸面积。

#### Stage 1-3 关键改动

| Stage | Issue | 内容 |
|-------|-------|------|
| Stage 1（基础设施） | BLF-933 | `MobileFilterStrip`/`MobileFilterWide` 组件 + `MobileStripMount` 挂载点 + `useMobileFilterStrip` hook；`TerminalShell` 正文 `main` 顶部挂载；组件/挂载机制双测试（`mobile-filter-strip.test.tsx` / `mobile-strip-mount.test.tsx`） |
| Stage 2（试点页面） | BLF-930 | 首页 `dashboard/page.tsx`（项目 Select + 数据区间徽标）+ `daily-analysis`（项目/站点/日期/SKU 四件套）接入；Playwright 试点冒烟 `mobile-filter-strip-pilot.spec.ts`（360px/390px 折叠渲染、摘要、展开交互、URL 同步、桌面零回归） |
| Stage 3（批量推广 13 页） | BLF-931 | 模式复制到 13 个终端页面，统一「桌面 `isMobileView={false}` + 手机 `useMobileFilterStrip`」双轨；12 页移除 `useIsMobile` 导入（仅 weekly-product-analysis 保留用于图表渲染）；各页测试补 mock `useMobileFilterStrip: () => null` |

#### 验证通过的移动端页面清单（Stage 3 批量推广）

| 页面 | 筛选控件形态 |
|------|--------------|
| 首页 `dashboard` | 项目 Select + 数据区间徽标 |
| 每日分析 `daily-analysis` | 项目/站点（短）+ 日期/SKU（宽）四件套 |
| 库存分析 `inventory-analysis` | 项目 + 国家站点 + 快照日期 + 业务日期徽标 |
| 库存流水 `inventory-ledger` | 6 维 Select（项目/月份/SKU/仓库/状态/事件）+ 清除筛选 |
| 补货分析 `inventory-replenishment` | 项目 + 关键词 + 站点 + 风险状态 |
| 组合总览 `portfolio-overview` | PortfolioFilters（多项目/站点/日期范围/刷新） |
| 周商品分析 `weekly-product-analysis` | Select × 2 + 日期范围 |
| SKU 信息 `sku-info` | 项目 + SKU 输入 + ASIN 输入 + 站点 + 状态 + 查询/重置 |
| 货件管理 `shipment-management` | 项目 + 状态 + 国家 + 货件编号搜索 |
| 季节性补货 `seasonal-replenishment` | 项目 + 站点 + 日期范围 + 关键词 + 同比开关 |
| 退货分析 `return-analysis` | 项目 + 站点 + 日期范围 |
| 目标管理 `project-goals` | 项目 + 站点 + 年份 |
| 平台收入 `finance/platform-revenue` | 项目 + 年份 + 月份 + 币种 + 回款类型 + 重置 |
| 汇率管理 `finance/exchange-rate` | 币种 + 年份 + 月份 + 重置 |
| 佣金管理 `finance/commission-management` | 月/年选择器 + 站点 + 核算按钮 |

#### 实现模式

```tsx
// 页面侧：桌面端走 useHeaderSlot，手机端走 useMobileFilterStrip（同一份筛选控件）
const desktopSlot = useHeaderSlot(
  <HeaderFilterControls isMobileView={false} controls={filters} />
)
const mobileStrip = useMobileFilterStrip(
  <MobileFilterStrip
    summary={summaryText /* 如 '玥涵 · US · 06/01~09/01' */}
    controls={
      <>
        <HeaderProjectSelect ... />   {/* 短控件：1/2 列 */}
        <HeaderCountrySelect ... />   {/* 短控件：1/2 列 */}
        <MobileFilterWide><HeaderDateRangePicker ... /></MobileFilterWide> {/* 宽：整行 */}
        <MobileFilterWide><SkuSearch ... /></MobileFilterWide>            {/* 宽：整行 */}
      </>
    }
  />
)
return <>{desktopSlot}{mobileStrip}</>
```

**关键点**：
- 折叠摘要 `summary` 由页面根据当前筛选值自行构造，筛选变化时保持同步；
- `useMobileFilterStrip` 仅在 `<768px`（`useIsMobile`）且挂载点就绪时渲染，SSR / 首帧挂载点未就绪时返回 null 不报错；
- 控件经 portal 进正文顶部 `MobileStripMount`，页面 unmount / 路由切换自动清除，不残留。

---

## 附录：常用断点参考

| 断点 | 范围 | 典型设备 |
|------|------|----------|
| 手机 | `<640px` | iPhone SE/Android 小屏 |
| 大手机 | `640px-767px` | iPhone 14/Pro |
| 平板竖屏 | `768px-1023px` | iPad Mini |
| 平板横屏/小桌面 | `1024px-1279px` | iPad Pro 11" |
| 桌面 | `≥1280px` | 笔记本/台式机 |