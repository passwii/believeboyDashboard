import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, 'theme.css'), 'utf8')

type TokenMap = Map<string, string>

function readBlock(marker: string): TokenMap {
  const start = css.indexOf(marker)
  if (start === -1) return new Map()
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  if (open === -1 || close === -1) return new Map()

  const tokens: TokenMap = new Map()
  for (const declaration of css.slice(open + 1, close).split(';')) {
    const part = declaration.trim()
    if (!part) continue
    const separator = part.indexOf(':')
    if (separator === -1) continue
    tokens.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
  }
  return tokens
}

const darkTokens = readBlock('.warm-ledger {')
const lightTokens = readBlock('html.light .warm-ledger {')

const FROZEN_DARK: Record<string, string> = {
  '--warm-ledger-color-stage': '#1c1d1d',
  '--warm-ledger-color-window': '#242525',
  '--warm-ledger-color-sidebar': '#202120',
  '--warm-ledger-color-panel': '#2b2c2b',
  '--warm-ledger-color-text': '#f1ede5',
  '--warm-ledger-color-accent': '#e8b35a',
  '--warm-ledger-color-accent-strong': '#f3c875',
  '--warm-ledger-color-positive': '#65cfa1',
  '--warm-ledger-color-negative': '#ee8580',
}

const LIGHT_SURFACES = [
  '--warm-ledger-color-stage',
  '--warm-ledger-color-window',
  '--warm-ledger-color-sidebar',
  '--warm-ledger-color-panel',
  '--warm-ledger-color-panel-strong',
  '--warm-ledger-color-raised',
  '--warm-ledger-color-raised-hover',
]

function parseHex(color: string) {
  return color.trim().slice(1).match(/.{2}/g)!.map((part) => parseInt(part, 16))
}

function hexChannel(value: number) {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(color: string) {
  const channels = parseHex(color)
  return 0.2126 * hexChannel(channels[0]) + 0.7152 * hexChannel(channels[1]) + 0.0722 * hexChannel(channels[2])
}

function contrast(foreground: string, background: string) {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function hue(color: string) {
  const [r, g, b] = parseHex(color)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  let raw: number
  if (max === r) raw = 60 * (((g - b) / delta) % 6)
  else if (max === g) raw = 60 * ((b - r) / delta + 2)
  else raw = 60 * ((r - g) / delta + 4)
  return raw < 0 ? raw + 360 : raw
}

describe('Warm Ledger light mode tokens', () => {
  it('keeps the approved dark baseline unchanged', () => {
    for (const [name, value] of Object.entries(FROZEN_DARK)) {
      expect(darkTokens.get(name), name).toBe(value)
    }
    expect(darkTokens.get('--warm-ledger-color-scrim')).toBe('rgba(0, 0, 0, 0.55)')
  })

  it('declares the light surface layer with every dark colour role', () => {
    expect(lightTokens.size).toBeGreaterThan(0)

    const darkColourNames = [...darkTokens.keys()].filter((name) =>
      name.startsWith('--warm-ledger-color-'),
    )
    for (const name of darkColourNames) {
      expect(lightTokens.has(name), `missing light token ${name}`).toBe(true)
    }

    for (const surface of LIGHT_SURFACES) {
      expect(lightTokens.get(surface), surface).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('switches the native colour scheme with the resolved theme', () => {
    expect(darkTokens.get('color-scheme')).toBe('dark')
    expect(lightTokens.get('color-scheme')).toBe('light')
    expect(lightTokens.has('--warm-ledger-color-on-accent')).toBe(true)
  })

  it('keeps amber for dark and separates light emphasis, positive, and negative by hue', () => {
    expect(darkTokens.get('--warm-ledger-color-accent')).toBe('#e8b35a')
    expect(hue('#e8b35a')).toBeGreaterThan(30)
    expect(hue('#e8b35a')).toBeLessThan(50)

    const lightAccent = lightTokens.get('--warm-ledger-color-accent')!
    const lightPositive = lightTokens.get('--warm-ledger-color-positive')!
    const lightNegative = lightTokens.get('--warm-ledger-color-negative')!

    expect(hue(lightAccent)).toBeGreaterThanOrEqual(140)
    expect(hue(lightAccent)).toBeLessThanOrEqual(190)
    expect(hue(lightPositive)).toBeGreaterThanOrEqual(100)
    expect(hue(lightPositive)).toBeLessThan(140)
    expect(hue(lightNegative)).toBeLessThan(60)

    for (const soft of ['--warm-ledger-color-accent-soft', '--warm-ledger-color-accent-area']) {
      expect(lightTokens.get(soft), soft).toMatch(/rgba/)
    }
  })

  it('meets WCAG contrast on every light surface', () => {
    const surfaces = LIGHT_SURFACES.map((name) => lightTokens.get(name)!)
    const bodyText = ['--warm-ledger-color-text', '--warm-ledger-color-text-soft', '--warm-ledger-color-text-muted']
    const accentRoles = [
      '--warm-ledger-color-accent',
      '--warm-ledger-color-accent-strong',
      '--warm-ledger-color-positive',
      '--warm-ledger-color-negative',
    ]

    for (const role of [...bodyText, ...accentRoles]) {
      const colour = lightTokens.get(role)!
      for (const surface of surfaces) {
        expect(contrast(colour, surface), `${role} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }

    const faint = lightTokens.get('--warm-ledger-color-text-faint')!
    for (const surface of surfaces) {
      expect(contrast(faint, surface), `faint on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('routes every dark shadow through a token instead of a literal', () => {
    const offenders: string[] = []

    for (const line of css.split('\n')) {
      if (!line.includes('rgba(0, 0, 0,')) continue
      if (line.trim().startsWith('--')) continue
      offenders.push(line.trim())
    }

    expect(offenders).toEqual([])
    expect(darkTokens.has('--warm-ledger-shadow-popover')).toBe(true)
    expect(darkTokens.has('--warm-ledger-shadow-dialog')).toBe(true)
    expect(darkTokens.has('--warm-ledger-color-backdrop')).toBe(true)
  })

  it('never animates every property at once', () => {
    expect(css).not.toContain('transition: all')
  })
})
