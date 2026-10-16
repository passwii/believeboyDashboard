/**
 * CRM 操作审计日志类型（P4）。
 *
 * 后端 GET /crm/audit-logs 返回 snake_case；前端 camelCase + string 主键。
 * action 取值与后端 audit_service 约定一致。
 */

/** 审计动作（与后端 action 约定一致）。 */
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'transfer'
  | 'move_sea'
  | 'claim'
  | 'convert'
  | 'complete'
  | 'cancel'
  | 'status'

/** 一条审计日志（前端视角）。 */
export interface AuditLog {
  id: string
  entityType: 'customer' | 'lead' | 'contact' | 'task' | 'proposal'
  entityId: string
  action: AuditAction
  actorId: string | null
  actorName: string | null
  summary: string | null
  createdAt: string
}

/** 审计日志查询参数。 */
export interface AuditLogQuery {
  entityType?: string
  entityId?: string
  /** P5-9: 多值过滤（客户抽屉同时查 customer + 该客户下所有 contact）。 */
  entityTypes?: string[]
  entityIds?: number[]
  actorId?: string
  action?: string
  page?: number
  pageSize?: number
}

/** 动作 → 中文标签（展示用）。 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  create: '新建',
  update: '编辑',
  delete: '删除',
  transfer: '指派负责人',
  move_sea: '释放公海',
  claim: '领取',
  convert: '转化',
  complete: '完成',
  cancel: '取消',
  status: '状态变更',
}
