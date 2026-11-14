import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ToolsPageFrame, ToolsPanel } from './index'

describe('ToolsPageFrame', () => {
  it('renders a single-column Warm tool page by default', () => {
    render(
      <ToolsPageFrame>
        <p>工具内容</p>
      </ToolsPageFrame>
    )

    const frame = screen.getByText('工具内容').parentElement
    expect(frame).toHaveAttribute('data-tools-page-frame', 'true')
    expect(frame).toHaveAttribute('data-layout', 'stack')
  })

  it('supports the two-column desktop layout used by tool workspaces', () => {
    render(
      <ToolsPageFrame layout="split">
        <p>左侧</p>
        <p>右侧</p>
      </ToolsPageFrame>
    )

    expect(screen.getByText('左侧').parentElement).toHaveAttribute('data-layout', 'split')
  })

  it('forwards standard attributes and caller classes without adding copy', () => {
    render(
      <ToolsPageFrame aria-busy="true" className="custom-frame">
        <p>无文案容器</p>
      </ToolsPageFrame>
    )

    const frame = screen.getByText('无文案容器').parentElement
    expect(frame).toHaveAttribute('aria-busy', 'true')
    expect(frame).toHaveClass('custom-frame')
    expect(frame).not.toHaveAttribute('aria-label')
  })
})

describe('ToolsPanel', () => {
  it('renders the caller-provided title, actions, and body', () => {
    render(
      <ToolsPanel
        title="Markdown 编辑区"
        actions={<button type="button">清空</button>}
        bodyClassName="custom-body"
      >
        <textarea aria-label="Markdown 内容" />
      </ToolsPanel>
    )

    const panel = screen.getByRole('region', { name: 'Markdown 编辑区' })
    expect(panel).toHaveAttribute('data-tools-panel', 'true')
    expect(screen.getByRole('heading', { level: 2, name: 'Markdown 编辑区' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '清空' })).toBeInTheDocument()
    expect(screen.getByLabelText('Markdown 内容').parentElement).toHaveClass('custom-body')
  })

  it('keeps the panel body as the only surface that receives bodyClassName', () => {
    render(
      <ToolsPanel title="实时预览" bodyClassName="preview-body">
        <p>预览内容</p>
      </ToolsPanel>
    )

    const body = screen.getByText('预览内容').parentElement
    expect(body).toHaveAttribute('data-tools-panel-body', 'true')
    expect(body).toHaveClass('preview-body')
    expect(screen.getByRole('region', { name: '实时预览' })).not.toHaveClass('preview-body')
  })
})

describe('Warm tool frame styling contract', () => {
  it('uses Warm tokens for shared surfaces with a phone stacking breakpoint', () => {
    const css = readFileSync(join(__dirname, 'tools-frame.module.css'), 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).toContain('var(--warm-ledger-inset-panel)')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain(".frame[data-layout='split']")
    expect(css).not.toContain('--term-')
  })
})
