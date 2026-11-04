import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FollowUpGroups } from '@/lib/crm/types'

import { stableNotifications } from '@/test-utils/stable-mocks'
import { CrmFollowUpList } from './index'

const groups: FollowUpGroups = {
  overdue: [
    {
      entityType: 'customer',
      entityId: 'c1',
      name: '甲公司',
      ownerId: 'u1',
      ownerName: '小王',
      nextFollowAt: '2026-10-01T09:00:00Z',
    },
  ],
  today: [],
  thisWeek: [],
  overdueCount: 1,
  totalCount: 1,
}

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))
vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => ({ listFollowUps: vi.fn().mockResolvedValue(groups) }),
}))
vi.mock('@/hooks/use-crm-data-scope', () => ({
  useCrmDataScope: () => ({ scope: 'all', setScope: vi.fn() }),
}))
vi.mock('@/hooks/use-crm-users', () => ({ useCrmUsers: () => [] }))
vi.mock('@/components/notifications', () => ({ useNotifications: () => stableNotifications() }))

describe('CrmFollowUpList · Warm Ledger', () => {
  it('保留逾期分组与行内容，并标记 Warm 分组容器', async () => {
    render(<CrmFollowUpList />)

    expect(await screen.findByText('逾期未跟进')).toBeInTheDocument()
    expect(screen.getByText('甲公司')).toBeInTheDocument()
    expect(screen.getByText('逾期未跟进').closest('[data-warm-crm-follow-group]')).toHaveAttribute(
      'data-tone',
      'negative'
    )
  })
})
