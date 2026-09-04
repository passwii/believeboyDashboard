import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CrmValueProfileCard } from './index'
import type { Customer } from '@/lib/crm/types/customer'

const { mockClient, mockUpdateValueScores } = vi.hoisted(() => {
  const fn = vi.fn()
  return { mockClient: { updateValueScores: fn }, mockUpdateValueScores: fn }
})
vi.mock('@/lib/crm/api/crm-client-provider', async (i) => {
  const a = await i<typeof import('@/lib/crm/api/crm-client-provider')>()
  return { ...a, useCrmClient: () => mockClient }
})

const now = new Date().toISOString()
const mk = (o: Partial<Customer> = {}): Customer =>
  ({
    id: '7',
    name: 'X',
    rating: 'B',
    scoreScale: 'A',
    scorePay: 'A',
    scoreFit: 'B',
    scoreCoop: 'A',
    ownerId: 'u1',
    ownerName: '小王',
    status: 'active',
    source: 'referral',
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    address: null,
    website: null,
    annualRevenue: null,
    employeeCount: null,
    remark: null,
    lastFollowAt: null,
    nextFollowAt: null,
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...o,
  }) as Customer

describe('CrmValueProfileCard (P6a)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('展示 4 维度 + 综合档 badge', () => {
    render(<CrmValueProfileCard customer={mk()} />)
    expect(screen.getByText('体量与潜力')).toBeTruthy()
    expect(screen.getByText('付费能力与意愿')).toBeTruthy()
    expect(screen.getByText('跨境匹配度')).toBeTruthy()
    expect(screen.getByText('合作性')).toBeTruthy()
    expect(screen.getByText('综合档 B')).toBeTruthy()
  })

  it('未评分显示待完善', () => {
    render(
      <CrmValueProfileCard
        customer={mk({
          rating: null as unknown as string,
          scoreScale: null,
          scorePay: null,
          scoreFit: null,
          scoreCoop: null,
        })}
      />
    )
    expect(screen.getByText(/评分待完善|未评分/)).toBeTruthy()
  })

  it('编辑 → 选 A → 保存调 updateValueScores', async () => {
    mockUpdateValueScores.mockResolvedValue(
      mk({ scoreScale: 'A', scorePay: 'A', scoreFit: 'A', scoreCoop: 'A', rating: 'A' })
    )
    // 初始全 B，点 A 后 4 维都变更 → 全发
    render(<CrmValueProfileCard customer={mk({ scoreScale: 'B', scorePay: 'B', scoreFit: 'B', scoreCoop: 'B', rating: 'B' })} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑评分' }))
    const aBtns = await screen.findAllByRole('radio', { name: 'A' })
    expect(aBtns.length).toBe(4)
    aBtns.forEach((b) => fireEvent.click(b))
    fireEvent.click(screen.getByRole('button', { name: '保存评分' }))
    await waitFor(() =>
      expect(mockUpdateValueScores).toHaveBeenCalledWith('7', {
        score_scale: 'A',
        score_pay: 'A',
        score_fit: 'A',
        score_coop: 'A',
      })
    )
  })

  it('编辑模式 4 行各 4 档 radio', async () => {
    render(<CrmValueProfileCard customer={mk()} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑评分' }))
    expect(screen.getAllByRole('radio', { name: 'A' }).length).toBe(4)
    expect(screen.getAllByRole('radio', { name: 'D' }).length).toBe(4)
  })
})