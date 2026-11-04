import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuditLog } from '@/lib/crm/types'

const { listAuditLogs } = vi.hoisted(() => ({
  listAuditLogs: vi.fn(),
}))

vi.mock('@/lib/crm/api/crm-client-provider', () => {
  const client = { listAuditLogs }
  return { useCrmClient: () => client }
})

vi.mock('@/hooks/use-crm-users', () => ({
  useCrmUsersSafe: () => [],
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

import CrmAuditPage from './page'

const now = '2026-11-04T08:30:00+00:00'

function auditLog(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: '1',
    entityType: 'customer',
    entityId: '42',
    action: 'update',
    actorId: 'user-1',
    actorName: '张三',
    summary: '客户名称: 青山贸易→青山国际',
    createdAt: now,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  listAuditLogs.mockResolvedValue({
    items: [auditLog()],
    total: 31,
    page: 1,
    pageSize: 30,
  })
})

describe('CRM 操作日志 Warm 迁移', () => {
  it('保留管理员查询参数、Warm 表格与分页行为', async () => {
    const { container } = render(<CrmAuditPage />)

    expect(await screen.findByText('张三')).toBeVisible()
    expect(listAuditLogs).toHaveBeenCalledWith({
      entityType: undefined,
      action: undefined,
      page: 1,
      pageSize: 30,
    })
    expect(container.querySelector('[data-warm-crm-page]')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '操作日志表格' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByText('第 1 / 2 页')).toBeVisible()
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => {
      expect(listAuditLogs).toHaveBeenLastCalledWith({
        entityType: undefined,
        action: undefined,
        page: 2,
        pageSize: 30,
      })
    })
  })

  it('筛选变化时回到第一页并保留对象筛选参数', async () => {
    render(<CrmAuditPage />)
    await screen.findByText('张三')

    const entityFilter = screen.getByRole('combobox', { name: '对象' })
    fireEvent.click(entityFilter)
    fireEvent.click(await screen.findByRole('option', { name: '客户' }))

    await waitFor(() => {
      expect(listAuditLogs).toHaveBeenLastCalledWith({
        entityType: 'customer',
        action: undefined,
        page: 1,
        pageSize: 30,
      })
    })
  })

  it('当前 403/错误映射保持为仅管理员提示', async () => {
    listAuditLogs.mockRejectedValueOnce(new Error('403'))
    render(<CrmAuditPage />)

    expect(await screen.findByText('无权限查看操作日志（仅管理员）')).toBeVisible()
    expect(screen.queryByRole('region', { name: '操作日志表格' })).not.toBeInTheDocument()
  })
})
