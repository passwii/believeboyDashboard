import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SIDEBAR_TOP_GROUPS } from '@/lib/sidebar-config'

const routePages = [
  'page.tsx',
  'ad-analysis/page.tsx',
  'believeboy-models/page.tsx',
  'chat/page.tsx',
  'customer-service/page.tsx',
  'digital-employees/page.tsx',
  'digital-employees/[id]/page.tsx',
  'digital-employees/office/page.tsx',
  'insights/page.tsx',
  'inventory-health/page.tsx',
] as const

const mobileStyles = [
  ['ai insights', 'insights/insights-warm.module.css'],
  ['inventory health', 'inventory-health/inventory-health-warm.module.css'],
  ['believeboy models', 'believeboy-models/believeboy-models-warm.module.css'],
  ['AI chat', '../../../components/chat/warm-chat.module.css'],
  ['AI ad analysis', '../../../components/dashboard/ai-ad-analysis/ai-ad-analysis-warm.module.css'],
  ['AI schedules', '../../../components/dashboard/ai-insights/schedule-mobile.module.css'],
  ['customer service', '../../../components/customer-service/customer-service-warm.module.css'],
  ['digital employees', '../../../components/digital-employee/digital-employee-warm.module.css'],
] as const

function read(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8')
}

function readMobileBlock(stylesheet: string): string {
  const css = read(stylesheet)
  const marker = '@media (max-width: 640px)'
  const start = css.indexOf(marker)
  if (start === -1) return ''
  const open = css.indexOf('{', start)
  if (open === -1) return ''
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, index)
    }
  }
  return ''
}

function readRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  return match?.[1] ?? ''
}

describe('V4 AI workspace phone layout contract (Stage 7)', () => {
  it('ships all ten AI routes in the issue scope', () => {
    for (const route of routePages) {
      expect(read(route)).not.toHaveLength(0)
    }
  })

  it.each(mobileStyles)('%s ships a phone layout block', (_name, stylesheet) => {
    expect(readMobileBlock(stylesheet)).not.toHaveLength(0)
  })

  it('keeps the AI group reachable from the shared sidebar route source', () => {
    const aiGroup = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'ai')
    expect(aiGroup).toBeDefined()

    const configuredRoutes = aiGroup?.items.map((item) => item.url) ?? []
    expect(configuredRoutes).toEqual(
      expect.arrayContaining([
        '/dashboard/ai/insights',
        '/dashboard/ai/ad-analysis',
        '/dashboard/ai/inventory-health',
        '/dashboard/ai/chat',
        '/dashboard/ai/believeboy-models',
        '/dashboard/ai/customer-service',
        '/dashboard/ai/digital-employees',
        '/dashboard/ai/digital-employees/office',
      ])
    )
  })

  it('reflows employee stats, roster, detail, office, and presentation content', () => {
    const mobile = readMobileBlock(
      '../../../components/digital-employee/digital-employee-warm.module.css'
    )

    expect(mobile).toMatch(
      /\.skeletonStats,\s*\.statsPanel\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    )
    expect(mobile).toMatch(
      /\.skeletonLayout,\s*\.listLayout,\s*\.detailGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
    )
    expect(mobile).toMatch(
      /\.officeGrid,\s*\.officeSkeletonGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
    )
    expect(readRule(mobile, '.presentationGrid')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/
    )
    expect(readRule(mobile, '.spotlight')).toContain(
      'calc(66px + env(safe-area-inset-bottom)'
    )
  })

  it('keeps the virtual office presentation exception forced-dark', () => {
    const source = read('digital-employees/office/page.tsx')
    expect(source).toContain('forceDarkDocument')
    expect(source).toContain('data-office-presentation="true"')
  })

  it('stacks AI insight filters and keeps the full record table in its scroller', () => {
    const mobile = readMobileBlock('insights/insights-warm.module.css')
    expect(readRule(mobile, '.filters')).toMatch(
      /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
    )
    expect(mobile).toMatch(
      /\.tableScroller,\s*\.scheduleSurface\s*\{[^}]*overflow-x:\s*auto/s
    )
    expect(readRule(mobile, '.dataTable')).toMatch(/min-width:\s*900px/)
    expect(mobile).toContain('-webkit-overflow-scrolling: touch')
    expect(readRule(mobile, '.dialogContent')).toContain('env(safe-area-inset-bottom)')
  })

  it('stacks AI ad-analysis filters and anchors its dialogs to the dynamic viewport', () => {
    const mobile = readMobileBlock(
      '../../../components/dashboard/ai-ad-analysis/ai-ad-analysis-warm.module.css'
    )
    expect(readRule(mobile, '.filters')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/
    )
    expect(readRule(mobile, '.dataTable')).toMatch(/min-width:\s*900px/)
    const dialog = readRule(mobile, '.dialogContent')
    expect(dialog).toContain('100dvh')
    expect(dialog).toContain('env(safe-area-inset-top)')
    expect(dialog).toContain('env(safe-area-inset-bottom)')
    expect(dialog).toMatch(/transform:\s*none/)
  })

  it('keeps the schedule form above the keyboard and safe areas', () => {
    const mobile = readMobileBlock(
      '../../../components/dashboard/ai-insights/schedule-mobile.module.css'
    )
    const dialog = readRule(mobile, '.dialogContent')
    expect(dialog).toContain('100dvh')
    expect(dialog).toContain('env(safe-area-inset-bottom)')
    expect(readRule(mobile, '.dialogFooter')).toMatch(/display:\s*grid/)
    expect(readRule(mobile, '.textInput')).toMatch(/font-size:\s*16px/)
  })

  it('turns the customer-service workspace into one readable column', () => {
    const mobile = readMobileBlock(
      '../../../components/customer-service/customer-service-warm.module.css'
    )
    expect(readRule(mobile, '.page')).toMatch(/height:\s*auto/)
    expect(readRule(mobile, '.workspace')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/
    )
    expect(readRule(mobile, '.controlsRow')).toMatch(/grid-template-columns:/)
    expect(readRule(mobile, '.control')).toMatch(/font-size:\s*16px/)
  })

  it('stacks inventory-health filters and keeps the generate action full width', () => {
    const mobile = readMobileBlock('inventory-health/inventory-health-warm.module.css')
    expect(readRule(mobile, '.filters')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/
    )
    expect(readRule(mobile, '.generateAction :global(.warm-ledger__button)')).toContain(
      'width: 100%'
    )
  })

  it('keeps the model reference table scrollable and its metadata stacked on phones', () => {
    const mobile = readMobileBlock('believeboy-models/believeboy-models-warm.module.css')
    expect(readRule(mobile, '.metaBar')).toMatch(/flex-direction:\s*column/)
    expect(readRule(mobile, '.tableScroll')).toContain('-webkit-overflow-scrolling: touch')
    expect(read('believeboy-models/believeboy-models-warm.module.css')).toContain(
      'min-width: 720px'
    )
  })

  it('keeps AI chat history, composer controls, and keyboard inset mobile-safe', () => {
    const mobile = readMobileBlock('../../../components/chat/warm-chat.module.css')
    expect(read('../../../components/chat/warm-chat.module.css')).toMatch(
      /\.sidebarScrim\s*\{[^}]*pointer-events:\s*auto/s
    )
    expect(readRule(mobile, '.inputSend')).toMatch(/width:/)
    expect(readRule(mobile, '.textarea')).toMatch(/font-size:\s*16px/)

    const source = read('../../../components/chat/ai-chat-window.tsx')
    expect(source).toContain('visualViewport')
    expect(source).toContain('--chat-keyboard-inset')
    expect(source).toContain('ai-chat-sidebar-scrim')
    expect(source).toContain("event.key === 'Escape'")
  })
})
