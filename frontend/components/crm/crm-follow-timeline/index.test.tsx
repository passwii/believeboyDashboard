import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CrmFollowTimeline } from './index'
import type { Follow } from '@/lib/crm/types/follow'

const follows: Follow[] = [
  {
    id: 'f1',
    entityType: 'customer',
    entityId: 'c1',
    type: 'phone',
    content: '首次电话沟通',
    createdBy: 'u1',
    createdByName: '小王',
    createdAt: new Date().toISOString(),
  },
]

describe('CrmFollowTimeline', () => {
  it('渲染已有跟进记录', () => {
    render(
      <CrmFollowTimeline entityType="customer" entityId="c1" follows={follows} onSubmit={vi.fn()} />
    )
    expect(screen.getByText('首次电话沟通')).toBeTruthy()
    // createdByName 与相对时间拼在同一 span：小王 · 今天
    expect(screen.getByText((_, el) => !!el && el.textContent?.startsWith('小王') === true)).toBeTruthy()
  })

  it('空记录显示空态', () => {
    render(<CrmFollowTimeline entityType="customer" entityId="c1" follows={[]} onSubmit={vi.fn()} />)
    expect(screen.getByText('暂无跟进记录')).toBeTruthy()
  })

  it('填写内容并提交回调', async () => {
    const onSubmit = vi.fn()
    render(<CrmFollowTimeline entityType="customer" entityId="c1" follows={[]} onSubmit={onSubmit} />)
    const textarea = screen.getByPlaceholderText('记录本次跟进内容…')
    fireEvent.change(textarea, { target: { value: '回访客户' } })
    fireEvent.click(screen.getByText('添加跟进'))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ content: '回访客户', type: 'phone' })
    )
  })

  it('内容为空时禁用提交', () => {
    render(<CrmFollowTimeline entityType="customer" entityId="c1" follows={[]} onSubmit={vi.fn()} />)
    expect(screen.getByText('添加跟进')).toBeDisabled()
  })
})
