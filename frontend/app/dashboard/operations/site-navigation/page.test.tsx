import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import SiteNavigationPage from './page'

afterEach(() => {
  cleanup()
})

describe('SiteNavigationPage Warm Ledger 契约', () => {
  it('使用 Warm Ledger 导航壳且不混用 Terminal 表面', () => {
    const { container } = render(<SiteNavigationPage />)

    const page = screen.getByTestId('site-navigation-warm-page')
    expect(page).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('保留真实外链并在新标签页打开', () => {
    render(<SiteNavigationPage />)

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(7)
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
    }
    expect(screen.getByRole('link', { name: /Amazon/ })).toHaveAttribute(
      'href',
      'https://www.amazon.com'
    )
  })
})
