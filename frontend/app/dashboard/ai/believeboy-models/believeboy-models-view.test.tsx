import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import BelieveboyModelsPage from './page'
import { BelieveboyModelsView } from './believeboy-models-view'

const SOURCE = `# 模型选型

## 模型对比表

| 名称 | 架构 |
| --- | --- |
| Believeboy-Max | MOE |

> 待补全说明
`

describe('BelieveboyModelsView', () => {
  it('renders the real Markdown as a read-only Warm document', () => {
    const { container } = render(<BelieveboyModelsView source={SOURCE} />)

    expect(
      container.querySelector('[data-warm-believeboy-models="true"]')
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '模型对比表' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Believeboy-Max' })).toBeInTheDocument()
    expect(screen.getByText('待补全说明')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()
  })

  it('keeps the source Markdown link and archive metadata', () => {
    render(<BelieveboyModelsView source={SOURCE} />)

    expect(
      screen.getByRole('link', { name: /查看原始 markdown/ })
    ).toHaveAttribute('href', '/docs/believeboy-models.md')
    expect(screen.getByText('归档位')).toBeInTheDocument()
    expect(screen.getByText('归属')).toBeInTheDocument()
  })

  it('loads the tracked Markdown file through the server page', async () => {
    render(await BelieveboyModelsPage())

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: '彼励扶 Believeboy 模型选型方案',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('cell', { name: 'Believeboy-Max' })
    ).toBeInTheDocument()
  })

  it('uses Warm tokens with phone layout support and no Terminal aliases', () => {
    const cssPath = join(__dirname, 'believeboy-models-warm.module.css')
    const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : ''

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).toContain('var(--warm-ledger-inset-panel)')
    expect(css).not.toContain('--term-')
    expect(css).toContain('@media (max-width: 640px)')
  })
})
