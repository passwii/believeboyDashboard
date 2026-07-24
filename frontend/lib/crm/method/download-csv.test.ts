import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadCrmCsv } from './download-csv'

// 仅 mock 代码实际用到的响应字段（ok/status/blob/json），避开 jsdom Blob 与
// Node Response 不兼容的问题。
function okResponse(body = '客户,简称\nA,') {
  const blob = new Blob([body], { type: 'text/csv' })
  return { ok: true, status: 200, blob: async () => blob, json: async () => ({}) }
}

describe('downloadCrmCsv', () => {
  let clickSpy: ReturnType<typeof vi.fn>
  let appendSpy: ReturnType<typeof vi.fn>
  let removeSpy: ReturnType<typeof vi.fn>
  let createObjectURLSpy: ReturnType<typeof vi.fn>
  let revokeObjectURLSpy: ReturnType<typeof vi.fn>
  let capturedDownload: string

  beforeEach(() => {
    clickSpy = vi.fn()
    appendSpy = vi.fn()
    removeSpy = vi.fn()
    capturedDownload = ''
    vi.spyOn(document, 'createElement').mockReturnValue({
      click: clickSpy,
      remove: removeSpy,
      href: '',
      set download(v: string) {
        capturedDownload = v
      },
      get download() {
        return capturedDownload
      },
    } as unknown as HTMLElement)
    vi.spyOn(document.body, 'appendChild').mockImplementation(appendSpy)
    createObjectURLSpy = vi.fn(() => 'blob:mock')
    revokeObjectURLSpy = vi.fn()
    ;(URL as unknown as { createObjectURL: typeof createObjectURLSpy }).createObjectURL =
      createObjectURLSpy
    ;(URL as unknown as { revokeObjectURL: typeof revokeObjectURLSpy }).revokeObjectURL =
      revokeObjectURLSpy
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('客户导出：命中 customers/export 并触发下载', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await downloadCrmCsv('customers', { scope: 'mine', keyword: '苹果' })

    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('/api/backend/v1/crm/customers/export')
    expect(calledUrl).toContain('scope=mine')
    expect(calledUrl).toContain('keyword=%E8%8B%B9%E6%9E%9C') // 苹果 URL 编码
    expect(createObjectURLSpy).toHaveBeenCalled()
    expect(appendSpy).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalled()
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock')
  })

  it('线索导出：命中 leads/export，无参数不带 query', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await downloadCrmCsv('leads')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/backend/v1/crm/leads/export')
  })

  it('下载的锚点带 .csv 文件名', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()))

    await downloadCrmCsv('customers')

    expect(capturedDownload).toMatch(/^客户_\d{8}\.csv$/)
  })

  it('后端非 2xx：抛错并取 detail 消息', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 403,
        blob: async () => new Blob([]),
        json: async () => ({ detail: 'Admin required' }),
      })
    )

    await expect(downloadCrmCsv('customers')).rejects.toThrow('Admin required')
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('后端非 2xx 且非 JSON：用通用消息', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 500,
        blob: async () => new Blob([]),
        json: async () => {
          throw new Error('not json')
        },
      })
    )

    await expect(downloadCrmCsv('leads')).rejects.toThrow('导出失败（500）')
  })
})
