import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

const { client } = vi.hoisted(() => ({
  client: {
    getProposal: vi.fn(),
    getProposalVersionContent: vi.fn(),
    downloadProposalVersion: vi.fn(),
    listCustomers: vi.fn(),
    updateProposal: vi.fn(),
    addProposalVersion: vi.fn(),
  },
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'proposal-1' }),
}))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: vi.fn(),
}))
vi.mock('@/lib/crm/api/crm-client-provider', () => ({ useCrmClient: () => client }))
vi.mock('@/hooks/use-crm-data-scope', () => ({
  useCrmDataScope: () => ({ scope: 'all', setScope: vi.fn(), currentUserId: 'user-1' }),
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

import ProposalDetailPage from './page'

const DETAIL = {
  id: 'proposal-1',
  title: '北美春季方案',
  proposalType: 'operation' as const,
  status: 'published' as const,
  customerId: 'customer-1',
  customerName: '客户甲',
  ownerId: 'user-1',
  ownerName: '负责人甲',
  currentVersionNo: 2,
  versionCount: 2,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  versions: [
    {
      id: 'version-2',
      versionNo: 2,
      originalFilename: 'plan-v2.html',
      contentType: 'text/html',
      fileSize: 2048,
      changeNote: '补充报价',
      createdAt: '2026-10-02T00:00:00Z',
    },
    {
      id: 'version-1',
      versionNo: 1,
      originalFilename: 'plan-v1.html',
      contentType: 'text/html',
      fileSize: 1024,
      changeNote: '初始版本',
      createdAt: '2026-10-01T00:00:00Z',
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  client.getProposal.mockResolvedValue(DETAIL)
  client.getProposalVersionContent.mockResolvedValue({
    proposalId: 'proposal-1',
    versionNo: 2,
    title: DETAIL.title,
    content: '<html><body>方案内容</body></html>',
  })
  client.listCustomers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 })
})

describe('Warm Ledger 方案详情', () => {
  it('403 时保留后端错误文案与返回列表入口', async () => {
    client.getProposal.mockRejectedValue(new Error('无权限访问此方案'))

    const { container } = render(<ProposalDetailPage />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('无权限访问此方案')
    expect(screen.getByRole('link', { name: '返回列表' })).toHaveAttribute(
      'href',
      '/dashboard/crm/proposals'
    )
    expect(container.querySelector('[data-warm-crm-page]')).toBeInTheDocument()
    expect(
      container.querySelector('[data-warm-crm-state][data-state="error"]')
    ).toBeInTheDocument()
  })

  it('加载当前版本并保留适配版/原始版预览切换', async () => {
    const { container } = render(<ProposalDetailPage />)

    expect(await screen.findByRole('heading', { name: '北美春季方案' })).toBeInTheDocument()
    await waitFor(() => expect(container.querySelector('iframe')).toBeInTheDocument())

    expect(client.getProposal).toHaveBeenCalledWith('proposal-1')
    expect(client.getProposalVersionContent).toHaveBeenCalledWith('proposal-1', 2, {
      raw: false,
    })
    expect(container.querySelector('[data-warm-crm-page]')).toBeInTheDocument()
    expect(container.querySelector('[data-proposal-preview-layout]')).toBeInTheDocument()
  })
})
