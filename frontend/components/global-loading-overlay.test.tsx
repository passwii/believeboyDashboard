import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GlobalLoadingOverlay } from './global-loading-overlay'
import { GlobalLoadingProvider, useGlobalLoading } from './global-loading-provider'

function BlockingLoadControls() {
  const { startGlobalLoading } = useGlobalLoading()

  return (
    <button type="button" onClick={() => startGlobalLoading('blocking')}>
      Start loading
    </button>
  )
}

describe('GlobalLoadingOverlay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows one loading indicator for blocking work', () => {
    vi.useFakeTimers()
    const { container } = render(
      <GlobalLoadingProvider>
        <BlockingLoadControls />
        <GlobalLoadingOverlay />
      </GlobalLoadingProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start loading' }))
    act(() => {
      vi.advanceTimersByTime(180)
    })

    expect(screen.getByText('加载中，请稍候...')).toBeInTheDocument()
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(1)
    expect(container.querySelector('.global-loading-track')).not.toBeInTheDocument()
  })
})
