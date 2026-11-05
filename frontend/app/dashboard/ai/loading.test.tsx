import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import AiLoading from './loading'

describe('AI loading Warm Ledger surface', () => {
  it('renders a local Warm Ledger loading shell', () => {
    const { container } = render(<AiLoading />)

    expect(screen.getByTestId('ai-loading-warm-page')).toHaveAttribute(
      'data-warm-surface',
      'warm-ledger'
    )
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
  })
})
