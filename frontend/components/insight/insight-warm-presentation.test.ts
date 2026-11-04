import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('Insight Warm presentation contract', () => {
  it('styles only with Warm tokens and does not add responsive breakpoints', () => {
    const css = readFileSync(join(import.meta.dirname, 'insight-warm.module.css'), 'utf8')

    expect(css).toContain('--warm-ledger-color-panel')
    expect(css).toContain('--warm-ledger-radius-panel')
    expect(css).not.toContain('--term-')
    expect(css).not.toContain('@media')
  })
})
