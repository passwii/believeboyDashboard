/**
 * P9 规则引擎规则（BLF-543 schema / BLF-545 编辑器）。
 *
 * 后端 `crm_rules` + `crm_rule_conditions` + `crm_rule_actions`（1:N）：
 * - rule：作用实体（customer/lead）+ 触发事件（event_type）+ 启停/优先级。
 * - condition：AND 语义，按 sort_order 求值；MVP「客户创建 7 天内无跟进」
 *   = `days_since_created gte N` + `last_follow_at is_null`。
 * - action：按 sort_order 顺序执行；MVP 仅 `notify_owner`（写 active 提醒，
 *   复用 P9-1 SSE 链路）。
 *
 * 前端约定：rule.id 为 int（后端自增主键）；conditions/actions 的子表 id
 * 仅编辑回填用，创建时省略。
 */
export type RuleEntityType = 'customer' | 'lead'
export type RuleEventType = 'stale_follow_up'
export type RuleConditionOperator =
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'eq'
  | 'ne'
  | 'is_null'
  | 'is_not_null'
export type RuleActionType = 'notify_owner'

export interface RuleCondition {
  /** 子表主键（后端回填；新建省略） */
  id?: number
  /** 白名单字段：days_since_created / days_since_last_follow / last_follow_at / status / rating */
  field: string
  operator: RuleConditionOperator
  /** is_null/is_not_null 时为空 */
  value: string | null
  sortOrder: number
}

export interface RuleAction {
  /** 子表主键（后端回填；新建省略） */
  id?: number
  actionType: RuleActionType
  params: Record<string, unknown> | null
  sortOrder: number
}

export interface Rule {
  id: number
  name: string
  description?: string
  entityType: RuleEntityType
  eventType: RuleEventType
  enabled: boolean
  priority: number
  conditions: RuleCondition[]
  actions: RuleAction[]
  createdBy?: string
  createdAt: string
  updatedAt: string
}

/** 规则创建/更新入参（conditions/actions 整体替换；后端原子重建子表）。 */
export type RuleInput = Omit<
  Rule,
  'id' | 'createdBy' | 'createdAt' | 'updatedAt' | 'priority'
> & {
  description?: string
  priority?: number
}
