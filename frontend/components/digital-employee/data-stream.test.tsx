import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DURATION } from '@/lib/motion/tokens'
import { DataStream } from './data-stream'
import type { DigitalEmployee } from '@/types/digital-employee'

/**
 * BLF-1361 复审 P2：`DataStream` 的自动轮换是「淡出 → 换内容 → 淡入」，
 * 轮换 `setTimeout` 与容器的 `transition` 必须**同源**。
 *
 * 历史坑：迁移时只把 CSS 一侧换成 `duration-[var(--duration-medium)]`（350ms），
 * timer 仍是裸的 300ms——淡出没走完就换内容并反向插值，每次轮换都有一次
 * 可见的 content pop。这里用「淡出结束前内容不得变」把它钉死：谁把两侧改成不同值，
 * 这两个用例就会红。
 */

const EMPLOYEE: DigitalEmployee = {
  id: 1,
  name: '测试员工',
  description: '描述文案',
  avatar_url: null,
  employee_type: 'AI_AGENT',
  status: 'IDLE',
  last_heartbeat_at: null,
  is_silent_alert_threshold_minutes: 30,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

/** description + RUNNING 任务 → 2 条消息，才会启动轮换。 */
const RUNNING_TASK = {
  task_name: '任务一',
  progress_percent: 40,
  current_step: '抓取中',
  status: 'RUNNING',
}

/** 淡出/淡入时长（ms），与组件同源取值。 */
const FADE_MS = DURATION.medium * 1000

function renderStream() {
  const { container } = render(<DataStream employee={EMPLOYEE} currentTask={RUNNING_TASK} />)
  const panel = container.querySelector('[data-testid="data-stream-panel"]') as HTMLElement
  expect(panel).not.toBeNull()
  return panel
}

describe('DataStream：轮换 timer 与 transition 同源', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('轮换状态可被测试和辅助技术稳定识别', () => {
    const panel = renderStream()
    expect(screen.getByText('抓取中')).toBeTruthy()
    expect(panel).toHaveAttribute('data-fade-state', 'in')
  })

  it('淡出走满 --duration-medium 后才换内容（timer 不得短于过渡）', () => {
    const panel = renderStream()
    expect(screen.getByText('抓取中')).toBeTruthy()

    // 轮换间隔到点 → 开始淡出
    act(() => {
      vi.advanceTimersByTime(4500)
    })
    expect(panel).toHaveAttribute('data-fade-state', 'out')

    // 过渡还没结束（差 1ms）：内容必须仍是旧的，否则就是 content pop
    act(() => {
      vi.advanceTimersByTime(FADE_MS - 1)
    })
    expect(screen.getByText('抓取中')).toBeTruthy()
    expect(panel).toHaveAttribute('data-fade-state', 'out')

    // 过渡结束 → 换内容并淡入
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText('抓取中')).toBeNull()
    expect(screen.getByText('描述文案')).toBeTruthy()
    expect(panel).toHaveAttribute('data-fade-state', 'in')
  })

  it('FADE_MS 与 CSS token 一致（350ms），不是历史遗留的 300ms', () => {
    expect(FADE_MS).toBe(350)
  })
})

describe('Digital employee Warm styling contract', () => {
  it('uses Warm tokens with phone layout support and no Terminal aliases', () => {
    const css = readFileSync(join(__dirname, 'digital-employee-warm.module.css'), 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).toContain('var(--warm-ledger-inset-panel)')
    expect(css).not.toContain('--term-')
    expect(css).toContain('@media (max-width: 640px)')
  })
})
