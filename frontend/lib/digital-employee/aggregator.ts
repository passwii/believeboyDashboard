/**
 * 聚合器 — 把 task 列表按 (project_name × report_type) 分桶。
 * 纯函数，无副作用，便于单测。
 */

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
  project_name?: string
  report_label?: string
  country?: string
  row_count?: number
  detected_date_range?: string
}

const STATUS_PRIORITY: Record<string, number> = {
  FAILED: 4,
  RUNNING: 3,
  PENDING: 2,
  CANCELLED: 1,
  SUCCEEDED: 0,
}

const LARGE_BUCKET_THRESHOLD = 20

export function aggregateTasks(tasks: RawTask[]): RhythmBucket[] {
  if (tasks.length === 0) return []

  // 1) 按 (project_name, report_type) 分桶
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

  // 2) 粒度自适应：把所有桶按 reportType 分组，每组内如果桶数 > 1 且每桶都 > LARGE_BUCKET_THRESHOLD
  //    → 把同 reportType 的桶合并为一个"多项目"桶
  //    简化版：只要单桶任务数 > LARGE_BUCKET_THRESHOLD 且同 reportType 存在多个 project 桶 → 合并
  const byType = new Map<string, Array<{ key: string; entry: { tasks: RawTask[]; meta: TaskMeta } }>>()
  for (const [key, entry] of bucketMap) {
    const reportType = entry.tasks[0].task_type
    if (!byType.has(reportType)) byType.set(reportType, [])
    byType.get(reportType)!.push({ key, entry })
  }

  for (const [, group] of byType) {
    if (group.length < 2) continue  // 单 project 桶不合并
    const allLarge = group.every((g) => g.entry.tasks.length > LARGE_BUCKET_THRESHOLD)
    if (!allLarge) continue
    // 合并所有桶
    const allTasks = group.flatMap((g) => g.entry.tasks)
    const firstReportLabel = group[0].entry.meta.report_label || group[0].entry.tasks[0].task_type
    const mergedKey = `__multiproject__::${firstReportLabel}`
    bucketMap.set(mergedKey, {
      tasks: allTasks,
      meta: { project_name: '多项目', report_label: firstReportLabel },
    })
    for (const g of group) bucketMap.delete(g.key)
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
    const successRate = total > 0 ? succeeded / total : 0
    let finalStatus: RhythmBucket['status']
    if (successRate >= 0.8) {
      finalStatus = 'SUCCEEDED'
    } else {
      // 取最高优先级
      const sorted = Object.entries(statusCounts).sort(
        ([a, ac], [b, bc]) =>
          (STATUS_PRIORITY[b] ?? 0) - (STATUS_PRIORITY[a] ?? 0) || bc - ac,
      )
      finalStatus = (sorted[0]?.[0] ?? 'PENDING') as RhythmBucket['status']
    }

    const rowCountTotal = ts.reduce(
      (s, t) => s + ((t.metadata_json?.row_count as number | undefined) ?? 0),
      0,
    )
    const dates = ts
      .map((t) => t.metadata_json?.detected_date_range)
      .filter(Boolean) as string[]
    const dateRange = mergeDateRanges(dates)

    const startedAtList = ts.map((t) => t.started_at).filter(Boolean) as string[]
    const endedAtList = ts.map((t) => t.ended_at).filter(Boolean) as string[]
    const firstStarted = startedAtList.length > 0 ? startedAtList.reduce((m, s) => (s < m ? s : m)) : null
    const lastEnded = endedAtList.length > 0 ? endedAtList.reduce((m, s) => (s > m ? s : m)) : null

    buckets.push({
      id: key,
      projectName: meta.project_name || '_global',
      reportType: ts[0].task_type,
      reportLabel: meta.report_label || ts[0].task_type,
      status: finalStatus,
      eventCount: total,
      rowCountTotal,
      firstOccurredAt: new Date(firstStarted || Date.now()),
      lastOccurredAt: new Date(lastEnded || Date.now()),
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
