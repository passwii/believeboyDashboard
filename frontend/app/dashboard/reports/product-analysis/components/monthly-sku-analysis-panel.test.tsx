import type { ChangeEvent } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { notify, stableNotifications, stableSession } from '@/test-utils/stable-mocks'

const projectListMock = vi.hoisted(() => vi.fn())
const exportMock = vi.hoisted(() => vi.fn())

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { isAdmin: true } }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: projectListMock,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/product-analysis-export', () => ({
  exportProductAnalysisToExcel: exportMock,
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

import MonthlySkuAnalysisPanel from './monthly-sku-analysis-panel'

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

function getLastMonthRange() {
  const now = new Date()
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86400000)
  const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1)
  return { start: formatDate(firstOfPrevMonth), end: formatDate(lastOfPrevMonth) }
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

const runResult = {
  project_id: 1,
  project_name: '店铺A',
  country: 'US',
  total_periods: 1,
  periods: [
    {
      report_start_date: '2026-10-01',
      report_end_date: '2026-10-31',
      summary: {},
      details: [{ SKU: 'SKU-1', 总销量: 1 }],
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

describe('月度 SKU 分析面板', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectListMock.mockResolvedValue([{ id: 1, name: '店铺A' }])
    fetchMock.mockReset()
  })

  it('保留上月默认范围，一次提交三类文件且全部 dry-run', async () => {
    const user = userEvent.setup()
    const expectedRange = getLastMonthRange()
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
      if (url.includes('/calculation/preview')) return jsonResponse(runResult)
      throw new Error(`unexpected request: ${url}`)
    })

    render(<MonthlySkuAnalysisPanel />)

    expect(screen.getByLabelText('开始日期')).toHaveValue(expectedRange.start)
    expect(screen.getByLabelText('结束日期')).toHaveValue(expectedRange.end)
    await waitForProjectAndUpload(user)

    await user.click(screen.getByRole('button', { name: '一键识别并提交（不入库）' }))

    await waitFor(() => {
      const commitCalls = (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(
        ([url]) => url.endsWith('/commit')
      )
      expect(commitCalls).toHaveLength(3)
    })

    const commitCalls = (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(
      ([url]) => url.endsWith('/commit')
    )
    for (const [, init] of commitCalls) {
      expect(JSON.parse(String(init.body))).toMatchObject({
        project_name: '店铺A',
        country: 'US',
        report_start_date: expectedRange.start,
        report_end_date: expectedRange.end,
        dry_run: true,
      })
    }
  })

  it('核算期间暴露 loading，完成后调用共享两表导出并保留文件名前缀', async () => {
    const user = userEvent.setup()
    const expectedRange = getLastMonthRange()
    let resolvePreview: ((response: Response) => void) | undefined
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
      if (url.includes('/calculation/preview')) {
        return new Promise<Response>((resolve) => {
          resolvePreview = resolve
        })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    render(<MonthlySkuAnalysisPanel />)
    await waitForProjectAndUpload(user)
    await user.click(screen.getByRole('button', { name: '一键识别并提交（不入库）' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '核算并导出 Excel' })).toBeEnabled()
    )

    await user.click(screen.getByRole('button', { name: '核算并导出 Excel' }))
    expect(screen.getByRole('button', { name: '正在核算并导出' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
    const previewCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(([url]) =>
      url.includes('/calculation/preview')
    )
    expect(JSON.parse(String(previewCall?.[1].body))).toEqual({
      project_id: 1,
      country: 'US',
      start_date: expectedRange.start,
      end_date: expectedRange.end,
      business_temp_file_id: 'business-temp',
      payment_temp_file_id: 'payment-temp',
      ad_temp_file_id: 'ad-temp',
    })

    resolvePreview?.(jsonResponse(runResult))
    await waitFor(() =>
      expect(exportMock).toHaveBeenCalledWith({
        periods: runResult.periods,
        projectName: '店铺A',
        country: 'US',
        startDate: expectedRange.start,
        endDate: expectedRange.end,
        fileNamePrefix: '月度SKU分析',
      })
    )
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: 'Excel 已下载' })
    )
  })

  it('预览失败显示错误', async () => {
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
      if (url.includes('/calculation/preview')) {
        return jsonResponse({ detail: '临时文件已失效' }, false)
      }
      throw new Error(`unexpected request: ${url}`)
    })

    render(<MonthlySkuAnalysisPanel />)
    await waitForProjectAndUpload(user)
    await user.click(screen.getByRole('button', { name: '一键识别并提交（不入库）' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '核算并导出 Excel' })).toBeEnabled()
    )

    await user.click(screen.getByRole('button', { name: '核算并导出 Excel' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('临时文件已失效')
  })

  it('预览空结果显示真实空态', async () => {
    const user = userEvent.setup()
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
      if (url.includes('/calculation/preview')) {
        return jsonResponse({ ...runResult, periods: [], total_periods: 0 })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    render(<MonthlySkuAnalysisPanel />)
    await waitForProjectAndUpload(user)
    await user.click(screen.getByRole('button', { name: '一键识别并提交（不入库）' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '核算并导出 Excel' })).toBeEnabled()
    )

    await user.click(screen.getByRole('button', { name: '核算并导出 Excel' }))
    expect(await screen.findByText('当前日期范围无可核算数据')).toBeInTheDocument()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', title: '核算结果为空' })
    )
  })
})
