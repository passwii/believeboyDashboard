import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  HttpIntentClient,
  intentConflictFollowup,
  isIntentVersionConflict,
} from './http-client'

const BASE = '/api/backend/v1/crm/intent'

function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
  ): Response {
  const status = init.status ?? 200
  return {
    ok: status < 400,
    status,
    json: async () => payload,
    blob: async () => new Blob(['csv-bytes'], { type: 'text/csv' }),
    headers: new Headers(init.headers ?? {}),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const client = new HttpIntentClient()

describe('HttpIntentClient 列表与 meta', () => {
  it('listCompanies 拼接筛选参数并映射分页响应', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [{ id: 1, name: '企业甲', intent_level: 'A', followup: { state: 'contacted', version: 2 } }],
        total: 1,
        page: 1,
        page_size: 50,
      })
    )

    const page = await client.listCompanies({
      scope: 'mine',
      q: '家居',
      level: 'A',
      state: 'contacted',
      withPhone: true,
      dup: true,
      due: true,
      sort: 'score',
      page: 1,
      pageSize: 50,
    })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain(`${BASE}/companies?`)
    expect(url).toContain('scope=mine')
    expect(url).toContain('level=A')
    expect(url).toContain('state=contacted')
    expect(url).toContain('with_phone=true')
    expect(url).toContain('dup=true')
    expect(url).toContain('due=true')
    expect(url).toContain('page_size=50')
    expect(page.items[0]?.name).toBe('企业甲')
    expect(page.total).toBe(1)
  })

  it('getMeta 无 rev 时不带 data_rev；有 rev 时带上并映射 changed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ stats: { total: 3 }, data_rev: 4, followup_rev: 1, changed: true })
    )
    await client.getMeta('mine')
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('data_rev')

    fetchMock.mockResolvedValueOnce(jsonResponse({ changed: false, data_rev: 4, followup_rev: 1 }))
    const meta = await client.getMeta('all', { dataRev: 4, followupRev: 1 })
    const url = String(fetchMock.mock.calls[1][0])
    expect(url).toContain('data_rev=4')
    expect(url).toContain('followup_rev=1')
    expect(meta.changed).toBe(false)
  })
})

describe('HttpIntentClient 详情 scope', () => {
  it('getCompany 透传 ?scope=（P0-1：非管理员读 sea 记录）', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 42, name: '岚川', followup: { state: 'none', version: 1 } })
    )
    const detail = await client.getCompany(42, { scope: 'sea' })
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/companies/42?scope=sea`)
    expect(detail.name).toBe('岚川')
  })
})

describe('HttpIntentClient 写路径', () => {
  it('updateFollowup 发送 PATCH + If-Match + snake_case body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ state: 'quoted', state_label: '已报价', version: 4, note: '已发报价单' })
    )

    const followup = await client.updateFollowup(
      42,
      { state: 'quoted', note: '已发报价单', nextContactAt: '2026-11-12T10:00:00+08:00' },
      3
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${BASE}/companies/42/followup`)
    expect(init?.method).toBe('PATCH')
    expect(init?.headers?.['If-Match']).toBe('3')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({
      state: 'quoted',
      note: '已发报价单',
      next_contact_at: '2026-11-12T10:00:00+08:00',
    })
    expect(followup.version).toBe(4)
    expect(followup.stateLabel).toBe('已报价')
  })

  it('version=0 也发送 If-Match: 0（P2-17：并发首写必须可检测）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'contacted', version: 1 }))
    await client.updateFollowup(7, { state: 'contacted' }, 0)
    expect(fetchMock.mock.calls[0][1].headers?.['If-Match']).toBe('0')
  })

  it('409 INTENT_VERSION_CONFLICT 抛 ApiError，并能取出服务端 current', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: 'INTENT_VERSION_CONFLICT',
            message: '记录已被其他人更新',
            current: { state: 'won', state_label: '已成交', version: 5, note: '' },
          },
        },
        { status: 409 }
      )
    )

    await expect(client.updateFollowup(42, { note: 'x' }, 3)).rejects.toBeInstanceOf(ApiError)

    try {
      await client.updateFollowup(42, { note: 'x' }, 3)
    } catch (error) {
      expect(isIntentVersionConflict(error)).toBe(true)
      const current = intentConflictFollowup(error)
      expect(current).toMatchObject({ state: 'won', version: 5, stateLabel: '已成交' })
    }
  })

  it('普通 400 不当成版本冲突', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: '号码格式不正确' }, { status: 400 })
    )
    try {
      await client.updateFollowup(1, { note: 'x' }, 3)
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect(isIntentVersionConflict(error)).toBe(false)
      expect((error as Error).message).toBe('号码格式不正确')
    }
  })

  it('claim / 补录 / 有效标记 / 删除 / 转客户 均按 BE Company 响应映射', async () => {
    const company = {
      id: 42,
      name: '宁波岚川',
      owner: { id: 'u-1', name: '张三' },
      human_touched: true,
      phones: [
        { id: 9, phone_raw: '13900000001', phone_normalized: '13900000001', source: 'manual', is_valid: false },
      ],
      followup: { state: 'none', version: 1 },
    }
    fetchMock
      .mockResolvedValueOnce(jsonResponse(company))
      .mockResolvedValueOnce(
        jsonResponse({
          ...company,
          phones: [...company.phones, { id: 10, phone_raw: '13900000002', phone_normalized: '13900000002', source: 'manual', is_valid: false }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...company, phones: [{ ...company.phones[0], is_valid: true }] })
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...company, phones: [] })
      )
      .mockResolvedValueOnce(
        jsonResponse({ company_id: 42, customer_id: 88, data_rev: 32, company })
      )

    const claimed = await client.claimCompany(42)
    expect(claimed.owner).toEqual({ id: 'u-1', name: '张三' })
    expect(claimed.humanTouched).toBe(true)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/companies/42/claim')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')

    const added = await client.addPhone(42, '13900000001')
    expect(added.phones).toHaveLength(2)
    expect(added.phones[1]?.normalized).toBe('13900000002')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ phone_raw: '13900000001' })

    const valid = await client.setPhoneValid(42, 9, true)
    expect(valid.phones[0]?.isValid).toBe(true)
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ is_valid: true })

    const afterDelete = await client.deletePhone(42, 10)
    expect(afterDelete.phones).toHaveLength(0)
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE')

    const converted = await client.convertCompany(42)
    expect(converted).toMatchObject({ companyId: 42, customerId: 88, dataRev: 32 })
    expect(converted.company?.name).toBe('宁波岚川')
  })
})

describe('HttpIntentClient 资料编辑', () => {
  it('updateProfile PATCH /profile 发送 snake_case 字段并映射 Company', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 42, name: '岚川', legal_person: '王五', followup: { state: 'none', version: 1 } })
    )
    const updated = await client.updateProfile(42, {
      creditCode: null, legalPerson: '王五', province: '浙江', city: '宁波',
      foundedYear: 2012, registeredCapitalWan: 300, products: '懒人沙发',
      category: '家居用品', channel: '展会', channels: ['展会', '官网'], channelSource: 'batch.csv',
      trademarks: [], trademarkCount: 0, intentLevel: 'B', intentScore: 70,
      intentBasis: null, amazonFit: null, walmartFit: null, sources: [],
      risks: null, screenedAt: '2026-11-09', phoneNote: null,
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${BASE}/companies/42/profile`)
    expect(init?.method).toBe('PATCH')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      legal_person: '王五',
      founded_year: 2012,
      intent_level: 'B',
      channel: '展会',
      channels: ['展会', '官网'],
      channel_source: 'batch.csv',
      screened_at: '2026-11-09',
    })
    expect(updated.legalPerson).toBe('王五')
  })
})

describe('HttpIntentClient 导出与导入', () => {
  it('exportCsv 返回 blob 与 Content-Disposition 文件名', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(null, {
        headers: {
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('客户雷达_意向客户_2026-11-10.csv')}`,
        },
      })
    )

    const file = await client.exportCsv({ scope: 'all', level: 'A' })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/export?')
    expect(url).toContain('scope=all')
    expect(url).toContain('level=A')
    expect(file.blob).toBeInstanceOf(Blob)
    expect(file.filename).toBe('客户雷达_意向客户_2026-11-10.csv')
  })

  it('uploadBatch 以 multipart 提交并映射 BE IngestResult', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        batch_id: 7,
        status: 'completed',
        created: 8,
        updated: 1,
        skipped_locked: 1,
        skipped_existing: 2,
        rejected_count: 0,
        companies_total: 10,
        pool_total: 5,
        data_rev: 32,
        rows: [{ scope: 'company', index: 1, status: 'created' }],
      })
    )
    const form = new FormData()
    form.append('file', new Blob(['{}']), 'batch.json')
    form.append('batch_date', '2026-11-10')

    const result = await client.uploadBatch(form)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/batches/upload')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    expect(fetchMock.mock.calls[0][1]?.body).toBeInstanceOf(FormData)
    expect(result.batchId).toBe(7)
    expect(result.createdCount).toBe(8)
    expect(result.skippedExistingCount).toBe(2)
    expect(result.totalCompanies).toBe(10)
    expect(result.rows[0]?.scope).toBe('company')
  })

  it('listBatches / getBatch 映射 admin 批次列表与详情', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 7, batch_date: '2026-11-10', source: 'manual', source_label: '人工导入', total_companies: 10 }],
          total: 1,
          page: 1,
          page_size: 20,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 7,
          batch_date: '2026-11-10',
          status: 'completed',
          rows_truncated: true,
          rows: [{ scope: 'company', index: 1, status: 'created' }],
          rejected: [{ scope: 'company', index: 2, reason: '缺少 name' }],
        })
      )

    const page = await client.listBatches(1, 20)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/batches?page=1&page_size=20')
    expect(page.items[0]?.sourceLabel).toBe('人工导入')

    const detail = await client.getBatch(7)
    expect(String(fetchMock.mock.calls[1][0])).toContain('/batches/7')
    expect(detail.rowsTruncated).toBe(true)
    expect(detail.rows).toHaveLength(1)
    expect(detail.rejected).toHaveLength(1)
  })

  it('网络失败抛普通 Error（无 status），错误文案保留原因', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(client.getMeta('mine')).rejects.toThrow(/网络错误/)
  })
})
