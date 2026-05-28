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

---

## 附录：常用断点参考

| 断点 | 范围 | 典型设备 |
|------|------|----------|
| 手机 | `<640px` | iPhone SE/Android 小屏 |
| 大手机 | `640px-767px` | iPhone 14/Pro |
| 平板竖屏 | `768px-1023px` | iPad Mini |
| 平板横屏/小桌面 | `1024px-1279px` | iPad Pro 11" |
| 桌面 | `≥1280px` | 笔记本/台式机 |