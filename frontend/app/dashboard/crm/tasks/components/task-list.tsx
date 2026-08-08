'use client'

import { Inbox } from 'lucide-react'
import type { Task } from '@/lib/crm/types'
import {
  TASK_PRIORITY_COLORS,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_COLORS,
  TASK_STATUS_LABELS,
  TASK_TYPE_COLORS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatDueDate } from '../task-utils'

/**
 * 简易列表骨架（BLF-512，与 BLF-514 列表完整化衔接）：
 * 全部状态可见（含 cancelled）；表头筛选/排序/行操作为 BLF-514 范围。
 */
export function TaskList({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-muted-foreground">
        <Inbox className="h-10 w-10" />
        <p className="text-sm">暂无任务</p>
      </div>
    )
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60 bg-card">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-border/60 text-xs text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">标题</th>
            <th className="px-4 py-2.5 font-medium">类型</th>
            <th className="px-4 py-2.5 font-medium">优先级</th>
            <th className="px-4 py-2.5 font-medium">状态</th>
            <th className="px-4 py-2.5 font-medium">截止</th>
            <th className="px-4 py-2.5 font-medium">关联</th>
            <th className="px-4 py-2.5 font-medium">负责人</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {tasks.map((task) => {
            const linked = task.customerName ?? task.leadName
            const linkedKind = task.customerName ? '客户' : task.leadName ? '线索' : undefined
            return (
              <tr key={task.id} data-testid={`task-row-${task.id}`} className="hover:bg-muted/40">
                <td className="max-w-[280px] truncate px-4 py-2.5 font-medium text-foreground">
                  {task.title}
                </td>
                <td className="px-4 py-2.5">
                  <Badge
                    variant="outline"
                    className={cn('px-1.5 py-0 text-[11px]', TASK_TYPE_COLORS[task.type])}
                  >
                    {TASK_TYPE_LABELS[task.type]}
                  </Badge>
                </td>
                <td className="px-4 py-2.5">
                  <Badge
                    variant="secondary"
                    className={cn('px-1.5 py-0 text-[11px]', TASK_PRIORITY_COLORS[task.priority])}
                  >
                    {TASK_PRIORITY_LABELS[task.priority]}
                  </Badge>
                </td>
                <td className="px-4 py-2.5">
                  <Badge
                    variant="secondary"
                    className={cn('px-1.5 py-0 text-[11px]', TASK_STATUS_COLORS[task.status])}
                  >
                    {TASK_STATUS_LABELS[task.status]}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {task.dueDate ? formatDueDate(task.dueDate) || '—' : '—'}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {linked ? `${linkedKind} · ${linked}` : '—'}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{task.ownerName ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
