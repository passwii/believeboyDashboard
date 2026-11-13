import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Review Tracking Warm Ledger stylesheet contract', () => {
  it('uses Warm tokens and reflows filters, target selection, and review data for phones', () => {
    const cssPath = join(__dirname, 'review-tracking-warm.module.css')
    expect(() => readFileSync(cssPath, 'utf8')).not.toThrow()
    const css = readFileSync(cssPath, 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).not.toContain('--term-')
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/)
    expect(css).toMatch(/\.tableScroll\s*\{[^}]*overflow:\s*auto/s)
    expect(css).toMatch(
      /\.layout,\s*\.loadingLayout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
    )
  })
})
