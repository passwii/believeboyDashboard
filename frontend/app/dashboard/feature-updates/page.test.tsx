import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import FeatureUpdatesPage from './page'

afterEach(cleanup)

function productionFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    if (!/\.(tsx|css)$/.test(entry.name) || entry.name.includes('.test.')) return []
    return [path]
  })
}

describe('FeatureUpdates V4 Warm Ledger contract', () => {
  it('保留 V7 feature 内容并渲染 Warm 页面标记', () => {
    const { container } = render(<FeatureUpdatesPage />)

    expect(container.querySelector('[data-warm-page="feature-updates"]')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'V7 版本正式发布' })).toBeInTheDocument()
    expect(screen.getAllByText('洞察重试机制上线').length).toBeGreaterThan(0)
    expect(screen.getAllByText('店铺核算整数格式优化').length).toBeGreaterThan(0)
    expect(screen.getByText('本阶段共完成 7 项核心能力升级')).toBeInTheDocument()
  })

  it('Utility 四页生产代码不残留 Terminal 或方角样式', () => {
    const files = ['profile', 'change-password', 'feature-updates', 'table-showcase'].flatMap(
      (route) => productionFiles(join('app', 'dashboard', route))
    )

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/TermPanel|TermPill|term-|rounded-none/)
      if (file.endsWith('.tsx')) {
        expect(source, file).not.toMatch(/font-mono/)
      }
    }
  })
})
