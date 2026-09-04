/**
 * 规则编辑器 表单 ↔ Rule 映射（P9，BLF-545）。
 *
 * MVP 仅支持「当【客户/线索】创建超过 N 天 且 从未跟进 → 提醒负责人」，
 * 映射到后端 rule/condition/action 结构：
 * - entity_type + event_type=stale_follow_up
 * - conditions: days_since_created gte N [+ last_follow_at is_null]
 * - actions: notify_owner
 *
 * 编辑兼容性：规则含 MVP 之外的 condition/action 时 parseRuleToForm 返回
 * unsupported=true，编辑器提示只读、禁保存（避免静默改坏规则）。
 */
import type { Rule, RuleInput } from '@/lib/crm/types'

export interface RuleFormValues {
  name: string
  description: string
  entityType: 'customer' | 'lead'
  /** days_since_created gte N */
  days: number
  /** last_follow_at is_null（从未跟进） */
  onlyNeverFollowed: boolean
  enabled: boolean
}

export const DEFAULT_FORM_VALUES: RuleFormValues = {
  name: '',
  description: '',
  entityType: 'customer',
  days: 7,
  onlyNeverFollowed: true,
  enabled: true,
}

export const ENTITY_LABELS: Record<RuleFormValues['entityType'], string> = {
  customer: '客户',
  lead: '线索',
}

/** Rule → 编辑器表单值（含 unsupported 标记，MVP 之外的组合不可编辑）。 */
export function parseRuleToForm(rule: Rule): { values: RuleFormValues; unsupported: boolean } {
  const daysCond = rule.conditions.find((c) => c.field === 'days_since_created')
  const neverCond = rule.conditions.find((c) => c.field === 'last_follow_at')
  const supported = rule.conditions.every(
    (c) =>
      (c.field === 'days_since_created' && c.operator === 'gte') ||
      (c.field === 'last_follow_at' && c.operator === 'is_null')
  )
  const actionsSupported =
    rule.actions.length > 0 && rule.actions.every((a) => a.actionType === 'notify_owner')

  const values: RuleFormValues = {
    name: rule.name,
    description: rule.description ?? '',
    entityType: rule.entityType,
    days: daysCond?.value != null ? Number(daysCond.value) : 7,
    onlyNeverFollowed: neverCond != null,
    enabled: rule.enabled,
  }
  const unsupported = !supported || !actionsSupported || Number.isNaN(values.days) || values.days < 0
  return { values, unsupported }
}

/** 表单值 → RuleInput（conditions/actions 按 MVP 结构生成）。 */
export function toRuleInput(values: RuleFormValues): RuleInput {
  const conditions: RuleInput['conditions'] = [
    { field: 'days_since_created', operator: 'gte', value: String(values.days), sortOrder: 0 },
  ]
  if (values.onlyNeverFollowed) {
    conditions.push({ field: 'last_follow_at', operator: 'is_null', value: null, sortOrder: 1 })
  }
  return {
    name: values.name.trim(),
    description: values.description.trim() || undefined,
    entityType: values.entityType,
    eventType: 'stale_follow_up',
    enabled: values.enabled,
    priority: 0,
    conditions,
    actions: [{ actionType: 'notify_owner', params: null, sortOrder: 0 }],
  }
}

/** 生成可读规则摘要（列表展示用）。 */
export function describeRule(rule: Pick<Rule, 'entityType' | 'conditions'>): string {
  const daysCond = rule.conditions.find((c) => c.field === 'days_since_created')
  const neverCond = rule.conditions.find((c) => c.field === 'last_follow_at')
  const entity = ENTITY_LABELS[rule.entityType] ?? rule.entityType
  const parts: string[] = []
  if (daysCond?.value != null) {
    parts.push(`${entity}创建超过 ${daysCond.value} 天`)
  }
  if (neverCond?.operator === 'is_null') {
    parts.push('从未跟进')
  }
  const when = parts.length > 0 ? parts.join(' 且 ') : `${entity}符合条件`
  return `当${when} → 提醒负责人`
}
