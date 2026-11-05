import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

import AutoReconcileTab from './auto-reconcile-tab'

type DeferredResponse = {
  promise: Promise<Response>
  resolve: (response: Response) => void
}

let csvDownload: DeferredResponse
let pdfDownload: DeferredResponse

function deferredResponse(): DeferredResponse {
  let resolve: (response: Response) => void = () => {}
  const promise = new Promise<Response>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const availableReport = {
  report_id: 7,
  project_name: '项目A',
  country: 'US',
  report_month: '2026-10',
  has_summary_pdf: true,
  pdf_url: 'https://example.test/report.pdf',
  pdf_uploaded_at: '2026-11-05T08:00:00+08:00',
  pt3_calculation_complete: true,
  pt4_calculation_complete: true,
  status: 'ready',
  has_transaction_csv: true,
  reconciled: false,
  reconcile_match_rate: null,
  reconcile_record_id: null,
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/available-reports')) {
    return jsonResponse({ reports: [availableReport], total: 1 })
  }
  if (url.includes('/download-csv')) return csvDownload.promise
  if (url.includes('/download-pdf')) return pdfDownload.promise
  return jsonResponse({})
})

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: new Headers(),
  } as unknown as Response
}

function downloadResponse(filename: string) {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(['download']),
    json: async () => ({}),
    text: async () => '',
    headers: new Headers({
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    }),
  } as unknown as Response
}

const originalAnchorClick = HTMLAnchorElement.prototype.click

beforeEach(() => {
  vi.clearAllMocks()
  csvDownload = deferredResponse()
  pdfDownload = deferredResponse()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(window.URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:test'),
  })
  Object.defineProperty(window.URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  HTMLAnchorElement.prototype.click = vi.fn()
})

afterAll(() => {
  HTMLAnchorElement.prototype.click = originalAnchorClick
})

function renderAutoReconcile() {
  return render(
    <AutoReconcileTab
      projectId="1"
      setProjectId={vi.fn()}
      country="US"
      setCountry={vi.fn()}
      loading={false}
      setLoading={vi.fn()}
      fetchAvailableReportsRef={{ current: () => {} }}
    />
  )
}

describe('自动核对行下载防重', () => {
  it('tracks CSV and PDF independently with aria-busy and ignores repeated clicks', async () => {
    renderAutoReconcile()

    const csvButton = await screen.findByRole('button', { name: 'CSV' }, { timeout: 3_000 })
    fireEvent.click(csvButton)

    const busyCsv = await screen.findByRole('button', { name: '正在下载 CSV' })
    expect(busyCsv).toHaveAttribute('aria-busy', 'true')
    expect(busyCsv).toBeDisabled()
    fireEvent.click(busyCsv)
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/download-csv'))
    ).toHaveLength(1)

    csvDownload.resolve(downloadResponse('transactions.csv'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'CSV' })).not.toHaveAttribute('aria-busy')
    )

    const pdfButton = screen.getByRole('button', { name: 'PDF' })
    fireEvent.click(pdfButton)

    const busyPdf = await screen.findByRole('button', { name: '正在下载 PDF' })
    expect(busyPdf).toHaveAttribute('aria-busy', 'true')
    expect(busyPdf).toBeDisabled()
    expect(screen.getByRole('button', { name: 'CSV' })).not.toHaveAttribute('aria-busy')
    fireEvent.click(busyPdf)
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/download-pdf'))
    ).toHaveLength(1)

    pdfDownload.resolve(downloadResponse('summary.pdf'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'PDF' })).not.toHaveAttribute('aria-busy')
    )
  })
})
