import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SIDEBAR_TOP_GROUPS } from '@/lib/sidebar-config'

const routeStyles = [
  ['audit', 'audit/audit-warm.module.css'],
  ['dashboard', 'dashboard/dashboard-warm.module.css'],
  ['intent', 'intent/intent-warm.module.css'],
  ['leads', 'leads/leads-warm.module.css'],
  ['proposals', 'proposals/proposals-warm.module.css'],
  ['settings', 'settings/settings-warm.module.css'],
  ['tasks', 'tasks/page.module.css'],
] as const

const scopedRoutes = [
  '/dashboard/crm',
  '/dashboard/crm/audit',
  '/dashboard/crm/customers',
  '/dashboard/crm/dashboard',
  '/dashboard/crm/follow-ups',
  '/dashboard/crm/intent',
  '/dashboard/crm/leads',
  '/dashboard/crm/proposals',
  '/dashboard/crm/proposals/[id]',
  '/dashboard/crm/sea',
  '/dashboard/crm/settings',
  '/dashboard/crm/tasks',
  '/dashboard/crm/workbench',
] as const

function readMobileBlock(stylesheet: string, maxWidth = 640): string {
  const css = readFileSync(join(__dirname, stylesheet), 'utf8')
  const marker = `@media (max-width: ${maxWidth}px)`
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

function declarationNumber(block: string, property: string): number {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(block)
  const value = match?.[1]?.trim() ?? ''
  const direct = /^(-?\d+(?:\.\d+)?)px$/.exec(value)
  if (direct) return Number(direct[1])
  const fallback = /var\([^,]+,\s*(-?\d+(?:\.\d+)?)px\)/.exec(value)
  return fallback ? Number(fallback[1]) : Number.NaN
}

describe('V4 CRM phone layout contract (Stage 5)', () => {
  it.each(routeStyles)('%s includes phone media queries', (_route, stylesheet) => {
    const css = readFileSync(join(__dirname, stylesheet), 'utf8')
    expect(css).toMatch(/@media\s*\(max-width:\s*(?:640|460|380)px\)/)
  })

  it('covers all 13 scoped CRM routes in the sidebar navigation or route redirects', () => {
    const crmGroup = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'crm')
    expect(crmGroup).toBeDefined()

    const items = crmGroup?.items ?? []
    for (const route of scopedRoutes) {
      if (route === '/dashboard/crm' || route === '/dashboard/crm/workbench') {
        const filename = route === '/dashboard/crm' ? 'page.tsx' : 'workbench/page.tsx'
        const content = readFileSync(join(__dirname, filename), 'utf8')
        expect(content).toContain("redirect('/dashboard/crm/customers')")
        continue
      }

      const isCovered = items.some((item) => {
        if (item.url === route) return true
        if (item.matchPrefixes?.some((prefix) => route.startsWith(prefix))) return true
        if (route === '/dashboard/crm/proposals/[id]') {
          return item.matchPrefixes?.some((prefix) => prefix === '/dashboard/crm/proposals')
        }
        return false
      })
      expect(isCovered, `route ${route} should be covered by sidebar-config`).toBe(true)
    }
  })

  it.each([
    ['warm-crm-kit', '../../../components/dashboard-v2/warm-ledger/crm/warm-crm-kit.module.css'],
    ['intent-board', 'intent/intent-warm.module.css'],
  ])('%s keeps wide data inside scroller with touch scrolling', (_name, relativePath) => {
    const css = readFileSync(join(__dirname, relativePath), 'utf8')
    expect(css).toMatch(/overflow(?:-x)?:\s*auto/)
    expect(css).toContain('-webkit-overflow-scrolling: touch')
  })

  it.each([
    ['audit', 'audit/audit-warm.module.css'],
    ['intent', 'intent/intent-warm.module.css'],
    ['leads', 'leads/leads-warm.module.css'],
    ['proposals', 'proposals/proposals-warm.module.css'],
    ['settings', 'settings/settings-warm.module.css'],
    ['tasks', 'tasks/page.module.css'],
    ['task-list', 'tasks/components/task-list.module.css'],
    ['crm-table', '../../../components/crm/crm-table/crm-table-warm.module.css'],
    ['warm-crm-kit', '../../../components/dashboard-v2/warm-ledger/crm/warm-crm-kit.module.css'],
  ])('%s ensures mobile controls meet touch target standards', (_name, stylesheet) => {
    const css = readFileSync(join(__dirname, stylesheet), 'utf8')
    expect(css).toContain('--warm-ledger-control-target-touch')
  })

  it('keeps CRM drawers inside the visual viewport above safe areas and the keyboard', () => {
    const mobile = readMobileBlock(
      '../../../components/dashboard-v2/warm-ledger/crm/warm-crm-kit.module.css'
    )
    const drawer = readRule(mobile, '.drawerContent')

    expect(drawer).toMatch(/height:\s*100dvh/)
    expect(drawer).toContain('var(--crm-visual-viewport-height, 100dvh)')
    expect(drawer).toContain('var(--crm-visual-viewport-offset-top, 0px)')
    expect(drawer).toContain('env(safe-area-inset-top)')
    expect(drawer).toContain('env(safe-area-inset-bottom)')
    expect(drawer).toContain('env(safe-area-inset-left)')
    expect(drawer).toContain('env(safe-area-inset-right)')
  })

  it('anchors intent dialogs to the keyboard-safe dynamic viewport', () => {
    const mobile = readMobileBlock('intent/intent-warm.module.css')
    const dialog = readRule(mobile, '.dialogContent')

    expect(dialog).toContain('var(--crm-visual-viewport-height, 100dvh)')
    expect(dialog).toContain('var(--crm-keyboard-inset-bottom, 0px)')
    expect(dialog).toMatch(/max-height:\s*calc\(100dvh - env\(safe-area-inset-top\)\)/)
    expect(dialog).toMatch(/padding-bottom:\s*calc\([^}]*env\(safe-area-inset-bottom\)\)/)
    expect(dialog).toMatch(/bottom:\s*0/)
  })

  it('keeps proposal dialogs above the bottom safe area on the dynamic viewport', () => {
    const mobile = readMobileBlock('proposals/proposals-warm.module.css')
    const dialog = readRule(mobile, '.dialog')

    expect(dialog).toContain('var(--crm-visual-viewport-height, 100dvh)')
    expect(dialog).toContain('var(--crm-keyboard-inset-bottom, 0px)')
    expect(dialog).toMatch(/max-height:\s*calc\(100dvh - env\(safe-area-inset-top\)\)/)
    expect(dialog).toMatch(/padding-bottom:\s*calc\([^}]*env\(safe-area-inset-bottom\)\)/)
  })

  it('opts the CRM shell into safe-area insets and keyboard content resizing', () => {
    const layout = readFileSync(join(__dirname, 'layout.tsx'), 'utf8')
    expect(layout).toContain("viewportFit: 'cover'")
    expect(layout).toContain("interactiveWidget: 'resizes-content'")
    expect(layout).toContain('<CrmVisualViewportSync />')
  })

  it.each([
    ['settings', 'settings/settings-warm.module.css'],
    ['rules panel', '../../../components/crm/crm-rules-panel.module.css'],
  ])('%s switch exposes a physical hit area of at least 44x44px', (_name, stylesheet) => {
    const mobile = readMobileBlock(stylesheet)
    const root = readRule(mobile, '.switch')
    const track = readRule(mobile, '.switch::before')

    expect(track).toContain("content: ''")
    expect(track).toMatch(/position:\s*absolute/)
    expect(declarationNumber(track, 'width')).toBe(36)
    expect(declarationNumber(track, 'height')).toBe(20)

    expect(declarationNumber(root, 'width'), `${stylesheet} switch hit width`).toBeGreaterThanOrEqual(44)
    expect(declarationNumber(root, 'height'), `${stylesheet} switch hit height`).toBeGreaterThanOrEqual(44)
  })

  it('ensures dashboard KPI grid reflows to 2 columns on mobile', () => {
    const css = readFileSync(join(__dirname, 'dashboard/dashboard-warm.module.css'), 'utf8')
    expect(css).toMatch(/\.kpiGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s)
  })

  it('ensures tasks kanban board reflows to single column stack on mobile', () => {
    const css = readFileSync(join(__dirname, 'tasks/components/task-kanban.module.css'), 'utf8')
    expect(css).toMatch(/\.board\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s)
  })

  it('ensures CRM overview drawer tabs reflow to 3 columns on mobile', () => {
    const css = readFileSync(
      join(__dirname, '../../../components/crm/crm-overview-drawer/crm-overview-drawer-warm.module.css'),
      'utf8'
    )
    expect(css).toMatch(/\.tabListCustomer\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s)
    expect(css).toMatch(/\.tabListEntity\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s)
  })

  it('ensures create form inputs stack in 1 column on mobile', () => {
    const css = readFileSync(
      join(__dirname, '../../../components/crm/crm-form-create/crm-form-create-warm.module.css'),
      'utf8'
    )
    expect(css).toMatch(/\.grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s)
  })
})
