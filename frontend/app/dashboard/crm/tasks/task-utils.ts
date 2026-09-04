/**
 * 任务截止时间展示工具（逾期红 / 今日黄，设计 §8.2）。
 */

export type DueState = 'overdue' | 'today' | 'future' | 'none'

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function dueDateState(due?: string): DueState {
  if (!due) return 'none'
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return 'none'
  const today = startOfDay(new Date())
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (d < today) return 'overdue'
  if (d < tomorrow) return 'today'
  return 'future'
}

export function formatDueDate(due?: string): string {
  const state = dueDateState(due)
  if (state === 'none' || !due) return ''
  const d = new Date(due)
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  if (state === 'overdue') {
    const days = Math.round(
      (startOfDay(new Date()).getTime() - startOfDay(d).getTime()) / 86400000
    )
    return days > 0 ? `逾期 ${days} 天` : '已逾期'
  }
  if (state === 'today') return `今天 ${md}`
  return md
}
