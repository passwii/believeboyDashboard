import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const PHONE_BREAKPOINT = '@media (max-width: 640px)'

const STAGE_8_ROUTES = [
  {
    route: 'account-management',
    page: 'account-management/page.tsx',
    stylesheet: 'account-management/account-management-warm.module.css',
  },
  {
    route: 'agent-management',
    page: 'agent-management/page.tsx',
    stylesheet: 'agent-management/agent-management-warm.module.css',
  },
  { route: 'alerts', page: 'alerts/page.tsx', stylesheet: 'alerts/alerts-warm.module.css' },
  {
    route: 'changelog',
    page: 'changelog/page.tsx',
    stylesheet: 'changelog/changelog-warm.module.css',
  },
  {
    route: 'data-management',
    page: 'data-management/page.tsx',
    stylesheet: 'data-management/data-management-warm.module.css',
  },
  {
    route: 'digital-display',
    page: 'digital-display/page.tsx',
    stylesheet: 'digital-display/digital-display-warm.module.css',
  },
  { route: 'logs', page: 'logs/page.tsx', stylesheet: 'logs/logs-warm.module.css' },
  {
    route: 'operator-management',
    page: 'operator-management/page.tsx',
    stylesheet: 'operator-management/operator-management-warm.module.css',
  },
  {
    route: 'project-info',
    page: 'project-info/page.tsx',
    stylesheet: 'project-info/project-info-warm.module.css',
  },
] as const

const PERSONAL_ROUTES = [
  {
    route: 'profile',
    page: '../profile/profile-client.tsx',
    stylesheet: '../profile/profile-warm.module.css',
  },
  {
    route: 'change-password',
    page: '../change-password/page.tsx',
    stylesheet: '../change-password/change-password-warm.module.css',
  },
  {
    route: 'feature-updates',
    page: '../feature-updates/page.tsx',
    stylesheet: '../feature-updates/feature-updates-warm.module.css',
  },
  {
    route: 'table-showcase',
    page: '../table-showcase/page.tsx',
    stylesheet: '../table-showcase/table-showcase-warm.module.css',
  },
] as const

function read(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8')
}

function readPhoneBlock(stylesheet: string): string {
  const css = read(stylesheet)
  const start = css.indexOf(PHONE_BREAKPOINT)
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

describe('V4 system and personal phone layout contract (Stage 8)', () => {
  it.each([...STAGE_8_ROUTES, ...PERSONAL_ROUTES])(
    '$route ships a page and a phone stylesheet block',
    ({ page, stylesheet }) => {
      expect(read(page)).not.toHaveLength(0)
      expect(read(stylesheet)).toContain(PHONE_BREAKPOINT)
      expect(read(stylesheet)).not.toContain('--term-')
    }
  )

  it('keeps the sidebar-backed system routes reachable', () => {
    const sidebar = read('../../../lib/sidebar-config.ts')
    for (const { route } of STAGE_8_ROUTES) {
      if (route === 'digital-display') continue
      expect(sidebar).toContain(`/dashboard/system/${route}`)
    }
  })

  it('stacks account and agent management headers while keeping table scrollers', () => {
    const account = readPhoneBlock('account-management/account-management-warm.module.css')
    const agent = readPhoneBlock('agent-management/agent-management-warm.module.css')

    expect(account).toMatch(/\.panelHeader\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(account).toMatch(/\.panelActions\s*\{[^}]*width:\s*100%/)
    expect(account).toMatch(/\.tableScroll\s*\{[^}]*overflow-scrolling:\s*touch/)
    expect(account).toMatch(/\.dialogFooter\s*\{[^}]*grid-template-columns/)

    expect(agent).toMatch(/\.tabList,[\s\S]*\.logTabList\s*\{[^}]*grid-template-columns/)
    expect(agent).toMatch(/\.domainGrid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(agent).toMatch(/\.filters\s*\{[^}]*grid-template-columns/)
    expect(agent).toMatch(/\.usageGuideToolbar\s*\{[^}]*flex-direction:\s*column/)
    expect(agent).toMatch(/\.tableScroll\s*\{[^}]*overflow-scrolling:\s*touch/)
  })

  it('reflows alert stats, tabs, filters and the rule dialog for phones', () => {
    const phone = readPhoneBlock('alerts/alerts-warm.module.css')

    expect(phone).toMatch(/\.statsGrid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(phone).toMatch(/\.tabList\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
    expect(phone).toMatch(/\.filters\s*\{[^}]*grid-template-columns/)
    expect(phone).toMatch(/\.formRow,[\s\S]*\.formRowThree\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(phone).toMatch(/\.ruleDialog\s*\{[^}]*bottom:\s*0/)
    expect(phone).toMatch(/\.pagination\s*\{[^}]*flex-direction:\s*column/)
  })

  it('stacks the changelog navigation above releases without losing release anchors', () => {
    const phone = readPhoneBlock('changelog/changelog-warm.module.css')
    const source = read('changelog/page.tsx')

    expect(phone).toMatch(
      /\.layout,[\s\S]*\.loadingPage\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
    )
    expect(phone).toMatch(/\.navigationColumn\s*\{[^}]*position:\s*static/)
    expect(phone).toMatch(/\.releaseNavigation\s*\{[^}]*flex-direction:\s*row/)
    expect(phone).toMatch(/\.highlightGrid\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(source).toContain('href={`#${release.version.toLowerCase()}`}')
  })

  it('keeps data management actions and table fields available on phones', () => {
    const phone = readPhoneBlock('data-management/data-management-warm.module.css')
    const source = read('data-management/page.tsx')

    expect(phone).toMatch(/\.toolbar\s*\{[^}]*grid-template-columns/)
    expect(phone).toMatch(/\.summaryGrid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(phone).toMatch(/\.tableScroll\s*\{[^}]*overflow-scrolling:\s*touch/)
    for (const label of ['表名', '中文名', '行数', '最后更新', '状态']) {
      expect(source).toContain(`>${label}<`)
    }
  })

  it('treats the digital display as a two-column KPI phone exception with forced dark', () => {
    const phone = readPhoneBlock('digital-display/digital-display-warm.module.css')
    const source = read('digital-display/page.tsx')

    expect(phone).toMatch(/\.kpiGrid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(phone).toMatch(/\.detailGrid\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(phone).toMatch(/\.controls\s*\{[^}]*grid-template-columns/)
    expect(source).toContain('data-digital-display-exception="true"')
    expect(source).toContain('forceDarkDocument()')
    expect(source).toContain('requestFullscreen()')
  })

  it('keeps log filters, table columns and the detail dialog usable on phones', () => {
    const phone = readPhoneBlock('logs/logs-warm.module.css')
    const source = read('logs/page.tsx')

    expect(phone).toMatch(/\.tabList\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
    expect(phone).toMatch(/\.filters\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(phone).toMatch(/\.tableScroll\s*\{[^}]*overflow-scrolling:\s*touch/)
    expect(phone).toMatch(/\.detailGrid\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(source).toContain('日志详情')
    expect(source).toContain('colSpan={7}')
  })

  it('stacks operator tools while preserving every editable table', () => {
    const phone = readPhoneBlock('operator-management/operator-management-warm.module.css')
    const source = read('operator-management/page.tsx')

    expect(phone).toMatch(/\.toolbar\s*\{[^}]*flex-direction:\s*column/)
    expect(phone).toMatch(/\.tabList\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
    expect(phone).toMatch(/\.metricStrip\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(phone).toMatch(/\.tableWrap,[\s\S]*\.tableWrapCommission\s*\{[^}]*overflow-scrolling:\s*touch/)
    expect(source).toContain('运营岗位列表')
    expect(source).toContain('运营绩效列表')
    expect(source).toContain('commissionTable')
  })

  it('keeps project info dialogs and the context grid phone-shaped', () => {
    const phone = readPhoneBlock('project-info/project-info-warm.module.css')
    const source = read('project-info/page.tsx')
    const contextPhone = readPhoneBlock(
      '../../../components/dashboard/project-context/project-context-warm.module.css'
    )

    expect(phone).toMatch(/\.formGrid\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(phone).toMatch(/\.shopGrid\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(phone).toMatch(/\.dialogSurface\s*\{[^}]*bottom:\s*0/)
    expect(phone).toMatch(/\.tableWrap\s*\{[^}]*overflow-scrolling:\s*touch/)
    expect(contextPhone).toMatch(
      /\.loadingGrid,[\s\S]*\.projectGrid\s*\{[^}]*minmax\(0,\s*1fr\)/
    )
    expect(source).toContain('项目资料列表')
    expect(source).toContain('店铺映射')
  })

  it('reflows the profile tabs, form, stats, avatar and dialogs', () => {
    const phone = readPhoneBlock('../profile/profile-warm.module.css')
    const profileClient = read('../profile/profile-client.tsx')
    const avatarTab = read('../profile/components/profile-avatar-tab.tsx')

    expect(phone).toMatch(/\.tabList\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
    expect(phone).toMatch(/\.form\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(phone).toMatch(/\.statsGrid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(phone).toMatch(/\.avatarLayout\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(phone).toMatch(/\.confirmDialog\s*\{[^}]*bottom:\s*0/)
    expect(profileClient).toContain('我的资料')
    expect(profileClient).toContain('资料设置')
    expect(avatarTab).toContain('上传新头像')
    expect(avatarTab).toContain('确认删除头像？')
  })

  it('keeps the password, feature update and table showcase phone layouts readable', () => {
    const passwordPhone = readPhoneBlock(
      '../change-password/change-password-warm.module.css'
    )
    const featurePhone = readPhoneBlock('../feature-updates/feature-updates-warm.module.css')
    const showcasePhone = readPhoneBlock('../table-showcase/table-showcase-warm.module.css')

    expect(passwordPhone).toMatch(/\.actions\s*>\s*:global\(\.warm-ledger__button\)\s*\{[^}]*width:\s*100%/)
    expect(passwordPhone).toMatch(/\.input\s*\{[^}]*font-size:\s*16px/)
    expect(featurePhone).toMatch(/\.featureGrid\s*\{[^}]*minmax\(0,\s*1fr\)/)
    expect(featurePhone).toMatch(/\.summaryGrid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(showcasePhone).toMatch(/\.toolbar\s*\{[^}]*flex-direction:\s*column/)
    expect(showcasePhone).toMatch(/\.detailGrid\s*\{[^}]*minmax\(0,\s*1fr\)/)
  })
})
