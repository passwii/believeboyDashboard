import { describe, expect, it } from 'vitest'

import {
  LEDGER_RUN_LABELS,
  ledgerCopyText,
  ledgerRunId,
  normalizeLedgerSummary,
  readInsightRunId,
  toLedgerPanelContent,
  toLedgerPanelState,
  toLedgerSummaryStatus,
} from './ledger-insight'
import type { LedgerItem } from './types'

function makeItem(overrides: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id: 11,
    ledger_key: 'lk-1',
    expected_date: '2026-08-24',
    expected_at: '2026-08-24T15:00:00+08:00',
    frequency: 'weekly',
    subscription_id: 7,
    email: 'ops@example.com',
    project_ids: '1,2',
    project_names: ['项目A'],
    country: 'US',
    status: 'sent',
    latest_delivery_log_id: 99,
    error_message: null,
    sent_at: '2026-08-24T15:05:00+08:00',
    can_resend: false,
    last_checked_at: null,
    screenshot_r2_url: null,
    screenshot_r2_thumb_url: null,
    ai_summary: null,
    ai_summary_status: 'pending',
    ai_summary_error: null,
    ai_summary_model: null,
    ai_summary_updated_at: null,
    ...overrides,
  }
}

describe('run 绑定识别（BLF-1015）', () => {
  it('两个候选字段名都认，且取第一个非空字符串', () => {
    expect(readInsightRunId({ insight_run_id: 'run-a' })).toBe('run-a')
    expect(readInsightRunId({ run_id: 'run-b' })).toBe('run-b')
    expect(readInsightRunId({ run_id: ' run-c ' })).toBe('run-c')
  })

  it('无绑定 / 空值 / 非对象一律 null，不臆造 run', () => {
    expect(readInsightRunId({ delivery_log_id: 99 })).toBeNull()
    expect(readInsightRunId({ run_id: '' })).toBeNull()
    expect(readInsightRunId({ run_id: 123 })).toBeNull()
    expect(readInsightRunId(null)).toBeNull()
    expect(readInsightRunId(['run-a'])).toBeNull()
    expect(readInsightRunId('run-a')).toBeNull()
    expect(ledgerRunId(makeItem())).toBeNull()
    expect(ledgerRunId(null)).toBeNull()
  })

  it('条目上带绑定时可读出', () => {
    expect(ledgerRunId(makeItem({ insight_run_id: 'run-1' }))).toBe('run-1')
  })
})

describe('run 状态 → 面板状态', () => {
  it('绑定 run 时用后端权威状态，传输层只决定是否闪 caret', () => {
    const running = toLedgerPanelState({
      item: makeItem({ insight_run_id: 'run-1' }),
      regenerating: false,
      runStatus: 'generating',
      transport: 'live',
      progress: 42,
    })
    expect(running.status).toBe('generating')
    expect(running.label).toBe(LEDGER_RUN_LABELS.generating)
    expect(running.progress).toBe(42)
    expect(running.isStreaming).toBe(true)
    expect(running.busy).toBe(true)

    const reconnecting = toLedgerPanelState({
      item: makeItem({ insight_run_id: 'run-1' }),
      regenerating: false,
      runStatus: 'generating',
      transport: 'reconnecting',
      progress: null,
    })
    expect(reconnecting.isStreaming).toBe(true)
  })

  it('绑定 run 的终态不再是 busy', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const state = toLedgerPanelState({
        item: makeItem({ insight_run_id: 'run-1' }),
        regenerating: false,
        runStatus: status,
        transport: status,
        progress: null,
      })
      expect(state.busy).toBe(false)
      expect(state.isStreaming).toBe(false)
    }
  })

  it('无绑定时退回落库 ai_summary_status，绝不显示进度', () => {
    const generating = toLedgerPanelState({
      item: makeItem({ ai_summary_status: 'generating' }),
      regenerating: false,
      runStatus: null,
      transport: 'live',
      progress: 80,
    })
    expect(generating.status).toBe('generating')
    expect(generating.label).toBe('AI 摘要生成中')
    expect(generating.progress).toBeNull()
    expect(generating.isStreaming).toBe(false)
    expect(generating.busy).toBe(true)

    const pending = toLedgerPanelState({
      item: makeItem(),
      regenerating: false,
      runStatus: null,
      transport: 'live',
      progress: null,
    })
    expect(pending.status).toBe('queued')
    expect(pending.label).toBe('AI 摘要尚未生成')
    expect(pending.busy).toBe(false)

    const failed = toLedgerPanelState({
      item: makeItem({ ai_summary_status: 'failed' }),
      regenerating: false,
      runStatus: null,
      transport: 'live',
      progress: null,
    })
    expect(failed.status).toBe('failed')
    expect(failed.busy).toBe(false)
  })

  it('父级乐观触发（regenerating）在无绑定时按生成中呈现', () => {
    const state = toLedgerPanelState({
      item: makeItem(),
      regenerating: true,
      runStatus: null,
      transport: 'live',
      progress: null,
    })
    expect(state.status).toBe('generating')
    expect(state.busy).toBe(true)
  })
})

describe('面板正文优先级', () => {
  it('流式草稿优先于落库摘要，且不被项目符号归一化改写', () => {
    const { content, contentState } = toLedgerPanelContent({
      item: makeItem({ ai_summary: '● 旧摘要', ai_summary_status: 'done' }),
      liveContent: '● 新摘要正文',
      runSettled: false,
    })
    expect(content).toBe('● 新摘要正文')
    expect(contentState).toBe('draft')
  })

  it('run 落定后同一份内容转为终态（配 digest）', () => {
    const { content, contentState } = toLedgerPanelContent({
      item: makeItem({ insight_run_id: 'run-1' }),
      liveContent: '正文',
      runSettled: true,
    })
    expect(content).toBe('正文')
    expect(contentState).toBe('final')
  })

  it('无流式内容时读历史摘要，并归一化项目符号保证渲染不回退', () => {
    const { content, contentState } = toLedgerPanelContent({
      item: makeItem({
        ai_summary_status: 'done',
        ai_summary: '● 德国站\n销量 13 单\n- 法国站',
      }),
      liveContent: '',
      runSettled: false,
    })
    expect(content).toBe('- 德国站\n销量 13 单\n- 法国站')
    expect(contentState).toBe('final')
  })

  it('两侧都为空时给出空正文', () => {
    const { content, contentState } = toLedgerPanelContent({
      item: makeItem(),
      liveContent: '',
      runSettled: false,
    })
    expect(content).toBe('')
    expect(contentState).toBe('final')
    expect(normalizeLedgerSummary('')).toBe('')
  })
})

describe('状态词表与复制文案', () => {
  it('canonical 状态映射回列表沿用的 ai_summary_status', () => {
    expect(toLedgerSummaryStatus('completed')).toBe('done')
    expect(toLedgerSummaryStatus('failed')).toBe('failed')
    expect(toLedgerSummaryStatus('cancelled')).toBe('failed')
    expect(toLedgerSummaryStatus('generating')).toBe('generating')
    expect(toLedgerSummaryStatus('queued')).toBe('generating')
  })

  it('复制沿用 ◉ 前缀，且只在行首替换', () => {
    expect(ledgerCopyText('- 德国站\n● 法国站\n行内 - 不改')).toBe(
      '◉ 德国站\n◉ 法国站\n行内 - 不改'
    )
  })
})
