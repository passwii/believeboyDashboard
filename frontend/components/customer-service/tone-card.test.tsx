import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScenarioField, ToneOption } from '@/lib/server/ai-chat'
import { ToneCard } from './tone-card'

const { createConversationMock, sendMock, callbacksRefs } = vi.hoisted(() => ({
  createConversationMock: vi.fn(),
  sendMock: vi.fn(),
  callbacksRefs: [] as Array<{
    current: {
      onChunk?: (delta: string) => void
      onDone?: () => void
      onError?: (message: string) => void
    }
  }>,
}))

vi.mock('@/lib/api/ai-chat', () => ({
  createConversation: createConversationMock,
}))

vi.mock('@/components/chat/hooks/use-chat-stream-v2', () => ({
  useChatStreamV2: (
    _conversationIdRef: unknown,
    callbacksRef: (typeof callbacksRefs)[number]
  ) => {
    callbacksRefs.push(callbacksRef)
    return { send: sendMock, isStreaming: false }
  },
}))

const schema: ScenarioField[] = [
  { key: 'period', label: '汇报周期', type: 'text' },
  { key: 'metrics', label: '核心指标', type: 'textarea' },
]

const briefTone: ToneOption = {
  id: 'brief',
  label: '简洁周报版',
  description: '一句话结论 + 要点，适合群里快速同步',
  promptSuffix: '简洁输出',
}

const formalTone: ToneOption = {
  id: 'formal',
  label: '正式报告版',
  description: '完整结构化报告，适合正式汇报',
  promptSuffix: '正式输出',
}

function renderTone(tone: ToneOption, generateToken = 1) {
  const onStreamingChange = vi.fn()
  const view = render(
    <ToneCard
      scenarioId="ops-report"
      tone={tone}
      freeText="本周 ACOS 升高"
      guidedFields={{ period: '本周', metrics: '销售额 1w' }}
      language="zh"
      length="standard"
      schema={schema}
      generateToken={generateToken}
      onStreamingChange={onStreamingChange}
    />
  )
  return { ...view, onStreamingChange }
}

describe('ToneCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callbacksRefs.length = 0
    createConversationMock
      .mockResolvedValueOnce({ id: 101 })
      .mockResolvedValueOnce({ id: 102 })
      .mockResolvedValueOnce({ id: 103 })
    sendMock.mockResolvedValue({})
  })

  it('creates a separate conversation for each tone and sends the built prompt contract', async () => {
    renderTone(briefTone)
    renderTone(formalTone)

    await waitFor(() => expect(createConversationMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2))

    expect(createConversationMock).toHaveBeenNthCalledWith(1, '客服交流')
    expect(createConversationMock).toHaveBeenNthCalledWith(2, '客服交流')
    expect(sendMock.mock.calls[0][0]).toContain('【原始内容】')
    expect(sendMock.mock.calls[0][0]).toContain('汇报周期：本周')
    expect(sendMock.mock.calls.map((call) => call[1].toneId).sort()).toEqual([
      'brief',
      'formal',
    ])
    expect(sendMock.mock.calls[0][1]).toMatchObject({
      scenarioId: 'ops-report',
      language: 'zh',
      length: 'standard',
    })
  })

  it('copies, exports, and regenerates the generated Markdown', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
    Object.defineProperty(navigator, 'clipboard', {
      value: clipboard,
      configurable: true,
    })
    const createObjectURL = vi.fn(() => 'blob:customer-service')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
    })
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})

    renderTone(briefTone)
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1))

    act(() => callbacksRefs[0].current.onChunk?.('已生成的客服文案'))
    expect(await screen.findByText('已生成的客服文案')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() =>
      expect(clipboard.writeText).toHaveBeenCalledWith('已生成的客服文案')
    )

    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(clickSpy.mock.contexts[0]).toHaveProperty('download', '简洁周报版.md')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:customer-service')

    fireEvent.click(screen.getByRole('button', { name: '重生成' }))
    await waitFor(() => expect(createConversationMock).toHaveBeenCalledTimes(2))
    expect(sendMock).toHaveBeenCalledTimes(2)

    clickSpy.mockRestore()
  })

  it('shows stream failures and releases the page generating state', async () => {
    sendMock.mockRejectedValueOnce(new Error('生成服务暂时不可用'))
    const { onStreamingChange } = renderTone(briefTone)

    expect(await screen.findByRole('alert')).toHaveTextContent('生成服务暂时不可用')
    expect(onStreamingChange).toHaveBeenLastCalledWith(false)
  })
})
