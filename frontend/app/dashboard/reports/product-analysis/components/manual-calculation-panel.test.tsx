import type { ChangeEvent } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

const projectListMock = vi.hoisted(() => vi.fn())
const downloadBlobMock = vi.hoisted(() => vi.fn())

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { isAdmin: true, name: '测试用户', full_name: '测试用户' } }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: projectListMock,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}))

vi.mock('@/components/report-upload/simple-dropzone', () => ({
  SimpleDropzone: ({
    onPickFiles,
  }: {
    onPickFiles: (event: ChangeEvent<HTMLInputElement>) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onPickFiles({
          target: {
            files: [
              new File(['business'], 'business.csv', { type: 'text/csv' }),
              new File(['payment'], 'payment.csv', { type: 'text/csv' }),
              new File(['ad'], 'ad.xlsx', {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              }),
            ],
            value: '',
          },
        } as unknown as ChangeEvent<HTMLInputElement>)
      }
    >
      上传测试文件
    </button>
  ),
}))

vi.mock('@/components/report-upload/report-status-card', () => ({
  ReportStatusCard: ({
    config,
    state,
    canCommit,
    onCommit,
  }: {
    config: { type: string; title: string }
    state: { activeTempFileId: string | null }
    canCommit: boolean
    onCommit: () => void
  }) => (
    <div data-testid={`card-${config.type}`}>
      <span>{config.title}</span>
      <span data-testid={`temp-${config.type}`}>{state.activeTempFileId ?? 'none'}</span>
      <button type="button" disabled={!canCommit} onClick={onCommit}>
        确认 {config.title}
      </button>
    </div>
  ),
}))

import ManualCalculationPanel from './manual-calculation-panel'

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(''),
  } as unknown as Response
}

function formatDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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
  return { start: formatDate(lastWeekMonday), end: formatDate(lastWeekSunday) }
}

function recognition(reportType: string, tempFileId: string) {
  return {
    temp_file_id: tempFileId,
    original_filename: `${tempFileId}.csv`,
    extension: tempFileId === 'ad-temp' ? 'xlsx' : 'csv',
    report_type: reportType,
    matched_columns: [],
    reason: '',
    status: 'recognized',
    country: 'US',
    detected_countries: ['US'],
    primary_country: 'US',
    date_input_mode: 'single_auto',
    detected_date: '2026-10-27',
    detected_start_date: null,
    detected_end_date: null,
    project_match: {
      status: 'matched',
      project_name: '店铺A',
      candidate_projects: [],
      matched_by: 'ASIN',
      matched_values: [],
      message: null,
    },
    row_count_preview: 10,
    warnings: [],
  }
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
      details: [{ SKU: 'SKU-1', ASIN: 'ASIN-1', 总销量: 1, 总销售额: 100, 利润: 20 }],
      persisted: true,
    },
  ],
}

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

async function waitForProjectAndUpload(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByRole('combobox', { name: '项目' })).toBeEnabled())
  await user.click(screen.getByRole('combobox', { name: '项目' }))
  await user.click(await screen.findByRole('option', { name: '店铺A' }))
  await user.click(screen.getByRole('button', { name: '上传测试文件' }))
  await waitFor(() => expect(screen.getByTestId('temp-business_report')).toHaveTextContent('business-temp'))
  await waitFor(() => expect(screen.getByTestId('temp-payment_report')).toHaveTextContent('payment-temp'))
  await waitFor(() =>
    expect(screen.getByTestId('temp-ad_promoted_product_report')).toHaveTextContent('ad-temp')
  )
}

describe('手动核算面板', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectListMock.mockResolvedValue([{ id: 1, name: '店铺A' }])
    fetchMock.mockReset()
  })

  it('保留上周默认值、业务/付款写入与广告 dry-run 提交体', async () => {
    const user = userEvent.setup()
    const expectedRange = getLastWeekRange()
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/recognize')) {
        const file = (init?.body as FormData).get('file') as File
        if (file.name === 'business.csv') return jsonResponse(recognition('business_report', 'business-temp'))
        if (file.name === 'payment.csv') return jsonResponse(recognition('payment_report', 'payment-temp'))
        return jsonResponse(recognition('ad_promoted_product_report', 'ad-temp'))
      }
      if (url.endsWith('/report-upload/commit') || url.endsWith('/ad-upload/commit')) {
        return jsonResponse({ ok: true })
      }
      if (url.includes('/calculation/check')) return jsonResponse(availability)
      if (url.includes('/calculation/run')) return jsonResponse(runResult)
      throw new Error(`unexpected request: ${url}`)
    })

    render(<ManualCalculationPanel />)

    expect(screen.getByLabelText('开始日期')).toHaveValue(expectedRange.start)
    expect(screen.getByLabelText('结束日期')).toHaveValue(expectedRange.end)
    await waitForProjectAndUpload(user)

    await user.click(screen.getByRole('button', { name: '确认 业务报告' }))
    await user.click(screen.getByRole('button', { name: '确认 付款报告' }))
    await user.click(screen.getByRole('button', { name: '确认 广告报告' }))

    await waitFor(() => {
      const commitCalls = (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(
        ([url]) => url.endsWith('/report-upload/commit') || url.endsWith('/ad-upload/commit')
      )
      expect(commitCalls).toHaveLength(3)
    })

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>
    const businessCommit = calls.find(
      ([url, init]) =>
        url.endsWith('/report-upload/commit') &&
        JSON.parse(String(init.body)).temp_file_id === 'business-temp'
    )
    const paymentCommit = calls.find(
      ([url, init]) =>
        url.endsWith('/report-upload/commit') &&
        JSON.parse(String(init.body)).temp_file_id === 'payment-temp'
    )
    const adCommit = calls.find(
      ([url, init]) =>
        url.endsWith('/ad-upload/commit') &&
        JSON.parse(String(init.body)).temp_file_id === 'ad-temp'
    )

    expect(JSON.parse(String(businessCommit?.[1].body))).toMatchObject({
      project_name: '店铺A',
      country: 'US',
      report_start_date: expectedRange.start,
      report_end_date: expectedRange.end,
      use_period_dates: true,
    })
    expect(JSON.parse(String(businessCommit?.[1].body))).not.toHaveProperty('dry_run')
    expect(JSON.parse(String(paymentCommit?.[1].body))).not.toHaveProperty('dry_run')
    expect(JSON.parse(String(adCommit?.[1].body))).toMatchObject({
      project_name: '店铺A',
      country: 'US',
      report_start_date: expectedRange.start,
      report_end_date: expectedRange.end,
      dry_run: true,
    })
  })

  it('执行核算后可展开周期并下载独立工作簿', async () => {
    const user = userEvent.setup()
    const expectedRange = getLastWeekRange()
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/recognize')) {
        const file = (init?.body as FormData).get('file') as File
        if (file.name === 'business.csv') return jsonResponse(recognition('business_report', 'business-temp'))
        if (file.name === 'payment.csv') return jsonResponse(recognition('payment_report', 'payment-temp'))
        return jsonResponse(recognition('ad_promoted_product_report', 'ad-temp'))
      }
      if (url.endsWith('/report-upload/commit') || url.endsWith('/ad-upload/commit')) {
        return jsonResponse({ ok: true })
      }
      if (url.includes('/calculation/check')) return jsonResponse(availability)
      if (url.includes('/calculation/run')) return jsonResponse(runResult)
      throw new Error(`unexpected request: ${url}`)
    })

    render(<ManualCalculationPanel />)
    await waitForProjectAndUpload(user)

    await user.click(screen.getByRole('button', { name: '确认 业务报告' }))
    await user.click(screen.getByRole('button', { name: '确认 付款报告' }))
    await user.click(screen.getByRole('button', { name: '确认 广告报告' }))

    const runButton = await screen.findByRole('button', { name: '执行核算' })
    await waitFor(() => expect(runButton).toBeEnabled())
    await user.click(runButton)

    await waitFor(() => {
      const runCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([url]) =>
        url.includes('/calculation/run')
      )
      expect(runCall).toBeDefined()
      expect(JSON.parse(String(runCall?.[1].body))).toEqual({
        project_id: 1,
        country: 'US',
        start_date: expectedRange.start,
        end_date: expectedRange.end,
        current_only: true,
      })
    })

    expect(await screen.findByText('核算结果 · 共 1 个周期')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '展开明细' }))
    expect(screen.getByText('SKU-1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '导出 Excel' }))
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1))
    expect(downloadBlobMock.mock.calls[0]?.[1]).toBe(
      `店铺A_美国站-产品核算-${expectedRange.start.replaceAll('-', '')}~${expectedRange.end.replaceAll('-', '')}.xlsx`
    )
  })

  it('检查失败显示错误', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/recognize')) {
        const file = (init?.body as FormData).get('file') as File
        if (file.name === 'business.csv') return jsonResponse(recognition('business_report', 'business-temp'))
        if (file.name === 'payment.csv') return jsonResponse(recognition('payment_report', 'payment-temp'))
        return jsonResponse(recognition('ad_promoted_product_report', 'ad-temp'))
      }
      if (url.endsWith('/report-upload/commit') || url.endsWith('/ad-upload/commit')) {
        return jsonResponse({ ok: true })
      }
      if (url.includes('/calculation/check')) return jsonResponse({ detail: '核心报表缺失' }, false)
      throw new Error(`unexpected request: ${url}`)
    })

    render(<ManualCalculationPanel />)
    await waitForProjectAndUpload(user)

    await user.click(screen.getByRole('button', { name: '确认 业务报告' }))
    await user.click(screen.getByRole('button', { name: '确认 付款报告' }))
    await user.click(screen.getByRole('button', { name: '确认 广告报告' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('核心报表缺失')
    expect(screen.getByRole('button', { name: '执行核算' })).toBeDisabled()
  })

  it('检查期间暴露 loading，执行空结果显示独立空态', async () => {
    const user = userEvent.setup()
    let resolveCheck: ((response: Response) => void) | undefined
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/recognize')) {
        const file = (init?.body as FormData).get('file') as File
        if (file.name === 'business.csv') {
          return jsonResponse(recognition('business_report', 'business-temp'))
        }
        if (file.name === 'payment.csv') {
          return jsonResponse(recognition('payment_report', 'payment-temp'))
        }
        return jsonResponse(recognition('ad_promoted_product_report', 'ad-temp'))
      }
      if (url.endsWith('/report-upload/commit') || url.endsWith('/ad-upload/commit')) {
        return jsonResponse({ ok: true })
      }
      if (url.includes('/calculation/check')) {
        return new Promise<Response>((resolve) => {
          resolveCheck = resolve
        })
      }
      if (url.includes('/calculation/run')) {
        return jsonResponse({ ...runResult, periods: [], total_periods: 0 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    render(<ManualCalculationPanel />)
    await waitForProjectAndUpload(user)

    await user.click(screen.getByRole('button', { name: '确认 业务报告' }))
    await user.click(screen.getByRole('button', { name: '确认 付款报告' }))
    await user.click(screen.getByRole('button', { name: '确认 广告报告' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '正在检查数据' })).toHaveAttribute(
        'aria-busy',
        'true'
      )
    )
    resolveCheck?.(jsonResponse(availability))

    const runButton = await screen.findByRole('button', { name: '执行核算' })
    await waitFor(() => expect(runButton).toBeEnabled())
    await user.click(runButton)
    expect(await screen.findByText('无核算数据')).toBeInTheDocument()
  })
})
