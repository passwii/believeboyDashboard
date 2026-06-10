#数字员工拟人化展示 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在已有的数字员工基础设施上，**为 autoReportUpload 增加事件上报** + **前端详情页增加拟人化节奏播放层**（慢速切换 +末尾延长），让运营人员"看一个员工干活"。

**架构：**
- **复用已有**：`DigitalEmployee` / `DigitalEmployeeTask` / `DigitalEmployeeLog` 数据模型 + `digital_employee_reporter.py` Reporter API + 列表/详情页框架
- **新增**：`autoReportUpload/emit_event.py` 接入 Reporter；前端 `rhythm-player` 纯逻辑模块（vitest 覆盖）+详情页改造为"拟人化展示"
- **不新增**任何数据库表、SSE 服务、aggregator 后端服务

**技术栈：**
- 后端：FastAPI + SQLAlchemy（沿用）
- 前端：Next.js 14 + React 18 + TypeScript + shadcn/ui
- **新增前端测试**：Vitest（仅测纯逻辑模块）

---

## 实施总览

|里程碑 | 内容 | 估时 |
|------|------|------|
| **M1** | Vitest 配置 + 节奏播放器纯逻辑模块（含 TDD 单测）| 0.5d |
| **M2** | 聚合器纯逻辑模块（按 project × report_type 分桶）含 TDD 单测 | 0.5d |
| **M3** | autoReportUpload 接入 Reporter（emit_event.py）| 0.5d |
| **M4** | 前端详情页改造：拟人化播放器组件 +替换任务历史区 | 0.5d |
| **M5** | 端到端验证：启动 autoReportUpload 放入测试文件 → 前端观察节奏 | 0.5d |

总估时：**2.5 天**。

---

## 文件结构

###新增文件

| 路径 | 职责 |
|------|------|
| `frontend/lib/digital-employee/rhythm-player.ts` | **核心**：节奏播放状态机（队列、setTimeout 控制、普通/末尾延长状态切换）|
| `frontend/lib/digital-employee/aggregator.ts` | **核心**：把 task 列表按 `project_name × report_type` 分桶聚合 |
| `frontend/lib/digital-employee/persona-templates.ts` | 文案模板（各状态→拟人化文字）|
| `frontend/lib/digital-employee/__tests__/rhythm-player.test.ts` | rhythm-player vitest 单测 |
| `frontend/lib/digital-employee/__tests__/aggregator.test.ts` | aggregator vitest 单测 |
| `frontend/lib/digital-employee/__tests__/persona-templates.test.ts` | 文案模板 vitest 单测 |
| `frontend/components/digital-employee/personified-player.tsx` | 拟人化播放 React 组件（包装 rhythm-player）|
| `autoReportUpload/emit_event.py` | 接入 digital_employee_reporter，上报 task 状态 |
| `vitest.config.ts` | Vitest 配置（路径别名、jsdom 环境）|

###修改文件

| 路径 | 修改点 |
|------|------|
| `frontend/package.json` | 新增 `vitest`、`@vitest/ui`（devDependencies），新增 `test` script |
| `frontend/vitest.config.ts`（新建）| vitest 配置 |
| `frontend/app/dashboard/digital-employees/[id]/page.tsx` | 替换"任务历史"卡片 → 嵌入 `PersonifiedPlayer` |
| `autoReportUpload/processor.py` | 在 `process_file()` 关键节点调用 `emit_event` |
| `autoReportUpload/models.py` | 增加 `DigitalEmployee` model import |

###不修改文件

- `backend/app/models/digital_employee.py` —— 模型已存在，**不新增字段**
- `backend/app/services/digital_employee_reporter.py` —— Reporter 已有，**不修改**
- `backend/app/api/v1/endpoints/digital_employees.py` —— API 已存在，**不修改**
- `frontend/app/dashboard/digital-employees/page.tsx` —— 列表页已支持卡片点击，**不修改**
- `frontend/components/digital-employee/activity-feed.tsx` —— 列表页"实时动态"独立组件，**不修改**

---

## 任务 0：初始化 Vitest

**文件：**
- 创建：`frontend/vitest.config.ts`
- 修改：`frontend/package.json`

- [ ] **步骤 1：安装 vitest 依赖**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/frontend
pnpm add -D vitest@^2.1.0 @vitejs/plugin-react@^4.3.0 jsdom@^25.0.0
```

- [ ] **步骤 2：在 `package.json` 的 `scripts` 段尾追加：**

```json
"test": "vitest run",
"test:watch": "vitest",
"test:ui": "vitest --ui"
```

- [ ] **步骤 3：创建 `frontend/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['lib/**/__tests__/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['lib/digital-employee/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
})
```

- [ ] **步骤 4：写一个空测试验证 vitest 跑得通**

创建 `frontend/lib/digital-employee/__tests__/_smoke.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('vitest works', () => {
    expect(1 + 1).toBe(2)
  })
})
```

运行：`cd frontend && pnpm test`
预期：PASS，看到 `1 passed`

- [ ] **步骤 5：删除 smoke 测试文件 + Commit**

```bash
rm frontend/lib/digital-employee/__tests__/_smoke.test.ts
git add frontend/vitest.config.ts frontend/package.json
git commit -m "chore(frontend): 引入 vitest 用于纯逻辑模块单测"
```

---

## 任务 1：节奏播放器 rhythm-player（TDD）

**文件：**
- 创建：`frontend/lib/digital-employee/__tests__/rhythm-player.test.ts`
- 创建：`frontend/lib/digital-employee/rhythm-player.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// frontend/lib/digital-employee/__tests__/rhythm-player.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRhythmPlayer, type RhythmBucket, type RhythmConfig } from '../rhythm-player'

const baseConfig: RhythmConfig = {
  intervalMs: 3000,        // 普通节奏
  tailExtendMs: 12000,     // 末尾延长
  idleAfterMs: 30000,      // 空闲后切到"下班"
}

function makeBucket(project: string, reportType: string): RhythmBucket {
  return {
    id: `${project}-${reportType}`,
    projectName: project,
    reportType,
    reportLabel: 'Payment Report',
    status: 'SUCCEEDED',
    eventCount: 1,
    rowCountTotal: 100,
    firstOccurredAt: new Date(),
    lastOccurredAt: new Date(),
    dateRange: '06-05~06-05',
  }
}

describe('RhythmPlayer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(()() => { vi.useRealTimers() })

  it('初始为空闲态', () => {
    const player = createRhythmPlayer(baseConfig)
    expect(player.snapshot().state).toBe('IDLE')
  })

  it('喂入桶后第一帧是工作态', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    expect(player.snapshot().state).toBe('WORKING')
  })

  it('普通节奏：队列还有 → 切下一桶前等 intervalMs', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report'), makeBucket('弥森', 'business_report')])
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')

    vi.advanceTimersByTime(2999)
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')

    vi.advanceTimersByTime(1)
    expect(player.snapshot().currentBucketId).toBe('弥森-business_report')
  })

  it('末尾延长：队列清空时，最后一项多等 tailExtendMs', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    // 走完普通 interval (3s) 后应该切到 TAIL
    vi.advanceTimersByTime(3000)
    expect(player.snapshot().state).toBe('WORKING_TAIL')

    // 走完 tailExtend (12s) 后切到 IDLE
    vi.advanceTimersByTime(11999)
    expect(player.snapshot().state).toBe('WORKING_TAIL')
    vi.advanceTimersByTime(1)
    expect(player.snapshot().state).toBe('IDLE')
  })

  it('空闲超时：IDLE 持续 idleAfterMs 后切到 OFFLINE', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    vi.advanceTimersByTime(3000) // WORKING → WORKING_TAIL
    vi.advanceTimersByTime(12000) // WORKING_TAIL → IDLE
    expect(player.snapshot().state).toBe('IDLE')
    vi.advanceTimersByTime(30000) // IDLE → OFFLINE
    expect(player.snapshot().state).toBe('OFFLINE')
  })

  it('WORKING 期间追加新桶，会出现在队列里但当前桶不变', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')

    // 工作中追加新桶
    player.feed([makeBucket('弥森', 'business_report')])
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')

    // 3 秒后切到弥森
    vi.advanceTimersByTime(3000)
    expect(player.snapshot().currentBucketId).toBe('弥森-business_report')
  })

  it('dispose 清理定时器', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    player.dispose()
    vi.advanceTimersByTime(10000)
    // 状态不再变化
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/frontend && pnpm test rhythm-player
```

预期：FAIL，报错"Cannot find module '../rhythm-player'"

- [ ] **步骤 3：实现 rhythm-player.ts**

```typescript
// frontend/lib/digital-employee/rhythm-player.ts

export type RhythmState = 'IDLE' | 'WORKING' | 'WORKING_TAIL' | 'OFFLINE'

export interface RhythmBucket {
  id: string
  projectName: string
  reportType: string
  reportLabel: string
  status: 'SUCCEEDED' | 'FAILED' | 'RUNNING' | 'PENDING'
  eventCount: number
  rowCountTotal: number
  firstOccurredAt: Date
  lastOccurredAt: Date
  dateRange: string
}

export interface RhythmConfig {
  intervalMs: number
  tailExtendMs: number
  idleAfterMs: number
}

export interface RhythmSnapshot {
  state: RhythmState
  currentBucketId: string | null
  currentBucket: RhythmBucket | null
}

export interface RhythmPlayer {
  feed(buckets: RhythmBucket[]): void
  snapshot(): RhythmSnapshot
  dispose(): void
}

export function createRhythmPlayer(config: RhythmConfig): RhythmPlayer {
  const queue: RhythmBucket[] = []
  let currentBucket: RhythmBucket | null = null
  let state: RhythmState = 'IDLE'
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (timer) { clearTimeout(timer); timer = null }
  }

  function scheduleNext(delayMs: number, next: () => void) {
    clearTimer()
    timer = setTimeout(next, delayMs)
  }

  function tick() {
    if (queue.length > 0) {
      // 切到下一桶
      currentBucket = queue.shift()!
      const hasMore = queue.length > 0
      state = hasMore ? 'WORKING' : 'WORKING_TAIL'
      scheduleNext(hasMore ? config.intervalMs : config.tailExtendMs, tick)
    } else if (currentBucket !== null) {
      // 队列空，保持 TAIL
      state = 'WORKING_TAIL'
      scheduleNext(config.tailExtendMs, tick)
    } else {
      // 完全空 → IDLE → idleAfterMs 后 → OFFLINE
      state = 'IDLE'
      scheduleNext(config.idleAfterMs, () => { state = 'OFFLINE' })
    }
  }

  return {
    feed(buckets) {
      for (const b of buckets) queue.push(b)
      // 如果当前是 IDLE 且刚喂入，立即启动
      if (state === 'IDLE' && currentBucket === null && queue.length > 0) {
        tick()
      }
    },
    snapshot() {
      return { state, currentBucketId: currentBucket?.id ?? null, currentBucket }
    },
    dispose() {
      clearTimer()
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test rhythm-player
```

预期：全部 7 个测试 PASS

- [ ] **步骤 5：Commit**

```bash
git add frontend/lib/digital-employee/rhythm-player.ts frontend/lib/digital-employee/__tests__/rhythm-player.test.ts
git commit -m "feat(digital-employee): 添加节奏播放器纯逻辑模块 + 7 个单测"
```

---

## 任务 2：聚合器 aggregator（TDD）

**文件：**
- 创建：`frontend/lib/digital-employee/__tests__/aggregator.test.ts`
- 创建：`frontend/lib/digital-employee/aggregator.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// frontend/lib/digital-employee/__tests__/aggregator.test.ts
import { describe, it, expect } from 'vitest'
import { aggregateTasks, type RawTask } from '../aggregator'

function rawTask(overrides: Partial<RawTask> = {}): RawTask {
  return {
    id: 'task-1',
    task_id: 'aru-1-payment',
    task_name: '润茗/Payment Report',
    task_type: 'payment_report',
    status: 'SUCCEEDED',
    progress_percent: 100,
    current_step: '入库完成',
    started_at: '2026-06-10T10:00:00Z',
    ended_at: '2026-06-10T10:00:05Z',
    metadata_json: { project_name: '润茗', report_label: 'Payment Report', country: 'US', row_count: 100, detected_date_range: '06-05' },
    ...overrides,
  }
}

describe('aggregateTasks', () => {
  it('空输入返回空数组', () => {
    expect(aggregateTasks([])).toEqual([])
  })

  it('单条任务生成一个桶', () => {
    const buckets = aggregateTasks([rawTask()])
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      projectName: '润茗',
      reportType: 'payment_report',
      reportLabel: 'Payment Report',
      status: 'SUCCEEDED',
      eventCount: 1,
      rowCountTotal: 100,
    })
  })

  it('同 project × report_type 的多条任务合并为一个桶', () => {
    const buckets = aggregateTasks([
      rawTask({ id: '1', metadata_json: { project_name: '润茗', report_label: 'Payment Report', country: 'US', row_count: 100, detected_date_range: '06-05' } }),
      rawTask({ id: '2', metadata_json: { project_name: '润茗', report_label: 'Payment Report', country: 'US', row_count: 200, detected_date_range: '06-06' } }),
    ])
    expect(buckets).toHaveLength(1)
    expect(buckets[0].eventCount).toBe(2)
    expect(buckets[0].rowCountTotal).toBe(300)
  })

  it('不同 project 拆成不同桶', () => {
    const buckets = aggregateTasks([
      rawTask({ id: '1', metadata_json: { project_name: '润茗', report_label: 'Payment Report', country: 'US', row_count: 100, detected_date_range: '06-05' } }),
      rawTask({ id: '2', metadata_json: { project_name: '弥森', report_label: 'Payment Report', country: 'US', row_count: 50, detected_date_range: '06-05' } }),
    ])
    expect(buckets).toHaveLength(2)
  })

  it('按 firstOccurredAt 升序排序', () => {
    const buckets = aggregateTasks([
      rawTask({ id: '1', started_at: '2026-06-10T10:01:00Z', metadata_json: { project_name: 'B', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
      rawTask({ id: '2', started_at: '2026-06-10T10:00:00Z', metadata_json: { project_name: 'A', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
    ])
    expect(buckets[0].projectName).toBe('A')
    expect(buckets[1].projectName).toBe('B')
  })

  it('粒度自适应：同桶 >20 事件则合并为"多项目"桶', () => {
    const tasks = Array.from({ length: 25 }, (_, i) =>
      rawTask({
        id: String(i),
        metadata_json: { project_name: `项目${i}`, report_label: 'Payment Report', country: 'US', row_count: 10, detected_date_range: '06-05' },
      }),
    )
    const buckets = aggregateTasks(tasks)
    expect(buckets).toHaveLength(1)
    expect(buckets[0].projectName).toBe('多项目')
    expect(buckets[0].eventCount).toBe(25)
  })

  it('桶状态：success 占比 ≥80% 算 success，否则按最高级别（failed > running > pending）', () => {
    const buckets = aggregateTasks([
      rawTask({ id: '1', status: 'SUCCEEDED', metadata_json: { project_name: 'A', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
      rawTask({ id: '2', status: 'SUCCEEDED', metadata_json: { project_name: 'A', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
      rawTask({ id: '3', status: 'FAILED', metadata_json: { project_name: 'A', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
    ])
    expect(buckets[0].status).toBe('FAILED')  // 2/3 = 67% < 80%
  })

  it('缺失 metadata_json 时 projectName 用 _global', () => {
    const buckets = aggregateTasks([rawTask({ metadata_json: null })])
    expect(buckets[0].projectName).toBe('_global')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/frontend && pnpm test aggregator
```

预期：FAIL，"Cannot find module '../aggregator'"

- [ ] **步骤 3：实现 aggregator.ts**

```typescript
// frontend/lib/digital-employee/aggregator.ts
import type { RhythmBucket } from './rhythm-player'

export interface RawTask {
  id: string
  task_id: string
  task_name: string
  task_type: string
  status: 'SUCCEEDED' | 'FAILED' | 'RUNNING' | 'PENDING' | 'CANCELLED'
  progress_percent: number
  current_step: string | null
  started_at: string | null
  ended_at: string | null
  metadata_json: Record<string, any> | null
}

interface TaskMeta {
  project_name: string
  report_label: string
  country?: string
  row_count?: number
  detected_date_range?: string
}

const STATUS_PRIORITY: Record<string, number> = {
  FAILED: 4, RUNNING: 3, PENDING: 2, CANCELLED: 1, SUCCEEDED: 0,
}

export function aggregateTasks(tasks: RawTask[]): RhythmBucket[] {
  if (tasks.length === 0) return []

  // 1) 分桶
  const bucketMap = new Map<string, { tasks: RawTask[]; meta: TaskMeta }>()
  for (const t of tasks) {
    const meta = (t.metadata_json ?? {}) as TaskMeta
    const projectName = meta.project_name || '_global'
    const reportType = t.task_type
    const key = `${projectName}::${reportType}`
    const existing = bucketMap.get(key)
    if (existing) {
      existing.tasks.push(t)
    } else {
      bucketMap.set(key, { tasks: [t], meta })
    }
  }

  // 2) 同桶内事件数 >20 的桶 → 进一步合并（按 reportType 全局汇总）
  const oversized = [...bucketMap.entries()].filter(([, v]) => v.tasks.length > 20)
  if (oversized.length > 1) {
    // 把同 reportType 的所有桶合并为一个"多项目"桶
    const byType = new Map<string, RawTask[]>()
    for (const [, v] of oversized) {
      const list = byType.get(v.meta.report_label) ?? []
      byType.set(v.meta.report_label, [...list, ...v.tasks])
    }
    for (const [reportLabel, allTasks] of byType) {
      const key = `__multiproject__::${reportLabel}`
      bucketMap.set(key, { tasks: allTasks, meta: { project_name: '多项目', report_label: reportLabel } })
    }
    for (const [k, v] of oversized) {
      if (k !== `__multiproject__::${v.meta.report_label}`) bucketMap.delete(k)
    }
  }

  // 3) 计算每个桶的最终字段
  const buckets: RhythmBucket[] = []
  for (const [key, { tasks: ts, meta }] of bucketMap) {
    const statusCounts: Record<string, number> = {}
    for (const t of ts) {
      statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1
    }
    const total = ts.length
    const succeeded = statusCounts['SUCCEEDED'] ?? 0
    const successRate = succeeded / total
    let finalStatus: RhythmBucket['status']
    if (successRate >= 0.8) {
      finalStatus = 'SUCCEEDED'
    } else {
      // 取最高优先级
      finalStatus = (Object.entries(statusCounts).sort(
        ([a, ac], [b, bc]) => (STATUS_PRIORITY[b] - STATUS_PRIORITY[a]) || (bc - ac),
      )[0]?.[0] ?? 'PENDING') as RhythmBucket['status']
    }

    const rowCountTotal = ts.reduce((s, t) => s + (t.metadata_json?.row_count ?? 0), 0)
    const dates = ts
      .map((t) => t.metadata_json?.detected_date_range)
      .filter(Boolean) as string[]
    const dateRange = mergeDateRanges(dates)

    const first = ts.reduce((m, t) => (t.started_at && t.started_at < m ? t.started_at : m), ts[0].started_at ?? '')
    const last = ts.reduce((m, t) => (t.ended_at && t.ended_at > m ? t.ended_at : m), ts[0].ended_at ?? '')

    buckets.push({
      id: key,
      projectName: meta.project_name || '_global',
      reportType: ts[0].task_type,
      reportLabel: meta.report_label || ts[0].task_type,
      status: finalStatus,
      eventCount: total,
      rowCountTotal,
      firstOccurredAt: new Date(first || Date.now()),
      lastOccurredAt: new Date(last || Date.now()),
      dateRange,
    })
  }

  // 4) 按 firstOccurredAt 升序
  buckets.sort((a, b) => a.firstOccurredAt.getTime() - b.firstOccurredAt.getTime())
  return buckets
}

function mergeDateRanges(dates: string[]): string {
  if (dates.length === 0) return ''
  const sorted = [...new Set(dates)].sort()
  if (sorted.length === 1) return sorted[0]
  return `${sorted[0]}~${sorted[sorted.length - 1]}`
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test aggregator
```

预期：全部 8 个测试 PASS

- [ ] **步骤 5：Commit**

```bash
git add frontend/lib/digital-employee/aggregator.ts frontend/lib/digital-employee/__tests__/aggregator.test.ts
git commit -m "feat(digital-employee): 添加聚合器纯逻辑模块 + 8 个单测"
```

---

## 任务 3：文案模板 persona-templates（TDD）

**文件：**
- 创建：`frontend/lib/digital-employee/__tests__/persona-templates.test.ts`
- 创建：`frontend/lib/digital-employee/persona-templates.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// frontend/lib/digital-employee/__tests__/persona-templates.test.ts
import { describe, it, expect } from 'vitest'
import { renderState, type TemplateContext } from '../persona-templates'

const ctx = (overrides: Partial<TemplateContext> = {}): TemplateContext => ({
  bucket: {
    id: 'A-payment',
    projectName: '润茗',
    reportType: 'payment_report',
    reportLabel: 'Payment Report',
    status: 'SUCCEEDED',
    eventCount: 1,
    rowCountTotal: 100,
    firstOccurredAt: new Date('2026-06-10T10:00:00Z'),
    lastOccurredAt: new Date('2026-06-10T10:00:05Z'),
    dateRange: '06-05',
  },
  employeeName: 'Payment Report 数字员工',
  ...overrides,
})

describe('renderState', () => {
  it('WORKING 状态文案', () => {
    const result = renderState('WORKING', ctx())
    expect(result).toContain('润茗')
    expect(result).toContain('Payment Report')
  })

  it('WORKING_TAIL 状态文案', () => {
    const result = renderState('WORKING_TAIL', ctx())
    expect(result).toContain('润茗')
    expect(result).toContain('100')
  })

  it('IDLE 状态文案', () => {
    const result = renderState('IDLE', ctx())
    expect(result).toContain('没有新报表')
  })

  it('OFFLINE 状态文案', () => {
    const result = renderState('OFFLINE', ctx())
    expect(result).toContain('工作')
  })

  it('FAILED 桶：WORKING 文案加警告前缀', () => {
    const result = renderState('WORKING', ctx({
      bucket: { ...ctx().bucket, status: 'FAILED' },
    }))
    expect(result).toContain('失败')
  })

  it('占位符全部替换无残留 {{...}}', () => {
    for (const state of ['WORKING', 'WORKING_TAIL', 'IDLE', 'OFFLINE'] as const) {
      const result = renderState(state, ctx())
      expect(result).not.toMatch(/\{\{/)
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/frontend && pnpm test persona-templates
```

预期：FAIL，"Cannot find module"

- [ ] **步骤 3：实现 persona-templates.ts**

```typescript
// frontend/lib/digital-employee/persona-templates.ts
import type { RhythmState, RhythmBucket } from './rhythm-player'

export interface TemplateContext {
  bucket: RhythmBucket | null
  employeeName: string
}

const TEMPLATES: Record<RhythmState, string> = {
  WORKING: '📊 正在核对【{{project_name}}】的 {{report_label}}，数据范围 {{date_range}}…',
  WORKING_TAIL: '✅ 【{{project_name}}】的 {{report_label}} 处理完成（共 {{row_count}} 行）。稍作整理中…',
  IDLE: '🍵 当前没有新报表，静候下一批任务…',
  OFFLINE: '🌙 今日工作告一段落，明日再续。',
}

const FAILED_PREFIX = '⚠️ '

function fillPlaceholders(template: string, bucket: RhythmBucket): string {
  return template
    .replace(/\{\{project_name\}\}/g, bucket.projectName)
    .replace(/\{\{report_label\}\}/g, bucket.reportLabel)
    .replace(/\{\{date_range\}\}/g, bucket.dateRange)
    .replace(/\{\{row_count\}\}/g, String(bucket.rowCountTotal))
}

export function renderState(state: RhythmState, ctx: TemplateContext): string {
  if ((state === 'WORKING' || state === 'WORKING_TAIL') && !ctx.bucket) {
    return renderState('IDLE', ctx)
  }
  if (state === 'IDLE' || state === 'OFFLINE') {
    return TEMPLATES[state]
  }
  const base = fillPlaceholders(TEMPLATES[state], ctx.bucket!)
  return ctx.bucket?.status === 'FAILED' ? FAILED_PREFIX + base : base
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test persona-templates
```

预期：全部 6 个测试 PASS

- [ ] **步骤 5：Commit**

```bash
git add frontend/lib/digital-employee/persona-templates.ts frontend/lib/digital-employee/__tests__/persona-templates.test.ts
git commit -m "feat(digital-employee): 添加文案模板纯逻辑模块 + 6 个单测"
```

---

## 任务 4：autoReportUpload 接入 Reporter

**文件：**
- 创建：`autoReportUpload/emit_event.py`
- 修改：`autoReportUpload/processor.py`
- 修改：`autoReportUpload/models.py`

- [ ] **步骤 1：在 `autoReportUpload/models.py` 中追加 model import**

打开 `autoReportUpload/models.py`，在已有 import 块**末尾**追加（不破坏现有 imports）：

```python
# Digital Employee models (for status reporting)
from app.models import (  # noqa: E402
    DigitalEmployee,
    DigitalEmployeeTask,
    DigitalEmployeeLog,
)
```

- [ ] **步骤 2：创建 `autoReportUpload/emit_event.py`**

```python
"""
autoReportUpload → Digital Employee 上报。

调用 digital_employee_reporter 把每个报表处理任务注册到数字员工基础设施。
不在主流程上引入额外失败点：所有 DB 写入都包在 try/except 里，失败仅记日志。
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

# backend 在 sys.path 里已就绪（由 models.py 提前注入）
from app.services.digital_employee_reporter import (
    get_or_create_employee as _get_or_create_employee,
    start_task as _reporter_start_task,
    report_heartbeat as _reporter_heartbeat,
    complete_task as _reporter_complete_task,
)

logger = logging.getLogger("autorun.emit_event")

EMPLOYEE_NAME = "AutoReport Upload"
EMPLOYEE_TYPE = "auto_report_upload"
EMPLOYEE_DESCRIPTION = "负责自动识别和上传 RPA 文件夹下的亚马逊报表"


# ── task_id 生成 ──────────────────────────────────────────────────────────────

_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9_-]+")


def _safe_task_id(*parts: Any) -> str:
    """生成稳定的 task_id，同一文件多次处理会复用同一 task_id。"""
    raw = "-".join(str(p) for p in parts if p is not None)
    safe = _UNSAFE_CHARS.sub("-", raw).strip("-")
    return f"aru-{safe[:48]}" if safe else f"aru-{secrets.token_hex(8)}"


# ── 上报函数 ──────────────────────────────────────────────────────────────────


def ensure_employee(db: Session) -> int | None:
    """确保数字员工存在，返回 employee_id；失败返回 None。"""
    try:
        emp = _get_or_create_employee(db, EMPLOYEE_NAME, EMPLOYEE_TYPE, EMPLOYEE_DESCRIPTION)
        return emp.id
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[emit_event] 创建/获取员工失败: {exc}")
        return None


def emit_start(
    db: Session,
    *,
    project_name: str | None,
    report_type: str,
    source_file_name: str,
    row_count: int | None = None,
    detected_date_range: str | None = None,
) -> str | None:
    """上报任务开始。返回 task_id（用于后续 complete 调用），失败返回 None。"""
    employee_id = ensure_employee(db)
    if employee_id is None:
        return None

    task_id = _safe_task_id(report_type, project_name, source_file_name, detected_date_range)
    task_name = f"{project_name or '未匹配'}/{report_type}"

    try:
        _reporter_start_task(db, employee_id, task_id, task_name, report_type)
        _reporter_heartbeat(
            db,
            employee_id,
            task_id,
            status="RUNNING",
            progress_percent=10,
            current_step="数据识别完成，准备入库",
            message=f"开始处理 {source_file_name}",
        )
        return task_id
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[emit_event] start_task 失败: {exc}")
        return None


def emit_complete(
    db: Session,
    *,
    task_id: str | None,
    success: bool,
    error_message: str | None = None,
) -> None:
    """上报任务完成。task_id 为 None 时跳过。"""
    if task_id is None:
        return
    try:
        _reporter_complete_task(db, task_id, success=success, error_message=error_message)
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[emit_event] complete_task 失败: {exc}")


# ── metadata 辅助 ─────────────────────────────────────────────────────────────


def _date_range_for(result) -> str | None:
    sd, ed = result.detected_start_date, result.detected_end_date
    if not sd and not ed:
        return None
    if not sd:
        return ed[5:] if ed else None  # type: ignore[index]
    if not ed or sd == ed:
        return sd[5:]  # type: ignore[index]
    # 跨天压缩：MM-DD~DD 或 MM-DD~MM-DD
    if sd[:7] == ed[:7]:
        return f"{sd[5:]}~{ed[8:]}"  # type: ignore[index]
    return f"{sd[5:]}~{ed[5:]}"  # type: ignore[index]


def _build_metadata(
    *,
    project_name: str,
    report_label: str,
    country: str,
    row_count: int | None,
    detected_date_range: str | None,
) -> str:
    """把 metadata_json 序列化为 Reporter 接受的 JSON 字符串。

    Reporter 实际不会读 metadata_json（只读 progress_percent/current_step），
    但我们写进 metadata 供未来聚合器使用。
    """
    import json
    return json.dumps(
        {
            "project_name": project_name,
            "report_label": report_label,
            "country": country,
            "row_count": row_count,
            "detected_date_range": detected_date_range,
        },
        ensure_ascii=False,
    )
```

## 任务 4.5：把 metadata 写入 task（需要 backend 微改）

**文件：**
- 修改：`backend/app/services/digital_employee_reporter.py`（start_task 增加 metadata_json 写入）
- 修改：`backend/app/models/digital_employee.py`（DigitalEmployeeTask 已有 metadata_json 字段，**不需改**）

- [ ] **步骤 1：在 `digital_employee_reporter.py` 的 `start_task()` 末尾增加 metadata_json 参数**

打开 `start_task` 函数（当前签名是 4 个参数），把签名改为：

```python
def start_task(
    db: Session,
    employee_id: int,
    task_id: str,
    task_name: str,
    task_type: str,
    metadata_json: str | None = None,
) -> DigitalEmployeeTask:
    """为数字员工创建一个运行中任务"""
    now = datetime.now(UTC)
    task = DigitalEmployeeTask(
        employee_id=employee_id,
        task_id=task_id,
        task_name=task_name,
        task_type=task_type,
        status=TaskStatus.RUNNING,
        progress_percent=0,
        started_at=now,
        metadata_json=metadata_json,
    )
    db.add(task)
    employee = db.get(DigitalEmployee, employee_id)
    if employee:
        employee.status = EmployeeStatus.RUNNING
    db.commit()
    db.refresh(task)
    return task
```

- [ ] **步骤 2：运行后端单测验证不破坏**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/backend
/Users/damon/miniconda3/bin/python3 -m pytest tests/services/ -x -q
```

预期：原有测试全部 PASS

- [ ] **步骤 3：Commit**

```bash
git add backend/app/services/digital_employee_reporter.py
git commit -m "feat(digital-employee): start_task 支持 metadata_json 传递项目/报表上下文"
```

---

## 任务 4 续：修改 processor.py 接入 emit

**文件：**
- 修改：`autoReportUpload/processor.py`

- [ ] **步骤 1：在 processor.py 顶部 import 块追加 emit_event**

找到 `from recognition import (` 块**之前**，新增：

```python
import emit_event as _emit_event
```

- [ ] **步骤 2：在 `process_file()` 函数顶部、`t0 = time.time()` 之后插入 emit_start**

定位 `import time` 和 `t0 = time.time()` 之间已有内容，在 `# 1. Recognize` 注释之前插入：

```python
# 0. Emit start (best-effort; 失败不影响主流程)
_task_id = _emit_event.emit_start(
    db,
    project_name=project_name,
    report_type=result.report_type if result else "unknown",
    source_file_name=file_path.name,
    row_count=result.row_count_preview if result else None,
    detected_date_range=None,  # 识别阶段还不知道，先传 None
)
```

注意：`result` 变量在 emit_start 处还未定义。把这一段放在识别成功之后更合理——**改为：把 emit_start 移动到 `# 1. Recognize` 之后、`if result is None:` 之前**。

**最终修改：在 `t1 = time.time()` 之后、`if result is None: return ...` 之前插入：**

```python
# Emit start to digital employee (best-effort)
_task_id = _emit_event.emit_start(
    db,
    project_name=project_name,
    report_type=result.report_type,
    source_file_name=file_path.name,
    row_count=result.row_count_preview,
    detected_date_range=_emit_event._date_range_for(result),
)
```

- [ ] **步骤 3：在 `process_file()` 末尾、`return ProcessResult(...)` 之前插入 emit_complete**

定位文件 `autoReportUpload/processor.py` 的 `return ProcessResult(` 在 `total_time` 处的位置（行 410 附近），**在该 return 之前**插入：

```python
# Emit complete to digital employee (best-effort)
_emit_event.emit_complete(db, task_id=_task_id, success=True)
```

- [ ] **步骤 4：在所有 skipped/失败 return 之前也插入 emit_complete**

按 `process_file` 当前的 4 个 early-return 路径，分别在 return 前加：

| 行号（约）| 场景 | 插入位置 |
|--------|------|---------|
| ~339 | 唯一约束冲突（skipped=True）| return 前：`_emit_event.emit_complete(db, task_id=_task_id, success=True, error_message="数据已存在")` |
| ~350 | 入库失败（success=False）| return 前：`_emit_event.emit_complete(db, task_id=_task_id, success=False, error_message=str(outcome.get('error', '')))` |
| ~378 | _persist_one_file 抛异常（success=False）| return 前：`_emit_event.emit_complete(db, task_id=_task_id, success=False, error_message=str(exc))` |

**说明：** 这些 emit_complete 都用 try/except 保护（`emit_complete` 内部已包），不抛异常到主流程。

**额外说明：** `process_file` 顶部还有 5 个 early return（`result is None` / `project_match is None` / `match_status != matched` / `matched_project != project_name` / `dry_run`）。这些 return 点发生在 `emit_start` 之前（`emit_start` 在 `# 1. Recognize` 之后），所以 `_task_id` 为 None。`emit_complete` 内部对 `task_id=None` 做 no-op 处理，因此这些路径**不需要**手动调用 emit_complete。

- [ ] **步骤 5：手动验证：放入一个测试文件观察 DB 写入**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/autoReportUpload
source .venv/bin/activate
python run.py --once --dry-run  # 先 dry-run
```

```bash
# 然后拷贝一个真实报表文件到 RPA/润茗/ 下
cp /path/to/test-payment-report.csv /Users/damon/Documents/RPA/润茗/
python run.py --once  # 实际处理
```

查询 DB：
```sql
SELECT id, task_id, task_name, status, progress_percent, current_step, started_at, ended_at
FROM digital_employee_tasks
ORDER BY created_at DESC LIMIT 5;
```

预期：刚才处理的文件对应一行 task，`status='SUCCEEDED'`，`task_name='润茗/payment_report'` 形式。

- [ ] **步骤 6：Commit**

```bash
git add autoReportUpload/emit_event.py autoReportUpload/processor.py autoReportUpload/models.py backend/app/services/digital_employee_reporter.py
git commit -m "feat(autoReportUpload): 接入数字员工 Reporter，每个文件处理上报为 task"
```

---

## 任务 5：前端拟人化播放器组件

**文件：**
- 创建：`frontend/components/digital-employee/personified-player.tsx`

- [ ] **步骤 1：创建组件文件**

```tsx
// frontend/components/digital-employee/personified-player.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DigitalEmployeeTask } from '@/types/digital-employee'
import { fetchEmployeeTasks } from '@/lib/digital-employee-api'
import { aggregateTasks, type RawTask } from '@/lib/digital-employee/aggregator'
import {
  createRhythmPlayer,
  type RhythmBucket,
  type RhythmPlayer,
  type RhythmSnapshot,
} from '@/lib/digital-employee/rhythm-player'
import { renderState } from '@/lib/digital-employee/persona-templates'
import { ArrowRight, Pause, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface PersonifiedPlayerProps {
  employeeId: number
  employeeName: string
  pollIntervalMs?: number
  lookbackMinutes?: number
}

const DEFAULT_RHYTHM = {
  intervalMs: 3000,
  tailExtendMs: 12000,
  idleAfterMs: 30000,
}

export function PersonifiedPlayer({
  employeeId,
  employeeName,
  pollIntervalMs = 15000,
  lookbackMinutes = 30,
}: PersonifiedPlayerProps) {
  const [snapshot, setSnapshot] = useState<RhythmSnapshot>({
    state: 'IDLE',
    currentBucketId: null,
    currentBucket: null,
  })
  const [isPaused, setIsPaused] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const playerRef = useRef<RhythmPlayer | null>(null)
  const tasksRef = useRef<RawTask[]>([])
  const consumedIdsRef = useRef<Set<string>>(new Set())

  // 初始化播放器
  useEffect(() => {
    const p = createRhythmPlayer(DEFAULT_RHYTHM)
    playerRef.current = p

    // 订阅 snapshot 变化
    const interval = setInterval(() => {
      setSnapshot(p.snapshot())
    }, 200)

    return () => {
      clearInterval(interval)
      p.dispose()
      playerRef.current = null
    }
  }, [])

  // 拉取 tasks 并喂给播放器
  useEffect(() => {
    if (isPaused) return

    async function poll() {
      try {
        const { items } = await fetchEmployeeTasks(employeeId)
        tasksRef.current = items as RawTask[]
        // 只把"新增"的桶喂给播放器（用桶 id 去重）
        const allBuckets = aggregateTasks(tasksRef.current)
        const newBuckets = allBuckets.filter(
          (b) => !consumedIdsRef.current.has(b.id),
        )
        for (const b of newBuckets) consumedIdsRef.current.add(b.id)
        if (newBuckets.length > 0) {
          playerRef.current?.feed(newBuckets)
        }
      } catch (err) {
        console.warn('[PersonifiedPlayer] poll failed', err)
      } finally {
        setIsLoading(false)
      }
    }

    void poll()
    const interval = setInterval(poll, pollIntervalMs)
    return () => clearInterval(interval)
  }, [employeeId, pollIntervalMs, isPaused])

  const text = useMemo(
    () => renderState(snapshot.state, { bucket: snapshot.currentBucket, employeeName }),
    [snapshot, employeeName],
  )

  const stateStyle = STATE_STYLES[snapshot.state]

  return (
    <div className="rounded-2xl border bg-gradient-to-br from-card to-card/60 p-8">
      {/* 状态徽章 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex h-2.5 w-2.5 rounded-full',
              stateStyle.dot,
              snapshot.state === 'WORKING' && 'animate-pulse',
            )}
          />
          <span className={cn('text-xs font-medium uppercase tracking-wider', stateStyle.text)}>
            {stateStyle.label}
          </span>
        </div>
        <div className="flex gap-1.5">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setIsPaused((v) => !v)}
            className="h-8 w-8"
            title={isPaused ? '继续' : '暂停'}
          >
            {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* 主文案区 */}
      <div className="min-h-[120px] flex items-center justify-center text-center">
        {isLoading ? (
          <div className="text-muted-foreground text-sm animate-pulse">正在加载任务历史…</div>
        ) : (
          <p
            key={snapshot.currentBucketId ?? snapshot.state}
            className="text-2xl md:text-3xl font-medium leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300"
          >
            {text}
          </p>
        )}
      </div>

      {/* 拟人化进度条：纯 shimmer 动画，不显示百分比 */}
      {snapshot.state === 'WORKING' && (
        <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-blue-500 to-transparent animate-shimmer" />
        </div>
      )}

      {/* 当前桶元数据 */}
      {snapshot.currentBucket && (
        <div className="mt-4 flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <span>{snapshot.currentBucket.projectName}</span>
          <ArrowRight className="h-3 w-3" />
          <span>{snapshot.currentBucket.reportLabel}</span>
          <span>·</span>
          <span>{snapshot.currentBucket.dateRange}</span>
          {snapshot.currentBucket.eventCount > 1 && (
            <>
              <span>·</span>
              <span>共 {snapshot.currentBucket.eventCount} 份</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const STATE_STYLES: Record<
  RhythmSnapshot['state'],
  { label: string; dot: string; text: string }
> = {
  IDLE: {
    label: '待命',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
  },
  WORKING: {
    label: '工作中',
    dot: 'bg-blue-500',
    text: 'text-blue-600 dark:text-blue-400',
  },
  WORKING_TAIL: {
    label: '收尾中',
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
  },
  OFFLINE: {
    label: '下班',
    dot: 'bg-muted',
    text: 'text-muted',
  },
}
```

- [ ] **步骤 2：lint 验证**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/frontend && pnpm lint
```

预期：无报错（如果有 tailwind class 顺序警告可忽略）

- [ ] **步骤 3：Commit**

```bash
git add frontend/components/digital-employee/personified-player.tsx
git commit -m "feat(digital-employee): 添加拟人化播放器 React 组件"
```

---

## 任务 6：详情页集成

**文件：**
- 修改：`frontend/app/dashboard/digital-employees/[id]/page.tsx`

- [ ] **步骤 1：在详情页 import 块追加**

打开 `frontend/app/dashboard/digital-employees/[id]/page.tsx`，在 import 区域**末尾**追加：

```tsx
import { PersonifiedPlayer } from '@/components/digital-employee/personified-player'
```

- [ ] **步骤 2：在 `Card`（基本信息）和 `Card`（任务历史）之间插入新的 Card**

定位 `<!-- Task History -->` 注释**之前**，插入：

```tsx
{/* Personified Player */}
<Card>
  <CardHeader>
    <CardTitle className="text-base">拟人化工作状态</CardTitle>
  </CardHeader>
  <CardContent>
    <PersonifiedPlayer
      employeeId={employeeId}
      employeeName={employee.name}
    />
  </CardContent>
</Card>
```

- [ ] **步骤 3：lint 验证**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/frontend && pnpm lint
```

预期：PASS

- [ ] **步骤 4：build 验证**

```bash
pnpm build
```

预期：build 成功

- [ ] **步骤 5：Commit**

```bash
git add frontend/app/dashboard/digital-employees/\[id\]/page.tsx
git commit -m "feat(digital-employee): 详情页嵌入拟人化播放器"
```

---

## 任务 7：端到端验证

**文件：**无（纯验证步骤）

- [ ] **步骤 1：准备测试文件**

```bash
# 拷贝一个真实的 Payment Report 到 RPA 根目录下任意项目文件夹
# （如果你没有现成的，可以从 processed 目录里 cp 一份回去）
cp /path/to/your/test-payment.csv /Users/damon/Documents/RPA/润茗/
```

- [ ] **步骤 2：启动 autoReportUpload**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/autoReportUpload
source .venv/bin/activate
python run.py --once
```

- [ ] **步骤 3：DB 验证**

```bash
/Users/damon/miniconda3/bin/python3 -c "
from sqlalchemy import create_engine, text
import os
engine = create_engine(os.environ['DATABASE_URL'])
with engine.connect() as conn:
    rows = conn.execute(text('''
        SELECT task_id, task_name, status, progress_percent, started_at, ended_at
        FROM digital_employee_tasks
        ORDER BY created_at DESC LIMIT 5
    ''')).fetchall()
    for r in rows: print(r)
"
```

预期：能看到刚才处理文件的 task 行。

- [ ] **步骤 4：启动后端 + 前端**

```bash
# Terminal 1
cd /Users/damon/DamonProjects/believeboyDashboard/backend
./run_api.sh

# Terminal 2
cd /Users/damon/DamonProjects/believeboyDashboard/frontend
pnpm dev
```

- [ ] **步骤 5：浏览器验证**

打开 `http://localhost:3000/dashboard/digital-employees/<employee_id>`

预期看到：
- ✅ "拟人化工作状态"卡片在基本信息卡和任务历史卡之间
- ✅ 主文案区显示"📊 正在核对【润茗】的 Payment Report..." 或 "🍵 当前没有新报表..."
- ✅ 状态徽章显示"待命"或"工作中"
- ✅ **3 秒后**文案切换（如果队列有多个 task）/ **12 秒后**进入 IDLE
- ✅ 暂停按钮可工作

- [ ] **步骤 6：业务测试清单**

请用户手动验证以下场景：

| 场景 | 预期结果 |
|------|---------|
| 放入 1 个文件 | 详情页 3 秒内显示工作文案，12 秒后进入"待命" |
| 一次性放入 5 个文件（不同项目）| 工作文案每 3 秒切换一次，最后一个多显示 12 秒 |
| 30 分钟无新文件 | 状态切到"下班" |
| 暂停按钮 | 状态不再变化；点击继续后恢复 |
| 浏览器刷新 | 重新拉取历史，从头慢播一遍（已展示过的桶不会重复）|

- [ ] **步骤 7：Commit（如有验证修复）**

```bash
git status  # 检查是否需要提交
```

---

## 实施顺序总结

1. 任务 0：初始化 Vitest（10 分钟）
2. 任务 1：rhythm-player TDD（30 分钟）
3. 任务 2：aggregator TDD（30 分钟）
4. 任务 3：persona-templates TDD（15 分钟）
5. 任务 4.5：Reporter metadata 支持（5 分钟）
6. 任务 4 续：autoReportUpload 接入（30 分钟）
7. 任务 5：PersonifiedPlayer 组件（20 分钟）
8. 任务 6：详情页集成（10 分钟）
9. 任务 7：端到端验证（30 分钟）

---

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| Reporter 写 DB 失败阻塞主流程 | emit_start/emit_complete 内部全包 try/except |
| 节奏参数调得不舒服 | 改 `DEFAULT_RHYTHM` 一行即可（3 个常量）|
| 前端 setInterval 漏掉状态切换 | snapshot 每 200ms 轮询，setTimeout 触发是确定的 |
| metadata_json 字段不存在 | Reporter 已有该字段（alembic 已建），无需新迁移 |

---

## 未来拓展（YAGNI，不在本次实施范围）

- 多数字员工按报表类型拆分（INSERT 多个员工 + 在 emit_start 路由）
- SSE 推流替代 15s 轮询
- 拟人化文案 persona 可配置（写到 `DigitalEmployee.description` 解析）
- 数字员工"今日小结"日终汇总
