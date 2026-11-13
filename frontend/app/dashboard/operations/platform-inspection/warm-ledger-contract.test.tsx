import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Platform Inspection Warm Ledger stylesheet contract', () => {
  it('uses Warm tokens and adapts inspection cards, tables, and controls for phones', () => {
    const cssPath = join(__dirname, 'platform-inspection-warm.module.css')
    expect(() => readFileSync(cssPath, 'utf8')).not.toThrow()
    const css = readFileSync(cssPath, 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).not.toContain('--term-')
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/)
    expect(css).toMatch(/\.tableScroll\s*\{[^}]*overflow:\s*auto/s)
    expect(css).toContain('.metricsGrid')
    expect(css).toContain('--warm-ledger-control-target-touch')
  })
})
