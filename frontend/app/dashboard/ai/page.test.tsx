import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/chat/ai-chat-window', () => ({
  AIChatWindow: () => <div data-testid="ai-chat-window-stub" />,
}))

import AiLandingPage from './page'

describe('AI landing Warm Ledger fullscreen surface', () => {
  it('uses a local fullscreen Warm Ledger root and Warm entry link', () => {
    const { container } = render(<AiLandingPage />)

    const page = screen.getByTestId('ai-landing-warm-page')
    expect(page).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(page).toHaveClass('warm-ledger')
    expect(screen.getByRole('link', { name: /进入 AI Chat/ })).toBeInTheDocument()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
  })
})
