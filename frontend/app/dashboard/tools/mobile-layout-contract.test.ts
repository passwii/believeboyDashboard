import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const PHONE_BREAKPOINT = '@media (max-width: 640px)'

const TOOL_ROUTES = [
  {
    route: 'brand-registration-example',
    stylesheet: 'brand-registration-example/brand-registration-example-page.module.css',
  },
  {
    route: 'cross-border-compliance',
    stylesheet: 'cross-border-compliance/cross-border-compliance-client.module.css',
  },
  {
    route: 'markdown-to-word',
    stylesheet: 'markdown-to-word/markdown-to-word.module.css',
  },
  {
    route: 'page-render',
    stylesheet: 'page-render/page-render.module.css',
  },
  {
    route: 'product-label',
    stylesheet: 'product-label/product-label-client.module.css',
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

describe('V4 tools phone layout contract (Stage 7)', () => {
  it.each(TOOL_ROUTES)('$route ships a tools page and a phone stylesheet block', ({ route, stylesheet }) => {
    expect(read(`${route}/page.tsx`)).not.toHaveLength(0)
    expect(read(stylesheet)).toContain(PHONE_BREAKPOINT)
  })

  it('keeps all five tools reachable from the toolbox navigation group', () => {
    const sidebar = read('../../../lib/sidebar-config.ts')
    for (const { route } of TOOL_ROUTES) {
      expect(sidebar).toContain(`/dashboard/tools/${route}`)
    }
  })

  it('stacks split tool workspaces and wraps panel actions on phones', () => {
    const css = read('_components/tools-frame.module.css')
    const phone = readPhoneBlock('_components/tools-frame.module.css')

    expect(phone).toMatch(
      /\.frame\[data-layout='split'\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
    )
    expect(phone).toMatch(/\.panelHeader\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(phone).toMatch(/\.panelActions\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).not.toContain('--term-')
  })

  it('stacks upload controls on phones without replacing the shared UploadZone', () => {
    const css = read('_components/tools-upload-zone.module.css')
    const phone = readPhoneBlock('_components/tools-upload-zone.module.css')
    const source = read('_components/tools-upload-zone.tsx')

    expect(phone).toMatch(/flex-direction:\s*column/)
    expect(phone).toContain('var(--warm-ledger-control-target-touch)')
    expect(source).toContain("from '@/components/ui/upload-zone'")
    expect(css).not.toContain('--term-')
  })

  it('reflows the brand gallery to two phone columns', () => {
    const css = read('brand-registration-example/brand-registration-example-page.module.css')
    const phone = readPhoneBlock(
      'brand-registration-example/brand-registration-example-page.module.css'
    )
    const source = read('brand-registration-example/brand-registration-example-page.tsx')

    expect(phone).toMatch(/\.layoutGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(phone).toMatch(
      /\.boxGrid,[\s\S]*\.productGrid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
    )
    expect(phone).toContain('var(--warm-ledger-font-size-page-title-mobile)')
    expect(source).toContain('(min-width: 641px) 30vw, 44vw')
    expect(css).not.toContain('--term-')
  })

  it('collapses compliance grids, stacks field rows, and keeps tables scrollable on phones', () => {
    const css = read(
      'cross-border-compliance/cross-border-compliance-client.module.css'
    )
    const phone = readPhoneBlock(
      'cross-border-compliance/cross-border-compliance-client.module.css'
    )

    expect(phone).toMatch(
      /\.chainGrid,[\s\S]*\.modeGrid,[\s\S]*\.materialGrid\s*\{[^}]*minmax\(0,\s*1fr\)/
    )
    expect(phone).toMatch(/\.fieldRow\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(phone).toMatch(
      /\.anchorLink\s*\{[^}]*min-height:\s*var\(--warm-ledger-control-target-touch\)/
    )
    expect(phone).toMatch(/\.tableScroll\s*\{[^}]*overflow-x:\s*auto/)
    expect(phone).toContain('-webkit-overflow-scrolling: touch')
    expect(css).toContain('scroll-margin-top')
  })

  it('keeps the markdown editor and preview usable with a phone keyboard', () => {
    const css = read('markdown-to-word/markdown-to-word.module.css')
    const phone = readPhoneBlock('markdown-to-word/markdown-to-word.module.css')
    const source = read('markdown-to-word/markdown-to-word-client.tsx')

    expect(phone).toMatch(/\.textarea\s*\{[^}]*font-size:\s*16px/)
    expect(phone).toMatch(
      /\.previewSurface\s*\{[^}]*max-height:\s*min\(56dvh,\s*520px\)/
    )
    expect(phone).toMatch(/\.editorHeading\s*\{[^}]*flex-direction:\s*column/)
    expect(phone).toMatch(/\.footer\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(source).toContain('data-testid="markdown-preview"')
  })

  it('keeps page-render output inside its own scrollers and preserves the white paper canvas', () => {
    const css = read('page-render/page-render.module.css')
    const phone = readPhoneBlock('page-render/page-render.module.css')
    const source = read('page-render/page-render-client.tsx')

    expect(phone).toMatch(
      /\.panel > \.uploadBody\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
    )
    expect(phone).toMatch(/\.input\s*\{[^}]*font-size:\s*16px/)
    expect(phone).toMatch(
      /\.markdownSurface\s*\{[^}]*max-height:\s*min\(56dvh,\s*520px\)/
    )
    expect(phone).toMatch(/\.htmlPreview\s*\{[^}]*height:\s*min\(56dvh,\s*520px\)/)
    expect(phone).toMatch(
      /\.tableScroll\s*\{[^}]*max-height:\s*min\(56dvh,\s*480px\)/
    )
    expect(css).toContain('background: #fff')
    expect(source).toContain('data-preview-surface="paper"')
    expect(source).toContain('sandbox="allow-scripts"')
  })

  it('lets product-label inputs and export actions reflow on phones', () => {
    const css = read('product-label/product-label-client.module.css')
    const phone = readPhoneBlock('product-label/product-label-client.module.css')
    const source = read('product-label/product-label-client.tsx')

    expect(phone).toMatch(/\.panel\s*\{[^}]*min-height:\s*0/)
    expect(phone).toMatch(/\.textarea\s*\{[^}]*font-size:\s*16px/)
    expect(phone).toMatch(/\.exportRow\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(phone).toMatch(/\.actionGroup\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(source).toContain('generateProductLabel')
    expect(source).toContain('downloadBlob')
  })
})
