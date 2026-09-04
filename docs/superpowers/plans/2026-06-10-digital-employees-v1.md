# 数字员工 V1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将数字员工模块从原型打磨到可交付质量，覆盖列表页、详情页、全屏展示页三个页面

**架构：** 纯前端改造。统一组件体系（Avatar/Persona/StatusBadge/HeartbeatDot），新增 DataStream fade 轮播组件和 LiveLog 实时日志组件，重写三个页面。后端仅新增一个日志端点。

**技术栈：** Next.js 14 App Router · React 18 · Tailwind CSS · shadcn/ui · Lucide Icons

**验证方式：** 每个任务完成后执行 `cd frontend && pnpm lint && pnpm build`（前端无单元测试框架）

---

## 文件结构

### 新增

| 文件 | 职责 |
|------|------|
| `frontend/components/digital-employee/data-stream.tsx` | Fade 轮播数据流窗口，用于卡片中间区域 |
| `frontend/components/digital-employee/live-log.tsx` | 实时日志流组件，用于详情页右侧 |
| `backend/app/services/digital/employee_service.py` (新增函数) | `list_employee_logs` — 按员工 ID 拉取最近日志 |
| `backend/app/api/v1/endpoints/digital_employees.py` (新增端点) | `GET /{employee_id}/logs` — 员工级日志端点 |

### 修改

| 文件 | 变更 |
|------|------|
| `frontend/components/digital-employee/persona.tsx` | 合并 persona 映射，新增 `PERSONA_COLORS` 导出 |
| `frontend/components/digital-employee/employee-avatar.tsx` | 重写：从 persona.tsx 导入颜色，用 style 替代动态类名 |
| `frontend/components/digital-employee/status-badge.tsx` | 微调：确保被统一引用 |
| `frontend/components/digital-employee/heartbeat-dot.tsx` | 微调：确保被统一引用 |
| `frontend/components/digital-employee/stats.tsx` | 重写：图标 + 数字 + 标签样式 |
| `frontend/components/digital-employee/digital-employee-card.tsx` | 重写：header + avatar + data-stream + footer |
| `frontend/components/digital-employee/digital-employee-grid.tsx` | 微调：适配新 card props |
| `frontend/components/digital-employee/activity-feed.tsx` | 微调：适配侧边栏布局 |
| `frontend/app/dashboard/digital-employees/page.tsx` | 重写：右侧边栏布局 |
| `frontend/app/dashboard/digital-employees/[id]/page.tsx` | 重写：焦点式 Hero + 双栏布局 |
| `frontend/app/dashboard/digital-employees/display/page.tsx` | 重写：暗色专业监控台 |
| `frontend/lib/digital-employee-api.ts` | 新增 `fetchEmployeeRecentLogs` 函数 |

### 删除

| 文件 | 原因 |
|------|------|
| `frontend/components/digital-employee/personified-player.tsx` | 拟人化播放器，详情页不再使用 |
| `frontend/lib/digital-employee/aggregator.ts` | 播放器依赖 |
| `frontend/lib/digital-employee/rhythm-player.ts` | 播放器依赖 |
| `frontend/lib/digital-employee/persona-templates.ts` | 播放器依赖 |

### 不变

| 文件 | 原因 |
|------|------|
| `frontend/hooks/use-digital-employees.ts` | 数据获取 hook 无需改动 |
| `frontend/types/digital-employee.ts` | 类型定义无需改动 |
| `frontend/components/digital-employee/progress-bar.tsx` | 保留，可能在其他地方使用 |

---

## 任务 1：统一 Persona 组件 + 修复 Tailwind 动态类名

**文件：**
- 修改：`frontend/components/digital-employee/persona.tsx`
- 修改：`frontend/components/digital-employee/employee-avatar.tsx`

**目的：** 合并两套 persona 映射为单一数据源，修复动态 Tailwind 类名问题。

- [ ] **步骤 1：重写 persona.tsx**

保留 `PERSONA_MAP` 和 `PERSONA_COLORS`，删除 `EmployeeAvatar` 导出（移到 employee-avatar.tsx）。新增 `getPersonaColorHsl` 辅助函数用于 style 属性。

```typescript
// frontend/components/digital-employee/persona.tsx
'use client'

import type { DigitalEmployeeStatus } from '@/types/digital-employee'
import { cn } from '@/lib/utils'

interface PersonaConfig {
  emoji: string
  tagline: string
  color: string       // Tailwind class name like 'text-blue-500'
  colorKey: string     // plain key like 'blue' for HSL
  bgGradient: string
}

export const PERSONA_MAP: Record<string, PersonaConfig> = {
  AUTO_REPORT_UPLOAD: {
    emoji: '📤',
    tagline: '报表快递员',
    color: 'text-blue-500',
    colorKey: 'blue',
    bgGradient: 'from-blue-500/10 to-cyan-500/5',
  },
  SCHEDULED_JOB: {
    emoji: '⏰',
    tagline: '定时指挥官',
    color: 'text-orange-500',
    colorKey: 'orange',
    bgGradient: 'from-orange-500/10 to-amber-500/5',
  },
  RPA_BOT: {
    emoji: '🤖',
    tagline: '流程机器人',
    color: 'text-violet-500',
    colorKey: 'violet',
    bgGradient: 'from-violet-500/10 to-purple-500/5',
  },
  AI_AGENT: {
    emoji: '💬',
    tagline: '洞察分析师',
    color: 'text-emerald-500',
    colorKey: 'emerald',
    bgGradient: 'from-emerald-500/10 to-teal-500/5',
  },
  MONITORING: {
    emoji: '📊',
    tagline: '数据观察员',
    color: 'text-pink-500',
    colorKey: 'pink',
    bgGradient: 'from-pink-500/10 to-rose-500/5',
  },
  DATABASE: {
    emoji: '🗄️',
    tagline: '数据库守护者',
    color: 'text-slate-500',
    colorKey: 'slate',
    bgGradient: 'from-slate-500/10 to-zinc-500/5',
  },
  CUSTOM: {
    emoji: '⚙️',
    tagline: '自定义任务',
    color: 'text-gray-500',
    colorKey: 'gray',
    bgGradient: 'from-gray-500/10 to-neutral-500/5',
  },
}

/** 用于 style 属性的渐变背景，避免 Tailwind 动态类名问题 */
export function getPersonaGradient(colorKey: string): string {
  return `linear-gradient(135deg, hsl(var(--${colorKey}-500)/.08) 0%, hsl(var(--${colorKey}-500)/.03) 100%)`
}

export function getPersonaBorder(colorKey: string): string {
  return `hsl(var(--${colorKey}-500)/.2)`
}

export function getPersona(employeeType: string): PersonaConfig {
  return PERSONA_MAP[employeeType] || PERSONA_MAP.CUSTOM
}

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_MAP: Record<AvatarSize, string> = {
  sm: 'h-9 w-9 text-xl',
  md: 'h-12 w-12 text-2xl',
  lg: 'h-16 w-16 text-3xl',
  xl: 'h-20 w-20 text-4xl',
}

interface EmployeeAvatarProps {
  employeeType?: string
  emoji?: string
  size?: AvatarSize
  status?: DigitalEmployeeStatus
  className?: string
}

const STATUS_DOT_COLORS: Record<DigitalEmployeeStatus, string> = {
  IDLE: 'bg-muted',
  RUNNING: 'bg-blue-500 animate-pulse',
  SUCCEEDED: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  SUSPENDED: 'bg-amber-500',
}

export function EmployeeAvatar({ employeeType, emoji, size = 'md', status, className = '' }: EmployeeAvatarProps) {
  const config = employeeType ? PERSONA_MAP[employeeType] : null
  const resolvedEmoji = emoji || config?.emoji || '🤖'
  const colorKey = config?.colorKey || 'slate'

  return (
    <div className={cn('relative inline-flex', className)}>
      <div
        className={cn(
          'flex items-center justify-center rounded-2xl border-2 shadow-sm',
          SIZE_MAP[size],
        )}
        style={{
          background: getPersonaGradient(colorKey),
          borderColor: getPersonaBorder(colorKey),
        }}
      >
        {resolvedEmoji}
      </div>
      {status && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-background',
            STATUS_DOT_COLORS[status],
          )}
        />
      )}
    </div>
  )
}
```

- [ ] **步骤 2：删除旧的 employee-avatar.tsx**

删除 `frontend/components/digital-employee/employee-avatar.tsx` 文件（其功能已合并到 persona.tsx 的 `EmployeeAvatar` 导出中）。

- [ ] **步骤 3：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：可能有其他文件引用 `@/components/digital-employee/employee-avatar` 的导入错误，记录下来在后续任务中修复。

- [ ] **步骤 4：Commit**

```bash
git add frontend/components/digital-employee/persona.tsx
git rm frontend/components/digital-employee/employee-avatar.tsx
git commit -m "refactor(digital-employee): 统一 persona 组件，修复 Tailwind 动态类名

- 合并 EmployeeAvatar 到 persona.tsx，删除 employee-avatar.tsx
- 新增 getPersonaGradient/getPersonaBorder 辅助函数
- 用 style 属性替代动态 Tailwind 类名拼接"
```

---

## 任务 2：修复详情页对 persona 的导入

**文件：**
- 修改：`frontend/app/dashboard/digital-employees/[id]/page.tsx`（仅导入路径）

**目的：** 修复任务 1 删除 `employee-avatar.tsx` 后的导入错误。

- [ ] **步骤 1：修改导入**

将详情页中的：
```typescript
import { EmployeeAvatar } from '@/components/digital-employee/employee-avatar'
```
改为：
```typescript
import { EmployeeAvatar } from '@/components/digital-employee/persona'
```

同时删除对 `status-badge.tsx` 的导入（后续重写详情页时会统一处理，此处仅修复编译错误）。

- [ ] **步骤 2：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/app/dashboard/digital-employees/\[id\]/page.tsx
git commit -m "fix(digital-employee): 修复详情页 persona 导入路径"
```

---

## 任务 3：新增 DataStream 组件

**文件：**
- 创建：`frontend/components/digital-employee/data-stream.tsx`

**目的：** 实现卡片中间的 fade 轮播数据流窗口。

- [ ] **步骤 1：创建 DataStream 组件**

```typescript
// frontend/components/digital-employee/data-stream.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'
import type { DigitalEmployee, DigitalEmployeeStatus } from '@/types/digital-employee'
import { cn } from '@/lib/utils'

interface StreamMessage {
  id: string
  text: string
  subtext?: string
  showProgress?: boolean
  progress?: number
}

interface DataStreamProps {
  employee: DigitalEmployee
  /** 最新任务信息（从活动流或轮询获取） */
  currentTask?: {
    task_name: string
    progress_percent: number
    current_step: string | null
    status: string
  } | null
  /** 数据流窗口变体样式 */
  variant?: 'default' | 'success' | 'error' | 'warning'
  className?: string
}

function buildMessages(employee: DigitalEmployee, currentTask?: DataStreamProps['currentTask']): StreamMessage[] {
  const messages: StreamMessage[] = []

  if (currentTask && currentTask.status === 'RUNNING') {
    messages.push({
      id: `task-${currentTask.task_name}`,
      text: currentTask.current_step || currentTask.task_name,
      subtext: currentTask.progress_percent > 0 ? `${currentTask.progress_percent}%` : undefined,
      showProgress: currentTask.progress_percent > 0,
      progress: currentTask.progress_percent,
    })
  }

  if (employee.description) {
    messages.push({
      id: 'desc',
      text: employee.description,
    })
  }

  if (messages.length === 0) {
    const statusText: Record<string, string> = {
      IDLE: '等待下一个任务…',
      RUNNING: '正在处理…',
      SUCCEEDED: '上次任务已完成',
      FAILED: '遇到问题，需要关注',
      SUSPENDED: '已暂停',
    }
    messages.push({
      id: 'status',
      text: statusText[employee.status] || '待命中',
    })
  }

  return messages
}

const VARIANT_STYLES: Record<string, { border: string; bg: string; text: string }> = {
  default: {
    border: 'border-border/50',
    bg: 'bg-muted/30',
    text: 'text-foreground/80',
  },
  success: {
    border: 'border-emerald-200 dark:border-emerald-800',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    text: 'text-emerald-700 dark:text-emerald-400',
  },
  error: {
    border: 'border-red-200 dark:border-red-800',
    bg: 'bg-red-50 dark:bg-red-950/30',
    text: 'text-red-700 dark:text-red-400',
  },
  warning: {
    border: 'border-amber-200 dark:border-amber-800',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    text: 'text-amber-700 dark:text-amber-400',
  },
}

export function DataStream({ employee, currentTask, variant = 'default', className }: DataStreamProps) {
  const messages = buildMessages(employee, currentTask)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [fadeState, setFadeState] = useState<'in' | 'out'>('in')

  // Auto-rotate messages
  useEffect(() => {
    if (messages.length <= 1) return

    const interval = setInterval(() => {
      setFadeState('out')
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % messages.length)
        setFadeState('in')
      }, 300) // fade duration
    }, 4500)

    return () => clearInterval(interval)
  }, [messages.length])

  // Reset index when messages change
  useEffect(() => {
    setCurrentIndex(0)
    setFadeState('in')
  }, [messages.length])

  const current = messages[currentIndex] || messages[0]
  if (!current) return null

  const variantStyle = VARIANT_STYLES[variant]

  return (
    <div className={cn('space-y-2', className)}>
      <div
        className={cn(
          'rounded-lg border px-3 py-2.5 min-h-[72px] transition-all duration-300',
          variantStyle.border,
          variantStyle.bg,
          fadeState === 'in' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
        )}
      >
        <p className={cn('text-sm leading-relaxed', variantStyle.text)}>
          {current.text}
        </p>
        {current.showProgress && current.progress !== undefined && (
          <div className="mt-2">
            <div className="h-1 w-full overflow-hidden rounded-full bg-background/50">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-700"
                style={{ width: `${Math.min(100, Math.max(0, current.progress))}%` }}
              />
            </div>
          </div>
        )}
        {current.subtext && !current.showProgress && (
          <p className="mt-1 text-xs text-muted-foreground">{current.subtext}</p>
        )}
      </div>

      {/* Dot indicators */}
      {messages.length > 1 && (
        <div className="flex justify-center gap-1.5">
          {messages.map((msg, i) => (
            <span
              key={msg.id}
              className={cn(
                'h-1 w-1 rounded-full transition-colors duration-300',
                i === currentIndex ? 'bg-foreground' : 'bg-muted-foreground/30',
              )}
            />
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **步骤 2：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/components/digital-employee/data-stream.tsx
git commit -m "feat(digital-employee): 新增 DataStream fade 轮播组件

- 固定高度消息窗口，自动 fade in/out 轮播（4.5s 间隔）
- 支持进度条、变体样式（default/success/error/warning）
- 底部圆点指示器"
```

---

## 任务 4：后端新增员工级日志端点

**文件：**
- 修改：`backend/app/services/digital/employee_service.py`
- 修改：`backend/app/api/v1/endpoints/digital_employees.py`

**目的：** 详情页需要按员工 ID 拉取所有日志（不指定 task_id）。

- [ ] **步骤 1：在 employee_service.py 中新增 `list_employee_logs` 函数**

在 `list_logs` 函数之后添加：

```python
def list_employee_logs(
    db: Session, employee_id: int, limit: int = 20
) -> list[dict]:
    """查询员工最近日志（不限 task），返回最新 N 条。"""
    q = (
        select(DigitalEmployeeLog)
        .where(DigitalEmployeeLog.employee_id == employee_id)
        .order_by(DigitalEmployeeLog.created_at.desc())
        .limit(limit)
    )
    items = list(db.execute(q).scalars().all())
    return [_serialize_log(l) for l in items]
```

- [ ] **步骤 2：在 router 中新增端点**

在 `digital_employees.py` 的 Logs 区域添加：

```python
@router.get("/{employee_id}/recent-logs")
def list_recent_logs_endpoint(
    employee_id: int,
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    from app.services.digital.employee_service import list_employee_logs
    items = list_employee_logs(db, employee_id=employee_id, limit=limit)
    return {"items": items}
```

- [ ] **步骤 3：验证后端**

运行：`cd backend && python -c "from app.api.v1.endpoints.digital_employees import router; print('OK')"`
预期：OK

- [ ] **步骤 4：Commit**

```bash
git add backend/app/services/digital/employee_service.py backend/app/api/v1/endpoints/digital_employees.py
git commit -m "feat(digital-employee): 新增员工级日志端点 GET /{id}/recent-logs

- 支持按员工 ID 拉取最近日志，不指定 task_id
- limit 参数默认 20，最大 100"
```

---

## 任务 5：新增 fetchEmployeeRecentLogs API 函数

**文件：**
- 修改：`frontend/lib/digital-employee-api.ts`

**目的：** 前端调用新的后端端点。

- [ ] **步骤 1：添加 API 函数**

在 `fetchEmployeeLogs` 函数之后添加：

```typescript
export async function fetchEmployeeRecentLogs(employeeId: number, limit = 20) {
  const res = await fetch(resolveApiUrl(`/api/v1/digital-employees/${employeeId}/recent-logs?limit=${limit}`), {
    cache: 'no-store',
  })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error('Failed to fetch recent logs')
  return res.json() as Promise<{ items: import('@/types/digital-employee').DigitalEmployeeLog[] }>
}
```

- [ ] **步骤 2：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/lib/digital-employee-api.ts
git commit -m "feat(digital-employee): 新增 fetchEmployeeRecentLogs API 函数"
```

---

## 任务 6：新增 LiveLog 组件

**文件：**
- 创建：`frontend/components/digital-employee/live-log.tsx`

**目的：** 详情页右侧的实时日志流，从 `digital_employee_logs` 表获取数据。

- [ ] **步骤 1：创建 LiveLog 组件**

```typescript
// frontend/components/digital-employee/live-log.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'
import type { DigitalEmployeeLog } from '@/types/digital-employee'
import { fetchEmployeeRecentLogs } from '@/lib/digital-employee-api'
import { cn } from '@/lib/utils'

interface LiveLogProps {
  employeeId: number
  pollInterval?: number
  maxItems?: number
  className?: string
}

const LEVEL_STYLES: Record<string, { dot: string; border: string; text: string }> = {
  info: { dot: 'bg-blue-500', border: 'border-l-blue-500', text: 'text-foreground' },
  warn: { dot: 'bg-amber-500', border: 'border-l-amber-500', text: 'text-amber-700 dark:text-amber-400' },
  error: { dot: 'bg-red-500', border: 'border-l-red-500', text: 'text-red-700 dark:text-red-400' },
  debug: { dot: 'bg-muted-foreground', border: 'border-l-muted-foreground', text: 'text-muted-foreground' },
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  return `${Math.floor(hours / 24)}天前`
}

export function LiveLog({ employeeId, pollInterval = 15000, maxItems = 20, className }: LiveLogProps) {
  const [logs, setLogs] = useState<DigitalEmployeeLog[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const { items } = await fetchEmployeeRecentLogs(employeeId, maxItems)
      setLogs(items)
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [employeeId, maxItems])

  useEffect(() => {
    void load()
    const interval = setInterval(load, pollInterval)
    return () => clearInterval(interval)
  }, [load, pollInterval])

  if (isLoading) {
    return (
      <div className={cn('space-y-2', className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    )
  }

  if (logs.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed py-8 text-muted-foreground', className)}>
        <span className="text-2xl mb-2">📋</span>
        <p className="text-sm">暂无日志记录</p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-1.5 overflow-y-auto', className)}>
      {logs.map((log) => {
        const style = LEVEL_STYLES[log.level] || LEVEL_STYLES.info
        return (
          <div
            key={log.id}
            className={cn(
              'rounded-lg border-l-2 bg-muted/30 px-3 py-2 transition-colors hover:bg-muted/50',
              style.border,
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <p className={cn('text-sm leading-relaxed flex-1', style.text)}>
                {log.message}
              </p>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {formatRelativeTime(log.created_at)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **步骤 2：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/components/digital-employee/live-log.tsx
git commit -m "feat(digital-employee): 新增 LiveLog 实时日志流组件

- 从 /recent-logs 端点获取数据，15s 轮询
- 按 level 着色（INFO=蓝，WARN=琥珀，ERROR=红）
- 加载骨架屏 + 空状态"
```

---

## 任务 7：重写 DigitalEmployeeCard

**文件：**
- 重写：`frontend/components/digital-employee/digital-employee-card.tsx`

**目的：** 新卡片结构：header + 大头像 + DataStream + footer。去掉心情球、思考气泡。

- [ ] **步骤 1：重写 digital-employee-card.tsx**

完整替换文件内容：

```typescript
// frontend/components/digital-employee/digital-employee-card.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DigitalEmployee, DigitalEmployeeStatus } from '@/types/digital-employee'
import { getPersona, getPersonaGradient, getPersonaBorder, EmployeeAvatar } from './persona'
import { StatusBadge } from './status-badge'
import { HeartbeatDot } from './heartbeat-dot'
import { DataStream } from './data-stream'
import { cn } from '@/lib/utils'

// ── 状态 → 顶部色带样式 ──────────────────────────────────────────────────────
const ACCENT_STYLES: Record<DigitalEmployeeStatus, string> = {
  IDLE: '',
  RUNNING: 'bg-gradient-to-r from-blue-500 via-cyan-400 to-blue-500 de-animate-shimmer',
  SUCCEEDED: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  SUSPENDED: 'bg-amber-500',
}

// ── 状态 → 头像边框 ──────────────────────────────────────────────────────────
const AVATAR_RING: Record<DigitalEmployeeStatus, string> = {
  IDLE: '',
  RUNNING: 'ring-2 ring-blue-400/40',
  SUCCEEDED: '',
  FAILED: 'ring-2 ring-red-400/30',
  SUSPENDED: '',
}

// ── 状态 → 数据流窗口变体 ────────────────────────────────────────────────────
function getDataVariant(status: DigitalEmployeeStatus): 'default' | 'success' | 'error' | 'warning' {
  if (status === 'SUCCEEDED') return 'success'
  if (status === 'FAILED') return 'error'
  if (status === 'SUSPENDED') return 'warning'
  return 'default'
}

interface DigitalEmployeeCardProps {
  employee: DigitalEmployee
  onClick?: (id: number) => void
  /** 当前运行任务（从活动流获取） */
  currentTask?: {
    task_name: string
    progress_percent: number
    current_step: string | null
    status: string
  } | null
}

export function DigitalEmployeeCard({ employee, onClick, currentTask }: DigitalEmployeeCardProps) {
  const router = useRouter()
  const [isHovered, setIsHovered] = useState(false)
  const persona = getPersona(employee.employee_type)
  const accent = ACCENT_STYLES[employee.status]
  const avatarRing = AVATAR_RING[employee.status]

  function handleInfoClick(e: React.MouseEvent) {
    e.stopPropagation()
    router.push(`/dashboard/digital-employees/${employee.id}`)
  }

  return (
    <div
      className={cn(
        'group relative rounded-2xl border bg-card transition-all duration-300 cursor-pointer',
        'hover:shadow-md hover:-translate-y-0.5 hover:border-primary/20',
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onClick?.(employee.id)}
    >
      {/* 顶部色带 */}
      {accent && (
        <div className={cn('absolute inset-x-0 top-0 h-0.5 rounded-t-2xl', accent)} />
      )}

      <div className="p-4 space-y-3">
        {/* Header: 名称 + ℹ 按钮 */}
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-semibold text-sm leading-tight">{employee.name}</h3>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {employee.employee_type.replace(/_/g, ' ').toLowerCase()} · {persona.tagline}
            </p>
          </div>
          <button
            onClick={handleInfoClick}
            className={cn(
              'ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold transition-colors',
              'text-muted-foreground hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950',
              isHovered ? 'border-blue-200' : 'border-border',
            )}
            title="查看详情"
          >
            ℹ
          </button>
        </div>

        {/* 大头像区域 */}
        <div className="flex justify-center">
          <div className={cn('transition-all duration-300', avatarRing)}>
            <EmployeeAvatar
              employeeType={employee.employee_type}
              size="lg"
              status={employee.status}
            />
          </div>
        </div>

        {/* 数据流窗口 */}
        <DataStream
          employee={employee}
          currentTask={currentTask}
          variant={getDataVariant(employee.status)}
        />

        {/* Footer: 心跳 + 状态 */}
        <div className="flex items-center justify-between">
          <HeartbeatDot lastSeen={employee.last_heartbeat_at} />
          <StatusBadge status={employee.status} size="sm" />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：更新 digital-employee-grid.tsx 的 props**

更新 grid 组件以传递新的 card props：

```typescript
// frontend/components/digital-employee/digital-employee-grid.tsx
'use client'

import type { DigitalEmployee } from '@/types/digital-employee'
import { DigitalEmployeeCard } from './digital-employee-card'
import { cn } from '@/lib/utils'

interface DigitalEmployeeGridProps {
  employees: DigitalEmployee[]
  onCardClick?: (id: number) => void
  /** 可选：每张卡片的当前任务信息 */
  taskMap?: Record<number, { task_name: string; progress_percent: number; current_step: string | null; status: string }>
}

export function DigitalEmployeeGrid({ employees, onCardClick, taskMap }: DigitalEmployeeGridProps) {
  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
      {employees.map((emp) => (
        <DigitalEmployeeCard
          key={emp.id}
          employee={emp}
          onClick={onCardClick}
          currentTask={taskMap?.[emp.id]}
        />
      ))}
    </div>
  )
}
```

- [ ] **步骤 3：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：列表页和详情页会有编译错误（旧的 props 传入），记录但不修复（后续任务重写页面）。

- [ ] **步骤 4：Commit**

```bash
git add frontend/components/digital-employee/digital-employee-card.tsx frontend/components/digital-employee/digital-employee-grid.tsx
git commit -m "refactor(digital-employee): 重写卡片组件，新结构 header+avatar+data-stream+footer

- 去掉心情球、思考气泡、ActionBar
- 新增 ℹ Info 按钮跳转详情页
- 集成 DataStream fade 轮播组件
- Grid 组件适配新 props"
```

---

## 任务 8：重写 Stats 组件

**文件：**
- 重写：`frontend/components/digital-employee/stats.tsx`

**目的：** 紧凑的统计条，与项目其他页面风格一致。

- [ ] **步骤 1：重写 stats.tsx**

```typescript
// frontend/components/digital-employee/stats.tsx
'use client'

import type { DigitalEmployee } from '@/types/digital-employee'
import { cn } from '@/lib/utils'

interface DigitalEmployeeStatsProps {
  employees: DigitalEmployee[]
}

export function DigitalEmployeeStats({ employees }: DigitalEmployeeStatsProps) {
  const total = employees.length
  const running = employees.filter((e) => e.status === 'RUNNING').length
  const idle = employees.filter((e) => e.status === 'IDLE').length
  const failed = employees.filter((e) => e.status === 'FAILED').length

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <StatCard icon="🤖" label="全部" value={total} />
      <StatCard
        icon={null}
        label="运行中"
        value={running}
        accent="text-blue-600"
        highlight={running > 0}
        pulse={running > 0}
      />
      <StatCard icon="✓" label="空闲" value={idle} accent="text-muted-foreground" />
      <StatCard
        icon="⚠"
        label="异常"
        value={failed}
        accent={failed > 0 ? 'text-red-600' : 'text-emerald-600'}
        highlight={failed > 0}
      />
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  accent = 'text-foreground',
  highlight = false,
  pulse = false,
}: {
  icon: string | null
  label: string
  value: number
  accent?: string
  highlight?: boolean
  pulse?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors',
        highlight
          ? 'border-primary/20 bg-primary/5'
          : 'border-border bg-card',
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/50">
        {pulse ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
        ) : (
          <span className="text-sm">{icon}</span>
        )}
      </div>
      <div>
        <p className={cn('text-2xl font-bold tabular-nums leading-none', accent)}>{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/components/digital-employee/stats.tsx
git commit -m "refactor(digital-employee): 重写 Stats 组件，紧凑图标+数字+标签样式"
```

---

## 任务 9：重写列表页

**文件：**
- 重写：`frontend/app/dashboard/digital-employees/page.tsx`

**目的：** 右侧边栏布局（卡片网格 + 活动流），去掉旧的底部折叠活动流。

- [ ] **步骤 1：重写 page.tsx**

```typescript
// frontend/app/dashboard/digital-employees/page.tsx
'use client'

import { useState } from 'react'
import { Monitor, RefreshCw, Users, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useDigitalEmployees } from '@/hooks/use-digital-employees'
import { DigitalEmployeeGrid } from '@/components/digital-employee/digital-employee-grid'
import { DigitalEmployeeStats } from '@/components/digital-employee/stats'
import { ActivityFeed } from '@/components/digital-employee/activity-feed'
import { cn } from '@/lib/utils'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { RefreshProgressBar } from '@/components/ui/refresh-progress-bar'

const STATUS_FILTERS = [
  { label: '全部', value: null },
  { label: '空闲', value: 'IDLE' },
  { label: '运行中', value: 'RUNNING' },
  { label: '成功', value: 'SUCCEEDED' },
  { label: '失败', value: 'FAILED' },
  { label: '暂停', value: 'SUSPENDED' },
]

export default function DigitalEmployeesPage() {
  const router = useRouter()
  const { employees, isLoading, error, mutate } = useDigitalEmployees()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)

  const { showSkeleton, isRefreshing } = useSmoothRefresh({
    loading: isLoading,
    hasData: employees.length > 0,
  })

  const filtered = employees.filter((emp) => {
    const matchSearch = !search || emp.name.includes(search) || (emp.description ?? '').includes(search)
    const matchStatus = !statusFilter || emp.status === statusFilter
    return matchSearch && matchStatus
  })

  const runningCount = employees.filter((e) => e.status === 'RUNNING').length
  const failedCount = employees.filter((e) => e.status === 'FAILED').length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/10 to-cyan-500/5 border border-blue-200/40 shadow-sm">
            <Users className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Operations · Digital Employees</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {runningCount > 0 && (
            <div className="flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600 dark:bg-blue-950 dark:text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
              </span>
              {runningCount} 个运行中
            </div>
          )}
          {failedCount > 0 && (
            <div className="flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 dark:bg-red-950 dark:text-red-400">
              ⚠ {failedCount} 个异常
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open('/dashboard/digital-employees/display', '_blank')}
            className="gap-1.5"
          >
            <Monitor className="h-4 w-4" />
            全屏展示
          </Button>
          <Button variant="outline" size="sm" onClick={() => void mutate()} className="gap-1.5">
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      {showSkeleton ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2xl border p-4 space-y-3">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-16 w-16 rounded-2xl mx-auto" />
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center rounded-xl border border-destructive/20 bg-destructive/5 p-8 text-destructive">
          <p>加载失败：{error.message}</p>
        </div>
      ) : (
        <div className="relative">
          <RefreshProgressBar refreshing={isRefreshing}>
            <DigitalEmployeeStats employees={employees} />

            {/* Filters */}
            <div className="flex items-center gap-4 mt-4">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="搜索数字员工..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {STATUS_FILTERS.map((f) => {
                  const count = f.value === null ? employees.length : employees.filter((e) => e.status === f.value).length
                  return (
                    <Badge
                      key={f.label}
                      variant={statusFilter === f.value ? 'default' : 'outline'}
                      className={cn(
                        'cursor-pointer transition-all',
                        statusFilter === f.value && 'shadow-sm',
                      )}
                      onClick={() => setStatusFilter(statusFilter === f.value ? null : f.value)}
                    >
                      {f.label}
                      <span className="ml-1 opacity-60">({count})</span>
                    </Badge>
                  )
                })}
              </div>
            </div>

            {/* Main: Grid + Activity Feed side by side */}
            <div className="mt-4 grid gap-6 lg:grid-cols-[1fr,360px]">
              {/* Card Grid */}
              <div>
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed p-16 text-muted-foreground gap-3">
                    <span className="text-4xl">🤖</span>
                    <p className="text-sm">暂无数字员工</p>
                  </div>
                ) : (
                  <DigitalEmployeeGrid
                    employees={filtered}
                    onCardClick={(id) => router.push(`/dashboard/digital-employees/${id}`)}
                  />
                )}
              </div>

              {/* Activity Feed Sidebar */}
              <div className="hidden lg:flex flex-col rounded-2xl border bg-card/50 overflow-hidden">
                <div className="flex items-center gap-2 border-b px-4 py-3">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  <h2 className="text-sm font-semibold">实时动态</h2>
                  <span className="ml-auto text-xs text-muted-foreground">15s 更新</span>
                </div>
                <div className="flex-1 overflow-hidden px-3 py-3">
                  <ActivityFeed pollInterval={15000} maxHeight="calc(100vh - 320px)" compact />
                </div>
              </div>
            </div>
          </RefreshProgressBar>
        </div>
      )}
    </div>
  )
}
```

- [ ] **步骤 2：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/app/dashboard/digital-employees/page.tsx
git commit -m "refactor(digital-employee): 重写列表页，右侧活动流边栏布局

- 左侧卡片网格 + 右侧 360px 活动流面板
- 小屏幕隐藏活动流
- Stats 组件使用新的紧凑样式"
```

---

## 任务 10：重写详情页

**文件：**
- 重写：`frontend/app/dashboard/digital-employees/[id]/page.tsx`

**目的：** 焦点式 Hero + 双栏布局（当前任务+任务历史 | 实时日志+员工信息）。加 15s 轮询。

- [ ] **步骤 1：重写 [id]/page.tsx**

```typescript
// frontend/app/dashboard/digital-employees/[id]/page.tsx
'use client'

import { useState, useEffect, useCallback, use } from 'react'
import { ArrowLeft, Pause, Play, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { fetchDigitalEmployee, fetchEmployeeTasks, suspendEmployee, resumeEmployee } from '@/lib/digital-employee-api'
import { EmployeeAvatar, getPersona } from '@/components/digital-employee/persona'
import { StatusBadge } from '@/components/digital-employee/status-badge'
import { HeartbeatDot } from '@/components/digital-employee/heartbeat-dot'
import { LiveLog } from '@/components/digital-employee/live-log'
import { cn } from '@/lib/utils'

const TASK_STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-muted/60 text-muted-foreground',
  RUNNING: 'bg-blue-500/10 text-blue-600',
  SUCCEEDED: 'bg-emerald-500/10 text-emerald-600',
  FAILED: 'bg-red-500/10 text-red-600',
  CANCELLED: 'bg-amber-500/10 text-amber-600',
}

const TASK_STATUS_ICON: Record<string, string> = {
  PENDING: '⏳',
  RUNNING: '⚡',
  SUCCEEDED: '✅',
  FAILED: '❌',
  CANCELLED: '⏸',
}

export default function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const employeeId = parseInt(id, 10)

  const [employee, setEmployee] = useState<import('@/types/digital-employee').DigitalEmployee | null>(null)
  const [tasks, setTasks] = useState<import('@/types/digital-employee').DigitalEmployeeTask[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isActing, setIsActing] = useState(false)
  const [taskPage, setTaskPage] = useState(1)

  const load = useCallback(async () => {
    try {
      const [emp, taskData] = await Promise.all([
        fetchDigitalEmployee(employeeId),
        fetchEmployeeTasks(employeeId),
      ])
      setEmployee(emp)
      setTasks(taskData.items)
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [employeeId])

  // 初始加载 + 15s 轮询
  useEffect(() => {
    void load()
    const interval = setInterval(load, 15000)
    return () => clearInterval(interval)
  }, [load])

  async function handleSuspend() {
    setIsActing(true)
    try {
      await suspendEmployee(employeeId)
      setEmployee((prev) => prev ? { ...prev, status: 'SUSPENDED' } : null)
    } finally {
      setIsActing(false)
    }
  }

  async function handleResume() {
    setIsActing(true)
    try {
      await resumeEmployee(employeeId)
      setEmployee((prev) => prev ? { ...prev, status: 'IDLE' } : null)
    } finally {
      setIsActing(false)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-[1fr,380px] gap-6">
          <div className="space-y-4">
            <Skeleton className="h-48 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-64 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        </div>
      </div>
    )
  }

  if (!employee) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        数字员工不存在
      </div>
    )
  }

  const persona = getPersona(employee.employee_type)
  const runningTask = tasks.find((t) => t.status === 'RUNNING')

  return (
    <div className="space-y-6">
      {/* 返回 */}
      <Button variant="ghost" size="sm" onClick={() => router.back()} className="gap-1.5">
        <ArrowLeft className="h-4 w-4" />
        返回列表
      </Button>

      {/* Hero 区 */}
      <div className="rounded-2xl border bg-card p-6">
        <div className="flex items-center gap-5">
          <EmployeeAvatar
            employeeType={employee.employee_type}
            size="xl"
            status={employee.status}
          />
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold tracking-tight">{employee.name}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {employee.employee_type.replace(/_/g, ' ').toLowerCase()} · {persona.tagline}
            </p>
            <div className="flex items-center gap-3 mt-2">
              <StatusBadge status={employee.status} />
              <HeartbeatDot lastSeen={employee.last_heartbeat_at} />
            </div>
          </div>
          <div className="flex gap-2">
            {employee.status === 'SUSPENDED' ? (
              <Button size="sm" variant="outline" onClick={() => void handleResume()} disabled={isActing}>
                <Play className="h-4 w-4 mr-1" /> 恢复
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void handleSuspend()} disabled={isActing}>
                <Pause className="h-4 w-4 mr-1" /> 暂停
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* 双栏布局 */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr,380px] gap-6">
        {/* 左栏：任务 */}
        <div className="space-y-4">
          {/* 当前任务（仅 RUNNING 时显示） */}
          {runningTask && (
            <div className="rounded-xl border bg-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold">当前任务</h3>
                <span className="text-xs text-muted-foreground">
                  进行中 {runningTask.started_at ? formatDuration(runningTask.started_at) : ''}
                </span>
              </div>
              <p className="text-base font-medium mb-3">{runningTask.task_name}</p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted mb-3">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-700"
                  style={{ width: `${runningTask.progress_percent}%` }}
                />
              </div>
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>{runningTask.current_step || '处理中…'}</span>
                <span className="font-medium text-blue-600">{runningTask.progress_percent}%</span>
              </div>
            </div>
          )}

          {/* 任务历史 */}
          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-semibold mb-4">任务历史</h3>
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">暂无任务记录</p>
            ) : (
              <div className="space-y-2">
                {tasks.slice(0, taskPage * 10).map((task) => (
                  <div key={task.id} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/30 transition-colors">
                    <span className="text-base shrink-0">{TASK_STATUS_ICON[task.status] || '⏳'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{task.task_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {task.started_at ? new Date(task.started_at).toLocaleString('zh-CN') : '—'}
                        {task.error_message && <span className="text-red-500 ml-2">{task.error_message}</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge className={cn(TASK_STATUS_STYLES[task.status], 'text-[10px]')}>{task.status}</Badge>
                      {task.status === 'RUNNING' && (
                        <span className="text-xs tabular-nums text-muted-foreground">{task.progress_percent}%</span>
                      )}
                    </div>
                  </div>
                ))}
                {tasks.length > taskPage * 10 && (
                  <button
                    onClick={() => setTaskPage((p) => p + 1)}
                    className="w-full mt-2 py-2 border border-dashed rounded-lg text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
                  >
                    加载更多
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 右栏：日志 + 信息 */}
        <div className="space-y-4">
          {/* 实时日志 */}
          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <h3 className="text-sm font-semibold">实时日志</h3>
            </div>
            <LiveLog employeeId={employeeId} maxItems={20} className="max-h-[400px]" />
          </div>

          {/* 员工信息 */}
          <div className="rounded-xl border bg-card p-5">
            <h3 className="text-sm font-semibold mb-3">员工信息</h3>
            <div className="space-y-2.5 text-sm">
              <InfoRow label="类型" value={employee.employee_type.replace(/_/g, ' ').toLowerCase()} />
              <InfoRow label="角色" value={persona.tagline} />
              <InfoRow label="静默阈值" value={`${employee.is_silent_alert_threshold_minutes} 分钟`} />
              <InfoRow label="创建时间" value={new Date(employee.created_at).toLocaleDateString('zh-CN')} />
              {employee.description && <InfoRow label="描述" value={employee.description} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right truncate">{value}</span>
    </div>
  )
}

function formatDuration(startedAt: string): string {
  const minutes = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}
```

- [ ] **步骤 2：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/app/dashboard/digital-employees/\[id\]/page.tsx
git commit -m "refactor(digital-employee): 重写详情页，焦点式 Hero + 双栏布局

- Hero 区大头像 + 状态 + 暂停/恢复按钮
- 左栏：当前任务高亮 + 任务历史（分页加载）
- 右栏：实时日志流 + 员工信息
- 15s 轮询刷新
- 删除拟人化播放器引用"
```

---

## 任务 11：重写全屏展示页

**文件：**
- 重写：`frontend/app/dashboard/digital-employees/display/page.tsx`

**目的：** 暗色专业监控台，三列卡片 + 活动流。去掉全屏 API 和拟人化元素。

- [ ] **步骤 1：重写 display/page.tsx**

```typescript
// frontend/app/dashboard/digital-employees/display/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { RefreshCw, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDigitalEmployees } from '@/hooks/use-digital-employees'
import { DigitalEmployeeCard } from '@/components/digital-employee/digital-employee-card'
import { ActivityFeed } from '@/components/digital-employee/activity-feed'
import { cn } from '@/lib/utils'

export default function DisplayPage() {
  const { employees, isLoading, mutate } = useDigitalEmployees({ pollInterval: 10000 })
  const [showFeed, setShowFeed] = useState(true)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    document.documentElement.classList.add('dark')
    const ticker = setInterval(() => setNow(new Date()), 1000)
    return () => {
      document.documentElement.classList.remove('dark')
      clearInterval(ticker)
    }
  }, [])

  const runningCount = employees.filter((e) => e.status === 'RUNNING').length
  const idleCount = employees.filter((e) => e.status === 'IDLE').length
  const failedCount = employees.filter((e) => e.status === 'FAILED').length

  return (
    <div className="min-h-screen bg-[#0f172a] p-6 text-slate-100">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Activity className="h-3 w-3" />
            <span className="uppercase tracking-wider">数字员工监控台</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-50">实时运行状态</h1>
          <p className="mt-1 text-sm text-slate-400">
            {now.toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'medium' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showFeed ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowFeed((v) => !v)}
            className="gap-1.5"
          >
            <Activity className="h-4 w-4" />
            {showFeed ? '隐藏动态' : '显示动态'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void mutate()}
            className="gap-1.5"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <DarkStatBox label="全部员工" value={employees.length} />
        <DarkStatBox
          label="运行中"
          value={runningCount}
          accent="text-blue-400"
          pulse={runningCount > 0}
          highlight
        />
        <DarkStatBox label="空闲" value={idleCount} accent="text-slate-400" />
        <DarkStatBox
          label="异常"
          value={failedCount}
          accent={failedCount > 0 ? 'text-red-400' : 'text-emerald-400'}
          highlight={failedCount > 0}
        />
      </div>

      {/* Main: grid + feed */}
      <div className={cn('grid gap-6', showFeed ? 'lg:grid-cols-[1fr,380px]' : 'grid-cols-1')}>
        {/* Card grid */}
        <div>
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-56 rounded-2xl border-2 border-dashed border-slate-800" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {employees.map((emp) => (
                <DarkCard key={emp.id} employee={emp} />
              ))}
            </div>
          )}
        </div>

        {/* Activity feed */}
        {showFeed && (
          <div className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/50">
            <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <h2 className="text-sm font-semibold text-slate-200">实时动态</h2>
              <span className="ml-auto text-xs text-slate-500">15s 更新</span>
            </div>
            <div className="flex-1 overflow-hidden px-3 py-3">
              <ActivityFeed pollInterval={15000} maxHeight="calc(100vh - 280px)" compact />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DarkStatBox({
  label,
  value,
  accent = 'text-slate-100',
  pulse = false,
  highlight = false,
}: {
  label: string
  value: number
  accent?: string
  pulse?: boolean
  highlight?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-4 text-center',
        highlight
          ? 'border-blue-500/20 bg-blue-500/10'
          : 'border-slate-800 bg-slate-900/30',
      )}
    >
      <div className="flex items-center justify-center gap-2">
        <p className={cn('text-3xl font-bold tabular-nums', accent)}>{value}</p>
        {pulse && (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-400">{label}</p>
    </div>
  )
}

// 暗色主题卡片 — 直接使用 DigitalEmployeeCard
// Tailwind 的 dark: 前缀在 <html class="dark"> 下生效
// bg-card、text-foreground 等 CSS 变量在暗色模式下自动切换
function DarkCard({ employee }: { employee: import('@/types/digital-employee').DigitalEmployee }) {
  return <DigitalEmployeeCard employee={employee} />
}
```

> 注意：`DarkCard` 组件中直接使用了 `DigitalEmployeeCard`，因为卡片组件使用 Tailwind 的 `bg-card`、`text-foreground` 等 CSS 变量，在暗色模式下会自动适配。不需要完全重写暗色版本。

- [ ] **步骤 2：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add frontend/app/dashboard/digital-employees/display/page.tsx
git commit -m "refactor(digital-employee): 重写全屏展示页，暗色专业监控台

- 暗色主题（#0f172a 背景）
- 三列卡片网格 + 活动流侧边栏
- 去掉 requestFullscreen API
- 使用 DigitalEmployeeCard 组件（CSS 变量自动适配暗色）"
```

---

## 任务 12：删除拟人化播放器相关文件

**文件：**
- 删除：`frontend/components/digital-employee/personified-player.tsx`
- 删除：`frontend/lib/digital-employee/aggregator.ts`
- 删除：`frontend/lib/digital-employee/rhythm-player.ts`
- 删除：`frontend/lib/digital-employee/persona-templates.ts`

**目的：** 清理不再使用的拟人化播放器代码。

- [ ] **步骤 1：确认无引用**

运行：`cd frontend && grep -r "personified-player\|aggregator\|rhythm-player\|persona-templates" --include="*.ts" --include="*.tsx" app/ components/ hooks/ lib/`
预期：无输出（所有引用已在任务 10 中删除）

- [ ] **步骤 2：删除文件**

```bash
rm frontend/components/digital-employee/personified-player.tsx
rm frontend/lib/digital-employee/aggregator.ts
rm frontend/lib/digital-employee/rhythm-player.ts
rm frontend/lib/digital-employee/persona-templates.ts
```

- [ ] **步骤 3：验证**

运行：`cd frontend && pnpm lint && pnpm build`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git rm frontend/components/digital-employee/personified-player.tsx \
       frontend/lib/digital-employee/aggregator.ts \
       frontend/lib/digital-employee/rhythm-player.ts \
       frontend/lib/digital-employee/persona-templates.ts
git commit -m "chore(digital-employee): 删除拟人化播放器及相关文件

- 删除 personified-player.tsx
- 删除 aggregator.ts、rhythm-player.ts、persona-templates.ts
- 详情页已改用 LiveLog 组件"
```

---

## 任务 13：最终验证

- [ ] **步骤 1：运行完整 lint**

运行：`cd frontend && pnpm lint`
预期：PASS，无警告

- [ ] **步骤 2：运行完整 build**

运行：`cd frontend && pnpm build`
预期：PASS

- [ ] **步骤 3：检查所有页面可访问**

启动开发服务器：`cd frontend && pnpm dev`
手动访问以下 URL 确认页面渲染正常：
- `http://localhost:3000/dashboard/digital-employees`（列表页）
- `http://localhost:3000/dashboard/digital-employees/1`（详情页，需要有数据）
- `http://localhost:3000/dashboard/digital-employees/display`（全屏展示页）

- [ ] **步骤 4：最终 Commit（如果有遗漏的 lint 修复）**

```bash
git add -A
git commit -m "fix(digital-employee): 最终 lint 修复"
```
