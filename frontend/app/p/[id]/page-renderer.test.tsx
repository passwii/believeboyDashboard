import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import PageRenderer from './page-renderer'

describe('PageRenderer', () => {
  it('renders Markdown on the Warm document surface', () => {
    const { container } = render(
      <PageRenderer
        content={'# 公开标题\n\n<script>alert("unsafe")</script>'}
        format="markdown"
        title="公开标题"
      />
    )

    expect(screen.getByRole('heading', { name: '公开标题' })).toBeInTheDocument()
    expect(container.querySelector('article')).toHaveAttribute('data-preview-surface', 'warm')
    expect(container.querySelector('script')).not.toBeInTheDocument()
  })

  it('keeps HTML isolated in the sandboxed white-paper iframe', () => {
    const html = '<!doctype html><html><body><h1>HTML 页面</h1></body></html>'
    render(<PageRenderer content={html} format="html" title="公开 HTML" />)

    const iframe = screen.getByTitle('公开 HTML')
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
    expect(iframe).toHaveAttribute('data-preview-surface', 'paper')
    expect(iframe.getAttribute('srcdoc')).toBe(html)
  })
})

describe('Public renderer V4 contract', () => {
  it('keeps Warm document styling and the white HTML paper exception in local CSS', () => {
    const rendererCss = readFileSync(join(__dirname, 'page-renderer.module.css'), 'utf8')
    const layoutCss = readFileSync(join(__dirname, 'public-page.module.css'), 'utf8')

    expect(rendererCss).toContain('var(--warm-ledger-color-panel)')
    expect(rendererCss).toContain('background: #fff')
    expect(layoutCss).toContain('var(--warm-ledger-radius-window)')
    expect(rendererCss).not.toContain('--term-')
    expect(layoutCss).not.toContain('--term-')
    expect(rendererCss).not.toContain('@media')
    expect(layoutCss).not.toContain('@media')
  })
})
