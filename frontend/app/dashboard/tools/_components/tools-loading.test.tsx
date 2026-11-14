import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ToolsLoading } from './index'

describe('ToolsLoading', () => {
  it('announces one polite Tools loading state inside a busy product region', () => {
    render(<ToolsLoading />)

    const region = screen.getByTestId('tools-loading')
    expect(region).toHaveAttribute('aria-busy', 'true')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('工具箱页面加载中')
  })

  it('reserves two static desktop panel surfaces without fake content', () => {
    render(<ToolsLoading />)

    expect(screen.getByTestId('tools-loading-panels').children).toHaveLength(2)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByText(/示例|演示|假数据/)).not.toBeInTheDocument()
  })

  it('uses static Warm skeleton surfaces with a phone single-column breakpoint', () => {
    const css = readFileSync(join(__dirname, 'tools-loading.module.css'), 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-color-raised)')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(css).not.toContain('animation')
    expect(css).not.toContain('--term-')
  })
})
