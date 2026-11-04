import { describe, expect, it, vi } from 'vitest'

const redirectMock = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}))

import ReportReconciliationPage from './page'

describe('ReportReconciliationPage', () => {
  it('保留原报表核对入口到财务月报核对 Tab 的重定向契约', () => {
    ReportReconciliationPage()

    expect(redirectMock).toHaveBeenCalledWith('/dashboard/reports/monthly-report/reconcile')
  })
})
