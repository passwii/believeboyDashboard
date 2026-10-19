import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, notify } from '@/test-utils/stable-mocks'

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

import { ExternalTargetsPanel } from './external-targets-panel'
import type { ExternalTarget } from '@/lib/review-tracking-api'
import type { ShopOption } from '@/lib/review-tracking-shops'

const SHOPS: ShopOption[] = [
  { id: 11, shopId: 'kjvs-11', shopName: '店铺A', country: 'US', projectId: 1, projectName: '项目A' },
]

function target(overrides: Partial<ExternalTarget> = {}): ExternalTarget {
  return {
    id: 5,
    marketplace: 'US',
    asin: 'B0CCCCCCC3',
    displayName: '竞品 C',
    isActive: true,
    links: [],
    activeLinkCount: 0,
    ...overrides,
  }
}

function renderPanel(props: Partial<React.ComponentProps<typeof ExternalTargetsPanel>> = {}) {
  const onCreate = vi.fn().mockResolvedValue(undefined)
  const onLink = vi.fn().mockResolvedValue(undefined)
  const onUnlink = vi.fn().mockResolvedValue(undefined)
  const onError = vi.fn()

  render(
    <ExternalTargetsPanel
      targets={props.targets ?? [target()]}
      shopOptions={props.shopOptions ?? SHOPS}
      shopOptionsLoading={props.shopOptionsLoading ?? false}
      isAdmin={props.isAdmin ?? true}
      busy={props.busy ?? false}
      onCreate={props.onCreate ?? onCreate}
      onLink={props.onLink ?? onLink}
      onUnlink={props.onUnlink ?? onUnlink}
      onError={props.onError ?? onError}
    />
  )

  return { onCreate, onLink, onUnlink, onError }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('ExternalTargetsPanel 权限门禁', () => {
  it('非管理员看不到登记表单与关联/移除按钮', () => {
    renderPanel({ isAdmin: false })

    expect(screen.queryByText('登记外部竞品 ASIN')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /关联店铺/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /移除关联/ })).not.toBeInTheDocument()
    expect(screen.getByText(/仅管理员可操作/)).toBeInTheDocument()
  })

  it('管理员可见登记表单', () => {
    renderPanel({ isAdmin: true })
    expect(screen.getByText('登记外部竞品 ASIN')).toBeInTheDocument()
  })
})

describe('ExternalTargetsPanel 登记与关联', () => {
  it('登记时 ASIN 自动大写并带上站点与展示名', async () => {
    const { onCreate } = renderPanel()

    fireEvent.change(screen.getByLabelText('ASIN'), { target: { value: 'b0ddddddd4' } })
    fireEvent.change(screen.getByLabelText('展示名称'), { target: { value: '竞品 D' } })
    fireEvent.click(screen.getByRole('button', { name: /登记/ }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate).toHaveBeenCalledWith({
      marketplace: 'US',
      asin: 'B0DDDDDDD4',
      shopId: null,
      displayName: '竞品 D',
    })
  })

  it('登记失败交给 onError（不吞错）', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('boom'))
    const onError = vi.fn()
    renderPanel({ onCreate, onError })

    fireEvent.change(screen.getByLabelText('ASIN'), { target: { value: 'B0DDDDDDD4' } })
    fireEvent.click(screen.getByRole('button', { name: /登记/ }))

    await waitFor(() => expect(onError).toHaveBeenCalled())
  })

  it('关联店铺走 onLink(targetId, shopId)', async () => {
    const { onLink } = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /关联店铺/ }))
    fireEvent.click(screen.getByLabelText('选择要关联的店铺'))
    fireEvent.click(await screen.findByText(/项目A \/ 店铺A/))
    fireEvent.click(screen.getByRole('button', { name: '关联' }))

    await waitFor(() => expect(onLink).toHaveBeenCalledWith(5, 11))
  })
})

describe('ExternalTargetsPanel 软删语义', () => {
  it('已关联店铺展示移除按钮，文案写明只是软删', async () => {
    const { onUnlink } = renderPanel({
      targets: [
        target({ links: [{ id: 7, shopId: 11, isActive: true }], activeLinkCount: 1 }),
      ],
    })

    expect(screen.getByText(/项目A \/ 店铺A/)).toBeInTheDocument()
    expect(screen.getByText(/软删/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /移除关联/ }))
    await waitFor(() => expect(onUnlink).toHaveBeenCalledWith(5, 7))
  })

  it('已移除（is_active=false）的关联不展示为有效关联', () => {
    renderPanel({
      targets: [
        target({ links: [{ id: 7, shopId: 11, isActive: false }], activeLinkCount: 0 }),
      ],
    })

    expect(screen.getByText('尚未关联店铺')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /移除关联/ })).not.toBeInTheDocument()
  })

  it('关联提示说明「复活并沿用历史」，不误导为新建历史', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /关联店铺/ }))
    // 常驻脚注 + 关联面板各一处，至少一处写明「复活并沿用历史」
    expect(screen.getAllByText(/复活原记录并沿用历史/).length).toBeGreaterThanOrEqual(1)
  })
})

describe('ExternalTargetsPanel 空态', () => {
  it('没有外部竞品时显示空态', () => {
    renderPanel({ targets: [] })
    expect(screen.getByText('还没有登记外部竞品')).toBeInTheDocument()
  })

  it('不触发任何通知（面板只通过回调上报）', () => {
    renderPanel({ targets: [] })
    expect(notify).not.toHaveBeenCalled()
  })
})
