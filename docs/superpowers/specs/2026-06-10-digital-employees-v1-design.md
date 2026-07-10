# 数字员工页面 V1 设计规格

> 日期：2026-06-10
> 范围：列表页 + 详情页 + 全屏展示页 — 全部深度打磨到可交付质量

---

## 1. 设计目标

将数字员工模块从"原型"提升到"可交付产品"，与项目其他页面的 Linear/Stripe 级别品质对齐。

**三词基调：专业 · 紧凑 · 可信赖**

### 1.1 要去掉的元素

| 当前元素 | 原因 |
|----------|------|
| emoji 心情球（mood orb）| 不专业，与项目风格不一致 |
| 💭 思考气泡 | 信息冗余，卡片内容过载 |
| 角色心情标签（⚡💤✅❌⏸）| 用状态 badge 替代 |
| `animate-shake` 失败动画 | 过于夸张 |
| 拟人化播放器（详情页）| 用实时日志流替代 |

### 1.2 要保留的元素

| 元素 | 保留方式 |
|------|----------|
| 类型 emoji（📤⏰🤖💬📊🗄️⚙️）| 作为头像区域的视觉锚点 |
| 角色 tagline（报表快递员等）| 作为副标题，更克制地展示 |
| 状态颜色体系 | 蓝=运行中，绿=成功，红=异常，灰=空闲，琥珀=暂停 |
| 轮询刷新 | 保留 10s 员工列表 + 15s 活动流 |

---

## 2. 统一组件体系

### 2.1 消除组件重复

当前有两套重叠的组件，需要合并：

| 功能 | 当前文件 | 合并为 |
|------|----------|--------|
| 员工头像 | `employee-avatar.tsx` + `persona.tsx` 的 `EmployeeAvatar` | 统一为 `employee-avatar.tsx` |
| 状态徽章 | `status-badge.tsx` + `digital-employee-card.tsx` 的 `StatusOrb` | 统一为 `status-badge.tsx` |
| 心跳指示 | `heartbeat-dot.tsx` + `digital-employee-card.tsx` 的 `LastActiveBar` | 统一为 `heartbeat-dot.tsx` |
| Persona 映射 | `persona.tsx` 的 `PERSONA_MAP` + `digital-employee-card.tsx` 内部的 `PERSONA_MAP` | 统一为 `persona.tsx` 导出 |

### 2.2 修复 Tailwind 动态类名

`PersonaAvatar` 和 `EmployeeAvatar` 中用模板字符串拼接 Tailwind 类名（如 `` `from-${color}-50` ``），这些类不会被 Tailwind 扫描器发现，编译后不存在。

**修复方案**：使用 `style` 属性替代动态类名，或使用完整的 safelist 类名映射。

```typescript
// ❌ 不会生效
`from-${color}-500/10 to-${color}-500/5`

// ✅ 用 style 替代
style={{ background: `linear-gradient(135deg, hsl(var(--${colorKey}-500)/.08), hsl(var(--${colorKey}-500)/.03))` }}
```

### 2.3 新增组件

| 组件 | 用途 |
|------|------|
| `DataStream` | 卡片内的 fade 轮播数据流窗口 |
| `LiveLog` | 详情页右侧的实时日志流 |
| `EmployeeCard`（重写）| 新结构：header + avatar + data-stream + footer |

---

## 3. 列表页 (`/dashboard/digital-employees`)

### 3.1 页面布局

```
┌─────────────────────────────────────────────────────────┐
│ [图标] Operations · Digital Employees    [全屏] [刷新]   │ ← Header
├─────────────────────────────────────────────────────────┤
│ [全部(7)] [运行中(3)] [空闲(3)] [异常(1)]  [搜索框]      │ ← Stats + Filters
├───────────────────────────────────────┬─────────────────┤
│                                       │ ● 实时动态       │
│   ┌─────────┐  ┌─────────┐           │                 │
│   │ Card 1  │  │ Card 2  │           │ [Activity 1]    │
│   │         │  │         │           │ [Activity 2]    │
│   └─────────┘  └─────────┘           │ [Activity 3]    │
│   ┌─────────┐  ┌─────────┐           │ [Activity 4]    │
│   │ Card 3  │  │ Card 4  │           │ ...             │
│   │         │  │         │           │                 │
│   └─────────┘  └─────────┘           │                 │
│                                       │                 │
├───────────────────────────────────────┴─────────────────┤
│                                                         │
└─────────────────────────────────────────────────────────┘
```

- 左侧：卡片网格（`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`）
- 右侧：固定宽度 360px 活动流面板（`lg:grid-cols-[1fr,360px]`）
- 小屏幕时活动流隐藏或折叠到底部

### 3.2 Stats 栏设计

与项目其他页面一致的紧凑统计条：

```
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│ 🤖  7  │ │ ●  3   │ │ ✓  3   │ │ ⚠  1   │
│ 全部    │ │ 运行中  │ │ 空闲   │ │ 异常    │
└────────┘ └────────┘ └────────┘ └────────┘
```

- 每个 stat 卡片：左侧小图标 + 右侧数字 + 底部标签
- 运行中的 stat 有蓝色高亮 + 脉冲点
- 异常 > 0 时红色高亮

### 3.3 卡片设计（核心）

每张卡片从上到下的结构：

```
┌──────────────────────────────┐
│ ═══ 顶部色带（运行中=蓝渐变） │ ← 2px 顶部装饰
├──────────────────────────────┤
│ 📤  报表上传机器人     [ℹ]   │ ← Header: emoji + 名称 + info 按钮
│     报表快递员               │ ← 副标题: tagline
├──────────────────────────────┤
│                              │
│           📤                 │ ← 中间: 大头像区域 (64×64)
│                              │
├──────────────────────────────┤
│ ┌──────────────────────────┐ │
│ │ 上传 BLF 日报 — 67%     │ │ ← 数据流窗口 (fade 轮播)
│ │ ████████░░░░░            │ │
│ └──────────────────────────┘ │
│   ● ● ○                      │ ← 轮播指示器
├──────────────────────────────┤
│ ● 2 分钟前活跃        运行中 │ ← Footer: 心跳 + 状态文字
└──────────────────────────────┘
```

#### 数据流窗口行为

- 固定高度 80px，只显示一条消息
- 多条消息自动 fade in/out 轮播，间隔 4-5 秒
- 底部小圆点指示器（当前消息高亮）
- 消息来源：当前任务进度 → 上次完成的任务 → 员工描述
- 运行中：显示当前任务名 + 进度条
- 空闲：显示上次完成的任务摘要
- 异常：显示错误信息，红色边框

#### 卡片状态样式

| 状态 | 顶部色带 | 头像边框 | 数据流窗口 |
|------|----------|----------|------------|
| RUNNING | 蓝色渐变 + shimmer 动画 | 蓝色边框 + 脉冲 | 蓝色进度条 |
| IDLE | 无 | 默认灰色边框 | 灰色文字 |
| SUCCEEDED | 绿色 | 绿色边框 | 绿色 ✓ 前缀 |
| FAILED | 红色 | 红色边框 | 红色背景 + ⚠ |
| SUSPENDED | 琥珀色 | 琥珀色边框 | 琥珀色 ⏸ 前缀 |

#### ℹ Info 按钮

- 位置：卡片右上角
- 样式：28×28 圆角方块，灰色边框，`ℹ` 图标
- 行为：点击跳转到 `/dashboard/digital-employees/{id}`
- hover 时边框变蓝

---

## 4. 详情页 (`/dashboard/digital-employees/[id]`)

### 4.1 页面布局

```
┌─────────────────────────────────────────────────────────┐
│ ← 返回列表                                              │
├─────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐ │
│ │  📤  报表上传机器人                    [暂停] [日志]  │ │ ← Hero 区
│ │      auto_report_upload · 报表快递员                 │ │
│ │      ● 运行中 · 最后活跃 2 分钟前                    │ │
│ └─────────────────────────────────────────────────────┘ │
├───────────────────────────────┬─────────────────────────┤
│ ┌─ 当前任务 ──────────────┐   │ ┌─ 实时动态 ──────────┐ │
│ │ 上传 BLF 日报           │   │ │ █ 解析文件数据 67%   │ │
│ │ ████████████░░░  67%    │   │ │ █ 文件校验通过       │ │
│ │ 步骤: 解析文件数据      │   │ │ █ 开始处理           │ │
│ └─────────────────────────┘   │ └─────────────────────┘ │
│ ┌─ 任务历史 ──────────────┐   │ ┌─ 员工信息 ──────────┐ │
│ │ ✅ SKU 成本表  14:30    │   │ │ 类型: auto_report   │ │
│ │ ✅ 库存报表    11:05    │   │ │ 静默阈值: 30 分钟    │ │
│ │ ❌ 广告报表    昨天     │   │ │ 创建: 2026-05-15    │ │
│ │ [加载更多]              │   │ │ 描述: 自动监控...    │ │
│ └─────────────────────────┘   │ └─────────────────────┘ │
└───────────────────────────────┴─────────────────────────┘
```

### 4.2 Hero 区

- 大头像 80×80 圆角方块 + 状态点
- 名称 22px 粗体
- 副标题：`employee_type · tagline`
- 状态 badge + 最后活跃时间
- 右侧操作按钮：暂停/恢复 + 查看日志

### 4.3 当前任务卡片

- 仅在状态为 RUNNING 时显示
- 任务名称 15px
- 进度条 6px 高，蓝色渐变
- 当前步骤 + 百分比
- 无 RUNNING 任务时，此卡片隐藏

### 4.4 任务历史

- 列表形式，每项：状态 icon + 任务名 + 时间 + 状态 badge
- 最多显示 10 条，底部"加载更多"按钮
- 失败任务显示错误原因

### 4.5 实时日志流

- 替代当前的拟人化播放器
- **数据源**：`digital_employee_logs` 表，通过 `fetchEmployeeLogs(employeeId, taskId)` 获取
- 垂直时间线样式，左侧色带（按 level：INFO=蓝，WARN=琥珀，ERROR=红）
- 每条日志：时间 + 消息内容
- 轮询刷新（15s）
- 最多显示 20 条，可滚动
- 需要新增 API：获取员工最近日志（不指定 task_id），或复用现有接口传 task_id=null

### 4.6 员工信息

- 简洁的键值对列表
- 类型、静默阈值、创建时间、描述

---

## 5. 全屏展示页 (`/dashboard/digital-employees/display`)

### 5.1 设计原则

- 保留暗色主题（适合 TV 长时间展示）
- 去掉全屏 API 调用（`requestFullscreen`）— 用户自己决定是否全屏
- 去掉拟人化元素，用专业卡片

### 5.2 页面布局

```
┌─────────────────────────────────────────────────────────┐
│ 数字员工监控台                                           │
│ 实时运行状态                                             │
│ 2026年6月10日 周二 15:32:18            [隐藏动态] [刷新] │
├─────────────────────────────────────────────────────────┤
│ ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                 │
│ │  7   │  │  3   │  │  3   │  │  1   │                 │
│ │全部  │  │运行中│  │空闲  │  │异常  │                 │
│ └──────┘  └──────┘  └──────┘  └──────┘                 │
├──────────────────────────────────┬──────────────────────┤
│ ┌─────────┐ ┌─────────┐ ┌──────┤ │ ● 实时动态          │
│ │ Card 1  │ │ Card 2  │ │Card 3│ │ [Activity 1]       │
│ └─────────┘ └─────────┘ └──────┤ │ [Activity 2]       │
│ ┌─────────┐ ┌─────────┐ ┌──────┤ │ [Activity 3]       │
│ │ Card 4  │ │ Card 5  │ │Card 6│ │ ...                │
│ └─────────┘ └─────────┘ └──────┤ │                    │
└──────────────────────────────────┴──────────────────────┘
```

### 5.3 暗色主题变量

- 背景：`#0f172a`（slate-900）
- 卡片背景：`rgba(255,255,255,0.04)`
- 卡片边框：`rgba(255,255,255,0.08)`
- 运行中高亮：`rgba(37,99,235,0.1)` 背景 + `rgba(37,99,235,0.2)` 边框
- 异常高亮：`rgba(220,38,38,0.1)` 背景 + `rgba(220,38,38,0.2)` 边框
- 文字：`#f1f5f9`（主）、`#94a3b8`（次）、`#64748b`（弱）

### 5.4 卡片结构

与列表页卡片相同的 header + avatar + data-stream + footer 结构，但使用暗色配色。

---

## 6. Activity Feed（活动流）

### 6.1 数据来源

保留现有的 `fetchAllRecentTasks` 逻辑：先拉所有员工，再逐个拉最近任务。后续优化为后端单次聚合接口。

### 6.2 样式

- 每条活动：左侧缩略头像 + 员工名 + 任务描述 + 时间
- 颜色语义：蓝=进行中，绿=完成，红=失败，灰=心跳
- 运行中的活动显示进度条
- 紧凑模式（`compact`）在列表页侧边栏使用

---

## 7. ActionBar 按钮接通

当前 ActionBar 的按钮没有接 API，需要在 V1 中接通：

| 按钮 | 行为 |
|------|------|
| 暂停 | 调用 `suspendEmployee(id)`，状态变 SUSPENDED |
| 恢复 | 调用 `resumeEmployee(id)`，状态变 IDLE |
| 重试 | 对 FAILED 状态的员工，调用 `resumeEmployee(id)` 重置为 IDLE |
| 详情/ℹ | 跳转 `/dashboard/digital-employees/{id}` |
| 日志 | 跳转详情页的实时日志区域 |

---

## 8. 代码质量修复清单

| # | 问题 | 修复方案 |
|---|------|----------|
| 1 | Tailwind 动态类名不生效 | 用 `style` 属性替代模板字符串拼接 |
| 2 | 两套 Avatar 组件 | 合并为 `employee-avatar.tsx`，从 `persona.tsx` 导入颜色映射 |
| 3 | 两套 persona 映射 | 统一到 `persona.tsx` 单一导出 |
| 4 | ActivityFeed N+1 请求 | 保持现状（后续后端优化），前端加 loading 状态 |
| 5 | 详情页无实时刷新 | 加 15s 轮询 |
| 6 | 详情页任务历史无分页 | 加"加载更多"按钮 |
| 7 | `use(params)` + `parseInt` | 保持 Next.js 14 兼容 |
| 8 | 拟人化播放器相关文件 | 详情页不再使用，保留文件但不在详情页引用 |

---

## 9. 文件变更清单

### 修改

| 文件 | 变更 |
|------|------|
| `frontend/components/digital-employee/digital-employee-card.tsx` | **重写**：新结构 header + avatar + data-stream + footer |
| `frontend/components/digital-employee/digital-employee-grid.tsx` | 微调：支持新的 card props |
| `frontend/components/digital-employee/persona.tsx` | 合并 persona 映射 + 修复动态类名 |
| `frontend/components/digital-employee/employee-avatar.tsx` | 合并两套实现 + 修复动态类名 |
| `frontend/components/digital-employee/status-badge.tsx` | 保持，确保被统一引用 |
| `frontend/components/digital-employee/heartbeat-dot.tsx` | 保持，确保被统一引用 |
| `frontend/components/digital-employee/stats.tsx` | **重写**：新样式（图标 + 数字 + 标签） |
| `frontend/components/digital-employee/activity-feed.tsx` | 微调：适配侧边栏布局 |
| `frontend/app/dashboard/digital-employees/page.tsx` | **重写**：右侧边栏布局 |
| `frontend/app/dashboard/digital-employees/[id]/page.tsx` | **重写**：焦点式布局 + 实时日志 |
| `frontend/app/dashboard/digital-employees/display/page.tsx` | **重写**：暗色专业监控台 |

### 新增

| 文件 | 用途 |
|------|------|
| `frontend/components/digital-employee/data-stream.tsx` | Fade 轮播数据流窗口组件 |

### 删除

| 文件 | 原因 |
|------|------|
| `frontend/components/digital-employee/personified-player.tsx` | 详情页不再使用，删除 |
| `frontend/lib/digital-employee/aggregator.ts` | 播放器依赖，一并删除 |
| `frontend/lib/digital-employee/rhythm-player.ts` | 播放器依赖，一并删除 |
| `frontend/lib/digital-employee/persona-templates.ts` | 播放器依赖，一并删除 |

### 不变

| 文件 | 原因 |
|------|------|
| `frontend/lib/digital-employee-api.ts` | 需新增 `fetchEmployeeRecentLogs(employeeId)` 函数 |
| `frontend/hooks/use-digital-employees.ts` | 数据获取 hook 无需改动 |
| `frontend/types/digital-employee.ts` | 类型定义无需改动 |
| `frontend/components/digital-employee/progress-bar.tsx` | 保留，可能在其他地方使用 |
| `backend/` | 后端无需改动（详情页日志复用现有 logs API） |
