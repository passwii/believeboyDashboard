import { afterEach, describe, expect, it } from 'vitest'

import { WARM_LEDGER_FALLBACK_COLORS, readWarmLedgerColor, readWarmLedgerColors } from './warm-ledger-colors'

describe('warm ledger colour reader', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('falls back to the dark baseline without a host element', () => {
    expect(readWarmLedgerColor('accent')).toBe(WARM_LEDGER_FALLBACK_COLORS.accent)
    expect(readWarmLedgerColor('window')).toBe(WARM_LEDGER_FALLBACK_COLORS.window)
  })

  it('reads the resolved token value from the warm ledger host', () => {
    const host = document.createElement('div')
    host.className = 'warm-ledger'
    host.style.setProperty('--warm-ledger-color-accent', '#0f6b57')
    host.style.setProperty('--warm-ledger-color-panel', '#ffffff')
    document.body.appendChild(host)

    expect(readWarmLedgerColor('accent')).toBe('#0f6b57')
    expect(readWarmLedgerColor('panel', host)).toBe('#ffffff')
  })

  it('reads a batch of colours for export canvases', () => {
    const host = document.createElement('div')
    host.style.setProperty('--warm-ledger-color-text-muted', '#565f58')
    document.body.appendChild(host)

    const colours = readWarmLedgerColors(['textMuted', 'textFaint'], host)
    expect(colours.textMuted).toBe('#565f58')
    expect(colours.textFaint).toBe(WARM_LEDGER_FALLBACK_COLORS.textFaint)
  })

  it('ignores empty token declarations and keeps the fallback', () => {
    const host = document.createElement('div')
    host.style.setProperty('--warm-ledger-color-accent', '')
    document.body.appendChild(host)

    expect(readWarmLedgerColor('accent', host)).toBe(WARM_LEDGER_FALLBACK_COLORS.accent)
  })
})
