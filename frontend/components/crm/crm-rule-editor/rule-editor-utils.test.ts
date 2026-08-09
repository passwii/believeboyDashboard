import { describe, expect, it } from 'vitest'
import { parseRuleToForm, toRuleInput, describeRule, DEFAULT_FORM_VALUES } from './rule-editor-utils'
import type { Rule } from '@/lib/crm/types'

const seedRule: Rule = {
  id: 1,
  name: '客户 7 天无跟进提醒',
  description: '客户创建超过 7 天且从未跟进 → 提醒负责人',
  entityType: 'customer',
  eventType: 'stale_follow_up',
  enabled: true,
  priority: 0,
  conditions: [
    { id: 10, field: 'days_since_created', operator: 'gte', value: '7', sortOrder: 0 },
    { id: 11, field: 'last_follow_at', operator: 'is_null', value: null, sortOrder: 1 },
  ],
  actions: [{ id: 20, actionType: 'notify_owner', params: null, sortOrder: 0 }],
  createdAt: '2026-08-08T00:00:00+00:00',
  updatedAt: '2026-08-08T00:00:00+00:00',
}

describe('parseRuleToForm（Rule → 表单，P9-7 BLF-545）', () => {
  it('MVP 种子规则解析为表单值且 unsupported=false', () => {
    const { values, unsupported } = parseRuleToForm(seedRule)
    expect(unsupported).toBe(false)
    expect(values).toEqual({
      name: '客户 7 天无跟进提醒',
      description: '客户创建超过 7 天且从未跟进 → 提醒负责人',
      entityType: 'customer',
      days: 7,
      onlyNeverFollowed: true,
      enabled: true,
    })
  })

  it('无条件 days_since_created 时回退默认天数', () => {
    const { values, unsupported } = parseRuleToForm({
      ...seedRule,
      conditions: [{ id: 11, field: 'last_follow_at', operator: 'is_null', value: null, sortOrder: 0 }],
    })
    expect(unsupported).toBe(false)
    expect(values.days).toBe(DEFAULT_FORM_VALUES.days)
    expect(values.onlyNeverFollowed).toBe(true)
  })

  it('MVP 之外的 condition/action 标记 unsupported（禁编辑）', () => {
    const { unsupported } = parseRuleToForm({
      ...seedRule,
      conditions: [
        { id: 10, field: 'days_since_created', operator: 'lt', value: '7', sortOrder: 0 },
      ],
    })
    expect(unsupported).toBe(true)

    const noAction = parseRuleToForm({ ...seedRule, actions: [] })
    expect(noAction.unsupported).toBe(true)

    const otherAction = parseRuleToForm({
      ...seedRule,
      actions: [{ id: 99, actionType: 'notify_owner', params: null, sortOrder: 0 }],
    })
    expect(otherAction.unsupported).toBe(false)
  })

  it('非法天数（非数字/负数）标记 unsupported', () => {
    expect(parseRuleToForm({ ...seedRule, conditions: [{ field: 'days_since_created', operator: 'gte', value: 'abc', sortOrder: 0 }] }).unsupported).toBe(true)
    expect(parseRuleToForm({ ...seedRule, conditions: [{ field: 'days_since_created', operator: 'gte', value: '-1', sortOrder: 0 }] }).unsupported).toBe(true)
  })
})

describe('toRuleInput（表单 → RuleInput）', () => {
  it('默认生成 MVP 结构：days_since_created gte + last_follow_at is_null + notify_owner', () => {
    const input = toRuleInput({
      name: '客户 7 天无跟进提醒',
      description: '描述',
      entityType: 'customer',
      days: 7,
      onlyNeverFollowed: true,
      enabled: true,
    })
    expect(input).toEqual({
      name: '客户 7 天无跟进提醒',
      description: '描述',
      entityType: 'customer',
      eventType: 'stale_follow_up',
      enabled: true,
      priority: 0,
      conditions: [
        { field: 'days_since_created', operator: 'gte', value: '7', sortOrder: 0 },
        { field: 'last_follow_at', operator: 'is_null', value: null, sortOrder: 1 },
      ],
      actions: [{ actionType: 'notify_owner', params: null, sortOrder: 0 }],
    })
  })

  it('取消「从未跟进」只保留天数条件；空描述剔除', () => {
    const input = toRuleInput({
      name: '仅天数',
      description: '  ',
      entityType: 'lead',
      days: 10,
      onlyNeverFollowed: false,
      enabled: false,
    })
    expect(input.description).toBeUndefined()
    expect(input.conditions).toEqual([
      { field: 'days_since_created', operator: 'gte', value: '10', sortOrder: 0 },
    ])
    expect(input.entityType).toBe('lead')
    expect(input.enabled).toBe(false)
  })
})

describe('describeRule（列表摘要）', () => {
  it('客户种子规则句子', () => {
    expect(describeRule(seedRule)).toBe('当客户创建超过 7 天 且 从未跟进 → 提醒负责人')
  })
  it('线索 + 无从未跟进条件', () => {
    expect(
      describeRule({
        entityType: 'lead',
        conditions: [{ field: 'days_since_created', operator: 'gte', value: '14', sortOrder: 0 }],
      })
    ).toBe('当线索创建超过 14 天 → 提醒负责人')
  })
})
