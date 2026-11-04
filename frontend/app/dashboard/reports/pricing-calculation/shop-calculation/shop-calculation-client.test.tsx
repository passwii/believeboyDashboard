import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

const headerCapture = vi.hoisted(() => ({ slot: null as ReactNode }))

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { isAdmin: false } }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/pricing-calculation/shop-calculation',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([{ id: 1, name: '项目A' }]),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderSlot: (node: ReactNode) => {
    headerCapture.slot = node
    return null
  },
  useMobileFilterStrip: () => null,
}))

vi.mock('@/components/dashboard/pricing-calculation/shop-calculation-us-section', () => ({
  ShopCalculationUsSection: () => <div data-testid="shop-us-section">US</div>,
}))

vi.mock('@/components/dashboard/pricing-calculation/shop-calculation-eu-section', () => ({
  ShopCalculationEuSection: () => <div data-testid="shop-eu-section">EU</div>,
}))

vi.mock('@/components/dashboard/pricing-calculation/snapshot-selector', () => ({
  PricingSnapshotSelector: ({ disabled }: { disabled: boolean }) => (
    <button type="button" disabled={disabled}>
      定价快照
    </button>
  ),
}))

vi.mock('@/components/dashboard/pricing-calculation/create-snapshot-dialog', () => ({
  CreatePricingSnapshotDialog: () => null,
}))

vi.mock('@/components/dashboard/pricing-calculation/edit-snapshot-dialog', () => ({
  EditPricingSnapshotDialog: () => null,
}))

vi.mock('@/lib/operation-audit', () => ({
  logClientOperation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/download-blob', () => ({
  downloadBlob: vi.fn(),
}))

import ShopCalculationClient from './shop-calculation-client'

const fetchMock = vi.fn(async () => jsonResponse({}))

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
  headerCapture.slot = null
  vi.stubGlobal('fetch', fetchMock)
})

describe('店铺测算 Warm Ledger 页面', () => {
  it('renders the Warm console, snapshot control, and data table surface', async () => {
    const { container } = render(<ShopCalculationClient />)

    expect(
      container.querySelector('[data-warm-pricing-shop-calculation="true"]')
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '控制台' })).toHaveAttribute(
      'data-warm-surface',
      'true'
    )
    expect(screen.getByTestId('shop-us-section')).toBeInTheDocument()
    expect(screen.getByText('SKU')).toBeInTheDocument()
    expect(screen.getByText('已测算')).toBeInTheDocument()
    expect(screen.getByText('盈利')).toBeInTheDocument()
    expect(screen.getByText('盈利占比')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '定价快照' })).toBeInTheDocument())
  })

  it('keeps export disabled until calculated rows exist', () => {
    render(<ShopCalculationClient />)

    expect(screen.getByRole('button', { name: '导出 Excel' })).toBeDisabled()
  })

  it('renders only Warm controls inside the header portal', () => {
    render(<ShopCalculationClient />)

    expect(headerCapture.slot).not.toBeNull()
    const { container } = render(<>{headerCapture.slot}</>)
    const header = container.querySelector('[data-warm-header-filters="true"]')

    expect(header).toBeInTheDocument()
    expect(screen.getByLabelText('项目筛选')).toBeInTheDocument()
    expect(screen.getByLabelText('SKU 搜索')).toBeInTheDocument()
    expect(screen.getByLabelText('站点筛选')).toBeInTheDocument()
    for (const element of [header!, ...Array.from(header!.querySelectorAll('*'))]) {
      const className = typeof element.className === 'string' ? element.className : ''
      expect(className).not.toContain('rounded-none')
      expect(className).not.toContain('term-')
      expect(className).not.toContain('font-mono')
    }
  })
})
