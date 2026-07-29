# P1 告警中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给已有的告警后端补一个 Celery beat 定时检测 + 一个前端告警中心管理页（事件 / 规则 / 偏好三 Tab）。

**Architecture:** 后端零新 API——13 个 `/api/v1/alerts/*` 端点已就绪，只新增一个每 15 分钟跑 `detect_anomalies` + `dispatch_batch` 的 Celery beat 任务。前端新建 `/dashboard/system/alerts` 页面，通过 Next.js 代理 `/api/backend/api/v1/alerts/*` 消费现有端点。

**Tech Stack:** Python 3.11 / Celery / FastAPI（已有）；Next.js 14 / React / TypeScript / shadcn ui（Tabs, Dialog, Select, Switch, Badge）/ Vitest + Testing Library。

## Global Constraints

- 主键统一 `Integer`（对齐 `alert_rule.py` 风格），勿用 `BigInteger`。
- Commit：中文 + Conventional Commits（feat/fix/docs/test/chore），scope 中文，subject 动宾短语 ≤50 字无句号。
- 前端取数走 Next.js 代理：`fetch('/api/backend/api/v1/<path>')`，**不带任何手动 auth header**（代理从 session cookie 注入）。
- 前端测试顺序：`pnpm lint` → `pnpm build` → `pnpm test`；后端：`cd backend && pytest`。失败立即修。
- Celery 任务路由到 `default` 队列（短任务）。
- Sidebar 不做角色墙（权限由单页接管）。

---

## File Structure

**Backend（新增 1 个文件 + 改 1 个）：**
- Create: `backend/app/celery_tasks/alert_detection.py` — `alert_detect` 任务，跑检测 + 分发
- Modify: `backend/app/tasks/celery_app.py` — beat_schedule 注册 `alert-detect`
- Test: `backend/tests/tasks/test_alert_detection.py`

**Frontend（新增 7 个文件 + 改 1 个）：**
- Create: `frontend/lib/alerts-api.ts` — 告警 API 客户端 + 类型
- Create: `frontend/app/dashboard/system/alerts/page.tsx` — 页面壳（Tab 切换 + 统计条）
- Create: `frontend/app/dashboard/system/alerts/components/alert-stats-bar.tsx`
- Create: `frontend/app/dashboard/system/alerts/components/alert-events-tab.tsx`
- Create: `frontend/app/dashboard/system/alerts/components/alert-rules-tab.tsx`
- Create: `frontend/app/dashboard/system/alerts/components/alert-rule-dialog.tsx`
- Create: `frontend/app/dashboard/system/alerts/components/alert-preferences-tab.tsx`
- Modify: `frontend/lib/sidebar-config.ts` — 系统管理组加"告警中心"入口
- Test: `frontend/lib/__tests__/alerts-api.test.ts`

---

### Task 1: Celery beat 定时检测任务

**Files:**
- Create: `backend/app/celery_tasks/alert_detection.py`
- Modify: `backend/app/tasks/celery_app.py`（beat_schedule + task_routes）
- Test: `backend/tests/tasks/test_alert_detection.py`

**Interfaces:**
- Consumes: `app.services.alert.detector.detect_anomalies(db) -> list[AlertEvent]`、`app.services.alert.dispatcher.dispatch_batch(db, events) -> None`、`app.db.session.SessionLocal`
- Produces: Celery 任务名 `alert_detect`（beat 调用）；函数 `alert_detect() -> str` 返回摘要字符串

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/tasks/test_alert_detection.py`：

```python
"""alert_detect Celery 任务单测：mock 检测器与分发器，验证调用链与提交。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch


def test_alert_detect_no_events_skips_dispatch():
    from app.celery_tasks.alert_detection import alert_detect

    with (
        patch("app.celery_tasks.alert_detection.SessionLocal") as mock_sl,
        patch("app.celery_tasks.alert_detection.detect_anomalies", return_value=[]) as mock_detect,
        patch("app.celery_tasks.alert_detection.dispatch_batch") as mock_dispatch,
    ):
        db = MagicMock()
        mock_sl.return_value = db
        result = alert_detect()

    mock_detect.assert_called_once_with(db)
    db.commit.assert_called_once()
    mock_dispatch.assert_not_called()
    db.close.assert_called_once()
    assert "events=0" in result


def test_alert_detect_with_events_dispatches():
    from app.celery_tasks.alert_detection import alert_detect

    fake_events = [MagicMock(), MagicMock()]
    with (
        patch("app.celery_tasks.alert_detection.SessionLocal") as mock_sl,
        patch("app.celery_tasks.alert_detection.detect_anomalies", return_value=fake_events),
        patch("app.celery_tasks.alert_detection.dispatch_batch") as mock_dispatch,
    ):
        db = MagicMock()
        mock_sl.return_value = db
        result = alert_detect()

    mock_dispatch.assert_called_once_with(db, fake_events)
    db.close.assert_called_once()
    assert "events=2" in result


def test_alert_detect_closes_db_on_error():
    from app.celery_tasks.alert_detection import alert_detect

    with (
        patch("app.celery_tasks.alert_detection.SessionLocal") as mock_sl,
        patch("app.celery_tasks.alert_detection.detect_anomalies", side_effect=RuntimeError("boom")),
    ):
        db = MagicMock()
        mock_sl.return_value = db
        try:
            alert_detect()
        except RuntimeError:
            pass

    db.close.assert_called_once()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && pytest tests/tasks/test_alert_detection.py -v`
Expected: FAIL（`ModuleNotFoundError: app.celery_tasks.alert_detection`）

- [ ] **Step 3: 实现任务**

创建 `backend/app/celery_tasks/alert_detection.py`：

```python
"""告警定时检测任务。

每 15 分钟跑一次全量规则检测，命中则分发（邮件 + 站内通知）。
队列：default（短任务）。
"""
from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(name="alert_detect", acks_late=False)
def alert_detect() -> str:
    """检测所有激活规则并分发新事件。

    acks_late=False：幂等周期任务，检测器自带 24h 去重，丢了重跑即可。
    """
    from app.db.session import SessionLocal
    from app.services.alert.detector import detect_anomalies
    from app.services.alert.dispatcher import dispatch_batch

    db = SessionLocal()
    try:
        events = detect_anomalies(db)
        db.commit()
        if events:
            dispatch_batch(db, events)
    finally:
        db.close()

    logger.info("alert_detect 完成：新增事件 %d", len(events))
    return f"events={len(events)}"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && pytest tests/tasks/test_alert_detection.py -v`
Expected: PASS（3 passed）

- [ ] **Step 5: 注册到 beat_schedule 与 task_routes**

编辑 `backend/app/tasks/celery_app.py`。在 `task_routes` 字典（`crm_sea_reclaim` 那行附近）加：

```python
            # 告警定时检测（P1）：default 队列（短任务，每 15 分钟）
            "alert_detect": {"queue": "default"},
```

在 `beat_schedule` 字典（`crm-sea-reclaim` 那项之后）加：

```python
            # 告警定时检测（P1）：每 15 分钟跑全量规则检测 + 分发
            "alert-detect": {
                "task": "alert_detect",
                "schedule": crontab(minute="*/15"),
            },
```

确认文件顶部已 `from celery.schedules import crontab`（已有，`crm-sea-reclaim` 在用）。

- [ ] **Step 6: 验证 celery 能加载配置**

Run: `cd backend && python -c "from app.tasks.celery_app import celery_app; print('alert-detect' in celery_app.conf.beat_schedule)"`
Expected: `True`

- [ ] **Step 7: Commit**

```bash
cd backend
git add app/celery_tasks/alert_detection.py app/tasks/celery_app.py tests/tasks/test_alert_detection.py
git commit -m "feat(告警): 新增 alert_detect 定时检测任务每 15 分钟跑全量规则"
```

---

### Task 2: 前端告警 API 客户端 + 类型

**Files:**
- Create: `frontend/lib/alerts-api.ts`
- Test: `frontend/lib/__tests__/alerts-api.test.ts`

**Interfaces:**
- Consumes: 后端 `/api/v1/alerts/*` 端点（经代理 `/api/backend/api/v1/alerts/*`）
- Produces: 类型 `AlertStats` / `AlertEventItem` / `AlertRuleItem` / `AlertPreference` / `MetricOption`；函数 `fetchAlertStats()` / `fetchAlertEvents(params)` / `acknowledgeEvent(id)` / `resolveEvent(id)` / `fetchAlertRules(params)` / `createAlertRule(payload)` / `updateAlertRule(id, payload)` / `deleteAlertRule(id)` / `fetchMetricOptions()` / `fetchAlertPreferences()` / `updateAlertPreferences(payload)`

- [ ] **Step 1: 写失败测试**

创建 `frontend/lib/__tests__/alerts-api.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildEventsQuery,
  type AlertEventsParams,
} from '../alerts-api'

describe('buildEventsQuery', () => {
  it('拼出全部筛选参数', () => {
    const params: AlertEventsParams = {
      status: 'active',
      severity: 'critical',
      project_id: 3,
      page: 2,
      page_size: 10,
    }
    const qs = buildEventsQuery(params)
    expect(qs).toContain('status=active')
    expect(qs).toContain('severity=critical')
    expect(qs).toContain('project_id=3')
    expect(qs).toContain('page=2')
    expect(qs).toContain('page_size=10')
  })

  it('忽略 undefined 参数', () => {
    const qs = buildEventsQuery({ page: 1, page_size: 20 })
    expect(qs).not.toContain('status')
    expect(qs).not.toContain('severity')
    expect(qs).toContain('page=1')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && pnpm vitest run lib/__tests__/alerts-api.test.ts`
Expected: FAIL（无法解析 `../alerts-api`）

- [ ] **Step 3: 实现 API 客户端**

创建 `frontend/lib/alerts-api.ts`：

```typescript
/**
 * 告警中心 API 客户端。
 *
 * 全部走 Next.js 代理 `/api/backend/api/v1/alerts/*`，代理从 session cookie
 * 注入鉴权头，浏览器端 fetch 不需要手动带任何 header。
 */

const BASE = '/api/backend/api/v1/alerts'

// ── 类型 ────────────────────────────────────────────────

export interface AlertStats {
  total_active: number
  critical_count: number
  warning_count: number
  info_count: number
  acknowledged_today: number
  resolved_today: number
}

export interface AlertEventItem {
  id: number
  rule_id: number
  project_id: number
  metric: string
  current_value: number
  baseline_value: number
  deviation_pct: number
  severity: string
  message: string
  status: string
  triggered_at: string
  acknowledged_at: string | null
  acknowledged_by: string | null
}

export interface AlertEventListResponse {
  items: AlertEventItem[]
  total: number
  page: number
  page_size: number
}

export interface AlertRuleItem {
  id: number
  name: string
  project_id: number
  country: string
  metric: string
  trigger_type: string
  condition: string
  threshold: number
  window_days: number
  severity: string
  notification_channels: string
  is_active: boolean
  created_by: string
  created_at: string
  updated_at: string
}

export interface AlertRulePayload {
  name: string
  project_id: number
  country: string
  metric: string
  trigger_type: string
  condition: string
  threshold: number
  window_days: number
  severity: string
  notification_channels: string
}

export interface AlertPreference {
  email_enabled: boolean
  in_app_enabled: boolean
  min_severity: string
  quiet_hours_start: string | null
  quiet_hours_end: string | null
}

export interface MetricOption {
  value: string
  label: string
  description: string
}

export interface AlertEventsParams {
  status?: string
  severity?: string
  project_id?: number
  page: number
  page_size: number
}

// ── 查询串拼装（纯函数，可单测）─────────────────────────

export function buildEventsQuery(params: AlertEventsParams): string {
  const sp = new URLSearchParams()
  if (params.status) sp.set('status', params.status)
  if (params.severity) sp.set('severity', params.severity)
  if (params.project_id != null) sp.set('project_id', String(params.project_id))
  sp.set('page', String(params.page))
  sp.set('page_size', String(params.page_size))
  return sp.toString()
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`Alerts API ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

// ── Stats ───────────────────────────────────────────────

export async function fetchAlertStats(projectId?: number): Promise<AlertStats> {
  const qs = projectId != null ? `?project_id=${projectId}` : ''
  const res = await fetch(`${BASE}/stats${qs}`)
  return jsonOrThrow<AlertStats>(res)
}

// ── Events ──────────────────────────────────────────────

export async function fetchAlertEvents(
  params: AlertEventsParams
): Promise<AlertEventListResponse> {
  const res = await fetch(`${BASE}/events?${buildEventsQuery(params)}`)
  return jsonOrThrow<AlertEventListResponse>(res)
}

export async function acknowledgeEvent(id: number): Promise<AlertEventItem> {
  const res = await fetch(`${BASE}/events/${id}/acknowledge`, { method: 'POST' })
  return jsonOrThrow<AlertEventItem>(res)
}

export async function resolveEvent(id: number): Promise<AlertEventItem> {
  const res = await fetch(`${BASE}/events/${id}/resolve`, { method: 'POST' })
  return jsonOrThrow<AlertEventItem>(res)
}

// ── Rules ───────────────────────────────────────────────

export async function fetchAlertRules(params?: {
  project_id?: number
  is_active?: boolean
}): Promise<AlertRuleItem[]> {
  const sp = new URLSearchParams()
  if (params?.project_id != null) sp.set('project_id', String(params.project_id))
  if (params?.is_active != null) sp.set('is_active', String(params.is_active))
  const qs = sp.toString()
  const res = await fetch(`${BASE}/rules${qs ? `?${qs}` : ''}`)
  return jsonOrThrow<AlertRuleItem[]>(res)
}

export async function createAlertRule(payload: AlertRulePayload): Promise<AlertRuleItem> {
  const res = await fetch(`${BASE}/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return jsonOrThrow<AlertRuleItem>(res)
}

export async function updateAlertRule(
  id: number,
  payload: Partial<AlertRulePayload> & { is_active?: boolean }
): Promise<AlertRuleItem> {
  const res = await fetch(`${BASE}/rules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return jsonOrThrow<AlertRuleItem>(res)
}

export async function deleteAlertRule(id: number): Promise<void> {
  const res = await fetch(`${BASE}/rules/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Delete rule ${res.status}: ${await res.text()}`)
}

// ── Metrics ─────────────────────────────────────────────

export async function fetchMetricOptions(): Promise<MetricOption[]> {
  const res = await fetch(`${BASE}/metrics`)
  const data = await jsonOrThrow<{ metrics: MetricOption[] }>(res)
  return data.metrics
}

// ── Preferences ─────────────────────────────────────────

export async function fetchAlertPreferences(): Promise<AlertPreference> {
  const res = await fetch(`${BASE}/preferences`)
  return jsonOrThrow<AlertPreference>(res)
}

export async function updateAlertPreferences(
  payload: Partial<AlertPreference>
): Promise<AlertPreference> {
  const res = await fetch(`${BASE}/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return jsonOrThrow<AlertPreference>(res)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && pnpm vitest run lib/__tests__/alerts-api.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: Commit**

```bash
cd frontend
git add lib/alerts-api.ts lib/__tests__/alerts-api.test.ts
git commit -m "feat(告警): 新增告警中心 API 客户端与类型定义"
```

---

### Task 3: 统计卡片条组件

**Files:**
- Create: `frontend/app/dashboard/system/alerts/components/alert-stats-bar.tsx`

**Interfaces:**
- Consumes: `AlertStats`（来自 Task 2）
- Produces: `AlertStatsBar({ stats }: { stats: AlertStats | null })` 组件

- [ ] **Step 1: 实现组件**

创建 `frontend/app/dashboard/system/alerts/components/alert-stats-bar.tsx`：

```tsx
'use client'

import { AlertTriangle, BellRing, CheckCircle2, Info, XCircle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import type { AlertStats } from '@/lib/alerts-api'

const CARDS = [
  { key: 'total_active', label: '活跃告警', icon: BellRing, tone: 'text-foreground' },
  { key: 'critical_count', label: '严重', icon: XCircle, tone: 'text-red-600 dark:text-red-400' },
  { key: 'warning_count', label: '警告', icon: AlertTriangle, tone: 'text-amber-600 dark:text-amber-400' },
  { key: 'info_count', label: '提示', icon: Info, tone: 'text-blue-600 dark:text-blue-400' },
  { key: 'acknowledged_today', label: '今日确认', icon: CheckCircle2, tone: 'text-foreground' },
  { key: 'resolved_today', label: '今日解决', icon: CheckCircle2, tone: 'text-emerald-600 dark:text-emerald-400' },
] as const

export function AlertStatsBar({ stats }: { stats: AlertStats | null }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {CARDS.map((c) => {
        const Icon = c.icon
        const value = stats ? stats[c.key] : null
        return (
          <div
            key={c.key}
            className="dashboard-surface flex items-center gap-3 rounded-xl p-4"
          >
            <Icon className={`h-5 w-5 shrink-0 ${c.tone}`} />
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">{c.label}</div>
              {value == null ? (
                <Skeleton className="mt-1 h-6 w-8" />
              ) : (
                <div className={`text-xl font-semibold tabular-nums ${c.tone}`}>{value}</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd frontend
git add app/dashboard/system/alerts/components/alert-stats-bar.tsx
git commit -m "feat(告警): 新增告警统计卡片条组件"
```

---

### Task 4: 告警事件 Tab

**Files:**
- Create: `frontend/app/dashboard/system/alerts/components/alert-events-tab.tsx`

**Interfaces:**
- Consumes: `fetchAlertEvents` / `acknowledgeEvent` / `resolveEvent` / `AlertEventItem` / `AlertEventsParams`（Task 2）
- Produces: `AlertEventsTab()` 组件（自管筛选 + 分页 + 确认/解决）

- [ ] **Step 1: 实现组件**

创建 `frontend/app/dashboard/system/alerts/components/alert-events-tab.tsx`：

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useNotifications } from '@/components/notifications'
import {
  acknowledgeEvent,
  fetchAlertEvents,
  resolveEvent,
  type AlertEventItem,
} from '@/lib/alerts-api'

const SEVERITY_TONE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  info: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
}

const STATUS_LABEL: Record<string, string> = {
  active: '活跃',
  acknowledged: '已确认',
  resolved: '已解决',
}

const PAGE_SIZE = 20

export function AlertEventsTab() {
  const { notify } = useNotifications()
  const [status, setStatus] = useState<string>('active')
  const [severity, setSeverity] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<AlertEventItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchAlertEvents({
        status: status === 'all' ? undefined : status,
        severity: severity === 'all' ? undefined : severity,
        page,
        page_size: PAGE_SIZE,
      })
      setItems(res.items)
      setTotal(res.total)
    } catch (err) {
      notify({ type: 'error', title: '加载告警事件失败', message: String(err) })
    } finally {
      setLoading(false)
    }
  }, [status, severity, page, notify])

  useEffect(() => {
    void load()
  }, [load])

  const onAck = async (id: number) => {
    try {
      await acknowledgeEvent(id)
      notify({ type: 'success', title: '已确认告警' })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '确认失败', message: String(err) })
    }
  }

  const onResolve = async (id: number) => {
    try {
      await resolveEvent(id)
      notify({ type: 'success', title: '已解决告警' })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '解决失败', message: String(err) })
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">活跃</SelectItem>
            <SelectItem value="acknowledged">已确认</SelectItem>
            <SelectItem value="resolved">已解决</SelectItem>
            <SelectItem value="all">全部状态</SelectItem>
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={(v) => { setSeverity(v); setPage(1) }}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="critical">严重</SelectItem>
            <SelectItem value="warning">警告</SelectItem>
            <SelectItem value="info">提示</SelectItem>
            <SelectItem value="all">全部级别</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="dashboard-surface rounded-xl">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>指标</TableHead>
              <TableHead>消息</TableHead>
              <TableHead className="text-right">偏差</TableHead>
              <TableHead>级别</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">加载中…</TableCell></TableRow>
            ) : items.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">暂无告警事件</TableCell></TableRow>
            ) : (
              items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(e.triggered_at).toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{e.metric}</TableCell>
                  <TableCell className="max-w-md truncate" title={e.message}>{e.message}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.deviation_pct.toFixed(1)}%</TableCell>
                  <TableCell>
                    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SEVERITY_TONE[e.severity] ?? ''}`}>
                      {e.severity}
                    </span>
                  </TableCell>
                  <TableCell>{STATUS_LABEL[e.status] ?? e.status}</TableCell>
                  <TableCell className="text-right">
                    {e.status === 'active' && (
                      <Button size="sm" variant="outline" onClick={() => onAck(e.id)}>确认</Button>
                    )}
                    {e.status !== 'resolved' && (
                      <Button size="sm" variant="ghost" className="ml-1" onClick={() => onResolve(e.id)}>解决</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>共 {total} 条</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
          <span>{page} / {totalPages}</span>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 无错误（若 `Table` 组件路径不同，按 `components/ui/table.tsx` 实际导出调整）

- [ ] **Step 3: Commit**

```bash
cd frontend
git add app/dashboard/system/alerts/components/alert-events-tab.tsx
git commit -m "feat(告警): 新增告警事件列表 Tab 含筛选分页与确认解决"
```

---

### Task 5: 告警规则 Tab + 规则编辑 Dialog

**Files:**
- Create: `frontend/app/dashboard/system/alerts/components/alert-rule-dialog.tsx`
- Create: `frontend/app/dashboard/system/alerts/components/alert-rules-tab.tsx`

**Interfaces:**
- Consumes: `fetchAlertRules` / `createAlertRule` / `updateAlertRule` / `deleteAlertRule` / `fetchMetricOptions` / `AlertRuleItem` / `AlertRulePayload` / `MetricOption`（Task 2）；项目列表 `/api/backend/api/v1/projects/manage`
- Produces: `AlertRulesTab()` 组件；`AlertRuleDialog({ open, onOpenChange, rule, onSaved })` 组件

- [ ] **Step 1: 实现规则编辑 Dialog**

创建 `frontend/app/dashboard/system/alerts/components/alert-rule-dialog.tsx`：

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNotifications } from '@/components/notifications'
import {
  createAlertRule,
  fetchMetricOptions,
  updateAlertRule,
  type AlertRuleItem,
  type AlertRulePayload,
  type MetricOption,
} from '@/lib/alerts-api'

interface ProjectOption {
  id: number
  name: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑态传入已有规则；新建态为 null */
  rule: AlertRuleItem | null
  projects: ProjectOption[]
  onSaved: () => void
}

const EMPTY: AlertRulePayload = {
  name: '',
  project_id: 0,
  country: 'US',
  metric: 'sales_amount',
  trigger_type: 'threshold',
  condition: 'drop_pct',
  threshold: 20,
  window_days: 7,
  severity: 'warning',
  notification_channels: 'in_app',
}

export function AlertRuleDialog({ open, onOpenChange, rule, projects, onSaved }: Props) {
  const { notify } = useNotifications()
  const [form, setForm] = useState<AlertRulePayload>(EMPTY)
  const [metrics, setMetrics] = useState<MetricOption[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    void fetchMetricOptions().then(setMetrics).catch(() => setMetrics([]))
    if (rule) {
      setForm({
        name: rule.name,
        project_id: rule.project_id,
        country: rule.country,
        metric: rule.metric,
        trigger_type: rule.trigger_type,
        condition: rule.condition,
        threshold: rule.threshold,
        window_days: rule.window_days,
        severity: rule.severity,
        notification_channels: rule.notification_channels,
      })
    } else {
      setForm({ ...EMPTY, project_id: projects[0]?.id ?? 0 })
    }
  }, [open, rule, projects])

  const set = <K extends keyof AlertRulePayload>(key: K, value: AlertRulePayload[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
    if (!form.name.trim()) {
      notify({ type: 'error', title: '请填写规则名称' })
      return
    }
    if (!form.project_id) {
      notify({ type: 'error', title: '请选择项目' })
      return
    }
    setSaving(true)
    try {
      if (rule) {
        await updateAlertRule(rule.id, form)
        notify({ type: 'success', title: '规则已更新' })
      } else {
        await createAlertRule(form)
        notify({ type: 'success', title: '规则已创建' })
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? '编辑告警规则' : '新建告警规则'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label>名称</Label>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如：US 销售额骤降" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>项目</Label>
              <Select value={String(form.project_id)} onValueChange={(v) => set('project_id', Number(v))}>
                <SelectTrigger><SelectValue placeholder="选择项目" /></SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>国家</Label>
              <Input value={form.country} onChange={(e) => set('country', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>指标</Label>
              <Select value={form.metric} onValueChange={(v) => set('metric', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {metrics.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>条件</Label>
              <Select value={form.condition} onValueChange={(v) => set('condition', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="drop_pct">下降超过 %</SelectItem>
                  <SelectItem value="rise_pct">上升超过 %</SelectItem>
                  <SelectItem value="below">低于基线 %</SelectItem>
                  <SelectItem value="above">高于基线 %</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label>阈值 (%)</Label>
              <Input type="number" value={form.threshold} onChange={(e) => set('threshold', Number(e.target.value))} />
            </div>
            <div className="grid gap-1.5">
              <Label>窗口 (天)</Label>
              <Input type="number" value={form.window_days} onChange={(e) => set('window_days', Number(e.target.value))} />
            </div>
            <div className="grid gap-1.5">
              <Label>级别</Label>
              <Select value={form.severity} onValueChange={(v) => set('severity', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">提示</SelectItem>
                  <SelectItem value="warning">警告</SelectItem>
                  <SelectItem value="critical">严重</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>通知通道</Label>
            <Select value={form.notification_channels} onValueChange={(v) => set('notification_channels', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="in_app">站内</SelectItem>
                <SelectItem value="email">邮件</SelectItem>
                <SelectItem value="both">站内 + 邮件</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 实现规则列表 Tab**

创建 `frontend/app/dashboard/system/alerts/components/alert-rules-tab.tsx`：

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useNotifications } from '@/components/notifications'
import {
  deleteAlertRule,
  fetchAlertRules,
  updateAlertRule,
  type AlertRuleItem,
} from '@/lib/alerts-api'
import { AlertRuleDialog } from './alert-rule-dialog'

interface ProjectOption {
  id: number
  name: string
}

export function AlertRulesTab({ projects }: { projects: ProjectOption[] }) {
  const { notify } = useNotifications()
  const [rules, setRules] = useState<AlertRuleItem[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AlertRuleItem | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRules(await fetchAlertRules())
    } catch (err) {
      notify({ type: 'error', title: '加载规则失败', message: String(err) })
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  const toggleActive = async (rule: AlertRuleItem) => {
    try {
      await updateAlertRule(rule.id, { is_active: !rule.is_active })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '切换失败', message: String(err) })
    }
  }

  const onDelete = async (rule: AlertRuleItem) => {
    if (!confirm(`确认删除规则「${rule.name}」？`)) return
    try {
      await deleteAlertRule(rule.id)
      notify({ type: 'success', title: '规则已删除' })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '删除失败', message: String(err) })
    }
  }

  const projectName = (id: number) => projects.find((p) => p.id === id)?.name ?? `#${id}`

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setEditing(null); setDialogOpen(true) }}>
          <Plus className="mr-1 h-4 w-4" /> 新建规则
        </Button>
      </div>

      <div className="dashboard-surface rounded-xl">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>项目</TableHead>
              <TableHead>指标</TableHead>
              <TableHead>条件</TableHead>
              <TableHead className="text-right">阈值</TableHead>
              <TableHead>级别</TableHead>
              <TableHead className="text-center">启用</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">加载中…</TableCell></TableRow>
            ) : rules.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">暂无规则，点击右上角新建</TableCell></TableRow>
            ) : (
              rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{projectName(r.project_id)}</TableCell>
                  <TableCell>{r.metric}</TableCell>
                  <TableCell>{r.condition}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.threshold}%</TableCell>
                  <TableCell>{r.severity}</TableCell>
                  <TableCell className="text-center">
                    <Switch checked={r.is_active} onCheckedChange={() => toggleActive(r)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => { setEditing(r); setDialogOpen(true) }}>编辑</Button>
                    <Button size="sm" variant="ghost" className="ml-1 text-red-600" onClick={() => onDelete(r)}>删除</Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AlertRuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editing}
        projects={projects}
        onSaved={load}
      />
    </div>
  )
}
```

- [ ] **Step 3: 类型检查**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd frontend
git add app/dashboard/system/alerts/components/alert-rule-dialog.tsx app/dashboard/system/alerts/components/alert-rules-tab.tsx
git commit -m "feat(告警): 新增告警规则列表 Tab 与规则编辑 Dialog"
```

---

### Task 6: 通知偏好 Tab

**Files:**
- Create: `frontend/app/dashboard/system/alerts/components/alert-preferences-tab.tsx`

**Interfaces:**
- Consumes: `fetchAlertPreferences` / `updateAlertPreferences` / `AlertPreference`（Task 2）
- Produces: `AlertPreferencesTab()` 组件

- [ ] **Step 1: 实现组件**

创建 `frontend/app/dashboard/system/alerts/components/alert-preferences-tab.tsx`：

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useNotifications } from '@/components/notifications'
import {
  fetchAlertPreferences,
  updateAlertPreferences,
  type AlertPreference,
} from '@/lib/alerts-api'

export function AlertPreferencesTab() {
  const { notify } = useNotifications()
  const [pref, setPref] = useState<AlertPreference | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void fetchAlertPreferences()
      .then(setPref)
      .catch((err) => notify({ type: 'error', title: '加载偏好失败', message: String(err) }))
  }, [notify])

  if (!pref) {
    return <div className="py-8 text-center text-muted-foreground">加载中…</div>
  }

  const save = async () => {
    setSaving(true)
    try {
      const updated = await updateAlertPreferences(pref)
      setPref(updated)
      notify({ type: 'success', title: '偏好已保存' })
    } catch (err) {
      notify({ type: 'error', title: '保存失败', message: String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-surface max-w-xl space-y-6 rounded-xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <Label>邮件通知</Label>
          <p className="text-xs text-muted-foreground">告警触发时发送邮件</p>
        </div>
        <Switch
          checked={pref.email_enabled}
          onCheckedChange={(v) => setPref({ ...pref, email_enabled: v })}
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label>站内通知</Label>
          <p className="text-xs text-muted-foreground">告警触发时写入通知中心（铃铛）</p>
        </div>
        <Switch
          checked={pref.in_app_enabled}
          onCheckedChange={(v) => setPref({ ...pref, in_app_enabled: v })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>最低告警级别</Label>
        <Select value={pref.min_severity} onValueChange={(v) => setPref({ ...pref, min_severity: v })}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="info">提示及以上</SelectItem>
            <SelectItem value="warning">警告及以上</SelectItem>
            <SelectItem value="critical">仅严重</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label>免打扰开始</Label>
          <Input
            type="time"
            value={pref.quiet_hours_start ?? ''}
            onChange={(e) => setPref({ ...pref, quiet_hours_start: e.target.value || null })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>免打扰结束</Label>
          <Input
            type="time"
            value={pref.quiet_hours_end ?? ''}
            onChange={(e) => setPref({ ...pref, quiet_hours_end: e.target.value || null })}
          />
        </div>
      </div>
      <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存偏好'}</Button>
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd frontend
git add app/dashboard/system/alerts/components/alert-preferences-tab.tsx
git commit -m "feat(告警): 新增告警通知偏好 Tab"
```

---

### Task 7: 页面壳 + Sidebar 入口

**Files:**
- Create: `frontend/app/dashboard/system/alerts/page.tsx`
- Modify: `frontend/lib/sidebar-config.ts`（系统管理组 items）

**Interfaces:**
- Consumes: `AlertStatsBar` / `AlertEventsTab` / `AlertRulesTab` / `AlertPreferencesTab`（Task 3-6）；`fetchAlertStats`（Task 2）；项目列表 `/api/backend/api/v1/projects/manage`
- Produces: 路由 `/dashboard/system/alerts`

- [ ] **Step 1: 实现页面壳**

创建 `frontend/app/dashboard/system/alerts/page.tsx`：

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchAlertStats, type AlertStats } from '@/lib/alerts-api'
import { AlertStatsBar } from './components/alert-stats-bar'
import { AlertEventsTab } from './components/alert-events-tab'
import { AlertRulesTab } from './components/alert-rules-tab'
import { AlertPreferencesTab } from './components/alert-preferences-tab'

interface ProjectOption {
  id: number
  name: string
}

export default function AlertCenterPage() {
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])

  useEffect(() => {
    void fetchAlertStats().then(setStats).catch(() => setStats(null))
    void fetch('/api/backend/api/v1/projects/manage')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Array<{ id: number; name: string }>) =>
        setProjects(Array.isArray(data) ? data.map((p) => ({ id: p.id, name: p.name })) : [])
      )
      .catch(() => setProjects([]))
  }, [])

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-semibold">告警中心</h1>
        <p className="text-sm text-muted-foreground">配置告警规则、跟踪异常事件、管理通知偏好</p>
      </div>

      <AlertStatsBar stats={stats} />

      <Tabs defaultValue="events">
        <TabsList>
          <TabsTrigger value="events">告警事件</TabsTrigger>
          <TabsTrigger value="rules">告警规则</TabsTrigger>
          <TabsTrigger value="preferences">通知偏好</TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="mt-4">
          <AlertEventsTab />
        </TabsContent>
        <TabsContent value="rules" className="mt-4">
          <AlertRulesTab projects={projects} />
        </TabsContent>
        <TabsContent value="preferences" className="mt-4">
          <AlertPreferencesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
```

- [ ] **Step 2: 加 Sidebar 入口**

编辑 `frontend/lib/sidebar-config.ts`，在系统管理组（`id: 'system'`）的 `items` 数组中，把告警中心插在"日志查看"之前。找到这一行：

```typescript
      { title: '日志查看', url: '/dashboard/system/logs', icon: IconMap.History },
```

在它**前面**插入：

```typescript
      { title: '告警中心', url: '/dashboard/system/alerts', icon: IconMap.Bell },
```

（`Bell` 已在文件顶部 import 列表中——若没有，加到 lucide-react 的 import 里。）

- [ ] **Step 3: 类型检查 + lint**

Run: `cd frontend && pnpm tsc --noEmit && pnpm lint`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd frontend
git add app/dashboard/system/alerts/page.tsx lib/sidebar-config.ts
git commit -m "feat(告警): 新增告警中心页面与 sidebar 入口"
```

---

### Task 8: 前端全量验证

**Files:** 无新增

- [ ] **Step 1: 跑前端完整测试链**

Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: lint 无错误；build 成功；test 全绿

- [ ] **Step 2: 跑后端测试**

Run: `cd backend && pytest tests/tasks/test_alert_detection.py -v`
Expected: 3 passed

- [ ] **Step 3: 若有失败，修复后重跑，全过再提交修复**

```bash
git add -A && git commit -m "fix(告警): 修复告警中心验证发现的问题"
```

（若无需修复则跳过此步。）
