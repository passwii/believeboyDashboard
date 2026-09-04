import type { Rule } from '@/lib/crm/types'

/**
 * 规则引擎 mock 种子（P9，BLF-545）。
 *
 * 对齐后端迁移 250（BLF-544）的 MVP 种子规则：
 * 「客户创建超过 7 天且从未跟进 → 提醒负责人」
 * = entity_type=customer + event_type=stale_follow_up
 *   + conditions: days_since_created gte 7 / last_follow_at is_null
 *   + action: notify_owner
 */
export const RULES_FIXTURE: Rule[] = [
  {
    id: 1,
    name: '客户 7 天无跟进提醒',
    description: '客户创建超过 7 天且从未跟进 → 提醒负责人（MVP 种子规则）',
    entityType: 'customer',
    eventType: 'stale_follow_up',
    enabled: true,
    priority: 0,
    conditions: [
      { id: 10, field: 'days_since_created', operator: 'gte', value: '7', sortOrder: 0 },
      { id: 11, field: 'last_follow_at', operator: 'is_null', value: null, sortOrder: 1 },
    ],
    actions: [{ id: 20, actionType: 'notify_owner', params: null, sortOrder: 0 }],
    createdBy: 'u-admin',
    createdAt: '2026-08-08T00:00:00+00:00',
    updatedAt: '2026-08-08T00:00:00+00:00',
  },
  {
    id: 2,
    name: '线索 7 天无跟进提醒',
    description: '线索创建超过 7 天且从未跟进 → 提醒负责人',
    entityType: 'lead',
    eventType: 'stale_follow_up',
    enabled: false,
    priority: 0,
    conditions: [
      { id: 12, field: 'days_since_created', operator: 'gte', value: '7', sortOrder: 0 },
      { id: 13, field: 'last_follow_at', operator: 'is_null', value: null, sortOrder: 1 },
    ],
    actions: [{ id: 21, actionType: 'notify_owner', params: null, sortOrder: 0 }],
    createdBy: 'u-admin',
    createdAt: '2026-08-08T01:00:00+00:00',
    updatedAt: '2026-08-08T01:00:00+00:00',
  },
]
