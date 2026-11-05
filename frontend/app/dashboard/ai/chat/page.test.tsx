import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/chat/ai-chat-window', () => ({
  AIChatWindow: () => <div data-testid="ai-chat-window-stub" />,
}))

import DashboardAiChatPage from './page'
import AiChatLoading from './loading'

describe('AI Chat Warm Ledger fullscreen surface', () => {
  it('keeps the fullscreen viewport contract on a local Warm Ledger root', () => {
    const { container } = render(<DashboardAiChatPage />)

    const page = screen.getByTestId('ai-chat-fullscreen-page')
    expect(page).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(page).toHaveClass('warm-ledger')
    expect(screen.getByTestId('ai-chat-window-stub')).toBeInTheDocument()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
  })

  it('uses a Warm Ledger loading shell without terminal skeletons', () => {
    const { container } = render(<AiChatLoading />)

    expect(container.firstElementChild).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
  })
})
