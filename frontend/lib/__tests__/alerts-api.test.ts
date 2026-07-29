import { describe, it, expect } from 'vitest'
import {
  buildEventsQuery,
  type AlertEventsParams,
} from '../alerts-api'

describe('buildEventsQuery', () => {
  it('拼出全部筛选参数', () => {
    const params: AlertEventsParams = {
      status: 'active',
      severity: 'critical',
      project_id: 3,
      page: 2,
      page_size: 10,
    }
    const qs = buildEventsQuery(params)
    expect(qs).toContain('status=active')
    expect(qs).toContain('severity=critical')
    expect(qs).toContain('project_id=3')
    expect(qs).toContain('page=2')
    expect(qs).toContain('page_size=10')
  })

  it('忽略 undefined 参数', () => {
    const qs = buildEventsQuery({ page: 1, page_size: 20 })
    expect(qs).not.toContain('status')
    expect(qs).not.toContain('severity')
    expect(qs).toContain('page=1')
  })
})
