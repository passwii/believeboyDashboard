import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { getInsightStatusTone, InsightStatus } from './insight-status'

describe('InsightStatus', () => {
  it('publishes determinate progress only when a value is known', () => {
    const { container, rerender } = render(
      <InsightStatus status="live" label="正在生成第 2 节" progress={42} />
    )

    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).toHaveAttribute('aria-valuenow', '42')

    rerender(<InsightStatus status="live" label="正在生成第 2 节" progress={null} />)
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('surfaces the error text and only offers actions that are meaningful for the state', () => {
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <InsightStatus
        status="failed"
        label="生成失败"
        error={{ code: 'MODEL_UNAVAILABLE', message: '模型暂不可用', retryable: true }}
        onRetry={onRetry}
        onCancel={onCancel}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('模型暂不可用')
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(<InsightStatus status="live" label="正在聚合数据" onRetry={onRetry} onCancel={onCancel} />)
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders the background continuation notice while detached', () => {
    render(
      <InsightStatus
        status="reconnecting"
        label="连接中断，正在重连"
        backgroundMessage="任务仍在后台运行，可稍后查看"
      />
    )

    expect(screen.getByText('任务仍在后台运行，可稍后查看')).toBeInTheDocument()
    expect(getInsightStatusTone('reconnecting')).toBe('warning')
    expect(getInsightStatusTone('live', true)).toBe('danger')
  })
})
