import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND_ROOT = process.cwd()
const SHELL_DIR = __dirname
const css = readFileSync(join(SHELL_DIR, 'theme.css'), 'utf8')

type TokenMap = Map<string, string>

function readBlock(marker: string): TokenMap {
  const start = css.indexOf(marker)
  if (start === -1) return new Map()
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  if (open === -1 || close === -1) return new Map()
  const tokens = new Map<string, string>()
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
const declaredTokens = new Set<string>()
for (const line of css.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('--warm-ledger-')) continue
  const separator = trimmed.indexOf(':')
  if (separator === -1) continue
  declaredTokens.add(trimmed.slice(0, separator).trim())
}

const FROZEN_DARK: Record<string, string> = {
  '--warm-ledger-color-stage': '#1c1d1d',
  '--warm-ledger-color-window': '#242525',
  '--warm-ledger-color-sidebar': '#202120',
  '--warm-ledger-color-panel': '#2b2c2b',
  '--warm-ledger-color-panel-strong': '#333433',
  '--warm-ledger-color-raised': '#3b3c3b',
  '--warm-ledger-color-raised-hover': '#454644',
  '--warm-ledger-color-hairline': 'rgba(246, 238, 226, 0.12)',
  '--warm-ledger-color-hairline-strong': 'rgba(246, 238, 226, 0.2)',
  '--warm-ledger-color-text': '#f1ede5',
  '--warm-ledger-color-text-soft': '#c2bbaf',
  '--warm-ledger-color-text-muted': '#a9a297',
  '--warm-ledger-color-text-faint': '#837d74',
  '--warm-ledger-color-accent': '#e8b35a',
  '--warm-ledger-color-accent-strong': '#f3c875',
  '--warm-ledger-color-accent-soft': 'rgba(232, 179, 90, 0.12)',
  '--warm-ledger-color-accent-area': 'rgba(232, 179, 90, 0.1)',
  '--warm-ledger-color-positive': '#65cfa1',
  '--warm-ledger-color-negative': '#ee8580',
  '--warm-ledger-color-chart-grid': 'rgba(246, 238, 226, 0.09)',
  '--warm-ledger-radius-pill': '999px',
  '--warm-ledger-highlight-shell': 'inset 0 1px 0 rgba(255, 255, 255, 0.07)',
  '--warm-ledger-highlight-rest': 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
  '--warm-ledger-highlight-hover': 'inset 0 1px 0 rgba(255, 255, 255, 0.14)',
  '--warm-ledger-highlight-pressed': 'inset 0 1px 2px rgba(0, 0, 0, 0.28)',
  '--warm-ledger-shadow-window': '0 28px 72px rgba(0, 0, 0, 0.36)',
  '--warm-ledger-focus-color': 'var(--warm-ledger-color-accent-strong)',
  '--warm-ledger-color-scrim': 'rgba(0, 0, 0, 0.55)',
  '--warm-ledger-color-backdrop': 'rgba(0, 0, 0, 0.48)',
  '--warm-ledger-color-on-accent': '#1c1d1d',
  '--warm-ledger-shadow-popover': '0 12px 32px rgba(0, 0, 0, 0.3)',
  '--warm-ledger-shadow-dialog': '0 28px 72px rgba(0, 0, 0, 0.58)',
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

function walk(dir: string, extensions: string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, extensions))
    else if (extensions.some((extension) => entry.endsWith(extension))) out.push(full)
  }
  return out
}

const warmSources = [
  ...walk(join(FRONTEND_ROOT, 'app', 'dashboard'), ['.css', '.tsx', '.ts']),
  ...walk(join(FRONTEND_ROOT, 'components'), ['.css', '.tsx', '.ts']),
].filter((file) => {
  const relativeFile = relative(FRONTEND_ROOT, file)
  // design-spec §1: login is an independent visual zone. It mirrors V4 values
  // through --login-* tokens but is not a Warm Ledger surface.
  const independentZones = [join('components', 'login')]
  if (relativeFile.endsWith(join('warm-ledger', 'shell', 'theme.css')) || relativeFile.endsWith('warm-theme.test.ts')) {
    return false
  }
  return !independentZones.some((zone) => relativeFile.startsWith(`${zone}${sep}`))
})

function readReferences(source: string): string[] {
  const refs: string[] = []
  const needle = 'var(--warm-ledger-'
  let index = source.indexOf(needle)
  while (index !== -1) {
    const rest = source.slice(index + needle.length)
    let end = 0
    while (end < rest.length) {
      const char = rest[end]
      if (char === ')' || char === ',' || char === ' ' || char === '\n' || char === '\r') break
      end += 1
    }
    refs.push('--warm-ledger-' + rest.slice(0, end))
    index = source.indexOf(needle, index + needle.length + end)
  }
  return refs
}

describe('Warm Ledger theme tokens', () => {
  it('keeps every approved dark value frozen', () => {
    for (const [name, value] of Object.entries(FROZEN_DARK)) {
      expect(darkTokens.get(name), name).toBe(value)
    }
  })

  it('declares the light surface layer with every dark colour role', () => {
    expect(lightTokens.size).toBeGreaterThan(0)
    const darkColourNames = [...darkTokens.keys()].filter((name) => name.startsWith('--warm-ledger-color-'))
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
  })

  it('keeps amber for dark and separates light emphasis, positive, and negative by hue', () => {
    expect(hue('#e8b35a')).toBeGreaterThan(30)
    expect(hue('#e8b35a')).toBeLessThan(50)

    const darkPositive = darkTokens.get('--warm-ledger-color-positive')!
    expect(hue(darkPositive)).toBeGreaterThan(140)

    const lightAccent = lightTokens.get('--warm-ledger-color-accent')!
    const lightPositive = lightTokens.get('--warm-ledger-color-positive')!
    const lightNegative = lightTokens.get('--warm-ledger-color-negative')!
    expect(hue(lightAccent)).toBeGreaterThanOrEqual(140)
    expect(hue(lightAccent)).toBeLessThanOrEqual(190)
    expect(hue(lightPositive)).toBeGreaterThanOrEqual(100)
    expect(hue(lightPositive)).toBeLessThan(140)
    expect(hue(lightNegative)).toBeLessThan(60)
  })

  it('meets WCAG contrast on every light surface', () => {
    const surfaces = LIGHT_SURFACES.map((name) => lightTokens.get(name)!)
    const roles = [
      '--warm-ledger-color-text',
      '--warm-ledger-color-text-soft',
      '--warm-ledger-color-text-muted',
      '--warm-ledger-color-accent',
      '--warm-ledger-color-accent-strong',
      '--warm-ledger-color-positive',
      '--warm-ledger-color-negative',
    ]
    for (const role of roles) {
      const colour = lightTokens.get(role)!
      for (const surface of surfaces) {
        expect(contrast(colour, surface), `${role} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    // 浅色 text-faint 实际承担可读标签，因此按正文 4.5:1 验收（暗色基线保持不变）。
    const faint = lightTokens.get('--warm-ledger-color-text-faint')!
    for (const surface of surfaces) {
      expect(contrast(faint, surface), `faint on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    const chartColours = [1, 2, 3, 4, 5].map((index) => lightTokens.get(`--warm-ledger-color-chart-${index}`)!)
    for (const colour of chartColours) {
      expect(contrast(colour, lightTokens.get('--warm-ledger-color-panel')!), colour).toBeGreaterThanOrEqual(3)
    }
    expect(contrast(lightTokens.get('--warm-ledger-color-on-accent')!, lightTokens.get('--warm-ledger-color-accent')!)).toBeGreaterThanOrEqual(4.5)
  })

  it('routes every dark shadow through a token instead of a literal', () => {
    const offenders = css
      .split('\n')
      // ::backdrop 不继承自定义属性，因此遮罩保留一个内联回退值；其余阴影必须走 token。
      .filter(
        (line) =>
          line.includes('rgba(0, 0, 0,') &&
          !line.trim().startsWith('--') &&
          !line.includes('var(--warm-ledger-color-backdrop,'),
      )
      .map((line) => line.trim())
    expect(offenders).toEqual([])
  })

  it('never animates every property at once', () => {
    expect(css).not.toContain('transition: all')
  })

  it('resolves every Warm Ledger variable reference used by the app', () => {
    const missing = new Map<string, string[]>()
    for (const file of warmSources) {
      for (const reference of readReferences(readFileSync(file, 'utf8'))) {
        if (declaredTokens.has(reference)) continue
        const list = missing.get(reference) ?? []
        list.push(relative(FRONTEND_ROOT, file))
        missing.set(reference, list)
      }
    }
    expect([...missing.entries()]).toEqual([])
  })

  it('never hardcodes the dark amber accent in Warm Ledger surfaces', () => {
    const offenders: string[] = []
    for (const file of warmSources.filter((source) => source.endsWith('.css'))) {
      const normalized = readFileSync(file, 'utf8').replace(/\s+/g, '')
      if (normalized.includes('rgba(232,179,90,') || normalized.includes('#e8b35a') || normalized.includes('#f3c875')) {
        offenders.push(relative(FRONTEND_ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the next-themes class contract the light selector depends on', () => {
    const layout = readFileSync(join(FRONTEND_ROOT, 'app', 'layout.tsx'), 'utf8')
    expect(layout).toContain('attribute="class"')
    expect(layout).toContain('defaultTheme="system"')
    expect(layout).toContain('enableSystem')
  })

  it('forces dark display routes without leaving the light class behind', () => {
    const pages = [
      join(FRONTEND_ROOT, 'app', 'dashboard', 'system', 'digital-display', 'page.tsx'),
      join(FRONTEND_ROOT, 'app', 'dashboard', 'ai', 'digital-employees', 'office', 'page.tsx'),
    ]
    for (const page of pages) {
      const source = readFileSync(page, 'utf8')
      expect(source, page).toContain('forceDarkDocument')
      expect(source, page).not.toContain("classList.add('dark')")
    }

    const helper = readFileSync(join(FRONTEND_ROOT, 'lib', 'forced-dark.ts'), 'utf8')
    expect(helper).toContain("classList.remove('light')")
    expect(helper).toContain("classList.add('dark')")
  })
})
