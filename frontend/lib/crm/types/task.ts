/**
 * P7 任务（BLF-512/514）。
 *
 * 后端 `crm_tasks`（BLF-510）：id int 主键；owner_id/created_by 为 UUID 字符串；
 * customer_id/lead_id 为 int FK（软删不触发）。
 * 前端约定：id/customerId/leadId 均转 string；可空字段 null → undefined。
 */
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskType = 'follow_up' | 'call' | 'visit' | 'custom'

export interface Task {
  id: string
  title: string
  description?: string
  dueDate?: string
  priority: TaskPriority
  status: TaskStatus
  type: TaskType
  ownerId: string | null
  ownerName?: string
  customerId?: string
  customerName?: string
  leadId?: string
  leadName?: string
  remindedAt?: string
  createdBy?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

/** 任务列表查询参数（与后端 list_tasks 白名单筛选对齐，设计 §8.2/§8.3）。 */
export interface TaskListParams {
  scope?: 'mine' | 'all'
  type?: TaskType
  status?: TaskStatus
  priority?: TaskPriority
  ownerId?: string
  customerId?: string
  leadId?: string
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}
