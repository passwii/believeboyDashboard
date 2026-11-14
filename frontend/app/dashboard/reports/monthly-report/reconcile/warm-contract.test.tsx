import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

function read(name: string) {
  return readFileSync(join(__dirname, name), 'utf8')
}

describe('报表核对 Warm Ledger contract', () => {
  it('preserves the page and both reconciliation surfaces with Warm markers', () => {
    expect(read('page.tsx')).toContain('data-warm-monthly-reconcile="true"')
    expect(read('auto-reconcile-tab.tsx')).toContain('data-warm-auto-reconcile="true"')
    expect(read('manual-reconcile-tab.tsx')).toContain('data-warm-manual-reconcile="true"')
  })

  it('uses Warm tables, status tones, and desktop-contained scrolling', () => {
    const auto = read('auto-reconcile-tab.tsx')
    const manual = read('manual-reconcile-tab.tsx')
    const css = read('reconcile-warm.module.css')

    expect(auto).toContain('data-warm-table-scroll="true"')
    expect(manual).toContain('data-warm-table-scroll="true"')
    expect(css).toContain('overflow-x: auto')
    expect(css).toContain('var(--warm-ledger-font-mono)')
    expect(css).toContain('var(--warm-ledger-color-positive)')
    expect(css).toContain('var(--warm-ledger-color-negative)')
  })

  it('does not leave Terminal visual aliases or new page breakpoints', () => {
    for (const source of [
      read('page.tsx'),
      read('auto-reconcile-tab.tsx'),
      read('manual-reconcile-tab.tsx'),
    ]) {
      expect(source).not.toContain('rounded-none')
      expect(source).not.toMatch(/\b(?:bg|border|text|divide)-term-/)
    }

    const css = read('reconcile-warm.module.css')
    expect(css).not.toContain('--term-')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/)
    expect(css).toMatch(/\.tableScroll\s*\{[^}]*overflow(?:-x)?:\s*auto/s)
  })
})
