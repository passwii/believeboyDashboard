import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/pricing-calculation/new-product',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="dynamic-table" />,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([{ id: 1, name: '项目A' }]),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderSlot: () => null,
  useMobileFilterStrip: () => null,
}))

vi.mock('@/lib/operation-audit', () => ({
  logClientOperation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/download-blob', () => ({
  downloadBlob: vi.fn(),
}))

vi.mock('@/lib/excel-styles', () => ({
  applyBorder: vi.fn(),
  applyHeaderBorder: vi.fn(),
}))

import NewProductClient from './new-product-client'

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/pricing-calculation/runs')) {
    return jsonResponse({ items: [], total: 0, page: 1, page_size: 12 })
  }
  if (url.includes('/product-costs')) {
    return jsonResponse({ items: [], page: 1, page_size: 20, has_next: false })
  }
  if (url.includes('/shipment')) {
    return jsonResponse({ items: [] })
  }
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

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

describe('新品核算 Warm Ledger 页面', () => {
  it('renders the Warm workspace and preserves the four calculation modes', async () => {
    const user = userEvent.setup()
    const { container } = render(<NewProductClient />)

    expect(container.querySelector('[data-warm-pricing-new-product="true"]')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '测算输入' })).toHaveAttribute(
      'data-warm-surface',
      'true'
    )
    expect(screen.getByRole('region', { name: '控制台' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '最近测算' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '测算对比矩阵' })).toBeInTheDocument()

    for (const mode of ['利润核算', '利润倒算', '成本倒推', 'FBM测算']) {
      expect(screen.getByRole('tab', { name: mode })).toBeInTheDocument()
    }

    await user.click(screen.getByRole('tab', { name: '利润倒算' }))
    expect(await screen.findByText('目标利润率(%)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '倒算售价' })).toBeInTheDocument()
  })

  it('keeps the form, export action, and empty run state usable', async () => {
    render(<NewProductClient />)

    expect(screen.getByPlaceholderText('例如：桌面置物架')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始测算' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 Excel' })).toBeDisabled()
    await waitFor(() => expect(screen.getAllByText('暂无测算记录').length).toBeGreaterThan(0))
  })
})
