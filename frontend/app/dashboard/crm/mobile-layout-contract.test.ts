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
    expect(css).toContain('var(--warm-ledger-control-target-touch')
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
