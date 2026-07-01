# 调度记录 Ledger 重构规格

## 背景

`frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx` 是「调度记录」页面，运营人员每天在这里看订阅报告的发送结果。当前实现有三个明显问题：

1. **关键信息藏在 Sheet 里** —— 项目名、邮箱、国家、截图缩略图全部不显示在列表上，必须点开 Sheet 才能看到一行订阅覆盖了哪些项目。30 天下来几十上百条记录，没法快速判断哪些订阅出了问题。
2. **排版松散** —— 5 列（应发时间 / 频率 / 状态 / 操作 + 展开按钮），操作列空旷，整体缺少节奏。
3. **Sheet 详情设计简陋** —— 状态条 + InfoRow 重复堆叠，截图 / AI 文案平铺纵向撑开，操作按钮被长文案挤到屏幕外。

## 范围

**仅前端修改**，不动后端 / 不动数据模型 / 不动 API。补发粒度保持 1 订阅 = 1 行（即「按订阅补发」语义不变；不做「按单项目补发」—— 后者需要后端建立项目级 delivery_log，超出本次范围）。

## 改动文件

| 文件 | 改动 |
|------|------|
| `frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx` | 重写：去掉统计卡，改为按日分组表格，Sheet 详情重做 |
| `frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerSummaryCards.tsx` | 不删除（保留以防其它页面引用），但 ledger page 不再 import |
| 其它 `_components/` | 不动 |
| 后端 | 不动 |

## 设计

### ① 工具栏（精简）

- 删除 `LedgerSummaryCards` 的引用及 `ledgerSummary` 状态
- `fetchLedger` 仍然调用，但忽略返回的 `summary` 字段
- 工具栏与下方分组表之间的间距由 `space-y-4` 收紧为 `space-y-3`
- 桌面端 / 移动端工具栏双布局保留现状

### ② 表格 · 按日分组

**数据分桶**

```ts
const groupedByDay = useMemo(() => {
  const buckets: Record<string, LedgerItem[]> = {}
  for (const item of ledgerItems) {
    const date = item.expected_date  // 后端已按 yyyy-MM-dd 字符串返回
    ;(buckets[date] ??= []).push(item)
  }
  // 按日期降序（最新一天在前）
  return Object.fromEntries(
    Object.entries(buckets).sort(([a], [b]) => b.localeCompare(a)),
  )
}, [ledgerItems])
```

**展开状态**

```ts
const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
// 初始化为 {endDate}，依赖 ledgerEndDate 变化重置
```

- 重置规则：仅当 `ledgerStartDate` 或 `ledgerEndDate` 变化时，`useEffect` 重新设置 `expandedDates = new Set([ledgerEndDate])`
- 不响应 `ledgerFrequency` / `ledgerStatus` / `ledgerEmail` 变化（这些筛选变化不重置展开状态）

**渲染结构**

```tsx
<Card>
  <CardContent className="p-0 divide-y divide-border/60">
    {Object.entries(groupedByDay).map(([date, items]) => {
      const expanded = expandedDates.has(date)
      const isAnchor = date === ledgerEndDate
      const isToday = date === format(today, 'yyyy-MM-dd')
      return (
        <div key={date}>
          {/* 组头：可点击 */}
          <button onClick={() => toggleDate(date)} className="...">
            <Chevron className={cn('transition-transform', !expanded && '-rotate-90')} />
            <span>{date} · {WEEKDAY_LABELS[new Date(date).getDay()]}</span>
            {isToday && <Badge>今天</Badge>}
            <span>{items.length} 条</span>
            {/* 右侧状态计数徽标 */}
            <DayStatusCounts items={items} />
          </button>
          {/* 折叠区：表格 */}
          {expanded && <DayTable items={items} ... />}
        </div>
      )
    })}
  </CardContent>
</Card>
```

**组头视觉**

- 背景：`bg-muted/40`（与表格形成对比但不抢戏）
- 折叠箭头：`▸` / `▾`（lucide `ChevronDown` + rotate）
- 日期 + 周几：`text-sm font-medium`，周几用 `WEEKDAY_LABELS[new Date(date).getDay()]`（已存在 `_components/types.ts`）
- 「今天」徽标：仅当 `date === today` 时显示，蓝色填充 Badge
- 当日状态计数：3 个 inline 徽标（成功 / 失败 / 缺失），复用现有 `STATUS_BG` 配色 token，缺失某状态时不渲染
- 整行可点击

**表格列（7 列）**

| 列 | 宽度 | 内容 |
|----|------|------|
| 应发时间 | `w-20` | `HH:mm` |
| 项目 | 默认 + `truncate` + tooltip | `项目A · 项目B · 项目C`（来自 `project_names.join(' · ')`） |
| 国家 | `w-24` | Badge 列表；超过 1 个时折叠为 `US +1` |
| 邮箱 | `w-44` | `truncate` + tooltip |
| 频率 | `w-16` | Badge（daily/weekly/monthly） |
| 状态 | `w-24` | 徽标（复用现有 `STATUS_BG`） |
| 操作 | `w-28` 右对齐 | `LedgerResendCell` |

**行交互**（沿用现状）
- 点行空白 → 打开 Sheet 详情
- 点重发按钮 → `e.stopPropagation()`，触发补发
- 点行时不再依赖单独的展开按钮（展开由组头控制）

**移动端**：保留现有卡片列表（不分组）。手机屏幕已经够窄，分组反而碎。这一块**只最小改动**：把项目名 / 邮箱提到顶部更显眼位置（已经有），不动结构。

### ③ Sheet 详情 · 重做

**整体布局**（自上而下）

```
┌─────────────────────────────────────┐  ← 粘顶 hero
│  Hero 区（日期时间 + 邮箱/频率/国家 + 状态徽标）    │
├─────────────────────────────────────┤
│  [条件] 错误信息条（仅 failed 显示）         │
├─────────────────────────────────────┤
│  报告范围（项目 + 国家 Badge 列表）            │
├─────────────────────────────────────┤
│  截图 │ AI 文案                              │
│  (并排双栏)│                              │
├─────────────────────────────────────┤
│  [粘底] 操作栏                              │
└─────────────────────────────────────┘
```

**Hero 区**

- 背景渐变（按状态）：
  - sent: `from-emerald-50 to-white` + 底边 `border-emerald-200`
  - failed: `from-red-50 to-white` + 底边 `border-red-200`
  - missing: `from-amber-50 to-white` + 底边 `border-amber-200`
- 主行：`text-xl font-semibold`，日期时间格式 `2026-07-01 · 15:00`
- 副行：`text-xs text-muted-foreground`，`📨 ops@believeboy.com · 每日 · US`
- 状态徽标：右上角，hero 区内偏上

**错误信息条**（仅 failed 显示）

- 整条 `bg-red-50 border border-red-200 rounded-md p-3`
- 字体 `font-mono text-xs text-red-700`
- `whitespace-pre-wrap` 保留换行

**报告范围**

- 项目：蓝色 Badge（`bg-blue-50 text-blue-700 border-blue-200`）
- 国家：灰色 Badge
- 超过 8 个时折叠成 `+N 更多`，点开展开全部（用本地 `useState` 控制）

**双栏区**

- 桌面：`grid grid-cols-2 gap-4`
- 移动：`grid-cols-1`
- 截图：沿用现有缩略图 + 点击触发 `PortraitScreenshotDialog`
- AI 文案：
  - 标题行 + 右上角 `复制` 按钮
  - 内容区固定高度 `h-[200px]` + `overflow-y-auto`
  - 沿用 ReactMarkdown 渲染，className 复用现有 prose 配置
  - 缺失时显示虚线占位

**操作栏**（粘底）

- `sticky bottom-0 -mx-4 px-4 py-3 bg-background border-t border-border/60`
- 取消按钮（左侧）+ 重发/补发按钮（右侧，hero 同色）
- 仅 `canTriggerResend || selectedItem.can_resend` 时显示

**视觉统一**

- 标题统一：`text-[10px] uppercase tracking-wider text-muted-foreground font-medium`
- 区块间距：`space-y-5`
- 所有区块用统一圆角 `rounded-lg` + `border border-border/60`

### ④ 折叠规则

| 触发条件 | 行为 |
|----------|------|
| 首次加载 | `expandedDates = new Set([ledgerEndDate])` |
| 日期范围变化 | `useEffect` 重置 `expandedDates = new Set([ledgerEndDate])` |
| 频率 / 状态 / 邮箱筛选变化 | 不重置 |
| 用户点击组头 | 切换该日期的展开状态（set 加 / 删） |
| 加载中 / 空数据 | 组不渲染（沿用现有空态） |

「今天」徽标仅在 `date === today AND date === ledgerEndDate` 时显示（即末日恰好是今天）；末日不是今天时只显示日期 + 周几。

## 不动部分

- `LedgerResendCell.tsx` —— 重发逻辑、模型选择 popover 不变
- `LedgerSummaryCards.tsx` —— 文件保留，ledger page 不再 import
- `subscriptions/page.tsx`、`_components/SubscriptionForm.tsx`、`CreateSubscriptionDialog.tsx`、`EditSubscriptionDialog.tsx`、`ProjectScopeSelect.tsx` —— 不动
- `fetchLedger` / `resendLedgerEntry` / `pollDeliveryLogStatus` —— 不动
- 所有后端代码 —— 不动
- `PortraitScreenshotDialog` —— 不动
- Sheet / Dialog 容器组件本身 —— 不动

## 测试策略

手工测试为主（项目其它页面也无单测，保持一致）。重点验证：

1. **分组展开**：
   - 首次加载：只有末日组展开 + 「今天」徽标
   - 改日期范围：展开锚点跟随末日
   - 改频率 / 状态 / 邮箱：展开状态保持
   - 手动展开 / 折叠：正常切换
2. **Sheet 详情**：
   - 成功记录：hero 绿，无错误条
   - 失败记录：hero 红，错误条显示完整内容
   - 缺失记录：hero 琥珀，无错误条
3. **截图 + AI 文案**：双栏并排，点击截图放大正常，点击复制按钮复制成功
4. **重发按钮**：成功 / 失败 / 缺失三种状态都能触发，loading 状态正确切换
5. **移动端卡片列表**：分组表格不渲染，卡片列表保持现有行为

## 风险与权衡

- **表格行变密**：7 列在小屏幕（< 1024px）可能拥挤。处理：1024px 以下仍走移动端卡片列表（不显示分组表格）。这是已有断点，不需要新加。
- **分组展开状态仅存内存**：刷新页面后丢失展开偏好，回到默认（末日展开）。可接受：当前用户明确说「筛选变更重置回默认」。
- **多订阅同日同时刻**：合并到同一日内，按后端返回顺序展示，不做进一步合并（同订阅的不同报告分两行）。