import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stableSession } from '@/test-utils/stable-mocks'

const projectListMock = vi.hoisted(() => vi.fn())
const exportMock = vi.hoisted(() => vi.fn())

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { isAdmin: true } }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: projectListMock,
}))

vi.mock('@/lib/product-analysis-export', () => ({
  exportProductAnalysisToExcel: exportMock,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: vi.fn(),
}))

import ProductAnalysisPanel from './product-analysis-panel'

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(''),
  } as unknown as Response
}

function getLastWeekRange() {
  const now = new Date()
  const day = now.getDay()
  const distanceToCurrentMonday = day === 0 ? 6 : day - 1
  const currentMonday = new Date(now)
  currentMonday.setDate(now.getDate() - distanceToCurrentMonday)
  const lastWeekMonday = new Date(currentMonday)
  lastWeekMonday.setDate(currentMonday.getDate() - 7)
  const lastWeekSunday = new Date(lastWeekMonday)
  lastWeekSunday.setDate(lastWeekMonday.getDate() + 6)
  const format = (date: Date) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const dayOfMonth = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${dayOfMonth}`
  }
  return { start: format(lastWeekMonday), end: format(lastWeekSunday) }
}

const availability = {
  business_report_missing: [],
  ad_report_missing: [],
  inventory_missing: [],
  business_period_info: [],
  ad_period_info: [],
  business_periodic_only_missing: [],
  ad_periodic_only_missing: [],
  payment_periods_overlapping: [],
  payment_full_period_covered: true,
  payment_daily_covered_dates: [],
  payment_objective_empty_dates: [],
  has_minimum_data: true,
  weekly_availability: [],
}

const runResult = {
  project_id: 1,
  project_name: '店铺A',
  country: 'US',
  total_periods: 1,
  periods: [
    {
      report_start_date: '2026-10-26',
      report_end_date: '2026-11-01',
      summary: { 总销售额: 100, 利润: 20, 利润率: 0.2, ACOS: 0.1 },
      details: [],
    },
  ],
}

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

describe('产品分析核算面板', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectListMock.mockResolvedValue([{ id: 1, name: '店铺A' }])
    fetchMock.mockReset()
  })

  it('保留周日期默认值、检查/执行请求体与导出调用', async () => {
    const user = userEvent.setup()
    const expectedRange = getLastWeekRange()
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/calculation/check')) return jsonResponse(availability)
      if (url.includes('/calculation/run')) return jsonResponse(runResult)
      throw new Error(`unexpected request: ${url}`)
    })

    render(<ProductAnalysisPanel session={stableSession({ user: { isAdmin: true } }).data as never} />)

    expect(screen.getByLabelText('开始日期')).toHaveValue(expectedRange.start)
    expect(screen.getByLabelText('结束日期')).toHaveValue(expectedRange.end)
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '项目' })).toHaveTextContent('店铺A')
    )

    await user.click(screen.getByRole('button', { name: '检查数据' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [checkUrl, checkInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(checkUrl).toBe('/api/backend/api/v1/product-analysis/calculation/check')
    expect(checkInit.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Is-Admin': 'true',
    })
    expect(JSON.parse(String(checkInit.body))).toEqual({
      project_id: 1,
      country: 'US',
      start_date: expectedRange.start,
      end_date: expectedRange.end,
    })

    await user.click(await screen.findByRole('button', { name: '执行核算' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [runUrl, runInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(runUrl).toBe('/api/backend/api/v1/product-analysis/calculation/run')
    expect(JSON.parse(String(runInit.body))).toEqual({
      project_id: 1,
      country: 'US',
      start_date: expectedRange.start,
      end_date: expectedRange.end,
      current_only: true,
    })

    await user.click(await screen.findByRole('button', { name: '导出 Excel' }))
    expect(exportMock).toHaveBeenCalledWith({
      periods: runResult.periods,
      projectName: '店铺A',
      country: 'US',
      startDate: expectedRange.start,
      endDate: expectedRange.end,
    })
  })

  it('检查期间暴露 loading，失败时显示可读错误状态', async () => {
    const user = userEvent.setup()
    let rejectCheck: ((response: Response) => void) | undefined
    fetchMock.mockImplementation(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          if (String(input).includes('/calculation/check')) rejectCheck = resolve
        })
    )

    render(<ProductAnalysisPanel session={stableSession({ user: { isAdmin: true } }).data as never} />)
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '项目' })).toHaveTextContent('店铺A')
    )

    await user.click(screen.getByRole('button', { name: '检查数据' }))
    expect(screen.getByRole('button', { name: '正在检查数据' })).toHaveAttribute(
      'aria-busy',
      'true'
    )

    rejectCheck?.(jsonResponse({ detail: '业务报告缺失' }, false))
    expect(await screen.findByRole('alert')).toHaveTextContent('业务报告缺失')
  })

  it('核算空结果保留独立空态', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/calculation/check')) return jsonResponse(availability)
      return jsonResponse({ ...runResult, periods: [], total_periods: 0 })
    })

    render(<ProductAnalysisPanel session={stableSession({ user: { isAdmin: true } }).data as never} />)
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '项目' })).toHaveTextContent('店铺A')
    )

    await user.click(screen.getByRole('button', { name: '检查数据' }))
    await user.click(await screen.findByRole('button', { name: '执行核算' }))

    expect(await screen.findByText('无核算数据')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 Excel' })).toBeDisabled()
  })
})
