import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { StatusBackButton } from './status-back-button'
import { StatusHomeAction, StatusPageShell } from './status-page-shell'
import { StatusRetryButton } from './status-retry-button'

describe('StatusPageShell', () => {
  it('renders a not-found status with V4 scope and no retry action', () => {
    const { container } = render(
      <StatusPageShell
        code="404"
        kind="not-found"
        title="页面不存在"
        description="请返回首页或回到上一步。"
        tone="warning"
        primaryAction={<StatusHomeAction />}
        secondaryAction={<StatusBackButton />}
      />
    )

    const shell = container.querySelector('[data-status-kind="not-found"]')
    expect(shell).toHaveClass('warm-ledger')
    expect(shell?.className).not.toMatch(/term-|rounded-none|font-mono/)
    expect(screen.getByRole('status')).toHaveTextContent('页面不存在')
    expect(screen.getByRole('heading', { name: '页面不存在' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveClass(
      'warm-ledger__button--primary'
    )
    expect(screen.getByRole('button', { name: '返回上一页' })).toHaveClass(
      'warm-ledger__button--secondary'
    )
    expect(screen.queryByRole('button', { name: /重新加载|重试/ })).not.toBeInTheDocument()
  })

  it('renders an actionable error as an alert and keeps reset on retry', () => {
    const reset = vi.fn()
    const { container } = render(
      <StatusPageShell
        code="ERROR"
        kind="error"
        title="页面暂时不可用"
        description="页面遇到异常，请刷新后重试。"
        primaryAction={<StatusHomeAction />}
        secondaryAction={<StatusRetryButton onClick={reset} />}
      />
    )

    const shell = container.querySelector('[data-status-kind="error"]')
    expect(shell).toHaveClass('warm-ledger')
    expect(screen.getByRole('alert')).toHaveTextContent('页面暂时不可用')
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveClass(
      'warm-ledger__button--primary'
    )
    const retry = screen.getByRole('button', { name: '重新加载' })
    expect(retry).toHaveClass('warm-ledger__button--secondary')
    fireEvent.click(retry)
    expect(reset).toHaveBeenCalledOnce()
  })

  it('uses Warm tokens for the page and excludes Terminal surface styles', () => {
    const css = readFileSync(join(__dirname, 'status-page-shell.module.css'), 'utf8')

    expect(css).toContain('--warm-ledger-color-stage')
    expect(css).toContain('--warm-ledger-color-window')
    expect(css).toContain('--warm-ledger-radius-window')
    expect(css).toContain('--warm-ledger-shadow-window')
    expect(css).not.toMatch(/--term-|term-(?:bg|border|panel|text|muted|faint|warn)/)
    expect(css).not.toContain('rounded-none')
  })
})
