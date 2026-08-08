/**
 * P7 任务枚举常量（中文标签 + 配色，仿 value-score / follow.enum 模式，设计 §8.5）。
 */
import type { TaskPriority, TaskStatus, TaskType } from '@/lib/crm/types/task'

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  done: '已完成',
  cancelled: '已取消',
}

export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  in_progress: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  cancelled: 'bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-300',
}

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
}

/** 优先级色条（卡片左侧竖条，实色）。 */
export const TASK_PRIORITY_BAR: Record<TaskPriority, string> = {
  low: 'bg-slate-400',
  medium: 'bg-sky-500',
  high: 'bg-amber-500',
  urgent: 'bg-rose-500',
}

export const TASK_PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300',
  medium: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  high: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  urgent: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
}

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  follow_up: '跟进',
  call: '电话',
  visit: '拜访',
  custom: '自定义',
}

export const TASK_TYPE_COLORS: Record<TaskType, string> = {
  follow_up: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  call: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  visit: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  custom: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300',
}

/** 看板三列（cancelled 不入看板，设计 §8.2）。 */
export const TASK_BOARD_COLUMNS: TaskStatus[] = ['pending', 'in_progress', 'done']
