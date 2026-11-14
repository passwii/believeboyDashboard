import { readdirSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  WarmBody,
  WarmCell,
  WarmEmptyState,
  WarmHead,
  WarmKpiTile,
  WarmMetricTile,
  WarmPanel,
  WarmRow,
  WarmTable,
  WarmTHead,
} from '@/components/dashboard/ad-analysis/warm-analysis'

const APP_ROOT = resolve(process.cwd(), 'app/dashboard/advertising/ad-analysis')
const COMPONENT_ROOT = resolve(process.cwd(), 'components/dashboard/ad-analysis')

function productionFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(root, entry.name)
      return entry.isDirectory() ? productionFiles(path) : [path]
    })
    .filter((path) => ['.css', '.ts', '.tsx'].includes(extname(path)))
    .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
}

const PAGE_MARKERS: Record<string, string> = {
  overview: 'overview-client.tsx',
  budget: 'budget-client.tsx',
  campaigns: 'campaigns-client.tsx',
  placements: 'placements-client.tsx',
  products: 'products-client.tsx',
  'purchased-products': 'purchased-products-client.tsx',
  'search-terms': 'search-terms-client.tsx',
  targets: 'targets-client.tsx',
  'time-trend': 'time-trend-client.tsx',
  'traffic-quality': 'traffic-quality-client.tsx',
}

afterEach(cleanup)

describe('广告分析 V4 Warm Ledger 契约', () => {
  it('生产源码不含 Terminal 视觉别名或终端等宽正文，且断点仅限手机适配', () => {
    const files = [...productionFiles(APP_ROOT), ...productionFiles(COMPONENT_ROOT)]
    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      expect(source, path).not.toMatch(/\b(?:bg|text|border)-term-/)
      expect(source, path).not.toContain('--term-')
      expect(source, path).not.toContain('rounded-none')
      expect(source, path).not.toMatch(/(?:^|[\s"'])font-mono(?=[\s"']|$)/m)
      expect(source, path).not.toMatch(
        /(?:^|[\s"'])(?:text|bg|border|ring|fill|stroke)-(?:primary(?:-foreground)?|secondary(?:-foreground)?|muted(?:-foreground)?|accent(?:-foreground)?|destructive(?:-foreground)?|foreground|background|card(?:-foreground)?|popover(?:-foreground)?|border|input|ring)(?:\/\d+)?(?=[\s"']|$)/m
      )
      expect(source, path).not.toMatch(
        /\bTerm(?:Panel|KpiTile|Pill|RefreshStatus|Table|Head|Cell|Row|Body|THead|GridHeader|MetricTile|ChartPanel)\b/
      )
      if (path.endsWith('.tsx')) {
        expect(source, path).not.toMatch(/\b(?:md|lg|xl|2xl):/)
      }
      if (path.endsWith('.css')) {
        const media = source.match(/@media\s*\([^)]*\)/g) ?? []
        expect(media, path).toContain('@media (prefers-reduced-motion: reduce)')
        for (const rule of media) {
          expect(
            ['@media (prefers-reduced-motion: reduce)', '@media (max-width: 640px)'],
            path
          ).toContain(rule)
        }
      }
    }
  })

  it('10 个任务页面与页面壳都暴露 Warm 标记', () => {
    for (const [marker, filename] of Object.entries(PAGE_MARKERS)) {
      const source = readFileSync(resolve(COMPONENT_ROOT, filename), 'utf8')
      expect(source).toContain(`data-warm-ad-analysis-page="${marker}"`)
    }

    const layout = readFileSync(resolve(APP_ROOT, 'layout.tsx'), 'utf8')
    const loading = readFileSync(resolve(APP_ROOT, 'loading.tsx'), 'utf8')
    const tabs = readFileSync(resolve(COMPONENT_ROOT, 'tab-nav.tsx'), 'utf8')
    const filters = readFileSync(resolve(COMPONENT_ROOT, 'top-filters.tsx'), 'utf8')
    expect(layout).toContain('data-warm-ad-analysis="true"')
    expect(loading).toContain('<AdAnalysisWarmLoading')
    expect(tabs).toContain('data-warm-tablist="true"')
    expect(filters).toContain('data-warm-header-filters="true"')
  })

  it('Warm 表格、KPI、空态与滚动容器真实渲染且不落回 Terminal 类名', () => {
    render(
      <WarmPanel title="广告分析">
        <WarmKpiTile label="Spend" value="$1,234.56" />
        <WarmMetricTile label="Sales" value="$9,876.54" changeRatio={0.12} />
        <WarmTable aria-label="广告明细">
          <WarmTHead>
            <WarmRow>
              <WarmHead numeric>Spend</WarmHead>
            </WarmRow>
          </WarmTHead>
          <WarmBody>
            <WarmRow>
              <WarmCell numeric>$1,234.56</WarmCell>
            </WarmRow>
          </WarmBody>
        </WarmTable>
        <WarmEmptyState message="当前没有广告分析数据。" />
      </WarmPanel>
    )

    const panel = screen.getByRole('region', { name: '广告分析' })
    expect(panel).toHaveAttribute('data-warm-surface', 'true')
    const table = screen.getByRole('table', { name: '广告明细' })
    expect(table.closest('[data-warm-table-scroll="true"]')).not.toBeNull()
    expect(screen.getByText('当前没有广告分析数据。').closest('[data-warm-empty-state="true"]')).not.toBeNull()

    for (const element of panel.querySelectorAll('*')) {
      const className = element.getAttribute('class') ?? ''
      expect(className).not.toContain('term-')
      expect(className).not.toContain('rounded-none')
      expect(className).not.toContain('font-mono')
    }
  })
})
