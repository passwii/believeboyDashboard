import { describe, it, expect } from 'vitest'
import { buildNotificationsQuery, type NotificationQuery } from '../notifications-api'

describe('buildNotificationsQuery', () => {
  it('拼出 type/read/分页', () => {
    const q: NotificationQuery = { type: 'alert', read: false, page: 2, page_size: 10 }
    const qs = buildNotificationsQuery(q)
    expect(qs).toContain('type=alert')
    expect(qs).toContain('read=false')
    expect(qs).toContain('page=2')
    expect(qs).toContain('page_size=10')
  })

  it('省略 undefined 字段', () => {
    const qs = buildNotificationsQuery({ page: 1, page_size: 20 })
    expect(qs).not.toContain('type')
    expect(qs).not.toContain('read')
  })
})
