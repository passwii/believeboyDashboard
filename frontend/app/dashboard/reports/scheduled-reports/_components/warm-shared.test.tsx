import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { WarmFrequencyTag, WarmStatusPill } from './warm-shared'

describe('scheduled reports Warm 共享原语', () => {
  it('状态 pill 用语义 tone 映射成功、失败与缺失', () => {
    render(
      <>
        <WarmStatusPill status="sent" label="成功" />
        <WarmStatusPill status="failed" label="失败" />
        <WarmStatusPill status="missing" label="缺失" />
      </>
    )

    expect(screen.getByText('成功').parentElement).toHaveAttribute('data-tone', 'positive')
    expect(screen.getByText('失败').parentElement).toHaveAttribute('data-tone', 'negative')
    expect(screen.getByText('缺失').parentElement).toHaveAttribute('data-tone', 'accent')
  })

  it('状态与频率标签不引入 Terminal 视觉类', () => {
    render(
      <>
        <WarmStatusPill status="sent" label={3} />
        <WarmFrequencyTag
          frequency="weekly"
          labels={{ daily: '每日', weekly: '每周', monthly: '每月' }}
        />
      </>
    )

    expect(screen.getByText('3').parentElement?.className).not.toMatch(
      /term-|rounded-none/
    )
    expect(screen.getByText('每周').className).not.toMatch(/term-|rounded-none/)
  })
})
