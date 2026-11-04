import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { client, getRefreshHandler, setRefreshHandler, notify } = vi.hoisted(() => {
  const client = {
    listProposals: vi.fn(),
    listCustomers: vi.fn(),
    createProposal: vi.fn(),
    downloadProposalVersion: vi.fn(),
    deleteProposal: vi.fn(),
  }
  let handler: (() => void | Promise<void>) | null = null
  return {
    client,
    notify: vi.fn(),
    getRefreshHandler: () => handler,
    setRefreshHandler: (next: () => void | Promise<void>) => { handler = next },
  }
})

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void | Promise<void>) => {
    setRefreshHandler(handler)
    return { setLoading: vi.fn() }
  },
}))
vi.mock('@/lib/crm/api/crm-client-provider', () => ({ useCrmClient: () => client }))
vi.mock('@/hooks/use-crm-data-scope', () => ({
  useCrmDataScope: () => ({ scope: 'all', setScope: vi.fn(), currentUserId: 'user-1' }),
}))
vi.mock('@/components/notifications', () => ({ useNotifications: () => ({ notify }) }))
vi.mock('@/hooks/use-confirm', () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(false) }) }))
vi.mock('@/components/crm/proposal', () => ({
  // 暴露一个触发 onSubmit 的按钮，让用例能驱动上传失败路径（BLF-1404）。
  ProposalCreateForm: ({ onSubmit }: { onSubmit: (input: unknown) => void }) => (
    <button type="button" onClick={() => onSubmit({ file: new File(['x'], 'a.html') })}>
      触发上传
    </button>
  ),
  ProposalStatusPill: ({ status }: { status: string }) => <span>{status}</span>,
  ProposalTypePill: ({ type }: { type: string }) => <span>{type}</span>,
}))
vi.mock('../customers/components/scope-toggle', () => ({ ScopeToggle: () => null }))

import ProposalsPage from './page'
import { ApiError } from '@/lib/crm/api/http-crm-client'

const PROPOSALS = [{
  id: 'proposal-1',
  customerId: 'customer-1',
  customerName: '客户甲',
  title: '北美春季方案',
  proposalType: 'other',
  status: 'draft',
  currentVersionNo: 2,
  versionCount: 2,
  updatedAt: '2026-10-01T00:00:00Z',
}]

beforeEach(() => {
  vi.clearAllMocks()
  client.listProposals.mockResolvedValue({ items: PROPOSALS, total: 1, page: 1, pageSize: 50 })
  client.listCustomers.mockResolvedValue({ items: [] })
})

describe('客户方案 Head 刷新', () => {
  it('查询条件变化时隐藏旧列表，失败不残留旧范围结果', async () => {
    let requestCount = 0
    client.listProposals.mockImplementation(async () => {
      requestCount += 1
      if (requestCount === 1) return { items: PROPOSALS, total: 1, page: 1, pageSize: 50 }
      throw new Error('新筛选加载失败')
    })

    render(<ProposalsPage />)
    await screen.findByText('北美春季方案')

    fireEvent.change(screen.getByLabelText('搜索方案标题'), { target: { value: '冬季' } })
    expect(screen.queryByText('北美春季方案')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('新筛选加载失败'))
    expect(screen.queryByText('北美春季方案')).not.toBeInTheDocument()
    expect(screen.getByText('共 0 个方案')).toBeInTheDocument()
  })

  it('按当前关键词、状态和 scope 重取列表，不丢筛选', async () => {
    render(<ProposalsPage />)
    await screen.findByText('北美春季方案')

    fireEvent.change(screen.getByLabelText('搜索方案标题'), { target: { value: '春季' } })
    fireEvent.change(screen.getByLabelText('按状态筛选'), { target: { value: 'draft' } })
    await waitFor(() => expect(client.listProposals).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: 'all', keyword: '春季', filters: [{ field: 'status', op: 'eq', value: 'draft' }], pageSize: 50,
    })))

    const beforeRefresh = client.listProposals.mock.calls.length
    await act(async () => { await getRefreshHandler()?.() })

    expect(client.listProposals).toHaveBeenCalledTimes(beforeRefresh + 1)
    expect(client.listProposals).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: 'all', keyword: '春季', filters: [{ field: 'status', op: 'eq', value: 'draft' }], pageSize: 50,
    }))
    expect(screen.getByLabelText('搜索方案标题')).toHaveValue('春季')
    expect(screen.getByLabelText('按状态筛选')).toHaveValue('draft')
  })
})

/**
 * BLF-1407：新增「调研方案」类型（`research`）。
 *
 * 列表页的「按类型筛选」下拉是枚举驱动的（map `PROPOSAL_TYPE_ORDER`），
 * 这里钉住两件事：
 *   1. 下拉里能选到「调研方案」；
 *   2. 选了之后真的把 `proposal_type eq research` 传给后端。
 * 只改 union 不改 ORDER/LABELS 时，第 1 条就会红。
 */
describe('BLF-1407: 类型筛选支持「调研方案」', () => {
  it('筛选下拉含「调研方案」，选中后按 proposal_type=research 查询', async () => {
    render(<ProposalsPage />)
    await screen.findByText('北美春季方案')

    const typeSelect = screen.getByLabelText('按类型筛选') as HTMLSelectElement
    const options = Array.from(typeSelect.options).map((o) => ({
      value: o.value,
      label: o.textContent,
    }))
    expect(options).toContainEqual({ value: 'research', label: '调研方案' })

    fireEvent.change(typeSelect, { target: { value: 'research' } })
    await waitFor(() =>
      expect(client.listProposals).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filters: [{ field: 'proposal_type', op: 'eq', value: 'research' }],
        })
      )
    )
  })
})

/**
 * BLF-1404：上传失败按状态码给可区分文案（413 文件过大 / 504 超时 / 其它保留原文）。
 * 这里验证的是**页面真的接上了** `proposalUploadErrorCopy`（单元逻辑在
 * `lib/crm/method/proposal-upload-error.test.ts`）。
 */
describe('BLF-1404: 方案上传失败的错误文案分档', () => {
  async function submitAndCatch() {
    render(<ProposalsPage />)
    await screen.findByText('北美春季方案')
    // 上传表单在「新建方案」弹窗里（默认关闭）→ 先开弹窗再点上传。
    fireEvent.click(screen.getByRole('button', { name: '新建方案' }))
    fireEvent.click(await screen.findByRole('button', { name: '触发上传' }))
    await waitFor(() => expect(notify).toHaveBeenCalled())
    return notify.mock.calls.at(-1)?.[0] as { type: string; title: string; message: string }
  }

  it('413 → 「文件过大」并带 20MB 上限', async () => {
    client.createProposal.mockRejectedValue(
      new ApiError(413, '文件超过 20971520 字节上限', { detail: '文件超过 20971520 字节上限' })
    )

    const call = await submitAndCatch()

    expect(call.type).toBe('error')
    expect(call.title).toBe('文件过大')
    expect(call.message).toContain('20MB')
  })

  /**
   * BLF-1404 复核（Codex P1）：平台网关 413（非 JSON 体）不能报 20MB ——
   * 用户传 5MB 也会撞 Vercel 4.5MB 网关，报「超过 20MB」是误导，
   * 且会把用户引向「再压缩」这个无效动作。
   */
  it('平台网关 413（非 JSON 体）→ 不提 20MB，改报平台体积限制', async () => {
    // body 为 undefined = 网关在函数之前拒了（纯文本错误体，res.json() 抛错）
    client.createProposal.mockRejectedValue(new ApiError(413, 'CRM 请求失败（413）'))

    const call = await submitAndCatch()

    expect(call.title).toBe('文件过大')
    expect(call.message).not.toContain('20MB')
    expect(call.message).toContain('4MB')
  })

  it('504 → 「上传超时」并建议重试', async () => {
    client.createProposal.mockRejectedValue(new ApiError(504, '请求后端服务超时，请稍后重试。'))

    const call = await submitAndCatch()

    expect(call.title).toBe('上传超时')
    expect(call.message).toContain('重试')
  })

  it('其它错误 → 保留后端 detail 原文', async () => {
    client.createProposal.mockRejectedValue(
      new ApiError(400, '不支持的文件类型：仅接受单个 HTML 文件（.html / .htm）')
    )

    const call = await submitAndCatch()

    expect(call.title).toBe('创建失败')
    expect(call.message).toContain('不支持的文件类型')
  })
})

describe('Warm Ledger 方案列表', () => {
  it('使用 Warm CRM 页面、工具行与表格框架承载现有行为', async () => {
    const { container } = render(<ProposalsPage />)
    await screen.findByText('北美春季方案')

    expect(container.querySelector('[data-warm-crm-page]')).toBeInTheDocument()
    expect(container.querySelector('[data-warm-crm-toolbar]')).toBeInTheDocument()
    expect(container.querySelector('[data-warm-crm-table-frame]')).toBeInTheDocument()
    expect(container.querySelector('[data-table-scroll]')).toBeInTheDocument()
  })
})
