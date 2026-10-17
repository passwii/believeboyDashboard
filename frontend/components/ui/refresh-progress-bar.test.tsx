import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RefreshProgressBar } from './refresh-progress-bar'

describe('RefreshProgressBar', () => {
  it('marks only the refreshed region busy without blocking reading or unrelated controls', () => {
    render(
      <RefreshProgressBar refreshing>
        <button type="button">筛选</button>
        <p>当前结果</p>
      </RefreshProgressBar>
    )

    const region = screen.getByText('当前结果').parentElement
    expect(region).toHaveAttribute('aria-busy', 'true')
    expect(region).not.toHaveClass('pointer-events-none')
    expect(screen.getByRole('button', { name: '筛选' })).toBeEnabled()
    expect(screen.getByText('当前结果')).toBeVisible()
    expect(screen.getByTestId('refresh-progress-indicator')).toHaveClass('bg-term-accent')
  })

  it('does not mark a resting region busy or render progress', () => {
    render(
      <RefreshProgressBar refreshing={false}>
        <p>内容</p>
      </RefreshProgressBar>
    )

    expect(screen.getByTestId('refresh-progress-region')).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByTestId('refresh-progress-indicator')).not.toBeInTheDocument()
  })
})
