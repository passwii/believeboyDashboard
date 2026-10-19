import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notify, stableNotifications } from '@/test-utils/stable-mocks'

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

const mockConfirm = vi.fn().mockResolvedValue(true)
vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}))

const {
  fetchReviewGroups,
  createReviewGroup,
  patchReviewGroup,
  deactivateReviewGroup,
} = vi.hoisted(() => ({
  fetchReviewGroups: vi.fn(),
  createReviewGroup: vi.fn(),
  patchReviewGroup: vi.fn(),
  deactivateReviewGroup: vi.fn(),
}))

vi.mock('@/lib/review-tracking-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/review-tracking-api')>()
  return {
    ...actual,
    fetchReviewGroups,
    createReviewGroup,
    patchReviewGroup,
    deactivateReviewGroup,
  }
})

import ReviewGroupSheet, { type SkuCandidate } from './review-group-sheet'
import { ReviewTrackingApiError, type ReviewGroup } from '@/lib/review-tracking-api'

const CANDIDATES: SkuCandidate[] = [
  { id: 101, sku: 'SKU-A', asin: 'B0AAAAAAA1', productName: '商品一' },
  { id: 102, sku: 'SKU-B', asin: 'B0BBBBBBB2', productName: '商品二' },
]

const GROUP: ReviewGroup = {
  id: 3,
  projectId: 18,
  marketplace: 'US',
  name: '组 A',
  description: null,
  representativeId: 101,
  memberIds: [101, 102],
  isActive: true,
}

function renderSheet(overrides: Partial<React.ComponentProps<typeof ReviewGroupSheet>> = {}) {
  const onClose = vi.fn()
  const onChanged = vi.fn()
  render(
    <ReviewGroupSheet
      open
      onClose={overrides.onClose ?? onClose}
      // 注意：projectId 显式传 null 有意义（缺少项目上下文），不能用 ?? 兜底
      projectId={'projectId' in overrides ? (overrides.projectId as number | null) : 18}
      projectName={overrides.projectName ?? '项目A'}
      marketplace={overrides.marketplace ?? 'US'}
      candidates={overrides.candidates ?? CANDIDATES}
      currentSkuId={'currentSkuId' in overrides ? (overrides.currentSkuId as number | null) : 101}
      onChanged={overrides.onChanged ?? onChanged}
    />
  )
  return { onClose, onChanged }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchReviewGroups.mockResolvedValue([GROUP])
})

afterEach(cleanup)

describe('ReviewGroupSheet 列表', () => {
  it('按项目 + 站点拉取有效共享组，并展示成员与代表', async () => {
    renderSheet()

    await waitFor(() =>
      expect(fetchReviewGroups).toHaveBeenCalledWith({
        projectId: 18,
        marketplace: 'US',
        isActive: true,
      })
    )
    expect(await screen.findByTestId('review-group-3')).toBeInTheDocument()
    expect(screen.getByText('组 A')).toBeInTheDocument()
    // 代表 ASIN + 成员 ASIN 列表
    expect(screen.getAllByText(/B0AAAAAAA1/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/B0AAAAAAA1 \/ B0BBBBBBB2/).length).toBe(1)
  })

  it('没有组时显示空态', async () => {
    fetchReviewGroups.mockResolvedValueOnce([])
    renderSheet()
    expect(await screen.findByText('该站点下还没有评论共享组')).toBeInTheDocument()
  })

  it('缺少项目信息时不允许提交', async () => {
    renderSheet({ projectId: null })
    await waitFor(() => expect(fetchReviewGroups).not.toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('组名'), { target: { value: '新组' } })
    fireEvent.click(screen.getByRole('button', { name: '创建共享组' }))

    await waitFor(() => expect(notify).toHaveBeenCalled())
    expect(createReviewGroup).not.toHaveBeenCalled()
  })
})

describe('ReviewGroupSheet 建组', () => {
  it('默认把当前 SKU 预选为成员与代表', async () => {
    renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.change(screen.getByLabelText('组名'), { target: { value: '新共享组' } })
    fireEvent.click(screen.getByRole('button', { name: '创建共享组' }))

    await waitFor(() => expect(createReviewGroup).toHaveBeenCalledTimes(1))
    expect(createReviewGroup).toHaveBeenCalledWith({
      projectId: 18,
      marketplace: 'US',
      name: '新共享组',
      description: null,
      memberIds: [101],
      representativeId: 101,
    })
  })

  it('组名为空时报错且不提交', async () => {
    renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.click(screen.getByRole('button', { name: '创建共享组' }))

    await waitFor(() => expect(notify).toHaveBeenCalled())
    expect(createReviewGroup).not.toHaveBeenCalled()
  })
})

describe('ReviewGroupSheet 编辑与停用', () => {
  it('编辑时用组的当前成员/代表填充，并走 PATCH', async () => {
    patchReviewGroup.mockResolvedValue({ ...GROUP, name: '组 A2' })
    renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('组名'), { target: { value: '组 A2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(patchReviewGroup).toHaveBeenCalledTimes(1))
    expect(patchReviewGroup).toHaveBeenCalledWith(3, {
      name: '组 A2',
      description: null,
      memberIds: [101, 102],
      representativeId: 101,
    })
  })

  it('停用需要二次确认，成功后调用 deactivate 并通知父级刷新', async () => {
    deactivateReviewGroup.mockResolvedValue({ ...GROUP, isActive: false })
    const { onChanged } = renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.click(screen.getByRole('button', { name: '停用' }))

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    await waitFor(() => expect(deactivateReviewGroup).toHaveBeenCalledWith(3))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('取消确认时不调用停用接口', async () => {
    mockConfirm.mockResolvedValueOnce(false)
    renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.click(screen.getByRole('button', { name: '停用' }))

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    expect(deactivateReviewGroup).not.toHaveBeenCalled()
  })

  it('409 冲突给出可执行提示（同名组 / SKU 已在其他组）', async () => {
    createReviewGroup.mockRejectedValueOnce(new ReviewTrackingApiError(409, 'name already exists'))
    renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.change(screen.getByLabelText('组名'), { target: { value: '重名组' } })
    fireEvent.click(screen.getByRole('button', { name: '创建共享组' }))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: '共享组冲突' })
      )
    )
  })

  it('403 提示需要管理员权限（不静默）', async () => {
    createReviewGroup.mockRejectedValueOnce(new ReviewTrackingApiError(403, 'forbidden'))
    renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.change(screen.getByLabelText('组名'), { target: { value: '新组' } })
    fireEvent.click(screen.getByRole('button', { name: '创建共享组' }))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('运营与管理员') })
      )
    )
  })
})

describe('ReviewGroupSheet 换代表同时移除旧代表（后端中间态 422 规避）', () => {
  it('拆两次 PATCH：先保留旧代表并切代表，再移除旧代表', async () => {
    patchReviewGroup.mockResolvedValue(GROUP)
    renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    // 成员多选（非「代表 ASIN」那个 combobox）里取消勾选 SKU-A（原代表 101）
    const memberTrigger = screen
      .getAllByRole('combobox')
      .find((trigger) => trigger.getAttribute('aria-label') !== '代表 ASIN')
    expect(memberTrigger).toBeTruthy()
    fireEvent.pointerDown(memberTrigger!, { pointerType: 'mouse', ctrlKey: false })
    fireEvent.click(memberTrigger!)
    fireEvent.click(await screen.findByRole('option', { name: /SKU-A · B0AAAAAAA1/ }))

    // 成员变化会清掉失效代表，这里重新指定 SKU-B（102）
    const repTrigger = screen.getByRole('combobox', { name: '代表 ASIN' })
    fireEvent.pointerDown(repTrigger, { pointerType: 'mouse', ctrlKey: false })
    fireEvent.click(repTrigger)
    fireEvent.click(await screen.findByRole('option', { name: 'SKU-B · B0BBBBBBB2' }))

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(patchReviewGroup).toHaveBeenCalledTimes(2))
    // 第一次：最终成员 ∪ {旧代表} + 新代表（旧代表仍在成员内 → 中间态合法）
    expect(patchReviewGroup).toHaveBeenNthCalledWith(1, 3, {
      name: '组 A',
      description: null,
      memberIds: [102, 101],
      representativeId: 102,
    })
    // 第二次：移除旧代表（此时当前代表已是 102，仍在成员内）
    expect(patchReviewGroup).toHaveBeenNthCalledWith(2, 3, { memberIds: [102] })
  })

  it('不换代表时只提交一次 PATCH', async () => {
    patchReviewGroup.mockResolvedValue(GROUP)
    renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('组名'), { target: { value: '组 A3' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(patchReviewGroup).toHaveBeenCalledTimes(1))
  })

  it('组名超过 255 字符时前置拦截，不提交', async () => {
    renderSheet()
    await screen.findByTestId('review-group-3')

    fireEvent.change(screen.getByLabelText('组名'), { target: { value: 'x'.repeat(256) } })
    fireEvent.click(screen.getByRole('button', { name: '创建共享组' }))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: '组名不能超过 255 个字符' })
      )
    )
    expect(createReviewGroup).not.toHaveBeenCalled()
  })
})
