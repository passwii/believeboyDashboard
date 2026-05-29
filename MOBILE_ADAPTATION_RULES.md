# 手机端响应式设计打磨规则

> 本文档记录定时报告页面手机端适配过程中总结的成功案例与设计规则，供后续页面打磨参考。

---

## 核心原则

1. **数据优先**：手机端显示的核心是数据本身，而非表格容器
2. **渐进式隐藏**：PC 端显示的信息在手机端通过卡片堆叠展示，关键信息不丢失
3. **触摸友好**：按钮、输入框足够大，间距充足，避免误触
4. **遵循项目设计系统**：复用 `dashboard-surface`、`dashboard-panel`、`dashboard-toolbar` 等组件类

---

## 规则清单

### 规则 1：表格 → 卡片列表（Table → Card List）

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

**注意**：如果某筛选项需要特别说明（如"周一限制 ≥ 16:00"），可以在控件内通过 tooltip 或 placeholder 提示，而不是单独标签

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
| SKU + 日期范围 | 全宽显示 | 各自独立一行，无标签 |
| 操作按钮 | 双按钮堆叠 | 双按钮横排 `flex-1` 各占一半 |
| 指标卡（11个） | 手机端左右箭头占位导致卡片被压缩 | 桌面端箭头+网格；手机端水平滑动 `overflow-x-auto` + `snap-x`，每屏 2 张 |
| Tab 切换 + 导出 | 导出按钮宽度不适配 | 桌面端 `w-auto`；手机端 `w-full` |
| 图表区域 | — | 保持现状（`h-[360px]` 足够高） |

---

---

## 附录：常用断点参考

| 断点 | 范围 | 典型设备 |
|------|------|----------|
| 手机 | `<640px` | iPhone SE/Android 小屏 |
| 大手机 | `640px-767px` | iPhone 14/Pro |
| 平板竖屏 | `768px-1023px` | iPad Mini |
| 平板横屏/小桌面 | `1024px-1279px` | iPad Pro 11" |
| 桌面 | `≥1280px` | 笔记本/台式机 |