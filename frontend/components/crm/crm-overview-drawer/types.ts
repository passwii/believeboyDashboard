import type { FieldDefinition } from '@/lib/crm/types/field'
import type { Follow, FollowInput, FollowEntityType } from '@/lib/crm/types/follow'
import type { User } from '@/lib/crm/types/user'

export interface CrmOverviewDrawerProps<T extends object> {
  open: boolean
  onOpenChange: (open: boolean) => void
  entityType: FollowEntityType
  entityId: string
  /** 实体数据（行点击时已拿到，避免再拉一次；编辑后由父级刷新传入） */
  data: T
  /** 字段清单（客户/线索/商机各自 FIELD_DEFS） */
  fields: FieldDefinition[]
  /** 标题（如客户名） */
  title: string
  headerExtra?: React.ReactNode
  users: User[]
  /** 加载跟进记录 */
  loadFollows: (entityType: FollowEntityType, entityId: string) => Promise<Follow[]>
  /** 提交跟进 */
  createFollow: (input: FollowInput) => Promise<Follow>
  /** 提交编辑（form 模式） */
  onSave: (input: Record<string, unknown>) => void | Promise<void>
}
