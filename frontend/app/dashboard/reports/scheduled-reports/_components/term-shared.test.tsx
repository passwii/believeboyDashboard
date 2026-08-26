import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { TermFrequencyTag, TermStatusPill } from './term-shared'

// BLF-836：Scheduled Reports 终端化共享原语契约。

describe('term-shared 终端化原语（BLF-836）', () => {
  it('TermStatusPill 三态语义色映射（sent=pos · failed=neg · missing=warn）', () => {
    render(
      <>
        <TermStatusPill status="sent" label="成功" data-testid="pill-sent" />
        <TermStatusPill status="failed" label="失败" data-testid="pill-failed" />
        <TermStatusPill status="missing" label="缺失" data-testid="pill-missing" />
      </>
    )

    expect(screen.getByText('成功').className).toContain('text-term-pos')
    expect(screen.getByText('失败').className).toContain('text-term-neg')
    expect(screen.getByText('缺失').className).toContain('text-term-warn')
  })

  it('TermStatusPill 保持终端规格：零圆角 + mono + tabular 计数', () => {
    const { container } = render(<TermStatusPill status="sent" label={3} />)

    const pill = container.firstElementChild as HTMLElement
    expect(pill.className).not.toContain('rounded-full')
    expect(pill.className).toContain('font-mono')
    expect(pill.className).toContain('tabular-nums')
    expect(pill.textContent).toContain('3')
  })

  it('TermFrequencyTag 频率标签零彩色底、mono 大写、未知频率回退 muted', () => {
    render(
      <>
        <TermFrequencyTag frequency="weekly" labels={{ daily: '每日', weekly: '每周', monthly: '每月' }} />
        <TermFrequencyTag frequency="hourly" labels={{}} />
      </>
    )

    const tags = screen.getAllByText(/每周|hourly/)
    expect(tags.length).toBeGreaterThanOrEqual(1)
    for (const tag of tags) {
      expect(tag.className).not.toContain('bg-blue-100')
      expect(tag.className).not.toContain('bg-purple-100')
      expect(tag.className).not.toContain('bg-amber-100')
      expect(tag.className).toContain('rounded-none')
      expect(tag.className).toContain('uppercase')
    }
  })

  it('未知状态 pill 回退 warn 色（防御性渲染不崩溃）', () => {
    const { container } = render(<TermStatusPill status="unknown-state" />)

    const pill = container.firstElementChild as HTMLElement
    expect(pill.className).toContain('text-term-warn')
    expect(pill.textContent).toContain('⚠')
  })
})
