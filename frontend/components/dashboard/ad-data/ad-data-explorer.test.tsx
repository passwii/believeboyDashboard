import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'

import { AdDataExplorer } from '@/components/dashboard/ad-data/ad-data-explorer'
import { clearAdClientCaches } from '@/lib/ad-client-cache'

// ── mocks ────────────────────────────────────────────────────────────────────

let mockSearchParams = new URLSearchParams('projectId=1&country=US')
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/dashboard/advertising/ad-data',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

let mockSession: unknown = {
  user: { id: 'user-1', roleType: 'admin', operatorNameZh: '张三' },
}
let mockStatus = 'authenticated'
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: mockStatus }),
}))

const UPLOAD_FILES = [
  { report_type: 'ad_campaign_report', ingestion_status: 'success' },
  { report_type: 'ad_budget_report', ingestion_status: 'failed' },
]

const RAW_PAYLOAD = {
  data: [{ id: 1, 活动: 'SP-auto' }],
  summary: { total_rows: 1 },
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetchSequence(fetchMock: ReturnType<typeof vi.spyOn>) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('ad-upload-files')) return jsonResponse(UPLOAD_FILES)
    if (url.includes('-raw')) return jsonResponse(RAW_PAYLOAD)
    return jsonResponse({})
  })
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('AdDataExplorer mount 请求行为（BEL-421）', () => {
  beforeEach(() => {
    clearAdClientCaches()
    window.sessionStorage.clear()
    mockSearchParams = new URLSearchParams('projectId=1&country=US')
    mockStatus = 'authenticated'
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    clearAdClientCaches()
    window.sessionStorage.clear()
  })

  it('mount 触发 2 个数据请求：报表类型列表 + 默认类型原始行', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    mockFetchSequence(fetchMock)

    render(<AdDataExplorer />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((u) => u.includes('/ad-upload-files?'))).toBe(true)
    expect(urls.some((u) => u.includes('/ad-campaigns-raw?'))).toBe(true)
  })

  it('2min 内重复 mount 不再发请求（列表与原始行都命中客户端缓存）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    mockFetchSequence(fetchMock)

    const first = render(<AdDataExplorer />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    first.unmount()

    render(<AdDataExplorer />)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
