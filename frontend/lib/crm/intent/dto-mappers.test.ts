import { describe, expect, it } from 'vitest'

import {
  mapIntentBatchDetail,
  mapIntentBatchPage,
  mapIntentBoard,
  mapIntentCompany,
  mapIntentCompanyDetail,
  mapIntentCompanyPage,
  mapIntentConvertResult,
  mapIntentFollowupResponse,
  mapIntentImportResult,
  mapIntentMeta,
  mapIntentPoolPage,
} from './dto-mappers'

describe('mapIntentCompany', () => {
  it('把 snake_case DTO 映射为领域模型并兜底缺省字段', () => {
    const company = mapIntentCompany({
      id: 42,
      batch_id: 7,
      name: '宁波岚川家居用品有限公司',
      credit_code: '910000000000000001',
      legal_person: '张三',
      province: '浙江',
      city: '宁波',
      founded_year: 2012,
      registered_capital_wan: '300.00',
      products: '懒人沙发、收纳箱',
      category: '家居用品',
      trademarks: ['示例商标'],
      trademark_count: 2,
      intent_level: 'A',
      intent_score: 86,
      intent_basis: '主营产品为轻小件',
      sources: ['https://example.com/demo'],
      screened_at: '2026-11-09',
      phones: [{ id: 1, phone_raw: '13800000001', phone_normalized: '13800000001', source: 'list', is_valid: true }],
      followup: { state: 'quoted', state_label: '已报价', version: 3, note: '已发报价' },
      owner: { id: 'u-1', name: '张三' },
      human_touched: true,
      converted_customer_id: 9,
    })

    expect(company.id).toBe(42)
    expect(company.registeredCapitalWan).toBe(300)
    expect(company.intentLevel).toBe('A')
    expect(company.phones[0]?.isValid).toBe(true)
    expect(company.followup.state).toBe('quoted')
    expect(company.followup.version).toBe(3)
    expect(company.owner).toEqual({ id: 'u-1', name: '张三' })
    expect(company.humanTouched).toBe(true)
    expect(company.convertedCustomerId).toBe(9)
  })

  it('未知级别归一 D、缺 followup/phones 时给安全默认值', () => {
    const company = mapIntentCompany({ id: 2, name: '某某公司', intent_level: 'Z' })
    expect(company.intentLevel).toBe('D')
    expect(company.phones).toEqual([])
    expect(company.followup.state).toBe('none')
    expect(company.followup.version).toBe(0)
    expect(company.trademarkCount).toBe(0)
  })

  it('单渠道字段回退为 channels 数组，batch 对象可提供 batch_date', () => {
    const company = mapIntentCompany({
      id: 3,
      name: '渠道企业',
      channel: '展会',
      batch: { id: 8, batch_date: '2026-11-10' },
    })
    expect(company.channels).toEqual(['展会'])
    expect(company.batchDate).toBe('2026-11-10')
    expect(company.batchId).toBe(8)
  })
})

describe('mapIntentCompanyDetail', () => {
  it('映射 shared_phones 共用组（公司 + 池）', () => {
    const detail = mapIntentCompanyDetail({
      id: 1,
      name: '共用企业',
      shared_phones: [
        {
          phone_normalized: '13800000001',
          raw: '13800000001',
          companies: [{ id: 42, name: '另一家', intent_level: 'B' }],
          pool: [{ id: 9, name: '池企业', status: 'pending' }],
        },
      ],
    })
    expect(detail.sharedPhones).toHaveLength(1)
    expect(detail.sharedPhones[0].companies[0]).toMatchObject({ id: 42, intentLevel: 'B' })
    expect(detail.sharedPhones[0].pool[0]).toMatchObject({ id: 9, status: 'pending' })
  })
})

describe('mapIntentCompanyPage', () => {
  it('映射分页响应；数组响应也兼容', () => {
    const page = mapIntentCompanyPage({ items: [{ id: 1, name: 'A' }], total: 1, page: 1, page_size: 50 })
    expect(page.total).toBe(1)
    expect(page.pageSize).toBe(50)
    expect(page.items[0]?.name).toBe('A')

    const arrayPage = mapIntentCompanyPage([{ id: 2, name: 'B' }])
    expect(arrayPage.items).toHaveLength(1)
  })
})

describe('mapIntentMeta', () => {
  it('映射批次 / 统计 / facets / rev，并按服务端口径给 by_level', () => {
    const meta = mapIntentMeta({
      batch: { id: 7, batch_date: '2026-11-10', updated_at: '2026-11-10T10:00:00+08:00', total: 128, pool_total: 80 },
      stats: { total: 128, by_level: { A: 10, B: 30, C: 50, D: 38 }, with_phone: 120, contacted: 8, followed_up: 12, pool_total: 80, dup_groups: 3, due_count: 2 },
      facets: { levels: ['A', 'B', 'C', 'D'], categories: ['家居用品'], channels: [], provinces: ['浙江'], cities: [{ province: '浙江', cities: ['宁波'] }], states: ['none', { value: 'won', label: '已成交' }] },
      data_rev: 31,
      followup_rev: 12,
      changed: true,
      server_time: '2026-11-10T10:00:00+08:00',
    })

    expect(meta.batch?.batchDate).toBe('2026-11-10')
    expect(meta.stats.total).toBe(128)
    expect(meta.stats.byLevel).toEqual({ A: 10, B: 30, C: 50, D: 38 })
    expect(meta.facets.cities[0]).toEqual({ province: '浙江', cities: ['宁波'] })
    expect(meta.facets.states.find((state) => state.value === 'won')?.label).toBe('已成交')
    expect(meta.dataRev).toBe(31)
    expect(meta.followupRev).toBe(12)
    expect(meta.changed).toBe(true)
  })

  it('changed=false 与空批次可透传，facets/states 缺失回退 8 态', () => {
    const meta = mapIntentMeta({ changed: false, data_rev: 3, followup_rev: 1 })
    expect(meta.changed).toBe(false)
    expect(meta.batch).toBeNull()
    expect(meta.facets.states).toHaveLength(8)
    expect(meta.stats.total).toBe(0)
  })
})

describe('mapIntentPoolPage', () => {
  it('映射待筛池条目与号码、渠道兜底', () => {
    const page = mapIntentPoolPage({
      items: [
        { id: 1, name: '池企业', legal_person: '李四', website: 'https://example.com', channel: '展会', status: 'screened', phones: [{ phone_raw: '13900000001', phone_normalized: '13900000001' }] },
      ],
      total: 1,
      page: 1,
      page_size: 60,
    })
    expect(page.items[0]).toMatchObject({ name: '池企业', status: 'screened', channels: ['展会'] })
    expect(page.items[0]?.phones[0]?.normalized).toBe('13900000001')
    expect(page.pageSize).toBe(60)
  })
})

describe('mapIntentBoard', () => {
  it('解析 BE {columns} 形状：item 只映射 next_contact_at/owner（无 phone）', () => {
    const board = mapIntentBoard({
      columns: [
        {
          state: 'won',
          state_label: '已成交',
          count: 2,
          items: [
            {
              id: 1,
              name: 'A 企业',
              intent_level: 'A',
              intent_level_label: '强意向',
              intent_score: 86,
              next_contact_at: '2026-11-12T10:00:00+08:00',
              owner: { id: 'u-1', name: '张三' },
              updated_at: '2026-11-10T10:00:00+08:00',
            },
          ],
        },
        { state: 'none', state_label: '未联系', count: 5, items: [] },
      ],
    })

    expect(board.groups.map((group) => group.state)).toEqual(['none', 'won'])
    expect(board.total).toBe(7)
    const item = board.groups[1]?.items[0]
    expect(item).toMatchObject({
      name: 'A 企业',
      intentLevel: 'A',
      intentLevelLabel: '强意向',
      intentScore: 86,
      nextContactAt: '2026-11-12T10:00:00+08:00',
    })
    expect(item?.owner).toEqual({ id: 'u-1', name: '张三' })
    expect(item).not.toHaveProperty('phone')
  })

  it('兼容按状态分组的对象形状', () => {
    const fromObject = mapIntentBoard({
      none: { count: 3, items: [{ id: 2, name: 'B', next_contact_at: null }] },
    })
    expect(fromObject.groups).toHaveLength(1)
    expect(fromObject.groups[0]?.items[0]?.name).toBe('B')
    expect(fromObject.total).toBe(3)
  })
})

describe('mapIntentFollowupResponse', () => {
  it('兼容平铺响应与 {followup:{…}} 嵌套响应', () => {
    const flat = mapIntentFollowupResponse({ state: 'contacted', state_label: '已联系', version: 4, note: '备注' })
    expect(flat.state).toBe('contacted')
    expect(flat.version).toBe(4)

    const nested = mapIntentFollowupResponse({ followup: { state: 'won', version: 9 } })
    expect(nested.state).toBe('won')
    expect(nested.stateLabel).toBe('已成交')
    expect(nested.version).toBe(9)
  })
})

describe('mapIntentImportResult', () => {
  it('按 BE IngestResult 映射 created/updated/skipped_*/rejected_count/rows', () => {
    const result = mapIntentImportResult({
      batch_id: 7,
      status: 'completed',
      created: 8,
      updated: 1,
      skipped_locked: 1,
      skipped_existing: 2,
      rejected_count: 2,
      companies_total: 10,
      pool_total: 5,
      data_rev: 32,
      rows: [
        { scope: 'company', index: 3, external_id: 'row-3', status: 'rejected', reason: 'registeredCapital 不是数值' },
        { scope: 'pool', index: 5, status: 'skipped_locked', reason: '人工已编辑' },
      ],
    })

    expect(result.batchId).toBe(7)
    expect(result.createdCount).toBe(8)
    expect(result.updatedCount).toBe(1)
    expect(result.skippedExistingCount).toBe(2)
    expect(result.skippedLockedCount).toBe(1)
    expect(result.rejectedCount).toBe(2)
    expect(result.totalCompanies).toBe(10)
    expect(result.dataRev).toBe(32)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({
      scope: 'company',
      index: 3,
      externalId: 'row-3',
      status: 'rejected',
    })
    expect(result.rows[0]?.reason).toContain('registeredCapital')
  })

  it('合并 rows 与 rejected 两个数组（兼容 AI/人工两种 ingest 返回）', () => {
    const result = mapIntentImportResult({
      batch_id: 9,
      created: 1,
      rejected: [{ scope: 'company', index: 2, reason: '缺少 name' }],
      rows: [{ scope: 'company', index: 1, status: 'created' }],
    })
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]?.status).toBe('created')
    expect(result.rows[1]?.reason).toBe('缺少 name')
  })
})

describe('mapIntentConvertResult', () => {
  it('映射 BE ConvertResult 的 customer_id/company/data_rev', () => {
    const result = mapIntentConvertResult({
      company_id: 42,
      customer_id: 88,
      data_rev: 32,
      company: {
        id: 42,
        name: '宁波岚川',
        converted_customer_id: 88,
        converted_at: '2026-11-10T12:00:00+08:00',
        followup: { state: 'won', version: 6 },
      },
    })
    expect(result).toMatchObject({ companyId: 42, customerId: 88, dataRev: 32 })
    expect(result.company?.convertedCustomerId).toBe(88)
  })
})

describe('批次列表/详情映射', () => {
  it('mapIntentBatchPage 映射分页包裹；mapIntentBatchDetail 平铺 Batch + rows/rejected', () => {
    const page = mapIntentBatchPage({
      items: [
        {
          id: 7,
          batch_date: '2026-11-10',
          source: 'manual',
          source_label: '人工导入',
          total_companies: 10,
          total_pool: 5,
          created_count: 8,
          updated_count: 1,
          skipped_locked_count: 1,
          rejected_count: 0,
          status: 'completed',
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
    })
    expect(page.items[0]?.sourceLabel).toBe('人工导入')
    expect(page.items[0]?.totalCompanies).toBe(10)

    const detail = mapIntentBatchDetail({
      id: 7,
      batch_date: '2026-11-10',
      status: 'completed',
      total_companies: 10,
      rows_truncated: true,
      rejected: [{ scope: 'company', index: 2, reason: '缺少 name' }],
      rows: [{ scope: 'pool', index: 1, status: 'created' }],
    })
    expect(detail.id).toBe(7)
    expect(detail.rowsTruncated).toBe(true)
    expect(detail.rejected).toHaveLength(1)
    expect(detail.rows[0]?.scope).toBe('pool')
  })
})
