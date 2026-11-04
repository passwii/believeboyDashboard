import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const notify = vi.hoisted(() => vi.fn())

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
}))

import { OrderEditDialog } from './OrderEditDialog'

const order = {
  id: 101,
  amazon_order_id: '111-1111111-0000001',
  sku: 'SKU-A',
  asin: 'B0TEST0001',
  product_name: '测试商品A',
  project_name: '店铺A',
  quantity: 2,
  country: 'US',
}

describe('OrderEditDialog', () => {
  beforeEach(() => {
    notify.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('把每个可见字段标签程序化关联到对应控件', () => {
    render(
      <OrderEditDialog
        open
        onOpenChange={vi.fn()}
        order={order}
        authHeaders={() => new Headers()}
      />
    )

    const controls = [
      screen.queryByLabelText('物流商（Carrier）'),
      screen.queryByLabelText('物流单号（Tracking No.）'),
      screen.queryByLabelText('发货时间（Shipped At · 北京时间）'),
      screen.queryByLabelText('操作人（Updated By）'),
    ]

    expect(controls).not.toContain(null)
  })

  it('字段留空时仍按现有行为跳过 PATCH', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const onOpenChange = vi.fn()
    const user = userEvent.setup()

    render(
      <OrderEditDialog
        open
        onOpenChange={onOpenChange}
        order={order}
        authHeaders={() => new Headers()}
      />
    )

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
