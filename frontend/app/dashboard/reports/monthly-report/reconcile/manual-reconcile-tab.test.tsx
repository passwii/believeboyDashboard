import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

import ManualReconcileTab from './manual-reconcile-tab'

let verifyDeferred: Promise<Response> | null = null

const fetchMock = vi.fn(async () => verifyDeferred ?? jsonResponse(emptyResult()))

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: new Headers(),
  } as unknown as Response
}

function emptyResult() {
  return {
    summary: {
      excel_total_income: null,
      excel_total_expense: null,
      excel_net_amount: null,
      pdf_total_income: null,
      pdf_total_expense: null,
      pdf_net_amount: null,
    },
    total_items: 0,
    matched_items: 0,
    mismatched_items: 0,
    missing_items: 0,
    match_rate: 100,
    items: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyDeferred = null
  vi.stubGlobal('fetch', fetchMock)
})

describe('手动核对异步按钮', () => {
  it('uses WarmButton loading state with aria-busy for the reconcile request', async () => {
    let resolveVerify: (response: Response) => void = () => {}
    verifyDeferred = new Promise<Response>((resolve) => {
      resolveVerify = resolve
    })
    const { container } = render(<ManualReconcileTab />)

    fireEvent.change(container.querySelector('input[accept=".xlsx,.xls"]')!, {
      target: { files: [new File(['excel'], 'report.xlsx')] },
    })
    fireEvent.change(container.querySelector('input[accept=".pdf"]')!, {
      target: { files: [new File(['pdf'], 'report.pdf')] },
    })
    fireEvent.click(screen.getByRole('button', { name: '开始核对' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/backend/api/v1/report-reconciliation/reconcile',
        expect.objectContaining({ method: 'POST', body: expect.any(FormData) })
      )
    })

    const busyButton = screen.getByRole('button', { name: '正在核对报表' })
    expect(busyButton).toHaveAttribute('aria-busy', 'true')
    expect(busyButton).toBeDisabled()

    resolveVerify(jsonResponse(emptyResult()))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '开始核对' })).not.toHaveAttribute('aria-busy')
    )
  })
})
