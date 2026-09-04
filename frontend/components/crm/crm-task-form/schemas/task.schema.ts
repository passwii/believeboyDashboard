import { z } from 'zod'
import type { TaskPriority, TaskType } from '@/lib/crm/types/task'

const TYPES: [TaskType, ...TaskType[]] = ['follow_up', 'call', 'visit', 'custom']
const PRIORITIES: [TaskPriority, ...TaskPriority[]] = ['low', 'medium', 'high', 'urgent']

/**
 * 任务新建/编辑表单 schema（zod）。
 * 标题必填（设计 §8.4）；类型/优先级默认值；截止可选；描述可选。
 */
export const taskSchema = z.object({
  title: z.string().min(1, '标题必填').max(200),
  type: z.enum(TYPES, { message: '请选择类型' }),
  priority: z.enum(PRIORITIES, { message: '请选择优先级' }),
  dueDate: z.string().optional().or(z.literal('')),
  description: z.string().max(500).optional().or(z.literal('')),
  ownerId: z.string().optional().or(z.null()).or(z.literal('')),
})

export type TaskFormValues = z.infer<typeof taskSchema>
