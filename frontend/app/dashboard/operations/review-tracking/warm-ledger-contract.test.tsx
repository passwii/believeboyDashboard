import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Review Tracking Warm Ledger stylesheet contract', () => {
  it('uses Warm tokens with no Terminal aliases or new page breakpoints', () => {
    const cssPath = join(__dirname, 'review-tracking-warm.module.css')
    expect(() => readFileSync(cssPath, 'utf8')).not.toThrow()
    const css = readFileSync(cssPath, 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).not.toContain('--term-')
    expect(css).not.toContain('@media')
  })
})
